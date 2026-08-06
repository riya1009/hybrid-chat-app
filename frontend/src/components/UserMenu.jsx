import { useEffect, useRef, useState } from 'react'
import { LogOut, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import Avatar from './Avatar'
import RecoveryCodeModal from './RecoveryCodeModal'

export default function UserMenu() {
  const { user, logout, setupRecoveryCode } = useAuth()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [hasRecoveryCode, setHasRecoveryCode] = useState(!!user.encrypted_private_key_recovery)
  const [generatingCode, setGeneratingCode] = useState(false)
  const [newCode, setNewCode] = useState(null)
  const containerRef = useRef(null)

  function close() {
    setOpen(false)
    setConfirming(false)
  }

  async function handleSetupRecoveryCode() {
    setGeneratingCode(true)
    try {
      setNewCode(await setupRecoveryCode())
      setHasRecoveryCode(true)
      close()
    } catch (err) {
      console.error('Could not generate a recovery code', err)
    } finally {
      setGeneratingCode(false)
    }
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
      <button onClick={() => setOpen((v) => !v)} title="Account">
        <Avatar name={user.name} color={user.avatar_color} size={32} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-surface-darksoft">
          {!confirming ? (
            <>
              <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">{user.name}</div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">{user.email}</div>
              </div>
              <button
                onClick={handleSetupRecoveryCode}
                disabled={generatingCode}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <ShieldCheck size={16} />
                {generatingCode
                  ? 'Generating…'
                  : hasRecoveryCode
                    ? 'Regenerate recovery code'
                    : 'Set up recovery code'}
              </button>
              <button
                onClick={() => setConfirming(true)}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <LogOut size={16} />
                Log out
              </button>
            </>
          ) : (
            <div className="p-2">
              <p className="px-1 pb-2 text-sm text-slate-600 dark:text-slate-300">
                Log out of Relay on this device?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={close}
                  className="flex-1 rounded-lg border border-slate-200 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  onClick={logout}
                  className="flex-1 rounded-lg bg-red-600 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {newCode && <RecoveryCodeModal code={newCode} onContinue={() => setNewCode(null)} />}
    </div>
  )
}
