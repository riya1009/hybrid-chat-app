import datetime
import hashlib
import random
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.hashing import hash_password, verify_password
from app.auth.jwt import create_access_token
from app.config import settings
from app.database import get_db
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User
from app.schemas.password_reset import (
    ForgotPasswordRequest,
    ResetPasswordRequest,
    ResetTokenInfo,
    VerifyResetTokenRequest,
)
from app.schemas.token import Token
from app.schemas.user import UserCreate, UserResponse
from app.utils.email import send_password_reset_email
from app.utils.rate_limit import limiter

router = APIRouter(prefix="/api/auth", tags=["auth"])

AVATAR_PALETTE = ["#6366F1", "#14B8A6", "#F97316", "#EC4899", "#8B5CF6", "#0EA5E9", "#22C55E"]
RESET_TOKEN_TTL_MINUTES = 30


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@router.post("/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def signup(request: Request, payload: UserCreate, db: AsyncSession = Depends(get_db)):
    # Real mail providers (Gmail included) treat "Name@x.com" and "name@x.com" as the same
    # mailbox, so an exact-case match here would let two "duplicate" accounts exist that are
    # really the same address, and would make login/forgot-password fail for anyone who
    # capitalizes their email slightly differently than they originally signed up with — a real
    # bug caught via a live forgot-password test that silently found no account at all.
    normalized_email = payload.email.lower()
    existing = await db.execute(select(User).where(func.lower(User.email) == normalized_email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    user = User(
        name=payload.name,
        email=normalized_email,
        hashed_password=hash_password(payload.password),
        avatar_color=random.choice(AVATAR_PALETTE),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(func.lower(User.email) == form_data.username.lower()))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    return Token(access_token=create_access_token(subject=user.email))


@router.post("/forgot-password", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("5/hour")
async def forgot_password(
    request: Request, payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(User).where(func.lower(User.email) == payload.email.lower()))
    user = result.scalar_one_or_none()
    # Always respond the same way regardless of whether the account exists — otherwise this
    # endpoint becomes a way to check which emails have a Relay account (a real, common
    # vulnerability class for "forgot password" flows, not a hypothetical one).
    if user is not None:
        token = secrets.token_urlsafe(32)
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=_hash_token(token),
                expires_at=datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(minutes=RESET_TOKEN_TTL_MINUTES),
            )
        )
        await db.commit()
        reset_url = f"{settings.CLIENT_URL}/reset-password?token={token}"
        await send_password_reset_email(user.email, reset_url)


async def _get_valid_reset_token(db: AsyncSession, token: str) -> PasswordResetToken:
    result = await db.execute(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == _hash_token(token))
    )
    reset = result.scalar_one_or_none()
    if reset is None or reset.used_at is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = reset.expires_at
    if expires_at.tzinfo is None:
        # SQLite (local dev) doesn't actually preserve tzinfo through DateTime(timezone=True)
        # the way Postgres does — everything written here is already UTC, so a naive value
        # read back is safe to treat as UTC rather than raising on a naive/aware comparison.
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at < now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")
    return reset


@router.post("/reset-password/verify", response_model=ResetTokenInfo)
@limiter.limit("20/hour")
async def verify_reset_token(
    request: Request, payload: VerifyResetTokenRequest, db: AsyncSession = Depends(get_db)
):
    # POST (token in the body) rather than GET with the token in the URL — a GET would land the
    # token in the backend's access logs and in browser history, for no real benefit here.
    reset = await _get_valid_reset_token(db, payload.token)
    user = await db.get(User, reset.user_id)
    return ResetTokenInfo(
        email=user.email,
        public_key=user.public_key,
        encrypted_private_key_recovery=user.encrypted_private_key_recovery,
        recovery_key_salt=user.recovery_key_salt,
    )


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/hour")
async def reset_password(
    request: Request, payload: ResetPasswordRequest, db: AsyncSession = Depends(get_db)
):
    reset = await _get_valid_reset_token(db, payload.token)
    user = await db.get(User, reset.user_id)

    user.hashed_password = hash_password(payload.new_password)
    # The old encrypted_private_key (wrapped with the now-abandoned password) is left exactly
    # as-is unless the client sends a replacement — if it can't recover/re-wrap the key here
    # (no working recovery code), the next login's self-healing logic in e2ee.js notices the
    # stale blob no longer unwraps and mints a fresh keypair automatically. Nothing here needs
    # to know which case it is.
    if payload.public_key is not None:
        user.public_key = payload.public_key
    if payload.encrypted_private_key is not None:
        user.encrypted_private_key = payload.encrypted_private_key
    if payload.key_salt is not None:
        user.key_salt = payload.key_salt
    if payload.encrypted_private_key_recovery is not None:
        user.encrypted_private_key_recovery = payload.encrypted_private_key_recovery
    if payload.recovery_key_salt is not None:
        user.recovery_key_salt = payload.recovery_key_salt

    reset.used_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
