import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useWebSocket } from '../hooks/useWebSocket'
import { useWebRTC } from '../hooks/useWebRTC'
import { api } from '../lib/api'
import { decryptText, deriveRoomKey, encryptText, isEncrypted } from '../lib/e2ee'
import ChatHeader from './ChatHeader'
import MessageBubble from './MessageBubble'
import Composer from './Composer'
import TypingDots from './TypingDots'
import CallOverlay from './CallOverlay'

export default function ChatWindow({ room, onRoomActivity, onBack }) {
  const { user } = useAuth()
  const peer = room.peer
  const scrollRef = useRef(null)
  const lastReadIdRef = useRef(0)
  const messageRefs = useRef({})
  const [roomKey, setRoomKey] = useState(null)
  const [displayMessages, setDisplayMessages] = useState([])
  const decryptCacheRef = useRef(new Map()) // "hasKey:ciphertext" -> decrypted string | null

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)

  const ws = useWebSocket(room.id)
  const rtc = useWebRTC({
    peerId: peer.id,
    peerOnline: ws.peerOnline,
    sendSignal: ws.sendSignal,
    onSignal: ws.onSignal,
    onP2PMessage: ws.ingestLocalMessage,
  })

  // E2EE: if the peer has a public key on file, derive the shared AES key for this chat.
  // If they don't (haven't logged in since this shipped, etc.), roomKey stays null and
  // every encrypt/decrypt call below transparently no-ops to today's plaintext behavior.
  useEffect(() => {
    let cancelled = false
    setRoomKey(null)
    if (peer.public_key) {
      deriveRoomKey(peer.public_key).then((key) => {
        if (!cancelled) setRoomKey(key)
      })
    }
    return () => {
      cancelled = true
    }
  }, [peer.public_key])

  // Decrypt every message for display. Legacy plaintext (sent before E2EE existed) passes
  // through unchanged; content that's encrypted but can't be decrypted (no room key yet,
  // or a genuine key mismatch) is flagged rather than shown as a blank bubble. Cached by
  // ciphertext so this effect re-running for unrelated reasons (e.g. a read receipt updating
  // `ws.messages`) never repeats a `crypto.subtle.decrypt` call for a message it already
  // resolved — decryption cost stays flat as history grows instead of scaling with it.
  useEffect(() => {
    let cancelled = false
    const cache = decryptCacheRef.current

    Promise.all(
      ws.messages.map(async (m) => {
        if (!isEncrypted(m.content)) return { ...m, decryptFailed: false }

        const cacheKey = `${roomKey ? 'k' : 'nokey'}:${m.content}`
        let decrypted
        if (cache.has(cacheKey)) {
          decrypted = cache.get(cacheKey)
        } else {
          decrypted = await decryptText(roomKey, m.content)
          cache.set(cacheKey, decrypted)
        }
        return { ...m, content: decrypted, decryptFailed: decrypted === null }
      })
    ).then((decrypted) => {
      if (!cancelled) setDisplayMessages(decrypted)
    })
    return () => {
      cancelled = true
    }
  }, [ws.messages, roomKey])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [displayMessages, ws.peerTyping])

  useEffect(() => {
    const unreadFromPeer = ws.messages.filter((m) => m.sender_id === peer.id && m.id != null)
    if (!unreadFromPeer.length) return
    const maxId = Math.max(...unreadFromPeer.map((m) => m.id))
    if (maxId > lastReadIdRef.current) {
      lastReadIdRef.current = maxId
      ws.sendRead(maxId)
      // The sidebar's unread badge is computed from a separate REST call, not this
      // WebSocket — without this it wouldn't clear until the next 5s poll cycle, which
      // reads as "the badge doesn't go away" even though it technically would, eventually.
      onRoomActivity?.(room.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.messages])

  useEffect(() => {
    if (ws.historyLoaded) onRoomActivity?.(room.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.messages.length])

  // Call setup failures (e.g. mic permission denied) reset the call back to "idle", which
  // closes CallOverlay — so the error has to be surfaced here instead, or it'd never be seen.
  useEffect(() => {
    if (!rtc.callError) return
    const timer = setTimeout(rtc.clearCallError, 8000)
    return () => clearTimeout(timer)
  }, [rtc.callError, rtc.clearCallError])

  // Search operates on `displayMessages` (already decrypted) since content is E2EE — the
  // server only ever has ciphertext, so there's no server-side search to delegate to here;
  // this has to run client-side over whatever's already been decrypted for display.
  const trimmedQuery = searchQuery.trim().toLowerCase()
  const searchMatches = useMemo(
    () =>
      trimmedQuery
        ? displayMessages.filter((m) => !m.deleted_at && m.content?.toLowerCase().includes(trimmedQuery))
        : [],
    [displayMessages, trimmedQuery]
  )
  const activeMatch = searchMatches.length ? searchMatches[Math.min(matchIndex, searchMatches.length - 1)] : null
  const activeMatchKey = activeMatch ? activeMatch.client_id || activeMatch.id : null

  useEffect(() => {
    setMatchIndex(0)
  }, [searchQuery])

  useEffect(() => {
    if (!activeMatchKey) return
    messageRefs.current[activeMatchKey]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeMatchKey])

  function goToNextMatch() {
    if (!searchMatches.length) return
    setMatchIndex((i) => (i + 1) % searchMatches.length)
  }
  function goToPrevMatch() {
    if (!searchMatches.length) return
    setMatchIndex((i) => (i - 1 + searchMatches.length) % searchMatches.length)
  }
  function closeSearch() {
    setSearchOpen(false)
    setSearchQuery('')
    setMatchIndex(0)
  }

  async function handleSend(content) {
    const clientId = crypto.randomUUID()
    const deliveredVia = rtc.p2pConnected ? 'p2p' : 'server'
    // Encrypt once and reuse the identical ciphertext for the optimistic echo and whatever
    // goes out over the wire — this is what keeps client_id-based reconciliation correct,
    // since the sender and the eventual server/P2P echo always agree on `content`. If there's
    // no room key (peer has no public key on file yet), this is a no-op — plaintext, exactly
    // as before E2EE existed.
    const wireContent = await encryptText(roomKey, content)

    const optimisticMessage = {
      client_id: clientId,
      sender_id: user.id,
      room_id: room.id,
      content: wireContent,
      attachment_url: null,
      attachment_type: null,
      created_at: new Date().toISOString(),
      read_at: null,
      viaP2P: rtc.p2pConnected,
      delivered_via: deliveredVia,
    }
    ws.ingestLocalMessage(optimisticMessage)

    if (rtc.p2pConnected) {
      rtc.sendP2P({ client_id: clientId, content: wireContent })
    }
    ws.sendMessage({ clientId, content: wireContent, deliveredVia })
  }

  async function handleSendFile(file) {
    const form = new FormData()
    form.append('file', file)
    const res = await api.post(`/api/messages/${room.id}/upload`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    const clientId = crypto.randomUUID()
    ws.ingestLocalMessage({
      client_id: clientId,
      sender_id: user.id,
      room_id: room.id,
      content: null,
      attachment_url: res.data.attachment_url,
      attachment_type: res.data.attachment_type,
      created_at: new Date().toISOString(),
      read_at: null,
      viaP2P: false,
      delivered_via: 'server',
    })
    ws.sendMessage({
      clientId,
      attachmentUrl: res.data.attachment_url,
      attachmentType: res.data.attachment_type,
      deliveredVia: 'server',
    })
  }

  async function handleDeleteMessage(messageId) {
    // Optimistic: don't wait on the round trip through the server/Redis broadcast to see it
    // disappear — the WS `message_deleted` event that comes back afterward is idempotent
    // with this, whether it's this tab's own broadcast or (for a group room later) a
    // duplicate arriving from elsewhere.
    ws.markMessageDeleted(messageId)
    try {
      await api.delete(`/api/messages/${messageId}`)
    } catch (err) {
      console.error('Failed to delete message', err)
    }
  }

  async function handleDeleteChat() {
    try {
      await api.delete(`/api/rooms/${room.id}`)
      ws.clearMessages()
      onRoomActivity?.(room.id)
    } catch (err) {
      console.error('Failed to delete chat', err)
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <ChatHeader
        peer={peer}
        online={ws.peerOnline}
        typing={ws.peerTyping}
        canCall={ws.peerOnline && rtc.callState === 'idle'}
        onStartAudioCall={() => rtc.startCall(false)}
        onStartVideoCall={() => rtc.startCall(true)}
        onBack={onBack}
        searchOpen={searchOpen}
        onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        onDeleteChat={handleDeleteChat}
      />

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-surface-darksoft">
          <Search size={16} className="shrink-0 text-slate-400" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.shiftKey ? goToPrevMatch() : goToNextMatch())
              if (e.key === 'Escape') closeSearch()
            }}
            placeholder="Search in this chat"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-white"
          />
          {trimmedQuery && (
            <span className="shrink-0 text-xs text-slate-400">
              {searchMatches.length ? `${matchIndex % searchMatches.length + 1}/${searchMatches.length}` : '0/0'}
            </span>
          )}
          <button
            onClick={goToPrevMatch}
            disabled={!searchMatches.length}
            className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800"
            title="Previous match"
          >
            <ChevronUp size={16} />
          </button>
          <button
            onClick={goToNextMatch}
            disabled={!searchMatches.length}
            className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800"
            title="Next match"
          >
            <ChevronDown size={16} />
          </button>
          <button
            onClick={closeSearch}
            className="shrink-0 rounded-full p-1 text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            title="Close search"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {ws.reconnecting && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          Reconnecting…
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-surface-soft px-4 py-4 dark:bg-surface-dark">
        {displayMessages.map((m) => {
          const key = m.client_id || m.id
          const isOwn = m.sender_id === user.id
          return (
            <div key={key} ref={(el) => (messageRefs.current[key] = el)}>
              <MessageBubble
                message={m}
                isOwn={isOwn}
                highlighted={key === activeMatchKey}
                onDelete={isOwn && m.id != null ? handleDeleteMessage : undefined}
              />
            </div>
          )
        })}
        {ws.peerTyping && <TypingDots />}
      </div>

      <Composer onSend={handleSend} onSendFile={handleSendFile} onTyping={ws.sendTyping} disabled={!ws.connected} />

      {rtc.callError && (
        <div className="fixed inset-x-0 top-4 z-[60] mx-auto w-fit max-w-[90vw] rounded-lg bg-red-600 px-4 py-2 text-center text-sm text-white shadow-lg">
          {rtc.callError}
        </div>
      )}

      <CallOverlay
        callState={rtc.callState}
        incomingCallVideo={rtc.incomingCallVideo}
        localStream={rtc.localStream}
        remoteStream={rtc.remoteStream}
        isMuted={rtc.isMuted}
        isCameraOn={rtc.isCameraOn}
        peer={peer}
        onAccept={rtc.acceptCall}
        onDecline={rtc.declineCall}
        onHangUp={rtc.hangUp}
        onToggleMute={rtc.toggleMute}
        onToggleCamera={rtc.toggleCamera}
      />
    </div>
  )
}
