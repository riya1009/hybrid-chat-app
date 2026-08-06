# Deploying Relay (Railway)

Railway hosts everything in one project: the backend (built from its `Dockerfile`), a
Postgres addon, a Redis addon, and the frontend as a second service. This doc also covers
testing the exact same Docker image locally before you deploy it.

## 1. Test locally with Docker first

This runs the backend against **real** Postgres + Redis (not the zero-infra SQLite/fakeredis
setup used for day-to-day development), in the same container that gets deployed:

```bash
docker compose up --build
```

Then, in a second terminal:

```bash
cd frontend
cp .env.example .env   # defaults already point at http://localhost:8000 / ws://localhost:8000
npm install
npm run dev
```

Open `http://localhost:5173`, sign up two users (e.g. in a normal window + an incognito
window so both sessions stay logged in), start a chat, and confirm:
- messages arrive in real time and survive a page refresh (persisted in the containerized Postgres)
- the "⚡ P2P" badge appears on a message a few seconds after both tabs are open in the same chat
- a voice call and a video call both connect, with working mute/camera-toggle/hang-up
- chat keeps working immediately after a call ends

You can also hit `http://localhost:8000/docs` directly to exercise the REST API. Tear down
with `docker compose down` (add `-v` to also wipe the Postgres volume and start fresh).

> Note: this sandboxed build environment doesn't have Docker permissions to run this stack
> itself (no root, not in the `docker` group) — the app's actual behavior was instead fully
> verified against the zero-infra SQLite + fakeredis setup with real browser automation. The
> Dockerfile/compose files just repackage the same code with a real Postgres/Redis behind it;
> run the two commands above yourself once to confirm the container path works on your machine
> before deploying.

## 2. Create the Railway project

1. [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo**, pick this repo.
2. **Add a Postgres plugin**: New → Database → PostgreSQL. Railway provisions it and exposes
   `DATABASE_URL` (as `${{Postgres.DATABASE_URL}}`) to reference from other services.
3. **Add a Redis plugin**: New → Database → Redis. Exposes `${{Redis.REDIS_URL}}` the same way.

## 3. Backend service

Add a service pointed at this repo with **root directory `backend/`** (Railway auto-detects
the `Dockerfile` there). Set these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a plain `postgres://` URL — the app normalizes the driver prefix itself, see `app/config.py`) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `JWT_SECRET` | generate a long random value (Railway can auto-generate one) |
| `JWT_ALGORITHM` | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` |
| `CLIENT_URL` | the frontend service's public URL once you have it (step 4) — used for CORS |
| `UPLOAD_DIR` | `/app/uploads` |
| `MAX_UPLOAD_MB` | `15` |

Railway sets `$PORT` automatically; the Dockerfile's `CMD` already binds to it and runs
`alembic upgrade head` before starting Uvicorn. Generate a public domain for this service
under Settings → Networking.

> **Uploads are ephemeral.** The container's filesystem doesn't persist across redeploys, so
> uploaded images/files vanish on the next deploy. Fine for a demo; for real persistence,
> attach a Railway volume to `/app/uploads` or swap to S3-compatible storage later.

## 4. Frontend service

Add a second service, **root directory `frontend/`**. Railway's Nixpacks builder auto-detects
a Vite app; set:

- **Build command:** `npm run build`
- **Start command:** `npx serve -s dist -l $PORT`
- **Environment variables:**
  | Variable | Value |
  |---|---|
  | `VITE_API_URL` | the backend service's public URL (`https://...`) |
  | `VITE_WS_URL` | the **same** backend URL with `wss://` instead of `https://` |

Generate a public domain for this service too, then go back to the backend service and set
its `CLIENT_URL` to this frontend URL (needed for CORS to allow the browser to call the API).

## 5. Verify the live deployment

Same checklist as the local Docker test, but now from the public URL — ideally from two
different devices/networks (not just two tabs on one machine), since that's what actually
exercises STUN/NAT traversal for the P2P chat path and calls. This is the link you'd put on a
resume.
