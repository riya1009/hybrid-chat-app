import datetime

from pydantic import BaseModel, EmailStr, ConfigDict, Field


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: EmailStr
    avatar_color: str
    last_seen_at: datetime.datetime
    public_key: str | None = None


class UserMeResponse(UserResponse):
    """Only for GET /api/users/me — the account owner recovering their own wrapped private
    key. Deliberately not part of UserResponse, which is what peers/search results use; there's
    no reason to expose your encrypted key material to someone who just searched for you."""

    encrypted_private_key: str | None = None
    key_salt: str | None = None
    encrypted_private_key_recovery: str | None = None
    recovery_key_salt: str | None = None


class PublicKeyUpdate(BaseModel):
    public_key: str = Field(min_length=1, max_length=2000)
    encrypted_private_key: str | None = Field(default=None, max_length=4000)
    key_salt: str | None = Field(default=None, max_length=64)
    encrypted_private_key_recovery: str | None = Field(default=None, max_length=4000)
    recovery_key_salt: str | None = Field(default=None, max_length=64)
