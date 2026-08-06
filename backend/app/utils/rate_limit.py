import time

from slowapi import Limiter
from slowapi.util import get_remote_address

# For REST routes (signup/login/message-post/upload) — decorate routes with @limiter.limit("...")
limiter = Limiter(key_func=get_remote_address)


class SlidingWindowRateLimiter:
    """Small per-key rate limiter for the WebSocket message loop, where slowapi's
    route-decorator style doesn't apply (there's no single request/response per message)."""

    def __init__(self, max_events: int, per_seconds: float) -> None:
        self.max_events = max_events
        self.per_seconds = per_seconds
        self._hits: dict[int, list[float]] = {}

    def allow(self, key: int) -> bool:
        now = time.monotonic()
        window_start = now - self.per_seconds
        hits = [t for t in self._hits.get(key, []) if t > window_start]
        if len(hits) >= self.max_events:
            self._hits[key] = hits
            return False
        hits.append(now)
        self._hits[key] = hits
        return True
