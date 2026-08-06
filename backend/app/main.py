import asyncio
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler

from app.config import settings
from app.redis.pubsub import start_subscriber_task
from app.routers import auth, messages, rooms, users
from app.sockets.chat_socket import router as chat_ws_router
from app.utils.rate_limit import limiter

app = FastAPI(title="HybridChat API")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.CLIENT_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(rooms.router)
app.include_router(messages.router)
app.include_router(chat_ws_router)

_subscriber_task: asyncio.Task | None = None


@app.on_event("startup")
async def on_startup() -> None:
    global _subscriber_task
    _subscriber_task = start_subscriber_task()


@app.get("/")
def root():
    return {"message": "HybridChat API running", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok"}
