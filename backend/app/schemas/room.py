import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.user import UserResponse


class RoomCreate(BaseModel):
    peer_user_id: int


class RoomResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    is_group: bool
    name: str | None
    created_at: datetime.datetime


class RoomWithPeer(RoomResponse):
    peer: UserResponse | None = None
    last_message: str | None = None
    last_message_at: datetime.datetime | None = None
    unread_count: int = 0
