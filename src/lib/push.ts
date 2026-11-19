import { nativeBridge } from './app'
import { supabase } from './supabase'

/** Android app: register this phone for new-order push notifications (Firebase). Safe to call often. */
export function setupPush() {
  const b = nativeBridge()
  if (!b?.pushToken) return
  const register = (token: string) => {
    if (!token) return
    try { localStorage.setItem('pq-push-token', token) } catch { /* ignore */ }
    void supabase.rpc('register_push_token', { p_token: token, p_platform: 'android' })
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
