# Deploying Relay without a credit card (Render + Neon + Upstash + Vercel)

Both Railway and Oracle Cloud ended up requiring a credit card at signup (Railway once you
exceed the trial credit; Oracle for identity verification even on Always Free). This path
avoids that entirely — as of this writing, Render, Neon, Upstash, and Vercel's free tiers can
all be signed up for with just GitHub/Google, no card. It's four accounts instead of one
platform, but none of them gate you behind payment info. (Free-tier policies do change —
if any of these ask for a card when you actually sign up, tell me and we'll swap that piece.)

| Piece | Provider | Why this one |
|---|---|---|
| Postgres | [Neon](https://neon.tech) | Permanent free tier (not a trial), no card |
| Redis | [Upstash](https://upstash.com) | Free tier (500k commands/mo), no card |
| Backend | [Render](https://render.com) | Free web service, deploys straight from the existing `backend/Dockerfile`, no card |
| Frontend | [Vercel](https://vercel.com) | Free Hobby plan, no card, zero-config for Vite |

## 1. Neon — Postgres

1. Sign up at neon.tech (GitHub login is easiest) → **Create a project**.
2. Copy the connection string it gives you (looks like `postgresql://user:pass@host/dbname`).
   You'll paste this in as `DATABASE_URL` below — the app normalizes the `postgresql://` /
   `postgres://` prefix to the `asyncpg` driver itself (see `backend/app/config.py`), so use
   it exactly as Neon gives it to you.

## 2. Upstash — Redis

1. Sign up at upstash.com → **Create Database** → pick a region close to where Render will
   run (US regions are typical for free-tier Render).
2. Copy the **`rediss://`** connection string (note the extra `s` — TLS). Our Redis client
   (`redis.asyncio.from_url`) handles `rediss://` automatically.

## 3. Render — backend

1. Sign up at render.com → **New → Web Service** → connect this repo.
2. **Root Directory:** `backend`. Render will detect the `Dockerfile` there and offer
   **Runtime: Docker** — pick that (keeps this identical to the Railway/Oracle deploys).
3. Environment variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 |
   | `REDIS_URL` | the Upstash `rediss://` string from step 2 |
   | `JWT_SECRET` | Render can generate a random value for you |
   | `JWT_ALGORITHM` | `HS256` |
   | `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` |
   | `CLIENT_URL` | fill in after step 4, once you have the Vercel URL |
   | `UPLOAD_DIR` | `/app/uploads` |
   | `MAX_UPLOAD_MB` | `15` |

4. Deploy. Render's free web services spin down after ~15 minutes idle and take a few seconds
   to wake back up on the next request — expected on the free tier, not a bug.
5. Once live, note the public URL, e.g. `https://relay-backend.onrender.com`.

> **Uploads aren't persistent** on Render's free tier (ephemeral filesystem, same caveat as
> Railway) — fine for a demo, revisit with a paid disk or S3-compatible storage later.

## 4. Vercel — frontend

1. Sign up at vercel.com → **Add New → Project** → import this repo.
2. **Root Directory:** `frontend`. Vercel auto-detects Vite (build command `npm run build`,
   output `dist`) — the `frontend/vercel.json` in this repo adds the SPA rewrite rule so
   direct links to `/login` etc. don't 404.
3. Environment variables:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | your Render backend URL, e.g. `https://relay-backend.onrender.com` |
   | `VITE_WS_URL` | the **same** host with `wss://` instead of `https://` |

4. Deploy. Note the resulting URL, e.g. `https://relay.vercel.app`.
5. Go back to Render and set the backend's `CLIENT_URL` to this Vercel URL (needed for CORS),
   then redeploy the backend service so it picks up the change.

## 5. Verify

Same checklist as always: sign up two accounts (from the live Vercel URL, ideally from two
different devices/networks), send messages both ways, confirm the "⚡ P2P" badge appears,
place a voice call and a video call, and confirm chat still works right after a call ends.
The very first request after idle time may be slow (Render's free tier waking up) — that's
expected, not a bug.
