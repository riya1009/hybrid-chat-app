# Architecture

Relay is a hybrid chat app: a FastAPI + Postgres/Redis backend guarantees delivery and
keeps history, while a direct browser-to-browser WebRTC connection is used opportunistically
for lower-latency text and for voice/video calls. This document explains the two trickiest,
least self-evident parts of the system — the hybrid send path and the call signaling flow —
plus how a message or a call actually gets from one browser to the other.

See `PROVENANCE.md` for what was borrowed from reference projects versus built from scratch.

## System diagram

```
React (Vite)                                     FastAPI (Uvicorn)
 ├─ REST (axios): /api/auth, /api/rooms,           routers/
 │  /api/messages, /api/users
 │
 ├─ WebSocket: one socket per open chat            sockets/chat_socket.py
 │  /ws/{room_id}?token=<JWT>                       │
 │  message types: message | typing | read |        ConnectionManager (per-worker,
 │  presence | signal                                in-memory: {room_id: [sockets]})
 │                                                    │
 │                                             Redis Pub/Sub "chat" channel
 │                                             (fakeredis locally, real Redis in prod)
 │                                                    │
 │                                             Postgres (async SQLAlchemy)
 │
 └─ RTCPeerConnection (per open 1:1 chat)  ◄──signal──►  peer's RTCPeerConnection
        ├─ DataChannel "chat": opportunistic P2P text
        ├─ Audio track: added when a call starts
        └─ Video track: added if camera is turned on (independently toggleable)
```

Every chat message is written to Postgres via the WebSocket handler regardless of which
path delivered it (P2P data-channel or WS relay) — the database is always the source of
truth for history and offline delivery.

## Why one WebSocket does four jobs

FastAPI's WebSocket support isn't event-typed like Socket.IO, so every message sent over
`/ws/{room_id}` carries a `type` field and the handler in `chat_socket.py` branches on it:

| `type` | Direction | Purpose |
|---|---|---|
| `message` | client → server | Persist + broadcast a chat message |
| `typing` | client → server → peer | Typing indicator (not persisted) |
| `read` | client → server → peer | Marks messages read, updates `read_at` |
| `presence` | server → client | Online/offline; also a *snapshot* on connect (see below) |
| `signal` | client ↔ server ↔ peer | WebRTC handshake relay (SDP + ICE), server never inspects it |

One connection, one relay path, five jobs — reusing the same channel for the WebRTC
handshake meant no second signaling server had to be designed, deployed, or explained.

### The presence snapshot (a subtlety worth calling out)

Presence is otherwise only broadcast on connect/disconnect *transitions*. That's a trap:
if Alice is already connected to a room and Bob joins later, Bob's connect broadcasts
"Bob is online" — which Alice receives — but Alice never told Bob "I'm already online",
because her presence event fired earlier, before Bob was listening. Bob would sit there
thinking Alice is offline forever.

The fix (`chat_socket.py`): before registering a new connection, the server snapshots who's
already in the room (`ConnectionManager.online_user_ids`) and sends *that specific new
socket* a direct presence message for each of them — bypassing Redis entirely for this one
targeted send. Only the newcomer's own "I just joined" event goes out through the normal
Redis-broadcast path to everyone else.

A related correctness issue on the *disconnect* side: a user can briefly have more than one
connection registered for the same room (a dev-mode React StrictMode phantom connection, or
legitimately the same chat open in two tabs), and a naive "broadcast offline on every
disconnect" fires even when the user still has another live connection — clobbering correct
presence state with a stale "offline". The fix is symmetrical to the connect-side snapshot:
on disconnect, only broadcast "offline" if `online_user_ids(room_id)` shows the user has *no*
remaining connections to that room.

## The hybrid send path

Sending a text message tries the fast path and the reliable path at the same time, not one
then the other:

1. **Optimistic local render** — the message is added to the UI immediately with a
   generated `client_id`, before any network round trip, so sending feels instant.
2. **If the P2P data channel is open** (`useWebRTC`'s `p2pConnected`), the same content is
   sent directly over the `RTCDataChannel`, tagged with that `client_id`. This is the
   "instant" path — it reaches the peer's browser without touching the server.
3. **Always**, regardless of step 2, the message is also sent over the WebSocket
   (`type: "message"`), which the server persists to Postgres and re-broadcasts to the room.

The receiver may therefore see the *same* message arrive twice: once fast (P2P, no DB id
yet), once a little later (WS, with the real DB id and timestamp). Both are reconciled into
one bubble by matching on `client_id` first, falling back to the DB `id` (see `upsertMessage`
in `useWebSocket.js`) — the second arrival just fills in the confirmed id/timestamp on the
same bubble instead of creating a duplicate. The small "⚡ P2P" badge reflects which path a
given message actually took.

If the data channel isn't open (peer offline, or the RTCPeerConnection hasn't finished
connecting yet), step 2 is simply skipped — the message still arrives via the normal
WebSocket path, just without the badge.

## End-to-end encryption for the server-relayed path

The server, Redis, and Postgres never see message text in plaintext — only ciphertext.
This is layered on top of the hybrid send path above without changing it: whatever content
gets encrypted client-side is what both the P2P data channel *and* the WebSocket/DB path
carry, so from the server's perspective nothing changed except the bytes it's relaying.

**Scheme:** ECDH (P-256) key agreement + AES-256-GCM, using the browser's native
`window.crypto.subtle` (`frontend/src/lib/e2ee.js`) — no crypto library, no server-side
crypto code at all.

1. Each **browser/device** generates one persistent ECDH keypair on first login, stored in
   IndexedDB. Only the **public** key is ever uploaded, via `PUT /api/users/me/public-key`
   (`backend/app/routers/users.py`) — it rides along in the existing `UserResponse` schema,
   so it's already returned everywhere a `User` is serialized (room list, search) with no new
   read endpoint needed.
2. Opening a 1:1 chat, both sides derive the *same* AES key locally via
   `ECDH(myPrivateKey, peerPublicKey)` — the shared key itself is never transmitted anywhere,
   only the two public keys (which is what "key agreement" means: two different inputs,
   mathematically guaranteed to produce the same shared secret on both ends).
3. Message content is encrypted into a self-describing string —
   `"e2ee:v1:" + base64(iv) + ":" + base64(ciphertext)` — before it ever leaves
   `ChatWindow.jsx`'s `handleSend`. The server (`backend/app/sockets/chat_socket.py`) stores
   and relays this exactly like it always stored plain text: as an opaque string it never
   inspects. That's what made this addable without touching proven, working message-handling
   code — `content` was always treated as opaque server-side; only what's *inside* it changed.
4. **Backward compatibility is the prefix.** Old messages in the database have no `e2ee:v1:`
   prefix, so the frontend displays them exactly as stored, no decryption attempted. If either
   side lacks a public key (hasn't logged in since this shipped), the chat transparently stays
   in plaintext — encryption only activates once both keys are actually available.

### Multi-device key sync

The first version of this shipped with a "single-device" limitation: each browser generated
its own keypair, so logging into the same account from a second device silently overwrote the
server's stored public key, permanently breaking decryption of everything encrypted under the
previous device's key — including that user's own sent history. This is expected behavior for
someone testing from a fresh incognito window each time, but it also breaks completely normal
usage (reading the same account's chats on phone and laptop), so it was fixed rather than left
as a disclosed limitation.

**Fix:** the private key is additionally wrapped (encrypted) with a key derived from the
user's **login password** via PBKDF2 (`frontend/src/lib/e2ee.js`, 210,000 iterations —
OWASP's current PBKDF2-SHA256 recommendation), and that wrapped blob + its salt are stored on
the server (`User.encrypted_private_key`, `User.key_salt`) alongside the public key. Any
device that logs in with the correct password re-derives the same wrapping key, decrypts the
blob, and recovers the *exact same* private key — the password is only ever available
client-side at the moment of an actual login/signup (never during token-based session
restore, which is also exactly why recovery only needs to happen there: a new device has
nothing cached yet, and that's precisely when it logs in for the first time).

**Trade-off, stated plainly:** private key security is now bounded by login password
strength — compromising the password also exposes message history, not just account access.
This is the same trust model as an encrypted password manager's master password, not a novel
risk. The server still never sees the plaintext password (only its bcrypt hash, as before)
or the plaintext private key (only ciphertext) — a database compromise alone, without the
password too, still can't decrypt anything.

**Known limitations (disclosed, not hidden):**
- **Trust-on-first-use key distribution.** The server hands out public keys with no
  out-of-band verification (no Signal-style "safety numbers" to manually confirm you're
  talking to the right key). This defends against anyone passively reading the database or
  Redis, but not an actively malicious server operator substituting their own key — the same
  class of limitation as most E2EE implementations without a separate verification UI.
- **Attachments are not encrypted** — same documented scope cut as the P2P layer ("file
  sharing goes through the server, not P2P"); only text `content` is covered.

## Password reset and the recovery code

A password reset happens *without* the old password by definition — that's the whole point of
"forgot password." But the private key is wrapped with a key derived from that password (see
above), so naively resetting it would permanently strand the key, and with it every message
ever encrypted under it, the moment anyone used the feature. This is the "natural next gap"
flagged when multi-device sync shipped, now closed two ways instead of one:

1. **A second, independent wrapped copy of the same private key** (`User.encrypted_private_key_recovery`,
   `recovery_key_salt`), wrapped with a one-time **recovery code** instead of the password —
   generated at signup (and retrofittable anytime from the account menu for existing accounts),
   shown to the user exactly once (`RecoveryCodeModal.jsx`), never stored or transmitted in
   plaintext anywhere. Either secret — password or code — can independently unwrap its own
   copy; neither can derive the other, so this doesn't weaken the password-based wrap at all,
   it just adds a second door onto the same room. If the user provides a working recovery code
   during a reset, the frontend unwraps the private key with it, re-wraps it under the *new*
   password, and — since a used recovery code shouldn't stay valid indefinitely — generates and
   uploads a freshly rotated recovery code too, shown again the same way.
2. **If they don't have it** (never set one up, or lost it too), the reset simply doesn't send
   any key material at all — and `setupOrRecoverKeyPair` in `e2ee.js` was extended to treat a
   failed unwrap (which is exactly what happens when the password changed since the blob was
   wrapped) as "mint a fresh keypair" instead of a hard failure. This is the same "no key, no
   data" trade-off documented everywhere else E2EE shows up in this app: old messages become
   permanently unreadable, but the account isn't left in a broken state, and new messages work
   immediately.

Reset tokens themselves: a random 256-bit token is emailed as a link; only its SHA-256 hash is
ever stored (`PasswordResetToken.token_hash`), expires after 30 minutes, and is single-use. The
`forgot-password` endpoint always responds identically whether or not the account exists, so it
can't be used to enumerate registered emails. Email delivery goes over Gmail's own SMTP relay
(`app/utils/email.py`), authenticated with a Google Account App Password rather than the real
account password — App Passwords are scoped to send/receive-mail access only, independently
revocable, and can't be used to change the underlying account's password or reach any other
Google service. `smtplib` has no async API, so the actual send runs via `asyncio.to_thread`
rather than blocking the event loop for every other request this worker is handling. With no
`GMAIL_ADDRESS`/`GMAIL_APP_PASSWORD` configured, the reset link is printed to the server console
instead — the same zero-infra-for-local-dev fallback pattern as `REDIS_URL=fake`, so this whole
flow is testable without a real Google account.

**A real gotcha worth naming:** the free path here wasn't "sign up and send" on the first two
tries. Resend was tried first — its unverified-sender mode rejected delivery to *any* recipient,
including the account's own signup email, with no way to actually deliver mail without verifying
an owned domain. Mailgun's free sandbox was tried next — it delivers mail, but only to
"Authorized Recipients" explicitly added and confirmed in its dashboard, so real, arbitrary users
still couldn't receive resets. Both providers converge on the same underlying truth: unrestricted
transactional email to *anyone*, through a dedicated provider, requires owning and verifying a
domain — free tiers only differ in how narrowly they let you test before that. Gmail's own SMTP
relay sidesteps this entirely (no domain, no recipient allowlist) at the cost of the sender
being a personal address instead of a branded one, and Gmail's own daily send cap — both
irrelevant at this project's actual (near-zero, demo-scale) volume, which is exactly why it's the
one that ended up shipped.

## Delete message, delete chat, and in-chat search

Three smaller features, grouped here because they share one constraint worth calling out
explicitly: **message content is E2EE (see above), so the server only ever holds ciphertext.**
Every design choice below follows from that one fact.

**Delete message** (`DELETE /api/messages/{id}`, sender-only) is a *soft* delete: the row
stays, but `content`/`attachment_url`/`attachment_type` are cleared and `deleted_at` is
stamped. A hard delete (removing the row outright) would leave a gap in the ordered history
that could confuse the `client_id`/id reconciliation described above for anything still
in-flight for that message; keeping the row with a stable "this message was deleted"
placeholder avoids that entirely. The deletion is broadcast to the room over the same
Redis Pub/Sub path used for everything else (`type: "message_deleted"`), so both sides update
in real time — the REST endpoint calls the same `publish_to_room` helper the WebSocket handler
uses, they just don't happen to share an HTTP request.

**Delete chat** (`DELETE /api/rooms/{id}`) clears the conversation for the user who deleted it
*only* — the other person's copy, and the messages themselves, are untouched. This is a
deliberate design choice, not a limitation: since messages belong to a shared `Room` rather
than to each participant individually, actually deleting them would delete the other person's
history too, which isn't what "delete chat" means in any chat app people are used to. Instead,
`RoomMember.cleared_at` is stamped for that user only; `GET /api/messages/{room_id}` and
`GET /api/rooms` both filter to `created_at > cleared_at` *for the requesting user's own row*,
so a cleared room simply drops out of that user's history and sidebar — until a new message
actually arrives after the clear point, at which point it reappears on its own (same behavior
as WhatsApp's "delete chat").

**Search in a chat** is entirely client-side (`ChatWindow.jsx`), filtering the already-decrypted
`displayMessages` array by substring match — there is no server-side search endpoint, and
there can't be one without breaking the E2EE guarantee: a server-side search would require
either the server holding plaintext (defeating the point of E2EE) or a searchable-encryption
scheme (a materially harder cryptographic problem, out of scope here). The trade-off is real
and worth naming: search only covers messages already loaded into the open chat, not the
entire history if pagination is in play. For this app's scale that's a non-issue in practice,
but it's the honest reason the search box doesn't hit an API at all.

## Call signaling: one peer connection, two purposes

Rather than adding PeerJS or any other library with its own signaling broker, calls reuse
the *same* `RTCPeerConnection` created for the text data-channel. Starting a call just adds
an audio (and optionally video) track to that existing connection:

1. **Deterministic roles avoid duplicate offers.** The peer with the numerically lower user
   id is "polite"; the other is "impolite" and is the one who calls
   `pc.createDataChannel('chat')` as soon as both users are online, which triggers
   `onnegotiationneeded` → an SDP offer → relayed over `signal`. This follows the
   [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
   pattern, so if both sides ever happen to renegotiate at once (e.g. a call starting right
   as the data channel is still being set up), the polite side rolls back its own offer
   instead of the connection deadlocking.
2. **Starting a call** (`startCall` in `useWebRTC.js`) sends a small `call-invite` control
   message (not an SDP offer — this is what triggers the callee's ringing UI), then acquires
   local mic/camera via `getUserMedia` and calls `pc.addTrack(...)`. Adding a track fires
   `onnegotiationneeded` again automatically — the exact same renegotiation machinery used
   for the original data channel now carries a real offer/answer for the call.
3. **The incoming SDP offer is buffered, not auto-answered.** Normally perfect negotiation
   answers an incoming offer immediately. But an offer that adds audio/video should first
   show the callee a ringing screen and wait for Accept/Decline — so `chat_socket`'s signal
   handler for an offer that arrives while `callState === 'incoming'` stores it
   (`pendingOfferRef`) instead of applying it. `acceptCall()` applies the buffered offer,
   adds the callee's own tracks, and only then creates the answer.
4. **Camera on/off mid-call removes/re-adds the actual video track** (`toggleCamera`), not
   just a mute flag — `pc.removeTrack`/`addTrack` again trigger the same renegotiation path.
   Mic mute, by contrast, just flips `track.enabled` (the standard approach — no
   renegotiation needed to silence audio).
5. **Hanging up removes only the media tracks** (`pc.getSenders()` filtered to audio/video),
   not the whole connection — the data channel underneath is untouched, so chat keeps
   working immediately after a call ends without needing to reconnect anything.

## Call reliability: TURN fallback and detecting a call that never actually connects

Two related gaps surfaced through real device testing (mobile calls that rang and appeared to
"connect" but carried no audio/video, and a callee's Accept button that occasionally did
nothing) — both fixed together since they're two halves of the same underlying problem:
*signaling succeeding is not the same as the call actually working.*

1. **STUN-only ICE fails on restrictive/symmetric NATs**, which are common on mobile carrier
   networks specifically (the two peers may have no discoverable direct path at all, no matter
   how many STUN-derived candidates are exchanged). `useWebRTC.js`'s `ICE_SERVERS` now also
   includes the [Open Relay Project](https://www.metered.ca/tools/openrelay/)'s public,
   no-signup TURN servers as a fallback, alongside the existing Google STUN servers — TURN
   relays media through a third party as a last resort when a direct/STUN path can't be found.
   These are shared, free credentials (modest bandwidth limits, no uptime SLA), which is an
   appropriate trade-off for a fallback path that most calls on reasonable networks will never
   actually need.
2. **Before this fix, nothing checked whether a call actually connected.** The UI flipped to
   "Call connected" the instant the SDP offer/answer exchange finished — regardless of whether
   ICE ever found a working path. On the narrow set of networks TURN doesn't rescue either, that
   meant a permanently frozen, silent "connected" screen with no error and no way to tell a
   dead call apart from a working one. `armConnectFailureWatch` in `useWebRTC.js` now starts a
   12-second timer the moment either side believes the call is connected; if
   `RTCPeerConnection.connectionState` hasn't independently confirmed `'connected'` by then, the
   call ends automatically with a visible "Call failed to connect" error instead of hanging
   silently forever.

A related, narrower bug from the same testing round: the incoming-call offer-buffering check
(`handleSignal` in `useWebRTC.js`) read `callState` from a React-state closure that can lag one
render behind the actual value, since the effect that owns it only re-runs after React flushes
that state update. An SDP offer arriving in that window would bypass the "wait for Accept"
buffering entirely and get auto-answered with no local media ever attached — leaving the callee
stuck on a ringing screen whose Accept button now had nothing left to accept. Fixed by mirroring
`callState` into a ref (`callStateRef`) that every generation of the handler reads live, instead
of the value each one happened to be created with.

## Known limitations (by design, given the timeline)

- **Presence and P2P/calls are 1:1 only.** Group rooms aren't wired into the UI yet — the
  `RoomMember` join table supports them, but building a group P2P mesh or group calling was
  out of scope for this pass.
- **Presence/`ConnectionManager` state is per-process and in-memory.** It's correct for a
  single Uvicorn worker/instance (this deployment). Scaling to multiple instances would need
  presence tracked in Redis (a set per room) instead of a local Python dict — message
  fan-out itself already goes through Redis Pub/Sub and is multi-instance-ready today.
