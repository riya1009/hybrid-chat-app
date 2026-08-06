import { useState } from 'react'
import { Check, CheckCheck, Lock, Paperclip, Trash2, X, Zap } from 'lucide-react'
import { API_URL } from '../lib/api'

function formatTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function MessageBubble({ message, isOwn, highlighted, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  const isDeleted = !!message.deleted_at
  const isImage = message.attachment_type?.startsWith('image/')
  const attachmentSrc = message.attachment_url?.startsWith('http')
    ? message.attachment_url
    : `${API_URL}${message.attachment_url || ''}`

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm shadow-sm transition-shadow ${
          isOwn
            ? 'rounded-br-md bg-accent-600 text-white'
            : 'rounded-bl-md bg-white text-slate-800 dark:bg-surface-darksoft dark:text-slate-100'
        } ${highlighted ? 'ring-2 ring-amber-400 ring-offset-1' : ''}`}
      >
        {isDeleted ? (
          <p className={`flex items-center gap-1.5 italic ${isOwn ? 'text-white/70' : 'text-slate-400'}`}>
            <Trash2 size={12} /> This message was deleted
          </p>
        ) : (
          <>
            {message.attachment_url &&
              (isImage ? (
                <img src={attachmentSrc} alt="attachment" className="mb-1.5 max-h-64 rounded-lg object-cover" />
              ) : (
                <a
                  href={attachmentSrc}
                  target="_blank"
                  rel="noreferrer"
                  className={`mb-1.5 flex items-center gap-1 truncate underline ${isOwn ? 'text-white/90' : 'text-accent-600'}`}
                >
                  <Paperclip size={14} /> Attachment
                </a>
              ))}

            {message.content && <p className="whitespace-pre-wrap break-words">{message.content}</p>}
            {message.decryptFailed && (
              <p className={`flex items-center gap-1 italic ${isOwn ? 'text-white/70' : 'text-slate-400'}`}>
                <Lock size={12} /> Unable to decrypt this message
              </p>
            )}
          </>
        )}

        <div
          className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] ${
            isOwn ? 'text-white/70' : 'text-slate-400'
          }`}
        >
          {message.viaP2P && !isDeleted && (
            <span
              className={`flex items-center gap-0.5 rounded px-1 ${
                isOwn ? 'bg-white/15' : 'bg-accent-50 text-accent-600 dark:bg-accent-900/40'
              }`}
            >
              <Zap size={11} /> P2P
            </span>
          )}
          <span>{formatTime(message.created_at)}</span>
          {isOwn && !isDeleted && (message.read_at ? <CheckCheck size={14} /> : <Check size={14} />)}

          {isOwn && !isDeleted && onDelete && (
            confirming ? (
              <span className="flex items-center gap-0.5">
                <button
                  onClick={() => {
                    setConfirming(false)
                    onDelete(message.id)
                  }}
                  title="Confirm delete"
                  className="rounded p-0.5 hover:bg-black/10"
                >
                  <Check size={12} />
                </button>
                <button onClick={() => setConfirming(false)} title="Cancel" className="rounded p-0.5 hover:bg-black/10">
                  <X size={12} />
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                title="Delete message"
                className="rounded p-0.5 opacity-60 transition hover:bg-black/10 hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
