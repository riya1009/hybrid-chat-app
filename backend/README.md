# Relay — Backend

FastAPI backend: JWT auth, REST endpoints, and the `/ws/{room_id}` WebSocket that carries
chat messages, typing/read/presence events, and WebRTC signaling. See the repo root
`ARCHITECTURE.md` for how the pieces fit together, and `PROVENANCE.md` for what was adapted
from reference projects.

## Run locally

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # defaults to SQLite + an in-process fake Redis — no external services needed
alembic upgrade head
uvicorn app.main:app --reload --port 8001
```

Interactive API docs: `http://localhost:8001/docs`. Use the `/api/auth/login` endpoint's
"Authorize" button there to test authenticated routes directly.

## Environment variables (`.env`)

| Variable | Local default | Production |
|---|---|---|
| `DATABASE_URL` | `sqlite+aiosqlite:///./hybridchat.db` | `postgresql+asyncpg://...` (e.g. Neon) |
| `REDIS_URL` | `fake` (in-process fakeredis, no server needed) | `redis://...` (e.g. Upstash) |
| `JWT_SECRET` | any string | a long random secret — **do not reuse the dev default** |
| `JWT_ALGORITHM` | `HS256` | same |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` | tune to taste |
| `CLIENT_URL` | `http://localhost:5173` | your deployed frontend origin (used for CORS) |
| `UPLOAD_DIR` | `./uploads` | a writable path/volume in your deployment |
| `MAX_UPLOAD_MB` | `15` | max attachment size |

## Migrations

Schema changes go through Alembic, not `create_all`:

```bash
alembic revision --autogenerate -m "describe the change"
alembic upgrade head
```

## Layout

```
app/
  main.py       FastAPI app: CORS, static /uploads, router + WS mounts, Redis subscriber startup
  config.py     pydantic-settings, reads .env
  database.py   async SQLAlchemy engine/session
  models/       User, Room, RoomMember, Message
  schemas/      Pydantic request/response models
  auth/         password hashing, JWT issue/verify, get_current_user (REST + WS variants)
  routers/      auth, users, rooms, messages (incl. file upload)
  sockets/      ConnectionManager + the /ws/{room_id} handler
  redis/        redis client (real or fakeredis) + the Pub/Sub subscriber task
  utils/        rate limiting (slowapi for REST, a small sliding-window limiter for the WS loop)
alembic/        migrations
```
