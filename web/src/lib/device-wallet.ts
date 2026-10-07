/*
 * Keeps a browser wallet's recovery phrase on this device, encrypted with a
 * password the user chooses (PBKDF2-SHA-256 and AES-GCM, Web Crypto). Tally
 * never receives the phrase or the password. Clearing site data removes it:
 * the written recovery phrase is the only backup.
 */

const STORE_KEY = 'tally-browser-wallet'
const ITERATIONS = 310_000

export interface DeviceWallet {
  address: string
  rewardAddress: string
  salt: string
  iv: string
  ciphertext: string
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

async function aesKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
}

export function deviceWallet(): DeviceWallet | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as DeviceWallet | null
    return saved && typeof saved.ciphertext === 'string' ? saved : null
  } catch {
    return null
  }
}

/** Saves the phrase encrypted. Returns false when this browser has no storage. */
export async function saveDeviceWallet(phrase: string, password: string, addresses: {address: string; rewardAddress: string}): Promise<boolean> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(password, salt), new TextEncoder().encode(phrase)))
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({...addresses, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext)}))
    return true
  } catch {
    return false
  }
}

/** The phrase, or null for a wrong password. */
export async function unlockDeviceWallet(password: string): Promise<string | null> {
  const saved = deviceWallet()
  if (!saved) return null
  try {
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(saved.iv)}, await aesKey(password, unb64(saved.salt)), unb64(saved.ciphertext))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

export function forgetDeviceWallet() {
  try { localStorage.removeItem(STORE_KEY) } catch { /* storage unavailable */ }
}
