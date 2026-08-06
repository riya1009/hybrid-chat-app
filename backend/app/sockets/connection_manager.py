"""In-memory per-worker connection registry.

Adapted from realtime-chat-system-main/app/core/websocket_manager.py: same
dict-of-lists-per-room shape. Changed to also track *which user* owns each
socket (needed for presence + excluding the sender's own other tabs) and to
be a pure local registry — actual cross-connection delivery goes through
Redis Pub/Sub (see app/redis/pubsub.py) so this class alone would only be
enough for a single-process deployment, and Redis is what makes it correct
across multiple Uvicorn workers/instances.
"""

from dataclasses import dataclass

from fastapi import WebSocket


@dataclass
class Connection:
    websocket: WebSocket
    user_id: int


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: dict[int, list[Connection]] = {}

    async def connect(self, room_id: int, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self.rooms.setdefault(room_id, []).append(Connection(websocket, user_id))

    def disconnect(self, room_id: int, websocket: WebSocket) -> None:
        conns = self.rooms.get(room_id)
        if not conns:
            return
        self.rooms[room_id] = [c for c in conns if c.websocket is not websocket]
        if not self.rooms[room_id]:
            del self.rooms[room_id]

    def online_user_ids(self, room_id: int) -> set[int]:
        return {c.user_id for c in self.rooms.get(room_id, [])}

    async def broadcast_local(self, room_id: int, payload: dict, exclude_ws: WebSocket | None = None) -> None:
        # A connection that's already gone stale (e.g. the client disconnected a moment
        # ago and our own cleanup hasn't run yet) must not raise here — one dead socket
        # would otherwise abort delivery to every other connection later in the list.
        for conn in list(self.rooms.get(room_id, [])):
            if conn.websocket is exclude_ws:
                continue
            try:
                await conn.websocket.send_json(payload)
            except Exception:
                self.disconnect(room_id, conn.websocket)


manager = ConnectionManager()
