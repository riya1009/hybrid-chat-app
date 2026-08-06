import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.auth.deps import get_current_user_ws
from app.database import AsyncSessionLocal
from app.models.message import DeliveryPath, Message
from app.models.room import RoomMember
from app.models.user import User
from app.redis.pubsub import publish_to_room
from app.sockets.connection_manager import manager
from app.utils.rate_limit import SlidingWindowRateLimiter

router = APIRouter()

# Generous but real: stops a runaway client/script from flooding a room.
message_rate_limiter = SlidingWindowRateLimiter(max_events=20, per_seconds=10)


async def _is_room_member(db, room_id: int, user_id: int) -> bool:
    result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == user_id)
    )
    return result.scalar_one_or_none() is not None


@router.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: int):
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(websocket, db)
        if user is None:
            await websocket.close(code=4401)
            return

        if not await _is_room_member(db, room_id, user.id):
            await websocket.close(code=4403)
            return

    # Presence is otherwise only ever broadcast on connect/disconnect *transitions*, so a
    # client joining after the other participant is already connected would never learn
    # they're online. Snapshot who's already here before adding ourselves, then tell only
    # this new socket about them directly (a targeted send, not a room-wide broadcast).
    already_online = manager.online_user_ids(room_id)
    await manager.connect(room_id, user.id, websocket)

    try:
        for other_user_id in already_online:
            await websocket.send_json({"type": "presence", "user_id": other_user_id, "status": "online"})

        await publish_to_room(
            room_id, {"type": "presence", "user_id": user.id, "status": "online"}
        )

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "message":
                if not message_rate_limiter.allow(user.id):
                    await websocket.send_json({"type": "error", "detail": "Sending too fast — slow down."})
                    continue

                content = (data.get("content") or "").strip() or None
                attachment_url = data.get("attachment_url")
                if not content and not attachment_url:
                    continue

                delivered_via = (
                    DeliveryPath.p2p if data.get("delivered_via") == "p2p" else DeliveryPath.server
                )

                async with AsyncSessionLocal() as db:
                    message = Message(
                        room_id=room_id,
                        sender_id=user.id,
                        content=content,
                        attachment_url=attachment_url,
                        attachment_type=data.get("attachment_type"),
                        delivered_via=delivered_via,
                    )
                    db.add(message)
                    await db.commit()
                    await db.refresh(message)

                await publish_to_room(
                    room_id,
                    {
                        "type": "message",
                        "client_id": data.get("client_id"),
                        "id": message.id,
                        "room_id": room_id,
                        "sender_id": user.id,
                        "content": message.content,
                        "attachment_url": message.attachment_url,
                        "attachment_type": message.attachment_type,
                        "delivered_via": message.delivered_via.value,
                        "created_at": message.created_at.isoformat(),
                        "read_at": None,
                    },
                )

            elif msg_type == "typing":
                await publish_to_room(
                    room_id,
                    {"type": "typing", "user_id": user.id, "is_typing": bool(data.get("is_typing"))},
                )

            elif msg_type == "read":
                up_to_id = data.get("up_to_message_id")
                if isinstance(up_to_id, int):
                    async with AsyncSessionLocal() as db:
                        result = await db.execute(
                            select(Message).where(
                                Message.room_id == room_id,
                                Message.id <= up_to_id,
                                Message.sender_id != user.id,
                                Message.read_at.is_(None),
                            )
                        )
                        now = datetime.datetime.now(datetime.timezone.utc)
                        for msg in result.scalars():
                            msg.read_at = now
                        await db.commit()

                    await publish_to_room(
                        room_id, {"type": "read", "user_id": user.id, "up_to_message_id": up_to_id}
                    )

            elif msg_type == "signal":
                await publish_to_room(
                    room_id, {"type": "signal", "from_user_id": user.id, "data": data.get("data")}
                )

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(room_id, websocket)
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(User).where(User.id == user.id))
            db_user = result.scalar_one_or_none()
            if db_user:
                db_user.last_seen_at = datetime.datetime.now(datetime.timezone.utc)
                await db.commit()
        # Only announce "offline" if this was genuinely this user's last connection to the
        # room. A single disconnect doesn't always mean that — a dev-mode StrictMode phantom
        # connection can register and unregister slightly after the real one is already up,
        # and a user can legitimately have the same chat open in two tabs — either way, a
        # stray disconnect here must not clobber presence for a connection that's still live.
        if user.id not in manager.online_user_ids(room_id):
            await publish_to_room(
                room_id,
                {
                    "type": "presence",
                    "user_id": user.id,
                    "status": "offline",
                    "last_seen_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                },
            )
