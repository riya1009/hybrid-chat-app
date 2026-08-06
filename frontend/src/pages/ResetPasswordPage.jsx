import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import {
  cacheKeyPairLocally,
  generateRecoveryCode,
  recoverKeyPairWithRecoveryCode,
  wrapPrivateKeyWithSecret,
} from '../lib/e2ee'
import AuthLayout from '../components/AuthLayout'
import RecoveryCodeModal from '../components/RecoveryCodeModal'

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const navigate = useNavigate()

  const [status, setStatus] = useState('checking') // checking | valid | invalid
  const [tokenInfo, setTokenInfo] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newRecoveryCode, setNewRecoveryCode] = useState(null)

  useEffect(() => {
    if (!token) {
      setStatus('invalid')
      return
    }
    api
      .post('/api/auth/reset-password/verify', { token })
      .then((res) => {
        setTokenInfo(res.data)
        setStatus('valid')
      })
      .catch(() => setStatus('invalid'))
  }, [token])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    try {
      const payload = { token, new_password: newPassword }
      let rotatedCode = null

      const trimmedCode = recoveryCode.trim()
      if (trimmedCode) {
        const recovered = await recoverKeyPairWithRecoveryCode(
          trimmedCode,
          tokenInfo.recovery_key_salt,
          tokenInfo.encrypted_private_key_recovery,
          tokenInfo.public_key
        )
        if (!recovered) {
          setError("That recovery code didn't work — check it and try again, or leave it blank to reset without it.")
          setBusy(false)
          return
        }

        await cacheKeyPairLocally(recovered)
        const passwordWrap = await wrapPrivateKeyWithSecret(newPassword, recovered.privateKey)
        payload.encrypted_private_key = passwordWrap.encryptedBlob
        payload.key_salt = passwordWrap.saltBase64

        // Rotate the recovery code after use — same reasoning as rotating a backup code once
        // it's spent, rather than leaving the same one valid indefinitely.
        rotatedCode = generateRecoveryCode()
        const recoveryWrap = await wrapPrivateKeyWithSecret(rotatedCode, recovered.privateKey)
        payload.encrypted_private_key_recovery = recoveryWrap.encryptedBlob
        payload.recovery_key_salt = recoveryWrap.saltBase64
      }

      await api.post('/api/auth/reset-password', payload)

      if (rotatedCode) {
        setNewRecoveryCode(rotatedCode)
      } else {
        navigate('/login', { replace: true })
      }
    } catch (err) {
      setError(err?.response?.data?.detail || 'Could not reset your password. The link may have expired.')
    } finally {
      setBusy(false)
    }
  }

  if (newRecoveryCode) {
    return (
      <RecoveryCodeModal code={newRecoveryCode} onContinue={() => navigate('/login', { replace: true })} />
    )
  }

  if (status === 'checking') {
    return (
      <AuthLayout title="Reset your password" subtitle="">
        <p className="text-sm text-slate-500 dark:text-slate-400">Checking your reset link…</p>
      </AuthLayout>
    )
  }

  if (status === 'invalid') {
    return (
      <AuthLayout title="Link expired" subtitle="">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This password reset link is invalid or has expired. Reset links are only valid for 30
          minutes.
        </p>
        <Link
          to="/forgot-password"
          className="mt-6 block text-center text-sm font-medium text-accent-600 hover:underline dark:text-accent-400"
        >
          Request a new link
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Reset your password" subtitle={`For ${tokenInfo.email}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600 dark:text-slate-300">New password</label>
          <input
            type="password"
            required
            minLength={8}
            autoFocus
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-slate-700 dark:bg-surface-darksoft"
            placeholder="At least 8 characters"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600 dark:text-slate-300">
            Confirm new password
          </label>
          <input
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-slate-700 dark:bg-surface-darksoft"
            placeholder="Repeat your new password"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600 dark:text-slate-300">
            Recovery code <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-slate-700 dark:bg-surface-darksoft"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          />
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            Your messages are end-to-end encrypted. Without your recovery code, resetting your
            password means your existing encrypted messages become permanently unreadable — new
            messages will still work fine. Enter it here to keep access to your history.
          </p>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-accent-600 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-700 disabled:opacity-60"
        >
          {busy ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
    </AuthLayout>
  )
}
