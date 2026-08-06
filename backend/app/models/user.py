import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    avatar_color: Mapped[str] = mapped_column(String(7), default="#6366F1")
    # This device's ECDH public key (base64 raw SPKI), uploaded client-side after login so
    # peers can derive a shared AES-GCM key for E2EE — the server only ever stores/serves the
    # public half; see frontend/src/lib/e2ee.js and ARCHITECTURE.md.
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The ECDH private key, encrypted client-side with a key derived from the user's login
    # password (PBKDF2) before ever being sent here — this server only ever sees ciphertext,
    # never the plaintext private key or password. Storing it (wrapped) is what lets any
    # device recover the *same* key on login instead of each device minting its own and
    # breaking decryption for everyone. `key_salt` is the PBKDF2 salt (not secret).
    encrypted_private_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    key_salt: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # A second, independent wrapped copy of the *same* private key, this one encrypted with a
    # key derived from a one-time recovery code instead of the login password. Lets a password
    # reset (which by definition happens without the old password) still recover the private
    # key — and therefore still decrypt old messages — if the user saved this code, without
    # weakening the password-based wrap at all: either secret alone can unwrap its own copy,
    # neither can derive the other. See ARCHITECTURE.md's password-reset section.
    encrypted_private_key_recovery: Mapped[str | None] = mapped_column(Text, nullable=True)
    recovery_key_salt: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.datetime.now(datetime.timezone.utc)
    )
    last_seen_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.datetime.now(datetime.timezone.utc)
    )
