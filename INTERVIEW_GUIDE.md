# Talking About Relay in an Interview

This doc is for *you*, not for the repo's users — it's prep material for explaining this
project out loud. It's organized so you can skim it once before an interview and have the
right answer ready when someone pushes back with "isn't this just another chat app?"

The short version of the whole strategy: **don't defend the feature list — it's
deliberately unoriginal. Defend the engineering underneath it, and lead with the real bugs
you hit, not the features that work.** Anyone can demo a chat app. Fewer people can explain
why an ICE candidate raced ahead of an SDP answer in production and what fixed it.

---

## The 30-second pitch

"Relay is a real-time chat app with a hybrid architecture — every message goes through a
FastAPI + Redis + Postgres server path for guaranteed delivery and history, but when both
people are online at the same time, it automatically upgrades to a direct WebRTC
peer-to-peer connection for lower latency, and reuses that *same* connection for voice and
video calling — no third-party calling SDK. Message content is also end-to-end encrypted
client-side, so the server only ever stores ciphertext. I built the signaling protocol, the
transport-selection logic, and the encryption myself instead of wiring up Socket.IO, a
calling API, or a crypto library, which is the part that's actually worth talking about."

---

## Feature list (the unoriginal part, on purpose)

| Feature | One line |
|---|---|
| Auth | Signup/login, JWT, bcrypt password hashing |
| 1:1 messaging | Real-time via WebSocket, persisted to Postgres |
| Typing indicators, read receipts, presence | Standard chat UX |
| P2P upgrade | Automatic, once both users are online in the same chat |
| Voice + video calling | Native WebRTC, no SDK, signaled over the same connection as chat |
| End-to-end encryption | Client-side ECDH + AES-GCM — the server only ever stores ciphertext |
| File/image sharing | Server-relayed upload, not P2P (documented scope cut) |
| Reconnect handling | WS auto-reconnect with backoff if the connection drops |

If an interviewer says "WhatsApp has all of this" — agree immediately. That's not the
point. Move straight to the next section.

---

## How each piece is actually implemented

### 1. Real-time messaging
`backend/app/sockets/chat_socket.py` — one WebSocket per open chat, `/ws/{room_id}`. FastAPI
WebSockets aren't event-typed like Socket.IO, so every message carries a `type` field
(`message`, `typing`, `read`, `presence`, `signal`) and the handler branches on it — **one
connection, five jobs**, including carrying the WebRTC handshake later.

Every inbound message is published to a Redis Pub/Sub channel (`backend/app/redis/pubsub.py`)
as JSON with an explicit `room_id`, and a single background subscriber task re-broadcasts to
whichever local WebSocket connections are in that room. This is what makes the design
horizontally scalable: add a second backend instance later, and fan-out still works, because
delivery goes through Redis, not an in-memory list shared across processes.

**Interview line:** *"I didn't use Socket.IO's rooms abstraction — I built the equivalent
myself with a plain per-room connection registry plus Redis Pub/Sub, so I understand what
that abstraction is actually doing underneath."*

### 2. The hybrid send path (the core idea)
`frontend/src/hooks/useWebSocket.js` + `useWebRTC.js`. Sending a message:
1. Renders optimistically in the UI immediately (before any network round trip).
2. If a WebRTC data channel is already open to the peer, sends the same content directly
   over it — this is the *fast* path, server never sees it in transit.
3. **Always**, regardless of step 2, also sends it over the WebSocket, which persists it to
   Postgres and re-broadcasts it.

The receiver can get the *same* message twice (once fast via P2P, once slightly later via
the server, now with a real DB id). Both collapse into one bubble by matching a client-
generated `client_id` first, falling back to the DB id — see `upsertMessage()` in
`useWebSocket.js`. The little "⚡ P2P" badge just reflects which path actually delivered it.

**Interview line:** *"The message doesn't choose one path — it takes both, and the client
reconciles duplicates. That's the actual hard part: making 'try the fast path, but never
trust it exclusively' correct, not just fast."*

### 3. Voice + video calling
`frontend/src/hooks/useWebRTC.js`. No PeerJS, no Twilio/ZegoCloud/Agora. One
`RTCPeerConnection` per open chat carries both the P2P text data channel *and*, when a call
starts, an audio/video track — added to the **same connection** via `pc.addTrack()`, which
triggers WebRTC's renegotiation (`onnegotiationneeded`) automatically. The SDP offer/answer
and ICE candidates travel over the exact same `/ws/{room_id}` signaling channel already built
for chat.

Uses the **perfect negotiation** pattern (a documented WebRTC pattern, not something I
invented) to avoid both sides creating conflicting offers: the numerically lower user ID is
"polite" and yields to an incoming offer instead of asserting its own.

An incoming call offer is deliberately *not* auto-answered — it's buffered
(`pendingOfferRef`) until the user clicks Accept, so the callee gets a proper ringing screen
instead of the call connecting silently.

**Interview line:** *"I could have integrated a calling SDK in an afternoon. I spent the
time instead on the actual signaling protocol and the renegotiation logic, because that's
the transferable systems knowledge, not the integration."*

### 4. Presence
`backend/app/sockets/chat_socket.py`. Naively, presence is only broadcast on connect/
disconnect *transitions* — which has a real bug: if Alice is already connected and Bob joins
later, Bob learns Alice is online (from her earlier broadcast reaching him? No — it already
happened before he was listening), so he'd never find out. Fixed by having the server
snapshot who's already in the room *before* registering the new connection, and sending that
snapshot directly to just the new socket — bypassing Redis entirely for that one targeted
message.

**Interview line:** *"This is a genuine distributed-systems bug class: state that's only
communicated on transitions is invisible to anyone who joins after the transition already
happened. The fix is a point-to-point snapshot on join, separate from the broadcast path."*

### 5. End-to-end encryption
`frontend/src/lib/e2ee.js`. Added after the app was already deployed and working, with one
hard constraint: don't touch what's already proven correct. ECDH (P-256) key agreement +
AES-256-GCM, native Web Crypto API, no library. Each device generates a keypair on first
login (stored in IndexedDB), uploads only the public half, and both sides of a chat derive
the same AES key locally via `ECDH(myPrivateKey, peerPublicKey)` — the shared secret itself
is never transmitted. Message content becomes a self-describing `"e2ee:v1:<iv>:<ciphertext>"`
string before it ever leaves the browser.

The reason this was safe to add without breaking anything: the server already treated
`content` as an opaque string it never parses (it just stores and relays whatever's there) —
so encrypting it client-side required **zero changes** to `chat_socket.py`'s message
handling. The backend changes were purely additive: one nullable column, one new endpoint
to upload a public key. Old plaintext messages have no `e2ee:` prefix, so they keep
displaying exactly as before — no migration, no breakage, no forced re-encryption of history.

**Interview line:** *"I could tell you the feature works because I tested the UI. What I can
actually prove is stronger: I queried the database directly after sending a message and
showed the content column holds ciphertext, not text — the server literally cannot read it
anymore. That's the difference between 'looks encrypted' and 'is encrypted.'"*

**Honest limitations, ready if asked:** trust-on-first-use key distribution (the server
hands out public keys with no out-of-band verification — defends against passive DB access,
not an actively malicious server operator); attachments aren't encrypted, only text. (Multi-
device sync used to be a limitation here too — see bug #10 below for why that got fixed
instead of staying documented.)

---

## Real bugs I hit and fixed (this is your strongest material)

These happened while actually building and deploying this — not hypothetical "future work."
Each one is a genuine "what was the hardest part" answer.

1. **A WebSocket connection leak that silently broke broadcast to an entire room.**
   React's dev-mode double-mount (StrictMode) opens a WebSocket, then immediately closes it.
   The server's presence-snapshot send to that already-dead socket raised an exception
   *outside* the connection's try/finally block, so cleanup never ran — leaving a dead socket
   registered. The next broadcast loop hit that dead socket, raised, and aborted delivery to
   every *other*, live connection in the room. Fix: widen the try/finally to cover the whole
   connection lifetime, and make the broadcast loop tolerant of one failed send instead of
   letting it abort the rest. *(`backend/app/sockets/chat_socket.py`, `connection_manager.py`)*

2. **`asyncpg` rejecting Neon's connection string.** Hosted Postgres providers hand out a
   `?sslmode=require` query param — a `psycopg2`/libpq convention. `asyncpg` has no such
   kwarg and threw `TypeError: connect() got an unexpected keyword argument 'sslmode'`. Fixed
   by normalizing the URL (strip `sslmode`, since asyncpg negotiates TLS with servers that
   require it automatically) in `backend/app/config.py`.

3. **Upstash Redis connections dying mid-handshake in production.** `redis.exceptions.
   ConnectionError: Connection closed by server` during auth — root cause: using a plain
   `redis://` URL against an endpoint that requires TLS. Fixed by using the `rediss://`
   connection string instead. Nothing wrong with the app code — a real "which connection
   string variant does this managed service actually need" debugging exercise.

4. **A race condition in WebRTC signal handling.** `addIceCandidate` threw
   `InvalidStateError: The remote description was null`. Root cause: incoming signaling
   messages (an SDP offer, followed immediately by several ICE candidates) were each handled
   by an async callback fired independently per WebSocket message, with no guarantee the
   *previous* message had finished processing — so a candidate's handler could start running
   before the offer's `setRemoteDescription()` had resolved. Only showed up over a real
   network (not localhost), where timing is different. Fixed by serializing all incoming
   signal messages through a single promise chain, guaranteeing they're handled strictly in
   arrival order. *(`frontend/src/hooks/useWebRTC.js`)*

5. **A CSS flexbox bug that broke the call UI.** The video call overlay's `<video>` element
   has an intrinsic size that, without `min-height: 0` on its flex container, forced the
   container taller than the viewport — pushing the mute/hangup controls off-screen entirely.
   Classic flexbox gotcha, only visible when actually testing the call UI end-to-end, not
   from reading the code.

6. **A presence race that silently marked an online peer as offline.** After adding a new
   feature, the "start a call" button started intermittently staying disabled even with both
   users genuinely connected. Traced it by instrumenting the raw WebSocket frames: React
   StrictMode's dev-only phantom connection doesn't always finish closing before the real one
   finishes connecting — occasionally the phantom's connection *and* disconnection both
   complete on the server, slightly after the real connection's own "online" broadcast, so its
   "offline" broadcast arrived last and clobbered the correct state. The bug wasn't "a disconnect
   fires an offline event" (that's correct) — it's that *every* disconnect fired one
   unconditionally, even when the user still had another live connection to the same room.
   Fixed by checking, at disconnect time, whether the user has *any* remaining connections to
   that room before broadcasting "offline" at all. *(`backend/app/sockets/chat_socket.py`)*

7. **Audio-only calls had no audio.** Calls connected fine — ICE, tracks, everything looked
   correct — but neither side could hear the other. Root cause: the remote `<video>` element
   was only ever mounted when the call *had video*, and that video element was the only thing
   in the UI consuming the remote stream at all. An audio-only call has no video track to
   trigger that branch, so `remoteStream`'s audio track was never attached to any playback
   element anywhere — nothing was ever going to make sound, regardless of how correct the
   WebRTC connection itself was. Fixed by adding a dedicated, always-mounted, invisible
   `<audio>` element bound to `remoteStream` unconditionally, and muting the video element
   (which would otherwise double up the same audio track when video *is* present). A good
   example of a bug that's invisible from reading the WebRTC code — it only exists in the
   gap between "the connection works" and "something is actually rendering what it carries."
   *(`frontend/src/components/CallOverlay.jsx`)*

8. **The ringtone worked on mobile but was silent on desktop.** Browsers only let a Web
   Audio `AudioContext` actually produce sound after a real user gesture (click/tap) on the
   page — otherwise scheduled sounds are silently dropped, no error thrown. Starting a call
   (a click) unlocks it fine, but an *incoming* call's ringtone is triggered by a WebSocket
   message arriving, which isn't a gesture — so it could get silently blocked depending on
   whether that specific tab had already been interacted with recently. Fixed by unlocking
   the shared `AudioContext` on the very first click/keypress anywhere in the app (e.g.
   logging in), long before any call happens, instead of trying to unlock it lazily right
   when a ringtone is first needed. *(`frontend/src/lib/ringtone.js`, `App.jsx`)*

9. **"Accept" sometimes silently did nothing.** Intermittent, hard to reproduce on purpose —
   which is usually the signature of a race condition, and this was one. The "incoming call"
   UI appears the instant a lightweight `call-invite` control message arrives, but the actual
   SDP offer is a *separate* message sent slightly later (the caller still has to acquire
   mic/camera and let `onnegotiationneeded` fire before it can be sent). `acceptCall` bailed
   out immediately if that offer hadn't arrived yet — so a callee who tapped Accept fast
   enough (more likely on a quick mobile tap than a deliberate desktop click, which is
   probably why it read as "sometimes on mobile") hit a no-op with no error and no retry.
   Fixed by recording "the user wants to accept" as intent (`acceptRequestedRef`) independent
   of whether the offer has arrived yet — whichever of "the offer arrives" or "the user taps
   Accept" happens *second* is what actually triggers the accept logic. Reproduced
   deterministically in a test by clicking Accept the instant the button appears, before
   confirming the fix. *(`frontend/src/hooks/useWebRTC.js`)*

10. **Messages became permanently undecryptable when logging into the same account from a
    second device.** Shipped E2EE with a documented "single-device" limitation — each browser
    mints its own keypair, uploads the public half, and overwrites whatever the server had
    before. That's an *acceptable-sounding* scope cut on paper, but it breaks the moment
    someone does the single most normal thing a chat app user does: read their messages on
    phone *and* desktop. Confirmed via a live report — messages started showing "Unable to
    decrypt this message," including the user's own previously-sent history, the instant a
    second device logged into the same account. The root cause wasn't a bug in the crypto —
    ECDH/AES-GCM worked exactly as designed; the *design itself* assumed one device per
    account, which is false for real usage. Fixed properly rather than just re-documenting
    the limitation: the private key is now additionally wrapped (AES-GCM) with a key derived
    from the user's **login password** via PBKDF2 (210,000 iterations — OWASP's current
    minimum for PBKDF2-SHA256), and the wrapped blob + its salt are stored server-side
    alongside the public key. Any device that logs in with the correct password re-derives
    the identical wrapping key, unwraps the *same* private key every other device already
    has, and multi-device sync just works — without the server ever seeing the plaintext
    password (only its bcrypt hash, unchanged) or the plaintext private key (only ciphertext).
    Verified with a dedicated test simulating two separate browser contexts on one account:
    the second "device" recovered the identical public key, could decrypt the first device's
    prior messages, and messages sent *from* the second device were readable by both the
    first device and the other party — plus a second test confirming an old-style account
    (public key only, no wrapped blob — simulating "created before this fix shipped") self-
    heals on its next login without rotating keys. *(`frontend/src/lib/e2ee.js`,
    `AuthContext.jsx`, `backend/app/models/user.py`, `routers/users.py`)*

**Interview line for #10:** *"This is the difference between a limitation you write down and
one you actually validate against real usage. 'Single-device' reads like a reasonable scope
cut until you remember chat apps exist specifically so people can read messages from more
than one device — I shipped the honest disclosure first, hit it myself within a day of real
testing, and then fixed the actual design gap instead of just leaving the caveat in the docs."*

11. **Video calls silently "connected" on some networks with no audio or video ever flowing,
    and the Accept button occasionally did nothing for an incoming video call specifically.**
    Two separate root causes, found by actually testing across real mobile networks instead of
    just two browser tabs on the same machine. First: the app only had STUN servers configured
    (a known, disclosed limitation), and STUN alone cannot traverse restrictive/symmetric NATs
    — common on mobile carrier networks — where no direct peer-to-peer path exists at all.
    Worse, the UI had no way to tell that apart from a working call: it flipped to "Call
    connected" the instant SDP offer/answer signaling finished, regardless of whether media
    ever actually flowed, so a NAT-traversal failure looked identical to "the app is broken" —
    a frozen, silent screen with no error. Fixed two ways: added the Open Relay Project's free,
    no-signup TURN servers as a fallback alongside the existing STUN servers (TURN relays
    media through a third party when no direct path can be found), *and* added a real
    connection-state watchdog — a 12-second timer that checks `RTCPeerConnection.connectionState`
    independently of the signaling exchange, and surfaces a visible "Call failed to connect"
    error and ends the call automatically if the connection never actually comes up, instead of
    hanging forever with no feedback. Second, narrower bug: the incoming-offer buffering check
    read `callState` from a React-state closure that can lag one render behind reality — an SDP
    offer arriving in that (small but real) window would slip past the "wait for Accept"
    buffering and get auto-answered with no local media ever attached, leaving the callee's
    Accept button pointed at an offer that no longer existed to accept. Fixed by mirroring the
    state into a ref that every version of the handler reads live, immune to render timing.
    *(`frontend/src/hooks/useWebRTC.js`)*

**Interview line for #11:** *"This is a good example of why 'it works on two tabs on my
laptop' doesn't mean 'it works.' Both of these needed a real network and a real mobile device
to surface — one is a NAT-traversal problem with a well-known fix (TURN as a fallback), and
the other is a React closure-staleness bug that only a timing-sensitive protocol like WebRTC
signaling would ever expose. Neither shows up in a code read; both showed up in testing."*

12. **A password-reset token that would reject as "expired" immediately, even seconds after
    being issued.** Building the forgot-password flow, `expires_at < now` compared a
    freshly-created, timezone-*aware* `datetime.now(timezone.utc)` against `expires_at` as read
    back from the database — which crashed with a naive/aware comparison `TypeError` locally,
    every single time. Root cause: SQLAlchemy's `DateTime(timezone=True)` is a real, enforced
    type on Postgres (what's actually deployed), but SQLite — used for zero-infra local dev in
    this project — has no native datetime type at all and silently hands back a naive value
    even though it was written as timezone-aware. Same column type, same code, correct in
    production, broken locally — a genuine "works on my machine (the wrong way)" class of bug,
    caught specifically *because* local dev uses a different database engine than prod, not
    despite it. Fixed by normalizing: if the value read back has no tzinfo, treat it as UTC
    (since everything this app ever writes there already is) before comparing.
    *(`backend/app/routers/auth.py`)*

13. **Resetting a forgotten password would have permanently destroyed access to every
    encrypted message, with no warning, the first time anyone actually used the feature.**
    Caught at the design stage, before writing any code, precisely because of the multi-device
    fix's own documented "next gap" (see #10): the private key is wrapped with a key derived
    from the login password, so a password reset — which happens *without* the old password by
    definition — can't re-derive the old wrapping key. There's no way around this without
    weakening the encryption itself (a server-side password-reset backdoor into an E2EE key
    would defeat the point of E2EE). Solved with a second, independent wrapped copy of the same
    private key under a one-time recovery code shown once at signup (and generatable anytime
    from account settings for existing accounts) — either secret can unwrap its own copy,
    neither can derive the other. A reset with a valid recovery code fully preserves message
    history (and rotates the code, so a spent one doesn't stay valid); a reset without one
    self-heals into a fresh keypair instead of leaving the account's encryption permanently
    stuck — same "no key, no data" trade-off as everywhere else E2EE shows up here, just now
    something the *user* controls by whether they saved their code, rather than something
    that happens to them by accident. *(`frontend/src/lib/e2ee.js`, `ResetPasswordPage.jsx`,
    `RecoveryCodeModal.jsx`, `backend/app/routers/auth.py`)*

**Interview line for #13:** *"The interesting part isn't the recovery-code cryptography — it's
that this bug never had to happen at all. Because the previous fix's limitations section
explicitly named 'password resets don't re-key' as the next gap, I caught this at the design
conversation, before writing a line of code, instead of shipping it and waiting for a user to
lose their message history to find out. Writing down your known limitations honestly is what
makes that possible."*

14. **A failed password-reset email looked exactly like a successful one in the logs — twice,
    across two different providers.** The reset endpoint always returns success regardless of
    whether the email actually sent (a deliberate choice — it can't leak whether an account
    exists), so email failures were only ever surfaced through logging. First bug: the failure
    path used `logger.exception(...)`, but this app never calls `logging.basicConfig()`
    anywhere, so Python's root logger has no handler — those calls were silently dropped, the
    same class of "invisible unless you already know to look" issue as the earlier ringtone/
    autoplay bugs, just in logging instead of the browser. Fixed by using `print()` instead
    (already the pattern for this file's local-dev fallback line, for the same reason). Second,
    separate discovery once logging was actually visible: Resend's unverified-sender mode
    doesn't just restrict *third-party* recipients the way I'd assumed going in — it rejected
    delivery to the account's own signup email too, with a 403 whose message ("domain not
    verified") is about the *sender* configuration, not anything the recipient did. Switched to
    Mailgun's free sandbox next — that one delivers mail, but only to explicitly-authorized test
    recipients confirmed in its dashboard, so real, arbitrary users still couldn't get resets.
    Settled on Gmail's own SMTP relay (an App Password, not the real account password,
    authenticating over STARTTLS) instead of a third dedicated provider — it can send to any
    real inbox with zero domain/allowlist requirements, at the honest cost of a personal rather
    than branded sender and Gmail's own daily send cap, both irrelevant at this project's actual
    volume. *(`backend/app/utils/email.py`)*

**Interview line for #14:** *"Two lessons stacked on top of each other here. One: if a fire-
and-forget path's only observability is a log line, that log line had better be guaranteed to
actually appear — 'it didn't throw' and 'it worked' are not the same claim, and I'd conflated
them. Two: a third-party API returning a 200-shaped response (or in this case, a clear error I
could actually see once logging worked) is worth more than any documentation about what a free
tier is supposed to allow — I tested the actual claim instead of assuming it, and it was wrong."*

15. **"Forgot password" silently did nothing — not an error, not a wrong result, just total
    silence — because of an exact-case email comparison.** Every email lookup in the app
    (signup's duplicate check, login, forgot-password) compared `User.email` against user input
    with plain SQL equality, which is case-sensitive. Real mail providers — Gmail very much
    included — treat `Name@x.com` and `name@x.com` as the same mailbox, so this app should too,
    but it silently didn't: a forgot-password request for an email that differed from what was
    stored by even one letter's capitalization would run the query, find no match, and — because
    the endpoint is *deliberately* designed to respond identically whether or not an account
    exists (see #14's neighbor, the anti-enumeration guarantee) — return the exact same success
    response as a real request, with no log line, no error, nothing to distinguish it from
    working correctly. Found via a real end-to-end test that produced completely clean logs with
    zero output at the one point where output was expected. Fixed by comparing
    `func.lower(User.email)` against the lowercased input in all three lookups, and normalizing
    new signups to lowercase at write time — the query-side fix alone was enough to correctly
    handle every *existing* account regardless of whatever casing it happened to already be
    stored with, with no data migration needed. *(`backend/app/routers/auth.py`)*

**Interview line for #15:** *"This is the same shape of bug as #14, one layer up the stack — a
deliberately silent success path (for good security reasons) is also the easiest possible place
for a completely unrelated bug to hide, because 'nothing happened, no error' looks identical
whether the silence is by design or by accident. The fix that actually gave me confidence wasn't
just correcting the comparison — it was proving it also worked against data that predates the
fix, not just fresh test accounts that happened to already be lowercase."*

**Interview line to close with:** *"None of these were 'features I added' — they were bugs
that only exist because I built the real thing instead of gluing together someone else's
SDK. That's the point of the project."*

---

## How this was actually tested — and why deployment was necessary, not optional

A good question to have a real answer for: *"How did you test this without real users?"*

**Locally, before anything ever deployed:**
- **Zero-infra local environment** — SQLite instead of Postgres, in-process `fakeredis` instead of real
  Redis (`REDIS_URL=fake`). The entire stack (auth, messaging, WebSockets, WebRTC signaling, E2EE) ran
  on one machine with no setup cost, which mattered because testing happened constantly during
  development, not just at the end.
- **Automated browser testing (Playwright) as the primary method, not manual clicking.** Real headless
  Chrome, multiple isolated browser contexts standing in for multiple real users, real WebSocket
  connections, real `RTCPeerConnection`s with `--use-fake-device-for-media-stream` supplying fake
  camera/mic feeds so calls could actually negotiate and carry media. This is what made re-verifying
  every bug fix take seconds instead of manually re-clicking a call flow each time.
- **Direct API/DB verification underneath the UI** — e.g. querying the database directly to confirm the
  `content` column genuinely holds `e2ee:v1:...` ciphertext (not just that the UI *displays* correctly),
  or hitting endpoints with `curl` to isolate whether a bug lived in the frontend or backend.
- **Reading server logs for fire-and-forget paths** — presence events, password-reset email attempts —
  that have no visible UI result to check.

**Why local testing wasn't enough, with three concrete examples from this project:**

The honest framing: *local testing proves the code's logic is correct under idealized conditions — it
can't prove the code survives conditions it was never exposed to.*

1. **NAT/network diversity.** A video call worked perfectly in every local Playwright test — same
   machine, same network, near-zero latency. It broke specifically when tested from two real devices on
   two real networks (mobile data + home Wi-Fi), because that's the only situation restrictive/symmetric
   NAT actually shows up in. No local test can simulate a mobile carrier's NAT configuration — that only
   exists in the real world.
2. **Real browser permission prompts.** Playwright's fake-media flag auto-grants camera/mic access —
   exactly the one interaction a real user has to do manually. A bug hiding specifically in that
   gesture-to-permission timing window was invisible to every automated test and only surfaced by
   testing on an actual phone.
3. **Third-party service behavior.** Whether an email provider's sandbox mode actually delivers mail,
   whether a hosting platform blocks outbound SMTP — these are facts about the real internet and real
   vendor policies that no local mock can stand in for. The only way to learn them was to deploy and
   hit them for real.

**Interview line:** *"I didn't wait until deployment to test — deployment was specifically for testing
the class of bugs that only exist in the real world: real networks, real NAT, real user gestures, real
third-party services. Everything else was already proven correct locally, fast, and repeatably, before
it ever went live."*

---

## Anticipated questions, with answers ready

- **"Why not just use Firebase/Supabase/Socket.IO for the real-time part?"** — Those are
  great choices for shipping fast, but they abstract away exactly what I wanted to
  demonstrate understanding of: connection management, message fan-out, and delivery
  guarantees. Using one would have made this a config exercise, not a systems project.

- **"Why not use a calling SDK like Twilio/Agora/ZegoCloud?"** — Same reason, plus a real
  constraint: those cost money past free tiers and add a third-party dependency for
  something WebRTC already provides natively in every browser.

- **"Isn't peer-to-peer overkill for text messages?"** — Practically, yes, latency
  difference is small. The point isn't that P2P text is essential — it's demonstrating I
  understand *when* to use each transport and can build the fallback logic correctly, which
  is the same skill needed for load balancing, circuit breakers, or any resilience pattern.

- **"Is the encryption actually end-to-end, or just HTTPS?"** — Genuinely end-to-end: HTTPS/
  WSS protects data *in transit* to the server, but the server itself can read it once it
  arrives. Here, content is encrypted in the browser before it's ever sent, with a key the
  server never has — I can (and have) shown this by querying the database directly and
  pointing at the ciphertext in the `content` column.

- **"Why not just use libsodium/a crypto library?"** — The browser's native Web Crypto API
  already provides audited, standard implementations of ECDH and AES-GCM — reaching for a
  third-party library would mean trusting *their* wrapper around the same primitives instead
  of the platform's own. Using the native API directly is the more defensible choice, not a
  shortcut.

- **"What would you do differently / what's not done?"** — Be upfront: the TURN fallback uses
  free, shared, no-signup credentials (fine for a demo, but no bandwidth guarantee at real
  scale — a production deployment would want its own TURN account), 1:1 only (no group call
  mesh), uploaded files aren't persisted across redeploys on the free hosting tier. Naming
  your own scope cuts *with reasons* reads as engineering judgment, not
  as gaps you didn't notice.

- **"How does it scale?"** — Message fan-out already goes through real Redis Pub/Sub, so
  adding backend instances works today. Presence is currently per-process in-memory (correct
  for the single instance actually deployed) — the honest next step to scale that too would
  be moving presence into a Redis set per room, same pattern as the message fan-out.

---

## If you want to demo it live

Two seeded demo accounts exist for exactly this — no need to sign up on the spot:
`demo1@relay.com` / `demo1@123` and `demo2@relay.com` / `demo2@123` (also documented in
`README.md`). Have both logged into two windows (normal + incognito) *before* the interview
starts. Show, in this order: (1) a message with no P2P badge (server path), (2) wait a few
seconds, send another — badge appears (P2P path), (3) start a video call, mute, toggle camera
off/on, hang up, (4) send one more message right after hangup to show the data channel
survived the call ending. That sequence hits every point in this doc in about 90 seconds.

If they want proof the encryption is real, not cosmetic: open `/docs` on the backend URL,
authenticate, hit `GET /api/messages/{room_id}` for the demo room — the `content` field comes
back as `e2ee:v1:...`, unreadable even with direct API access. That single response is worth
more than any amount of talking about it.
