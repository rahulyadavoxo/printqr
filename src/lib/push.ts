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

// ---------------- Customer "order ready" alert inside the Android app (v18) ----------------
const APP_READY_KEY = 'pq-ready-app'

/** Android app with the push bridge (app 1.5.21+). */
export function appPushSupported(): boolean {
  const b = nativeBridge()
  return !!b?.pushToken && !!b.askNotify
}

/** Notifications allowed for the app (Android 13+ asks; older phones allow unless turned off). */
export function appNotifyAllowed(): boolean {
  try {
    const b = nativeBridge()
    return !b?.notifyAllowed || b.notifyAllowed()
  } catch {
    return false
  }
}

/** True once this phone said yes to a "ready" alert, so later orders register quietly. */
export function appReadyOptedIn(): boolean {
  try { return localStorage.getItem(APP_READY_KEY) === '1' } catch { return false }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The app's Firebase token: the saved one, or the one that arrives through window.__pqPush. */
async function appToken(waitMs: number): Promise<string> {
  const b = nativeBridge()
  if (!b?.pushToken) return ''
  const w = window as unknown as { __pqPush?: (t: string) => void }
  const prev = w.__pqPush
  let got = ''
  // Keep the owner's own registration (setupPush) working while we listen.
  w.__pqPush = (t: string) => { got = t || got; prev?.(t) }
  try {
    got = b.pushToken() || ''
    const end = Date.now() + waitMs
    while (!got && Date.now() < end) await sleep(250)
    return got
  } catch {
    return ''
  } finally {
    if (w.__pqPush !== prev) w.__pqPush = prev
  }
}

/**
 * Native permission dialog (Android 13+). App 1.5.32+ answers through window.__pqNotify(granted);
 * older apps do not, so also poll notifyAllowed() until the time runs out.
 */
async function askAppNotify(): Promise<boolean> {
  const b = nativeBridge()
  if (!b?.askNotify) return appNotifyAllowed()
  const w = window as unknown as { __pqNotify?: (granted: boolean) => void }
  let answer: boolean | null = null
  w.__pqNotify = (g: boolean) => { answer = !!g }
  try {
    b.askNotify()
    const end = Date.now() + 60000
    while (answer === null && !appNotifyAllowed() && Date.now() < end) await sleep(300)
    return appNotifyAllowed()
  } finally {
    w.__pqNotify = undefined
  }
}

/**
 * Status page inside the app: ask for notification permission natively (when `ask`), take the FCM
 * token and register it for this order, the same way the browser's web-push token is stored.
 */
export async function appNotifyWhenReady(orderId: string, key: string, ask = true): Promise<'on' | 'denied' | 'off'> {
  const b = nativeBridge()
  if (!b?.pushToken) return 'off'
  try {
    if (!appNotifyAllowed()) {
      if (!ask) return 'off'
      if (!(await askAppNotify())) return 'denied'
    }
    const token = await appToken(ask ? 15000 : 4000)
    if (!token) return 'off'
    const { error } = await supabase.rpc('register_order_push', { p_order_id: orderId, p_key: key, p_token: token })
    if (error) return 'off'
    if (ask) { try { localStorage.setItem(APP_READY_KEY, '1') } catch { /* ignore */ } }
    return 'on'
  } catch (e) {
    console.warn('app ready push', e)
    return 'off'
  }
}
