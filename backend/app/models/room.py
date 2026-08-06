import datetime

from sqlalchemy import DateTime, ForeignKey, String, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.user import User


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # For 1:1 rooms only: "min(user_id)-max(user_id)", unique so a DM room is never duplicated.
    dm_key: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True, index=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    members: Mapped[list["RoomMember"]] = relationship(back_populates="room", cascade="all, delete-orphan")


class RoomMember(Base):
    __tablename__ = "room_members"

    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    joined_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.datetime.now(datetime.timezone.utc)
    )
    # "Delete chat" clears history for this user only — the other member's row (and the
    # messages themselves) are untouched, so their copy of the conversation is unaffected.
    # History/last-message queries filter to `created_at > cleared_at` for this user; the room
    # drops out of their list entirely until a message actually arrives after this timestamp.
    cleared_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    room: Mapped["Room"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship()
