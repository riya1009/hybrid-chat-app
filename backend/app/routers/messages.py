import datetime
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import settings
from app.database import get_db
from app.models.message import Message
from app.models.room import RoomMember
from app.models.user import User
from app.redis.pubsub import publish_to_room
from app.schemas.message import MessageResponse
from app.utils.rate_limit import limiter

router = APIRouter(prefix="/api/messages", tags=["messages"])

ALLOWED_ATTACHMENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"}


async def _get_room_member(db: AsyncSession, room_id: int, user_id: int) -> RoomMember:
    result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == user_id)
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this room")
    return member


@router.get("/{room_id}", response_model=list[MessageResponse])
async def get_history(
    room_id: int,
    skip: int = 0,
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    member = await _get_room_member(db, room_id, current_user.id)
    limit = min(limit, 100)

    query = select(Message).where(Message.room_id == room_id)
    if member.cleared_at is not None:
        # "Delete chat" only affects this user — everything before the clear point is hidden
        # from their history, but the rows (and the other member's view of them) are untouched.
        query = query.where(Message.created_at > member.cleared_at)
    query = query.order_by(Message.created_at.desc()).offset(skip).limit(limit)

    result = await db.execute(query)
    messages = result.scalars().all()
    return list(reversed(messages))


@router.delete("/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    message_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    message = await db.get(Message, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only delete your own messages")

    # Soft delete: clear the content but keep the row, so both sides' history keeps a stable
    # "this message was deleted" placeholder instead of a gap that would shift every message
    # around it and confuse client_id/id-based reconciliation for anything still in flight.
    message.content = None
    message.attachment_url = None
    message.attachment_type = None
    message.deleted_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()

    await publish_to_room(
        message.room_id,
        {"type": "message_deleted", "id": message.id, "deleted_at": message.deleted_at.isoformat()},
    )


@router.post("/{room_id}/upload")
@limiter.limit("20/minute")
async def upload_attachment(
    request: Request,
    room_id: int,
    file: UploadFile,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_room_member(db, room_id, current_user.id)

    if file.content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type")

    contents = await file.read()
    if len(contents) > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File too large")

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.UPLOAD_DIR, stored_name)
    with open(path, "wb") as f:
        f.write(contents)

    return {"attachment_url": f"/uploads/{stored_name}", "attachment_type": file.content_type}
