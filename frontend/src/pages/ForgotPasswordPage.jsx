import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import AuthLayout from '../components/AuthLayout'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/api/auth/forgot-password', { email })
    } finally {
      // Always show the same outcome whether or not the account exists — the backend
      // deliberately responds identically either way, so this can't be used to check which
      // emails have a Relay account.
      setBusy(false)
      setSent(true)
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle="">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          If an account exists for <span className="font-medium">{email}</span>, we've sent a
          link to reset your password. It expires in 30 minutes.
        </p>
        <Link
          to="/login"
          className="mt-6 block text-center text-sm font-medium text-accent-600 hover:underline dark:text-accent-400"
        >
          Back to log in
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Forgot your password?" subtitle="We'll email you a link to reset it.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600 dark:text-slate-300">Email</label>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-slate-700 dark:bg-surface-darksoft"
            placeholder="you@example.com"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-accent-600 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-700 disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <Link to="/login" className="font-medium text-accent-600 hover:underline dark:text-accent-400">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  )
}
