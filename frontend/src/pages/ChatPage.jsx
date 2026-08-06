import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { decryptText, deriveRoomKey, isEncrypted } from '../lib/e2ee'
import Sidebar from '../components/Sidebar'
import ChatWindow from '../components/ChatWindow'
import NewChatModal from '../components/NewChatModal'

export default function ChatPage() {
  const [rooms, setRooms] = useState([])
  const [displayRooms, setDisplayRooms] = useState([])
  const [activeRoom, setActiveRoom] = useState(null)
  const [showNewChat, setShowNewChat] = useState(false)

  const loadRooms = useCallback(() => {
    api.get('/api/rooms').then((res) => setRooms(res.data))
  }, [])

  useEffect(() => {
    loadRooms()
    // No global "you have a new chat" push channel exists (WS connections are
    // per-open-room only) — poll the sidebar so a brand-new incoming chat, or
    // activity in a room you're not currently viewing, still shows up.
    const interval = setInterval(loadRooms, 5000)
    return () => clearInterval(interval)
  }, [loadRooms])

  // The sidebar's "last message" preview comes straight from the DB, which — by design —
  // only ever holds ciphertext for E2EE'd messages; the server has no way to decrypt it for
  // us. So this has to be decrypted client-side here too, the same way ChatWindow decrypts
  // the messages inside an open chat, or every chat preview would show raw "e2ee:v1:..." text.
  useEffect(() => {
    let cancelled = false
    Promise.all(
      rooms.map(async (room) => {
        if (!isEncrypted(room.last_message)) return room
        const key = room.peer?.public_key ? await deriveRoomKey(room.peer.public_key) : null
        const decrypted = await decryptText(key, room.last_message)
        return { ...room, last_message: decrypted === null ? '🔒 Encrypted message' : decrypted }
      })
    ).then((result) => {
      if (!cancelled) setDisplayRooms(result)
    })
    return () => {
      cancelled = true
    }
  }, [rooms])

  async function handleSelectNewChatUser(peerUser) {
    const res = await api.post('/api/rooms', { peer_user_id: peerUser.id })
    setShowNewChat(false)
    await loadRooms()
    setActiveRoom(res.data)
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className={`h-full w-full sm:block sm:w-80 ${activeRoom ? 'hidden' : 'block'}`}>
        <Sidebar
          rooms={displayRooms}
          activeRoomId={activeRoom?.id}
          onSelectRoom={setActiveRoom}
          onNewChat={() => setShowNewChat(true)}
        />
      </div>

      <div className={`h-full flex-1 sm:flex ${activeRoom ? 'flex' : 'hidden'}`}>
        {activeRoom ? (
          <ChatWindow
            key={activeRoom.id}
            room={activeRoom}
            onRoomActivity={loadRooms}
            onBack={() => setActiveRoom(null)}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-surface-soft text-center dark:bg-surface-dark">
            <span className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-600 text-2xl font-semibold text-white">
              R
            </span>
            <h2 className="text-lg font-medium text-slate-700 dark:text-slate-200">Relay</h2>
            <p className="mt-1 max-w-xs text-sm text-slate-500 dark:text-slate-400">
              Pick a conversation, or start a new one — messages sync instantly, and switch to a
              direct peer-to-peer connection whenever both of you are online.
            </p>
          </div>
        )}
      </div>

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} onSelect={handleSelectNewChatUser} />}
    </div>
  )
}
