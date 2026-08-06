import datetime

from pydantic import BaseModel, ConfigDict

from app.models.message import DeliveryPath


class MessageCreate(BaseModel):
    content: str | None = None
    attachment_url: str | None = None
    attachment_type: str | None = None
    delivered_via: DeliveryPath = DeliveryPath.server


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    room_id: int
    sender_id: int
    content: str | None
    attachment_url: str | None
    attachment_type: str | None
    delivered_via: DeliveryPath
    created_at: datetime.datetime
    read_at: datetime.datetime | None
    deleted_at: datetime.datetime | None = None
