/**
 * Crypto Manager — PIN-based AES-GCM encryption.
 *
 * Key lifecycle:
 *   PIN → PBKDF2 → AES-GCM CryptoKey
 *   CryptoKey exported as raw bytes → stored in chrome.storage.session
 *   chrome.storage.session is cleared when the browser closes.
 *   On restart: user re-enters PIN → key re-derived.
 *   The PBKDF2 salt (non-sensitive) is stored in chrome.storage.local.
 */

import { SESSION_KEY_STORAGE } from '../shared/constants'

const PBKDF2_ITERATIONS = 310_000
const SALT_STORAGE_KEY = 'pbkdf2_salt'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ─── Salt management ─────────────────────────────────────────────────────────

async function getSalt(): Promise<Uint8Array | null> {
  const { [SALT_STORAGE_KEY]: saltB64 } = await chrome.storage.local.get(SALT_STORAGE_KEY)
  return saltB64 ? base64ToBytes(saltB64 as string) : null
}

async function createAndStoreSalt(): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  await chrome.storage.local.set({ [SALT_STORAGE_KEY]: bytesToBase64(salt) })
  return salt
}

// ─── Key derivation ───────────────────────────────────────────────────────────

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

// ─── Session key storage ──────────────────────────────────────────────────────

async function storeKeyInSession(key: CryptoKey): Promise<void> {
  const raw = await crypto.subtle.exportKey('raw', key)
  const arr = Array.from(new Uint8Array(raw))
  await chrome.storage.session.set({ [SESSION_KEY_STORAGE]: arr })
}

export async function loadKeyFromSession(): Promise<CryptoKey> {
  const result = await chrome.storage.session.get(SESSION_KEY_STORAGE)
  const arr: number[] | undefined = result[SESSION_KEY_STORAGE]
  if (!arr || arr.length === 0) throw new Error('SESSION_LOCKED')
  const raw = new Uint8Array(arr)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function isSessionUnlocked(): Promise<boolean> {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY_STORAGE)
    const arr: number[] | undefined = result[SESSION_KEY_STORAGE]
    return !!(arr && arr.length > 0)
  } catch {
    return false
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Called once when user first sets their PIN. Generates salt, derives and stores key. */
export async function setupPin(pin: string): Promise<void> {
  const salt = await createAndStoreSalt()
  const key = await deriveKey(pin, salt)
  await storeKeyInSession(key)
  await chrome.storage.local.set({ hasPinSetup: true })
}

/** Called on subsequent browser sessions to re-derive and store the key from PIN. */
export async function unlockWithPin(pin: string): Promise<boolean> {
  const salt = await getSalt()
  if (!salt) throw new Error('No PIN setup found. Please set up your PIN first.')
  try {
    const key = await deriveKey(pin, salt)
    // Verify key is correct by trying to encrypt/decrypt a test value
    const testData = new TextEncoder().encode('test')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, testData)
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    await storeKeyInSession(key)
    return true
  } catch {
    return false
  }
}

/** Change the PIN: re-encrypt all vault entries is handled by the caller. */
export async function changePin(oldPin: string, newPin: string): Promise<boolean> {
  const verified = await unlockWithPin(oldPin)
  if (!verified) return false
  const salt = await createAndStoreSalt() // new salt
  const newKey = await deriveKey(newPin, salt)
  await storeKeyInSession(newKey)
  return true
}

/** Encrypt arbitrary plaintext string using the session AES-GCM key. */
export async function encryptData(plaintext: string): Promise<{ iv: string; ct: string }> {
  const key = await loadKeyFromSession()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(cipherBuffer)),
  }
}

/** Decrypt a blob produced by encryptData. */
export async function decryptData(blob: { iv: string; ct: string }): Promise<string> {
  const key = await loadKeyFromSession()
  const iv = base64ToBytes(blob.iv)
  const ct = base64ToBytes(blob.ct)
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource)
  return new TextDecoder().decode(plainBuffer)
}
