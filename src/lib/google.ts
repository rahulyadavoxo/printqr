import { supabase } from './supabase'
import { IN_APP, nativeBridge } from './app'

/** Web OAuth client (Google Cloud project printqr-56a1b). Public value; the secret lives only in Supabase. */
export const GOOGLE_CLIENT_ID = '1036667270970-5l0orujb4t6a8hst7h5jjaerpo4ka96r.apps.googleusercontent.com'

/** Google login is possible here: any browser, or the Android app 1.5.74+ (native Google sheet; WebView blocks Google's page). */
export function googleAvailable(): boolean {
  return !IN_APP || Boolean(nativeBridge()?.googleSignIn)
}

function randomNonce(): string {
  const a = new Uint8Array(24)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Android app: show Google's account sheet, get an ID token, sign in to Supabase with it. 'cancel' when the user closed the sheet. */
function nativeIdToken(nonceHash: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const W = window as unknown as { __pqGoogle?: (token: string, err: string) => void }
    W.__pqGoogle = (token, err) => {
      delete W.__pqGoogle
      if (token) resolve(token)
      // Sheet closed / back pressed: Android reports it in several ways ("[16] Cancelled by user",
      // GetCredentialCancellationException, "canceled"). Treat all as a quiet cancel, not an error.
      else reject(new Error(/cancel|\[16\]|user.?(closed|dismiss)/i.test(err || '') ? 'cancel' : (err || 'google')))
    }
    try { nativeBridge()!.googleSignIn!(GOOGLE_CLIENT_ID, nonceHash) } catch (e) { delete W.__pqGoogle; reject(e) }
  })
}

/**
 * Sign in (or sign up) with Google.
 * Web: redirects to Google and back to redirectTo (Supabase finishes the login there).
 * App: resolves once signed in.
 */
export async function signInWithGoogle(redirectTo: string, captchaToken?: string | null): Promise<'redirect' | 'done'> {
  if (IN_APP) {
    const raw = randomNonce()
    const token = await nativeIdToken(await sha256Hex(raw))
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token, nonce: raw, options: { captchaToken: captchaToken || undefined } })
    if (error) throw error
    return 'done'
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, queryParams: { prompt: 'select_account' } } })
  if (error) throw error
  return 'redirect'
}
