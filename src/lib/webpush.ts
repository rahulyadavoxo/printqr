/** Web push (browser on Windows / Android): new-order notifications even when the dashboard tab is closed. */
import { supabase } from './supabase'

const CONFIG = {
  apiKey: 'AIzaSyAoTgYQQqNJiakK9lPfoslOD1L2zxiRssY',
  authDomain: 'printqr-56a1b.firebaseapp.com',
  projectId: 'printqr-56a1b',
  storageBucket: 'printqr-56a1b.firebasestorage.app',
  messagingSenderId: '1036667270970',
  appId: '1:1036667270970:web:56783755a2c972607d0203'
}
const VAPID = 'BLOqu_eU_r-7mk-cTOM410h6N9GgZJSBGIzbI1TOwFFvqMeecTpDW3duopW3_3OrNkm7M1TpMyowQ48GuYSgsfU'
const KEY = 'pq-webpush-token'

export function webPushSupported() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** FCM web push token for this browser; asks for permission when `ask` (needs a tap first on most browsers). */
export async function webPushToken(ask = true): Promise<string | null> {
  if (!webPushSupported()) return null
  let perm = Notification.permission
  if (perm === 'default' && ask) perm = await Notification.requestPermission()
  if (perm !== 'granted') return null
  const base = import.meta.env.BASE_URL || '/'
  const reg = await navigator.serviceWorker.register(base + 'firebase-messaging-sw.js', {
    scope: base + 'firebase-cloud-messaging-push-scope'
  })
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging')
  ])
  if (!(await isSupported())) return null
  const app = getApps()[0] || initializeApp(CONFIG)
  const token = await getToken(getMessaging(app), { vapidKey: VAPID, serviceWorkerRegistration: reg })
  return token || null
}

export async function setupWebPush() {
  try {
    const token = await webPushToken(true)
    if (!token) return
    const { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: 'web' })
    if (!error) localStorage.setItem(KEY, token)
  } catch (e) {
    console.warn('web push', e)
  }
}

/** Customer status page (v17): tell this browser when the order is ready. */
export async function notifyWhenReady(orderId: string, key: string, ask = true): Promise<boolean> {
  try {
    const token = await webPushToken(ask)
    if (!token) return false
    const { error } = await supabase.rpc('register_order_push', { p_order_id: orderId, p_key: key, p_token: token })
    return !error
  } catch (e) {
    console.warn('ready push', e)
    return false
  }
}

export async function removeWebPush() {
  let token = ''
  try { token = localStorage.getItem(KEY) || '' } catch { /* ignore */ }
  if (!token) return
  try {
    await supabase.rpc('unregister_push_token', { p_token: token })
    localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}
