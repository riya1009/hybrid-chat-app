# Relay — Frontend

React (Vite) + Tailwind frontend for Relay. See the repo root `ARCHITECTURE.md` for the
hybrid send path and call signaling walkthrough, and `PROVENANCE.md` for what was adapted
from reference projects versus built from scratch.

## Run locally

```bash
npm install
cp .env.example .env    # point at your backend, defaults assume it's on localhost:8001
npm run dev
```

Requires the backend running (see `../backend/README.md`).

## Environment variables (`.env`)

| Variable | Local default | Production |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8001` | your deployed backend's HTTPS URL |
| `VITE_WS_URL` | `ws://localhost:8001` | your deployed backend's **`wss://`** URL |

## Layout

```
src/
  pages/         Login, Signup, ChatPage
  components/    Sidebar, ChatWindow, MessageBubble, Composer, CallOverlay, ...
  hooks/
    useWebSocket.js   owns the per-room WebSocket: history load, live events, reconnect-with-backoff
    useWebRTC.js      owns the RTCPeerConnection: P2P data channel + voice/video calling
  context/       AuthContext (JWT in localStorage, current user)
  lib/           axios instance (attaches the JWT), shared API/WS base URLs
```

## Notes

- Voice/video calling needs a real browser mic/camera permission prompt — it won't work in
  a browser tab that denies media permissions.
- The P2P "⚡" badge only appears once both people in a chat are simultaneously online *and*
  the WebRTC data channel has finished connecting (a few seconds after both open the chat) —
  it's expected for the very first messages in a session to show as server-relayed.
