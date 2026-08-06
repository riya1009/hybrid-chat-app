"""Global fan-out subscriber — adapted from
realtime-chat-system-main/app/services/chat_service.py's redis_subscriber().

Kept: one long-lived background task subscribed to a single channel, looping
over pubsub.listen() and re-broadcasting to local connections.
Changed: the reference packed "room:username:message" into a colon-joined
string (breaks if content itself contains a colon); here the payload is JSON
with an explicit room_id field, so the subscriber can dispatch to the right
room in the local ConnectionManager without any string parsing.
"""

import asyncio
import json

from app.redis.redis_client import redis_client
from app.sockets.connection_manager import manager

CHANNEL = "chat"


async def publish_to_room(room_id: int, payload: dict) -> None:
    await redis_client.publish(CHANNEL, json.dumps({"room_id": room_id, "payload": payload}))


async def redis_subscriber() -> None:
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(CHANNEL)

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue
        try:
            data = json.loads(message["data"])
            await manager.broadcast_local(data["room_id"], data["payload"])
        except (json.JSONDecodeError, KeyError):
            continue


def start_subscriber_task() -> asyncio.Task:
    return asyncio.create_task(redis_subscriber())
