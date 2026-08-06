import { ArrowLeft, Phone, Search, Video } from 'lucide-react'
import Avatar from './Avatar'
import ChatOptionsMenu from './ChatOptionsMenu'

export default function ChatHeader({
  peer,
  online,
  typing,
  canCall,
  onStartAudioCall,
  onStartVideoCall,
  onBack,
  searchOpen,
  onToggleSearch,
  onDeleteChat,
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-surface-darksoft">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="-ml-1 rounded-full p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 sm:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <Avatar name={peer?.name} color={peer?.avatar_color} size={40} online={online} />
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-white">{peer?.name}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {typing ? 'typing…' : online ? 'Online' : 'Offline'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onStartAudioCall}
          disabled={!canCall}
          className="rounded-full p-2.5 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800"
          title={canCall ? 'Voice call' : 'Peer must be online to call'}
        >
          <Phone size={19} />
        </button>
        <button
          onClick={onStartVideoCall}
          disabled={!canCall}
          className="rounded-full p-2.5 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800"
          title={canCall ? 'Video call' : 'Peer must be online to call'}
        >
          <Video size={19} />
        </button>
        <button
          onClick={onToggleSearch}
          className={`rounded-full p-2.5 transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
            searchOpen ? 'text-accent-600' : 'text-slate-500 dark:text-slate-300'
          }`}
          title="Search in this chat"
        >
          <Search size={19} />
        </button>
        <ChatOptionsMenu onDeleteChat={onDeleteChat} />
      </div>
    </div>
  )
}
