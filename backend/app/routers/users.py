from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.user import PublicKeyUpdate, UserMeResponse, UserResponse

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/me", response_model=UserMeResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.put("/me/public-key", response_model=UserResponse)
async def update_public_key(
    payload: PublicKeyUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user.public_key = payload.public_key
    # Only overwrite these when actually provided — a plain public-key-only update (e.g. from
    # an older client, or a device that already has its key set up) must never wipe out an
    # existing wrapped key/salt that other devices depend on to recover the same key.
    if payload.encrypted_private_key is not None:
        current_user.encrypted_private_key = payload.encrypted_private_key
    if payload.key_salt is not None:
        current_user.key_salt = payload.key_salt
    if payload.encrypted_private_key_recovery is not None:
        current_user.encrypted_private_key_recovery = payload.encrypted_private_key_recovery
    if payload.recovery_key_salt is not None:
        current_user.recovery_key_salt = payload.recovery_key_salt
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.get("/search", response_model=list[UserResponse])
async def search_users(
    q: str = "",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(User).where(User.id != current_user.id)
    if q:
        query = query.where(User.name.ilike(f"%{q}%") | User.email.ilike(f"%{q}%"))
    result = await db.execute(query.order_by(User.name).limit(30))
    return result.scalars().all()
