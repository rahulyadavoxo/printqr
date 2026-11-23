/**
 * Shop PC app lock: a 4-8 digit PIN kept only on this device (salted SHA-256 in localStorage, per user)
 * and an idle timeout (5 / 10 / 30 minutes or off). Locking only covers the screen: the dashboard stays
 * mounted underneath, so new orders, sounds, notifications and auto-print keep working.
 * This is a counter-side privacy lock, not account security: anyone who can clear site data can remove it
 * (then they still need the account password to get back in).
 */

export type IdleMins = 0 | 5 | 10 | 30
export const IDLE_CHOICES: IdleMins[] = [5, 10, 30, 0]

type Saved = { salt: string; hash: string; idle: IdleMins }

const key = (uid: string) => 'pq_lock_' + uid
const lockedKey = (uid: string) => 'pq_locked_' + uid

export const PIN_RE = /^\d{4,8}$/

function read(uid: string): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(uid)) || 'null') as Saved | null
    return v && typeof v.salt === 'string' && typeof v.hash === 'string' ? v : null
  } catch {
    return null
  }
}

function hex(buf: ArrayBuffer | Uint8Array) {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function digest(salt: string, pin: string) {
  const data = new TextEncoder().encode(salt + ':' + pin)
  return hex(await crypto.subtle.digest('SHA-256', data))
}

export function hasPin(uid: string) {
  return !!read(uid)
}

export function idleMins(uid: string): IdleMins {
  const v = read(uid)?.idle
  return v === 5 || v === 10 || v === 30 ? v : 0
}

export async function setPin(uid: string, pin: string, idle?: IdleMins) {
  if (!PIN_RE.test(pin)) throw new Error('bad pin')
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)))
  const hash = await digest(salt, pin)
  const prev = read(uid)
  localStorage.setItem(key(uid), JSON.stringify({ salt, hash, idle: idle ?? prev?.idle ?? 10 } satisfies Saved))
  notify()
}

export function setIdle(uid: string, idle: IdleMins) {
  const v = read(uid)
  if (!v) return
  localStorage.setItem(key(uid), JSON.stringify({ ...v, idle }))
  notify()
}

export async function checkPin(uid: string, pin: string) {
  const v = read(uid)
  if (!v) return true
  return (await digest(v.salt, pin)) === v.hash
}

export function removePin(uid: string) {
  try {
    localStorage.removeItem(key(uid))
    localStorage.removeItem(lockedKey(uid))
  } catch { /* ignore */ }
  notify()
}

/** Locked state survives a reload (so a refresh does not unlock the screen). */
export function wasLocked(uid: string) {
  try { return localStorage.getItem(lockedKey(uid)) === '1' && hasPin(uid) } catch { return false }
}
export function saveLocked(uid: string, on: boolean) {
  try {
    if (on) localStorage.setItem(lockedKey(uid), '1')
    else localStorage.removeItem(lockedKey(uid))
  } catch { /* ignore */ }
}

// Settings changes tell the dashboard (same tab) to re-read the PIN / idle setting.
const EVT = 'pq-lock-change'
function notify() {
  try { window.dispatchEvent(new Event(EVT)) } catch { /* ignore */ }
}
export function onLockChange(fn: () => void) {
  window.addEventListener(EVT, fn)
  window.addEventListener('storage', fn)
  return () => {
    window.removeEventListener(EVT, fn)
    window.removeEventListener('storage', fn)
  }
}

/** Short device name from a user agent, e.g. "Chrome on Windows", "PrintQR app on Android". */
export function deviceName(ua: string) {
  const s = ua || ''
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iPod/i.test(s) ? 'iOS' : /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'Mac' : /Linux/i.test(s) ? 'Linux' : ''
  const app = /PrintQR/i.test(s) ? 'PrintQR app' : /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : ''
  if (app && os) return app + ' · ' + os
  return app || os || ''
}
