from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import decode_access_token
from app.database import get_db
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    email = decode_access_token(token)
    if email is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


async def get_current_user_ws(websocket: WebSocket, db: AsyncSession) -> User | None:
    """WebSockets can't send an Authorization header from the browser API, so the
    JWT is passed as a query param instead (?token=...) and validated the same way."""
    token = websocket.query_params.get("token")
    if not token:
        return None

    email = decode_access_token(token)
    if email is None:
        return None

    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()
