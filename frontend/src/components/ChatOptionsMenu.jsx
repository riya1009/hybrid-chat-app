import { useEffect, useRef, useState } from 'react'
import { MoreVertical, Trash2 } from 'lucide-react'

export default function ChatOptionsMenu({ onDeleteChat }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const containerRef = useRef(null)

  function close() {
    setOpen(false)
    setConfirming(false)
  }

  useEffect(() => {
    if (!open) return

    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) close()
    }
    function handleEscape(e) {
      if (e.key === 'Escape') close()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-2.5 text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title="Chat options"
      >
        <MoreVertical size={19} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-surface-darksoft">
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 size={16} />
              Delete chat
            </button>
          ) : (
            <div className="p-2">
              <p className="px-1 pb-2 text-sm text-slate-600 dark:text-slate-300">
                Delete this chat? This clears the history on your side only — the other person
                keeps theirs.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={close}
                  className="flex-1 rounded-lg border border-slate-200 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onDeleteChat()
                    close()
                  }}
                  className="flex-1 rounded-lg bg-red-600 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
