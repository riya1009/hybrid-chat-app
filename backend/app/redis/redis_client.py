"""Redis Pub/Sub client — adapted from realtime-chat-system-main/app/redis/redis_client.py.

Kept: the pub/sub-based fan-out pattern (publish every inbound message to a channel,
one subscriber task delivers it to whichever local WebSocket connections want it).
Changed: connects via REDIS_URL (so prod can point at a hosted Redis like Upstash)
instead of a hardcoded localhost, and falls back to an in-process fake broker
(fakeredis) when REDIS_URL="fake" — this keeps local development and tests free of
any external service to install/run, without changing a single line of the pub/sub
code path that runs in production.
"""

from app.config import settings

if settings.REDIS_URL == "fake":
    from fakeredis import aioredis as _redis_impl

    redis_client = _redis_impl.FakeRedis(decode_responses=True)
else:
    import redis.asyncio as _redis_impl

    redis_client = _redis_impl.from_url(settings.REDIS_URL, decode_responses=True)
