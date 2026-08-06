import Avatar from './Avatar'

function formatTimestamp(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function ChatListRow({ room, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
        active ? 'bg-accent-50 dark:bg-accent-900/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'
      }`}
    >
      <Avatar name={room.peer?.name} color={room.peer?.avatar_color} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">{room.peer?.name}</span>
          <span className="ml-2 shrink-0 text-[11px] text-slate-400">{formatTimestamp(room.last_message_at)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-slate-500 dark:text-slate-400">
            {room.last_message || 'Say hello 👋'}
          </span>
          {room.unread_count > 0 && (
            <span className="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent-600 px-1 text-[11px] font-semibold text-white">
              {room.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
