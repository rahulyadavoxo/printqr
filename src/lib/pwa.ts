/// <reference types="vite-plugin-pwa/client" />
// Website (PWA) updates: check for a new deploy every minute and whenever the tab comes back into view,
// then offer it with a banner (never reloads by itself, so a customer mid-upload loses nothing).
// The Android app bundles the site, so it updates through UpdateGate's native APK flow instead.
import { registerSW } from 'virtual:pwa-register'
import { IN_APP } from './app'

const CHECK_MS = 60 * 1000
let ready = false
let apply: ((reload?: boolean) => Promise<void>) | null = null
const subs = new Set<(v: boolean) => void>()

export function onWebUpdate(fn: (v: boolean) => void): () => void {
  subs.add(fn)
  fn(ready)
  return () => { subs.delete(fn) }
}
export function applyWebUpdate() {
  if (apply) void apply(true)
  else location.reload()
}

export function startPwa() {
  if (IN_APP || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true
      subs.forEach((f) => f(true))
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return
      const check = () => {
        if (navigator.onLine === false || reg.installing) return
        reg.update().catch(() => {})
      }
      setInterval(() => { if (document.visibilityState === 'visible') check() }, CHECK_MS)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
      window.addEventListener('online', check)
    }
  })
}
