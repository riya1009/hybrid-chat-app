/**
 * Client-side end-to-end encryption for message content, so the server (and
 * anyone with DB/Redis access) only ever sees ciphertext for text sent after
 * this shipped. Uses the browser's native Web Crypto API — no library.
 *
 * Scheme: each browser/device generates one persistent ECDH (P-256) keypair
 * on first use, stored in IndexedDB. Only the public half is ever uploaded to
 * the server. For a given 1:1 chat, both sides derive the *same* AES-256-GCM
 * key via ECDH(myPrivateKey, peerPublicKey) — the shared key itself is never
 * transmitted anywhere.
 *
 * Trade-offs (see ARCHITECTURE.md for the full writeup):
 * - Trust-on-first-use: the server distributes public keys with no
 *   out-of-band verification, so this defends against passive DB/Redis
 *   access, not an actively malicious server.
 * - The keypair is generated `extractable: true` (required so the public key
 *   can be exported for upload — the Web Crypto API applies one
 *   extractability flag to both halves of an ECDH pair) — the private key is
 *   simply never exported by this code except to wrap it for multi-device
 *   sync (see below); a hardened version would keep it non-extractable and
 *   rely solely on IndexedDB's structured-clone storage.
 *
 * Multi-device sync: the private key is also wrapped (encrypted) with a key
 * derived from the user's login password via PBKDF2, and that wrapped blob is
 * stored on the server alongside the public key. Any device that logs in with
 * the correct password can re-derive the same wrapping key and recover the
 * *same* private key — without this, every new device/browser would mint its
 * own keypair and silently break decryption of everything encrypted under any
 * other device's key, including the user's own sent history. The trade-off:
 * private key security is now bounded by login password strength (the same
 * trust model as e.g. an encrypted password manager's master password) — the
 * server still never sees the plaintext password or private key, only a
 * bcrypt hash of the former and ciphertext of the latter.
 *
 * Password reset + recovery code: a password reset happens without the old password by
 * definition, so it can't re-derive the old wrapping key — without anything else, that would
 * permanently strand the private key (and everything encrypted under it) the moment anyone
 * resets their password. A second, independent wrapped copy of the same private key — this one
 * under a one-time recovery code instead of the password — lets the reset flow recover it
 * anyway if the user saved that code. If they didn't (or never had one), `setupOrRecoverKeyPair`
 * simply notices the password-wrapped blob no longer unwraps and mints a fresh keypair instead
 * of failing outright — old messages become unreadable (unavoidable: no key, no data), but the
 * account isn't left in a broken state either way.
 */

const DB_NAME = 'relay-e2ee'
const STORE_NAME = 'keys'
const KEY_ID = 'device-keypair'
const PREFIX = 'e2ee:v1:'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer
}

let cachedKeyPair = null

/** Persists a keypair recovered from elsewhere (e.g. a recovery-code unwrap during password
 * reset) as this device's own, so it's immediately usable without another round trip. */
export async function cacheKeyPairLocally(keyPair) {
  await idbSet(KEY_ID, keyPair)
  cachedKeyPair = keyPair
}

/** Returns this device's persistent ECDH keypair, generating and storing one on first call. */
export async function getOrCreateKeyPair() {
  if (cachedKeyPair) return cachedKeyPair

  const stored = await idbGet(KEY_ID)
  if (stored?.privateKey && stored?.publicKey) {
    cachedKeyPair = stored
    return stored
  }

  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  await idbSet(KEY_ID, keyPair)
  cachedKeyPair = keyPair
  return keyPair
}

/** This device's public key, base64-encoded (raw SPKI) — safe to upload/share. */
export async function getPublicKeyBase64() {
  const { publicKey } = await getOrCreateKeyPair()
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  return bufToBase64(raw)
}

const roomKeyCache = new Map() // peer public key (base64) -> derived AES-GCM CryptoKey

/** Derives (and caches) the shared AES key for a chat, given the peer's public key.
 * Returns null if the peer has no key yet or derivation fails — callers should treat
 * that as "encryption unavailable for this chat" and fall back to plaintext. */
export async function deriveRoomKey(peerPublicKeyBase64) {
  if (!peerPublicKeyBase64) return null
  if (roomKeyCache.has(peerPublicKeyBase64)) return roomKeyCache.get(peerPublicKeyBase64)

  try {
    const { privateKey } = await getOrCreateKeyPair()
    const peerPublicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBuf(peerPublicKeyBase64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    roomKeyCache.set(peerPublicKeyBase64, aesKey)
    return aesKey
  } catch (err) {
    console.error('Failed to derive E2EE room key', err)
    return null
  }
}

export function isEncrypted(content) {
  return typeof content === 'string' && content.startsWith(PREFIX)
}

/** Encrypts plaintext into the self-describing "e2ee:v1:<iv>:<ciphertext>" string.
 * Returns the plaintext unchanged if no key is available (graceful, not an error). */
export async function encryptText(aesKey, plaintext) {
  if (!aesKey || plaintext == null) return plaintext
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoder.encode(plaintext))
  return `${PREFIX}${bufToBase64(iv)}:${bufToBase64(ciphertext)}`
}

/** Decrypts an "e2ee:v1:..." payload. Passes through non-encrypted (legacy plaintext)
 * content unchanged. Returns null if it's encrypted but can't be decrypted (wrong/missing
 * key or corrupted data) — never throws into the caller. */
export async function decryptText(aesKey, payload) {
  if (!isEncrypted(payload)) return payload
  if (!aesKey) return null

  try {
    const rest = payload.slice(PREFIX.length) // "<iv_b64>:<ciphertext_b64>"
    const sep = rest.indexOf(':')
    const iv = new Uint8Array(base64ToBuf(rest.slice(0, sep)))
    const ciphertext = base64ToBuf(rest.slice(sep + 1))
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
    return decoder.decode(plainBuf)
  } catch (err) {
    console.error('Failed to decrypt message', err)
    return null
  }
}

const PBKDF2_ITERATIONS = 210_000 // OWASP's current minimum recommendation for PBKDF2-SHA256

/** Derives an AES-GCM key from the user's login password via PBKDF2. Pass an existing
 * base64 salt to reproduce a previously-derived key (recovery on a new device); omit it to
 * mint a fresh one (first-ever key setup). The salt isn't secret — it's stored server-side
 * alongside the wrapped key precisely so any device can redo this derivation. */
async function deriveWrappingKey(password, existingSaltBase64) {
  const salt = existingSaltBase64 ? base64ToBuf(existingSaltBase64) : crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  return { wrappingKey, saltBase64: bufToBase64(salt) }
}

async function wrapPrivateKey(wrappingKey, privateKey) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    encoder.encode(JSON.stringify(jwk))
  )
  return `${bufToBase64(iv)}:${bufToBase64(ciphertext)}`
}

async function unwrapPrivateKey(wrappingKey, wrappedBlob) {
  const [ivB64, ciphertextB64] = wrappedBlob.split(':')
  const iv = new Uint8Array(base64ToBuf(ivB64))
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    base64ToBuf(ciphertextB64)
  )
  const jwk = JSON.parse(decoder.decode(plainBuf))
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
}

/** Called once at login/signup (the only moment the plaintext password is available — never
 * during token-based session restore). Either recovers this account's existing key from the
 * server's wrapped blob (so a new device ends up with the *same* key as every other device
 * on this account), or — if there's no wrapped blob yet (brand-new account, or an account
 * created before this sync existed) — wraps whatever key this device already has (or
 * generates one) and reports that it needs uploading. */
export async function setupOrRecoverKeyPair({
  password,
  existingPublicKeyBase64,
  existingEncryptedPrivateKey,
  existingSalt,
}) {
  if (existingEncryptedPrivateKey && existingSalt) {
    try {
      const { wrappingKey } = await deriveWrappingKey(password, existingSalt)
      const privateKey = await unwrapPrivateKey(wrappingKey, existingEncryptedPrivateKey)
      const publicKey = await crypto.subtle.importKey(
        'raw',
        base64ToBuf(existingPublicKeyBase64),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      )
      const keyPair = { privateKey, publicKey }
      await idbSet(KEY_ID, keyPair)
      cachedKeyPair = keyPair
      return { needsUpload: false }
    } catch (err) {
      // Unwrapping with the current password failed — in practice this means the password
      // was reset since this blob was wrapped (without a working recovery code to preserve
      // it; see below), not corruption. The old wrapped key is now permanently unrecoverable
      // — same "no key, no data" guarantee E2EE always has — so falling through to mint/reuse
      // a keypair below is what turns that into "messages work again going forward" instead
      // of leaving this account's encryption silently and permanently stuck.
      console.warn('Could not recover the existing E2EE key with the current password — issuing a new one', err)
    }
  }

  const keyPair = await getOrCreateKeyPair()
  const publicKeyBase64 = await getPublicKeyBase64()
  const { wrappingKey, saltBase64 } = await deriveWrappingKey(password, null)
  const encryptedPrivateKey = await wrapPrivateKey(wrappingKey, keyPair.privateKey)
  return { needsUpload: true, publicKeyBase64, encryptedPrivateKey, salt: saltBase64 }
}

const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L — easy to misread

/** A high-entropy, human-copyable recovery code (~100 bits) — an independent secret that can
 * unwrap the same private key the login password does, so a password reset (which by
 * definition happens without the old password) can still recover it. Shown to the user exactly
 * once; this module never stores or transmits the plaintext code anywhere, only what it wraps. */
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  const raw = Array.from(bytes, (b) => RECOVERY_CODE_ALPHABET[b % RECOVERY_CODE_ALPHABET.length]).join('')
  return raw.match(/.{1,5}/g).join('-')
}

/** Wraps this device's private key with an arbitrary secret. PBKDF2 doesn't care whether that
 * secret is a login password or a recovery code, so this is the one wrapping implementation
 * both paths share — reused here instead of duplicated for the recovery-code case. */
export async function wrapPrivateKeyWithSecret(secret, privateKey) {
  const { wrappingKey, saltBase64 } = await deriveWrappingKey(secret, null)
  const encryptedBlob = await wrapPrivateKey(wrappingKey, privateKey)
  return { encryptedBlob, saltBase64 }
}

/** Attempts recovery-code-based unwrapping. Never throws — a wrong or missing code has to be a
 * normal, handled outcome ("that code didn't work"), not an unexpected error — returns the
 * recovered keypair or null. */
export async function recoverKeyPairWithRecoveryCode(recoveryCode, recoverySalt, encryptedPrivateKeyRecovery, publicKeyBase64) {
  if (!recoveryCode || !recoverySalt || !encryptedPrivateKeyRecovery || !publicKeyBase64) return null
  try {
    const { wrappingKey } = await deriveWrappingKey(recoveryCode, recoverySalt)
    const privateKey = await unwrapPrivateKey(wrappingKey, encryptedPrivateKeyRecovery)
    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBuf(publicKeyBase64),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    )
    return { privateKey, publicKey }
  } catch (err) {
    console.warn('Recovery code did not unwrap the stored key', err)
    return null
  }
}
