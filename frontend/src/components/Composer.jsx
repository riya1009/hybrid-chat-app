import { useRef, useState } from 'react'
import { Paperclip, Send } from 'lucide-react'

export default function Composer({ onSend, onSendFile, onTyping, disabled }) {
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState(false)
  const typingTimeoutRef = useRef(null)
  const fileInputRef = useRef(null)

  function handleChange(e) {
    setText(e.target.value)
    onTyping(true)
    clearTimeout(typingTimeoutRef.current)
    typingTimeoutRef.current = setTimeout(() => onTyping(false), 1500)
  }

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    clearTimeout(typingTimeoutRef.current)
    onTyping(false)
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      await onSendFile(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-surface-darksoft">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || uploading}
        className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
        title="Attach a file"
      >
        <Paperclip size={20} />
      </button>
      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={handleFileChange} />

      <input
        value={text}
        onChange={handleChange}
        disabled={disabled}
        placeholder={uploading ? 'Uploading attachment…' : 'Message'}
        className="flex-1 rounded-full border border-slate-200 bg-surface-soft px-4 py-2.5 text-sm outline-none focus:border-accent-500 dark:border-slate-700 dark:bg-surface-dark"
      />

      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="rounded-full bg-accent-600 p-2.5 text-white transition hover:bg-accent-700 disabled:opacity-40"
        title="Send"
      >
        <Send size={18} />
      </button>
    </form>
  )
}
