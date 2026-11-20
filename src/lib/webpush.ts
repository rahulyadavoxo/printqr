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

export async function setupWebPush() {
  if (!webPushSupported()) return
  try {
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    if (perm !== 'granted') return
    const base = import.meta.env.BASE_URL || '/'
    const reg = await navigator.serviceWorker.register(base + 'firebase-messaging-sw.js', {
      scope: base + 'firebase-cloud-messaging-push-scope'
    })
    const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging')
    ])
    if (!(await isSupported())) return
    const app = getApps()[0] || initializeApp(CONFIG)
    const token = await getToken(getMessaging(app), { vapidKey: VAPID, serviceWorkerRegistration: reg })
    if (!token) return
    const { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: 'web' })
    if (!error) localStorage.setItem(KEY, token)
  } catch (e) {
    console.warn('web push', e)
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
