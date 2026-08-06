import { createContext, useContext, useEffect, useState } from 'react'
import { api } from '../lib/api'
import {
  generateRecoveryCode,
  getOrCreateKeyPair,
  getPublicKeyBase64,
  setupOrRecoverKeyPair,
  wrapPrivateKeyWithSecret,
} from '../lib/e2ee'

const AuthContext = createContext(null)

/** Called only at an actual login/signup, where the plaintext password is available — the
 * one moment a new device can recover this account's existing E2EE key instead of minting
 * its own (which would silently break decryption for everyone, including this user's own
 * sent history on every other device). Best-effort: never throws — if key recovery/upload
 * fails (unsupported browser, network hiccup, etc.), the app just continues without E2EE
 * for this session, same as it always has, rather than breaking login. */
async function setupKeysAfterLogin(currentUser, password) {
  try {
    const result = await setupOrRecoverKeyPair({
      password,
      existingPublicKeyBase64: currentUser.public_key,
      existingEncryptedPrivateKey: currentUser.encrypted_private_key,
      existingSalt: currentUser.key_salt,
    })
    if (result.needsUpload) {
      await api.put('/api/users/me/public-key', {
        public_key: result.publicKeyBase64,
        encrypted_private_key: result.encryptedPrivateKey,
        key_salt: result.salt,
      })
    }
  } catch (err) {
    console.error('E2EE key setup failed — continuing without it', err)
  }
}

/** Called on token-based session restore (page refresh) — there's no password in hand here
 * to recover/re-wrap anything, so this just makes sure *some* local keypair exists, same as
 * before multi-device sync existed. A device that's already logged in once has its key
 * cached from that real login; a device that's never logged in has nothing to restore a
 * session for in the first place. */
async function ensureLocalKeyPair() {
  try {
    await getOrCreateKeyPair()
  } catch (err) {
    console.error('E2EE local key check failed — continuing without it', err)
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      setLoading(false)
      return
    }
    api
      .get('/api/users/me')
      .then((res) => {
        setUser(res.data)
        ensureLocalKeyPair()
      })
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false))
  }, [])

  async function login(email, password) {
    const form = new URLSearchParams()
    form.set('username', email)
    form.set('password', password)
    const res = await api.post('/api/auth/login', form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    localStorage.setItem('token', res.data.access_token)
    const me = await api.get('/api/users/me')
    setUser(me.data)
    await setupKeysAfterLogin(me.data, password)
  }

  async function signup(name, email, password) {
    await api.post('/api/auth/signup', { name, email, password })
    await login(email, password)
  }

  function logout() {
    localStorage.removeItem('token')
    setUser(null)
  }

  /** Generates a fresh recovery code, wraps this device's private key with it, and uploads
   * the wrapped copy — the one thing that lets a future password reset still recover the key
   * (see e2ee.js). Reads the public key fresh via getPublicKeyBase64() rather than from `user`
   * state, since right after signup that state can still reflect the pre-upload snapshot from
   * before setupKeysAfterLogin finished. Deliberately doesn't swallow errors like the
   * background key setup does — this is a user-initiated action expecting a real code back,
   * so a failure here should surface to whoever's showing it, not vanish silently. */
  async function setupRecoveryCode() {
    const keyPair = await getOrCreateKeyPair()
    const publicKeyBase64 = await getPublicKeyBase64()
    const code = generateRecoveryCode()
    const { encryptedBlob, saltBase64 } = await wrapPrivateKeyWithSecret(code, keyPair.privateKey)
    await api.put('/api/users/me/public-key', {
      public_key: publicKeyBase64,
      encrypted_private_key_recovery: encryptedBlob,
      recovery_key_salt: saltBase64,
    })
    return code
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, setupRecoveryCode }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
