import { nativeBridge } from './app'
import { supabase } from './supabase'
import { removeWebPush, setupWebPush } from './webpush'

/** Android app: register this phone for new-order push notifications (Firebase). Safe to call often. */
export function setupPush() {
  const b = nativeBridge()
  if (!b?.pushToken) {
    // Browser (not the Windows app, which keeps itself alive in the tray instead)
    if (!(window as unknown as { PQDesktop?: unknown }).PQDesktop) void setupWebPush()
    return
  }
  const register = (token: string) => {
    if (!token) return
    try { localStorage.setItem('pq-push-token', token) } catch { /* ignore */ }
    void supabase.rpc('register_push_token', { p_token: token, p_platform: 'android' }).then(({ error }) => {
      try { localStorage.setItem('pq-push-state', error ? 'save: ' + (error.message || error.code || 'error').slice(0, 80) : 'ok') } catch { /* ignore */ }
    })
  }
  ;(window as unknown as { __pqPush?: (t: string) => void }).__pqPush = register
  try {
    register(b.pushToken())
    b.askNotify?.()
  } catch {
    /* old app without push */
  }
}

/** Before sign out: stop sending this account's orders to this phone. */
export async function removePush() {
  await removeWebPush()
  let token = ''
  try { token = localStorage.getItem('pq-push-token') || '' } catch { /* ignore */ }
  if (!token) return
  try {
    await supabase.rpc('unregister_push_token', { p_token: token })
    localStorage.removeItem('pq-push-token')
  } catch {
    /* ignore */
  }
}

/** One-line push state for Settings (app only): ok, or what is stuck. */
export function pushStatus(): string {
  const b = nativeBridge()
  if (!b?.pushToken) return ''
  try {
    if (b.notifyAllowed && !b.notifyAllowed()) return 'notifications blocked'
    const err = b.pushError?.() || ''
    if (err) return err
    const st = localStorage.getItem('pq-push-state') || ''
    if (st) return st
    return localStorage.getItem('pq-push-token') ? 'saving' : 'waiting for token'
  } catch {
    return ''
  }
}
