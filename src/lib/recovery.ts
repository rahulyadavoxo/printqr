import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL, supabase } from './supabase'

/*
 * Password reset with HashRouter.
 *
 * The reset email is requested with a separate "implicit" client, so the link works even when it is
 * opened in another browser than the one that asked for it (PKCE links only work in the same browser).
 * Supabase then redirects to the site root with the tokens in the URL hash:
 *   https://site/#access_token=...&refresh_token=...&type=recovery
 * HashRouter would read that as a route, so captureAuthHash() runs in main.tsx BEFORE the router
 * renders: it takes the tokens, rewrites the hash to #/reset and starts the session.
 * A PKCE-style link (?code=...) is still handled by the main client, which fires PASSWORD_RECOVERY;
 * App listens for that event and opens /reset.
 */

type Tokens = { access_token: string; refresh_token: string }

let sessionPromise: Promise<boolean> | null = null
let urlError: string | null = null
let recoveryClient: SupabaseClient | null = null

function setHash(route: string) {
  window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + route)
}

export function captureAuthHash(): void {
  const h = window.location.hash
  if (!h || h.length < 2 || h.startsWith('#/')) return
  let p: URLSearchParams
  try {
    p = new URLSearchParams(h.slice(1))
  } catch {
    return
  }
  const access_token = p.get('access_token')
  const refresh_token = p.get('refresh_token')
  if (access_token && refresh_token) {
    const tokens: Tokens = { access_token, refresh_token }
    const recovery = p.get('type') === 'recovery'
    setHash(recovery ? '/reset' : '/dashboard')
    sessionPromise = supabase.auth
      .setSession(tokens)
      .then(({ error }) => !error)
      .catch(() => false)
    return
  }
  const err = p.get('error_description') || p.get('error')
  if (err) {
    urlError = err.replace(/\+/g, ' ')
    setHash('/login')
  }
}

/** Error Supabase put in the URL (for example an expired link). */
export function peekAuthUrlError(): string | null {
  return urlError
}

export function clearAuthUrlError(): void {
  urlError = null
}

/** Resolves true when there is a session that may set a new password. */
export async function recoverySessionReady(): Promise<boolean> {
  if (sessionPromise) return sessionPromise
  const { data } = await supabase.auth.getSession()
  return Boolean(data.session)
}

export async function sendResetEmail(email: string) {
  if (!recoveryClient) {
    recoveryClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        flowType: 'implicit',
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: 'printqr-recovery'
      }
    })
  }
  return recoveryClient.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.origin + import.meta.env.BASE_URL
  })
}
