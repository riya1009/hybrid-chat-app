import { useCallback, useEffect, useRef, useState } from 'react'
import { WS_URL, api } from '../lib/api'
import { useAuth } from '../context/AuthContext'

/** Merges an incoming message into the list, correlating by client_id first
 * (so an optimistic local send, its P2P echo, and its server-confirmed copy
 * all collapse into one bubble) and falling back to the DB id. */
function upsertMessage(prev, incoming) {
  const idx = prev.findIndex(
    (m) =>
      (incoming.client_id && m.client_id === incoming.client_id) ||
      (incoming.id != null && m.id === incoming.id)
  )
  if (idx === -1) return [...prev, incoming]
  const next = [...prev]
  next[idx] = { ...next[idx], ...incoming }
  return next
}

function markDeleted(prev, id, deletedAt) {
  return prev.map((m) =>
    m.id === id ? { ...m, deleted_at: deletedAt, content: null, attachment_url: null, attachment_type: null } : m
  )
}

/** Owns the always-on WebSocket connection for one open room: history load,
 * live message/typing/read/presence events, and a signal passthrough for
 * useWebRTC. One connection per open chat, matching the /ws/{room_id} design
 * in README_fastapi.md. */
export function useWebSocket(roomId) {
  const { user } = useAuth()
  const [messages, setMessages] = useState([])
  const [connected, setConnected] = useState(false)
  const [peerOnline, setPeerOnline] = useState(false)
  const [peerTyping, setPeerTyping] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const wsRef = useRef(null)
  const signalHandlersRef = useRef(new Set())
  const everConnectedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setHistoryLoaded(false)
    api.get(`/api/messages/${roomId}`).then((res) => {
      if (cancelled) return
      setMessages(res.data.map((m) => ({ ...m, viaP2P: m.delivered_via === 'p2p' })))
      setHistoryLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [roomId])

  useEffect(() => {
    let tornDown = false
    let reconnectAttempt = 0
    let reconnectTimer = null

    function connect() {
      const token = localStorage.getItem('token')
      const ws = new WebSocket(`${WS_URL}/ws/${roomId}?token=${token}`)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttempt = 0
        everConnectedRef.current = true
        setConnected(true)
        setReconnecting(false)
      }

      ws.onclose = () => {
        setConnected(false)
        setPeerOnline(false)
        if (tornDown) return
        if (everConnectedRef.current) setReconnecting(true)
        // Network blip or server restart — retry with capped exponential backoff
        // instead of leaving the chat silently dead until the user reloads.
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000)
        reconnectAttempt += 1
        reconnectTimer = setTimeout(connect, delay)
      }

      ws.onmessage = (evt) => {
        const data = JSON.parse(evt.data)

        if (data.type === 'message') {
          setMessages((prev) =>
            upsertMessage(prev, {
              client_id: data.client_id,
              id: data.id,
              room_id: data.room_id,
              sender_id: data.sender_id,
              content: data.content,
              attachment_url: data.attachment_url,
              attachment_type: data.attachment_type,
              delivered_via: data.delivered_via,
              viaP2P: data.delivered_via === 'p2p',
              created_at: data.created_at,
              read_at: data.read_at,
            })
          )
        } else if (data.type === 'typing') {
          if (data.user_id !== user.id) setPeerTyping(data.is_typing)
        } else if (data.type === 'read') {
          if (data.user_id !== user.id) {
            setMessages((prev) =>
              prev.map((m) =>
                m.sender_id === user.id && m.id != null && m.id <= data.up_to_message_id
                  ? { ...m, read_at: m.read_at || new Date().toISOString() }
                  : m
              )
            )
          }
        } else if (data.type === 'presence') {
          if (data.user_id !== user.id) setPeerOnline(data.status === 'online')
        } else if (data.type === 'message_deleted') {
          setMessages((prev) => markDeleted(prev, data.id, data.deleted_at))
        } else if (data.type === 'signal') {
          if (data.from_user_id !== user.id) {
            signalHandlersRef.current.forEach((fn) => fn(data.data))
          }
        }
      }
    }

    connect()

    return () => {
      tornDown = true
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [roomId, user.id])

  const send = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    }
  }, [])

  const sendMessage = useCallback(
    ({ clientId, content, attachmentUrl, attachmentType, deliveredVia }) => {
      send({
        type: 'message',
        client_id: clientId,
        content,
        attachment_url: attachmentUrl,
        attachment_type: attachmentType,
        delivered_via: deliveredVia,
      })
    },
    [send]
  )

  const sendTyping = useCallback((isTyping) => send({ type: 'typing', is_typing: isTyping }), [send])
  const sendRead = useCallback((upToMessageId) => send({ type: 'read', up_to_message_id: upToMessageId }), [send])
  const sendSignal = useCallback((data) => send({ type: 'signal', data }), [send])

  const onSignal = useCallback((fn) => {
    signalHandlersRef.current.add(fn)
    return () => signalHandlersRef.current.delete(fn)
  }, [])

  /** Lets useWebRTC's P2P data-channel echo feed straight into the same
   * message list/reconciliation the WS path uses. */
  const ingestLocalMessage = useCallback((message) => {
    setMessages((prev) => upsertMessage(prev, message))
  }, [])

  /** Optimistic local echo of a delete, so the sender sees it disappear instantly instead of
   * waiting on their own broadcast to round-trip back through Redis/WS. Idempotent with the
   * real `message_deleted` event that arrives afterward — same shape, harmless to apply twice. */
  const markMessageDeleted = useCallback((id) => {
    setMessages((prev) => markDeleted(prev, id, new Date().toISOString()))
  }, [])

  /** "Delete chat" clears this user's view immediately; the room simply won't reappear in the
   * sidebar until a genuinely new message arrives (see rooms.py's list_my_rooms). */
  const clearMessages = useCallback(() => setMessages([]), [])

  return {
    messages,
    connected,
    reconnecting,
    peerOnline,
    peerTyping,
    historyLoaded,
    sendMessage,
    sendTyping,
    sendRead,
    sendSignal,
    onSignal,
    ingestLocalMessage,
    markMessageDeleted,
    clearMessages,
  }
}
