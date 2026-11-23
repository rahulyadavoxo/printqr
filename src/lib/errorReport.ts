// v38: the website / Android app / Windows app report crashes and failed server calls to the Admin bell
// (public.report_client_error -> ops_events, turned into an alert by the 15-minute health check).
// Never throws, never sends personal data (the server masks emails / tokens and cuts to 300 characters).
import { serverErrorHook, supabase } from './supabase'
import { currentLoginPlatform } from './appSettings'

const MAX_PER_PAGE = 8
const sent = new Set<string>()
// Noise that is not a PrintQR problem: browser extensions, cross-origin scripts, user cancels, offline phones.
const IGNORE = [
  /ResizeObserver loop/i, /^Script error\.?$/i, /Cancelled by user|\[16\]|user (cancel|closed|denied)/i,
  /Failed to fetch|NetworkError|Load failed|network request failed|offline|ERR_INTERNET|AbortError|aborted/i,
  /extension:\/\/|chrome-extension|moz-extension|safari-extension/i, /Non-Error promise rejection captured/i,
]

function platform(): 'web' | 'app' | 'desktop' {
  try { const p = currentLoginPlatform(); return p === 'app' ? 'app' : p === 'desktop' ? 'desktop' : 'web' } catch { return 'web' }
}

export function reportError(err: unknown, where?: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const e = err as { message?: unknown; code?: unknown } | null
    const msg = String((e && typeof e === 'object' && e.message) || err || '').trim()
    if (!msg || IGNORE.some((r) => r.test(msg))) return
    const code = e && typeof e === 'object' && e.code ? ` [${String(e.code)}]` : ''
    const text = (msg + code).slice(0, 240)
    const place = (where || location.pathname + location.hash).slice(0, 80)
    const k = text + '|' + place
    if (sent.has(k) || sent.size >= MAX_PER_PAGE) return
    sent.add(k)
    void supabase.rpc('report_client_error', { p_source: platform(), p_message: text, p_where: place }).then(() => undefined, () => undefined)
  } catch { /* never break the page */ }
}

export function startErrorReports(): void {
  serverErrorHook.fn = (msg, where) => reportError(msg, where)
  window.addEventListener('error', (ev) => {
    // ignore failed <img>/<script> loads from other sites and errors without our own file
    if (!ev.message) return
    const file = ev.filename || ''
    if (file && !file.startsWith(location.origin) && !file.includes('appassets.androidplatform.net')) return
    reportError(ev.error || ev.message, file ? `${file.split('/').pop()}:${ev.lineno}` : undefined)
  })
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'promise'))
}
