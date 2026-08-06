import { useState } from 'react'
import { Copy, ShieldCheck } from 'lucide-react'

export default function RecoveryCodeModal({ code, onContinue }) {
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-surface-darksoft">
        <div className="mb-3 flex items-center gap-2 text-accent-600">
          <ShieldCheck size={22} />
          <h3 className="text-base font-semibold text-slate-900 dark:text-white">Save your recovery code</h3>
        </div>
        <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
          Your messages are end-to-end encrypted — if you ever forget your password, this code
          is the <span className="font-medium">only</span> way to keep reading your existing
          encrypted messages after a reset. We can't show it to you again.
        </p>

        <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-surface-soft px-4 py-3 dark:border-slate-700 dark:bg-surface-dark">
          <code className="text-sm font-semibold tracking-wide text-slate-900 dark:text-white">{code}</code>
          <button
            onClick={handleCopy}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-700"
          >
            <Copy size={13} /> {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <label className="mb-4 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          I've saved this code somewhere safe (a password manager is ideal).
        </label>

        <button
          onClick={onContinue}
          disabled={!confirmed}
          className="w-full rounded-xl bg-accent-600 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
