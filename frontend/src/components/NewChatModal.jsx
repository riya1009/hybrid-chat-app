import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import Avatar from './Avatar'

export default function NewChatModal({ onClose, onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    const handle = setTimeout(() => {
      api
        .get('/api/users/search', { params: { q: query } })
        .then((res) => setResults(res.data))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(handle)
  }, [query])

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl dark:bg-surface-darksoft"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">Start a new chat</h3>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          className="w-full rounded-xl border border-slate-200 bg-surface-soft px-4 py-2.5 text-sm outline-none focus:border-accent-500 dark:border-slate-700 dark:bg-surface-dark"
        />

        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {loading && <p className="px-2 py-4 text-center text-sm text-slate-400">Searching…</p>}
          {!loading && results.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-slate-400">No users found</p>
          )}
          {results.map((u) => (
            <button
              key={u.id}
              onClick={() => onSelect(u)}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Avatar name={u.name} color={u.avatar_color} size={36} />
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-white">{u.name}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{u.email}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
