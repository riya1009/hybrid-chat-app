import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.message import Message
from app.models.room import Room, RoomMember
from app.models.user import User
from app.schemas.room import RoomCreate, RoomWithPeer

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


def _dm_key(user_id_a: int, user_id_b: int) -> str:
    lo, hi = sorted((user_id_a, user_id_b))
    return f"{lo}-{hi}"


@router.post("", response_model=RoomWithPeer, status_code=status.HTTP_201_CREATED)
async def get_or_create_dm(
    payload: RoomCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.peer_user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot start a chat with yourself")

    peer = await db.get(User, payload.peer_user_id)
    if peer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    key = _dm_key(current_user.id, peer.id)
    result = await db.execute(select(Room).where(Room.dm_key == key))
    room = result.scalar_one_or_none()

    if room is None:
        room = Room(is_group=False, dm_key=key)
        db.add(room)
        await db.flush()
        db.add_all(
            [
                RoomMember(room_id=room.id, user_id=current_user.id),
                RoomMember(room_id=room.id, user_id=peer.id),
            ]
        )
        await db.commit()
        await db.refresh(room)

    return RoomWithPeer(id=room.id, is_group=room.is_group, name=room.name, created_at=room.created_at, peer=peer)


@router.get("", response_model=list[RoomWithPeer])
async def list_my_rooms(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Two joins to RoomMember for the same room: one locates the *other* participant (the
    # "peer" shown in the UI), the other is this user's own membership row, needed here only
    # to read `cleared_at` ("delete chat" — see RoomMember's own comment). Using the inner join
    # on `own_member` also replaces the old `Room.id.in_(...)` membership filter for free —
    # a room only appears in these results if the current user actually has a row for it.
    peer_member = aliased(RoomMember)
    own_member = aliased(RoomMember)
    result = await db.execute(
        select(Room, User, own_member.cleared_at)
        .join(peer_member, and_(peer_member.room_id == Room.id, peer_member.user_id != current_user.id))
        .join(User, User.id == peer_member.user_id)
        .join(own_member, and_(own_member.room_id == Room.id, own_member.user_id == current_user.id))
        .where(Room.is_group.is_(False))
    )
    rows = result.all()

    responses: list[RoomWithPeer] = []
    for room, peer, cleared_at in rows:
        last_msg_query = select(Message).where(Message.room_id == room.id)
        unread_query = select(func.count(Message.id)).where(
            Message.room_id == room.id,
            Message.sender_id != current_user.id,
            Message.read_at.is_(None),
        )
        if cleared_at is not None:
            last_msg_query = last_msg_query.where(Message.created_at > cleared_at)
            unread_query = unread_query.where(Message.created_at > cleared_at)

        last_msg = await db.execute(last_msg_query.order_by(Message.created_at.desc()).limit(1))
        last_message = last_msg.scalar_one_or_none()

        if cleared_at is not None and last_message is None:
            # Cleared, and nothing new since — drop it from the list entirely (WhatsApp-style
            # "delete chat": it reappears on its own the moment a new message actually arrives).
            continue

        unread = await db.execute(unread_query)

        responses.append(
            RoomWithPeer(
                id=room.id,
                is_group=room.is_group,
                name=room.name,
                created_at=room.created_at,
                peer=peer,
                last_message=last_message.content if last_message else None,
                last_message_at=last_message.created_at if last_message else None,
                unread_count=unread.scalar_one(),
            )
        )

    responses.sort(key=lambda r: r.last_message_at or r.created_at, reverse=True)
    return responses


@router.delete("/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def clear_chat(
    room_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == current_user.id)
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this room")

    member.cleared_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
