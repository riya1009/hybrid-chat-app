# Provenance

This project was built by pulling proven
patterns from three reference projects that were sitting in this repo, and rebuilding
everything else fresh. This file is the map: for every borrowed idea, where it came
from, what was kept, what was changed, and why. If you ever swap in a *different*
reference project for a future iteration of this plan, update the "Source" column
first — the rest of the surrounding plan/architecture still holds.

| Source | What we took | What we changed | Why |
|---|---|---|---|
| `realtime-chat-system-main/app/core/websocket_manager.py` | The per-room `dict[str, list[WebSocket]]` connection-registry shape | Rewrote as `ConnectionManager` in `backend/app/sockets/connection_manager.py`: tracks *which user* owns each socket (needed for presence + excluding a user's own other tabs), and made `broadcast_local` tolerant of a dead/stale socket instead of letting one failed send abort delivery to the rest of the room | Original reference has no auth and no multi-room concept beyond a bare string; we needed user-aware, resilient delivery for direct messages between specific accounts |
| `realtime-chat-system-main/app/services/chat_service.py` (`redis_subscriber`) | The single background task subscribed to one Redis channel, re-broadcasting to local connections | Rewrote in `backend/app/redis/pubsub.py`: payload is JSON with an explicit `room_id` field instead of a hand-rolled `"room:username:message"` colon-joined string (which breaks the moment content contains a colon) | Correctness — the original format can't safely carry arbitrary message text or structured signaling payloads (SDP contains colons and newlines) |
| `realtime-chat-system-main/app/redis/redis_client.py` | Connecting to Redis via the `redis.asyncio` client for Pub/Sub | Added a `REDIS_URL=fake` mode (`backend/app/redis/redis_client.py`) that swaps in `fakeredis` transparently — same Pub/Sub code path, no external Redis process required for local dev/tests | This sandbox/dev environment has no way to install or run a real Redis or Postgres server (no root, no Docker group membership) — `fakeredis` lets the *exact* production code path (real Redis Pub/Sub in prod via `REDIS_URL`) be exercised locally without a mock replacing real logic |
| `realtime-chat-system-main/docker-compose.yml` | The idea of Postgres + Redis as sibling services | Not used directly — local dev instead runs SQLite (`aiosqlite`) + `fakeredis` by default via `.env`; production points `DATABASE_URL`/`REDIS_URL` at hosted Postgres (Neon) and Redis (Upstash) instead of self-hosted containers | Same environment constraint as above, plus hosted free-tier services are simpler to actually deploy for a resume-facing demo than self-managing Postgres/Redis containers |
| `whatsapp-clone-master/src/views/HomeView.vue`, `ChatsView.vue`, `MessageView.vue`, `MessageRowComponent.vue` | UI/UX *ideas only*: a fixed-width sidebar + chat pane two-column layout, a chat-list row showing avatar/name/timestamp/last-message/read-tick, a bottom composer bar with attach + send, an empty "no chat selected" state | All code rewritten from scratch in React (`frontend/src/components/Sidebar.jsx`, `ChatListRow.jsx`, `ChatWindow.jsx`, `Composer.jsx`) with a different visual identity: own name ("Relay"), an indigo/neutral color system instead of WhatsApp green, a vector icon set (`lucide-react`) instead of the reference's icon library, no shared CSS, no shared component code | Reference is Vue 3 + Firebase + a Node/Express backend — different stack entirely, and the brief was explicitly to *not* look like a WhatsApp reskin |
| `Real-Time-Chat-and-Video-Calling-Application-in-Django-main` (ConnectX) | UX concept only: a call button opening a full-screen call surface with mute/hang-up/camera controls | All code replaced — the reference uses Django templates + the ZegoCloud Web SDK (a paid third-party calling service reached via a generated token). This project instead uses native browser `RTCPeerConnection` (`frontend/src/hooks/useWebRTC.js`), signaled over the same FastAPI WebSocket already built for chat (`backend/app/sockets/chat_socket.py`'s `signal` message type) | No third-party calling service, no separate signaling broker to deploy/pay for, and it reuses infrastructure already being built anyway — see `ARCHITECTURE.md` for the full signaling walkthrough |

## What has no prior source (built from the ground up)

- JWT auth (signup/login, password hashing, `get_current_user` / WS query-param auth)
- Async SQLAlchemy models (`User`, `Room`, `RoomMember`, `Message`) + Alembic migrations
- The hybrid hybrid-send logic (data-channel-first, always-persist-via-server) and the
  P2P/server delivery badge on each message
- The "perfect negotiation" WebRTC pattern for reusing one `RTCPeerConnection` for both
  the opportunistic text data-channel and voice/video calls, including mid-call camera
  add/remove via renegotiation
- All React components, hooks, and the overall visual design
- Client-side end-to-end encryption (`frontend/src/lib/e2ee.js`) — ECDH key agreement +
  AES-GCM message encryption via the native Web Crypto API, added after initial deployment
  so the server/DB stop seeing message text in plaintext; see `ARCHITECTURE.md` for the design
- Multi-device E2EE key sync (`frontend/src/lib/e2ee.js`'s `deriveWrappingKey`/`wrapPrivateKey`/
  `unwrapPrivateKey`/`setupOrRecoverKeyPair`) — PBKDF2 password-derived key wrapping so the
  same private key can be recovered on any device logging into an account, added after a live
  multi-device bug report; see `ARCHITECTURE.md`'s "Multi-device key sync" section
- Synthesized ringback/ringtone call sounds (`frontend/src/lib/ringtone.js`) via the Web
  Audio API's oscillator nodes — no audio asset files, no licensing to worry about
- Live speaking-indicator waveform during audio-only calls (`useAudioLevel.js` +
  `VoiceWaveform` in `CallOverlay.jsx`), via an `AnalyserNode` tap on the remote audio stream
- TURN fallback for restrictive/mobile-carrier NATs (`useWebRTC.js`'s `ICE_SERVERS`, using the
  Open Relay Project's free public TURN credentials) plus a connection-state watchdog
  (`armConnectFailureWatch`) that surfaces a real error instead of a silently frozen "connected"
  screen when a call's signaling succeeds but the underlying media connection never comes up;
  see `ARCHITECTURE.md`'s "Call reliability" section
- Delete message (soft delete + real-time broadcast), delete chat (per-user history clearing
  via `RoomMember.cleared_at`), and client-side in-chat search (`ChatWindow.jsx`, over already-
  decrypted content, since the server never has plaintext to search) — see `ARCHITECTURE.md`'s
  "Delete message, delete chat, and in-chat search" section for why each is shaped the way it is
- Password reset (`forgot-password` / `reset-password` endpoints, token-hash storage, Gmail SMTP
  email integration with a dev-console-log fallback) plus a one-time recovery-code mechanism
  (`RecoveryCodeModal.jsx`, `e2ee.js`'s `generateRecoveryCode`/`wrapPrivateKeyWithSecret`) that
  lets a reset preserve access to E2EE'd message history — see `ARCHITECTURE.md`'s "Password
  reset and the recovery code" section
