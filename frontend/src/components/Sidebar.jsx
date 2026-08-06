import { SquarePen } from 'lucide-react'
import ChatListRow from './ChatListRow'
import UserMenu from './UserMenu'

export default function Sidebar({ rooms, activeRoomId, onSelectRoom, onNewChat }) {
  return (
    <div className="flex h-full w-full flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-darksoft sm:w-80">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-sm font-semibold text-white">
            R
          </span>
          <span className="text-base font-semibold text-slate-900 dark:text-white">Relay</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onNewChat}
            className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            title="New chat"
          >
            <SquarePen size={19} />
          </button>
          <UserMenu />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rooms.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-400">
            No chats yet. Tap the pencil icon to find someone to talk to.
          </p>
        )}
        {rooms.map((room) => (
          <ChatListRow
            key={room.id}
            room={room}
            active={room.id === activeRoomId}
            onClick={() => onSelectRoom(room)}
          />
        ))}
      </div>
    </div>
  )
}
