import { useEffect, useRef } from 'react'

/** Cloudflare Turnstile (bot check). The site key is public; the secret lives only in Supabase. */
export const TURNSTILE_SITE_KEY =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || '0x4AAAAAAGGs-7bzCQWIFcOF'

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id?: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let loader: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (!loader) {
    loader = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => {
        loader = null
        reject(new Error('captcha_load'))
      }
      document.head.appendChild(s)
    })
  }
  return loader
}

/** Shows the check and reports its token (null when expired or failed). Bump resetKey after each use: a token works once. */
export function Turnstile({ action, onToken, resetKey = 0, lang, quiet = false, onInteractive, onError }: {
  action: 'upload' | 'login' | 'signup' | 'reset'
  onToken: (token: string | null) => void
  resetKey?: number
  lang?: string
  /** Hidden unless Cloudflare needs the person to tick the box (most people never see it). */
  quiet?: boolean
  /** Cloudflare wants the person to tick the box (true) or is done with it (false). */
  onInteractive?: (on: boolean) => void
  /** The check could not load or failed (network, blocked script, Cloudflare error). */
  onError?: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const id = useRef<string | null>(null)
  const cb = useRef(onToken)
  cb.current = onToken
  const inter = useRef(onInteractive)
  inter.current = onInteractive
  const err = useRef(onError)
  err.current = onError

  useEffect(() => {
    let dead = false
    loadScript()
      .then(() => {
        if (dead || !box.current || !window.turnstile) return
        id.current = window.turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: 'auto',
          size: 'flexible',
          ...(quiet ? { appearance: 'interaction-only' } : {}),
          language: lang === 'hi' ? 'hi' : 'auto',
          callback: (tok: string) => cb.current(tok),
          'expired-callback': () => cb.current(null),
          'error-callback': () => { cb.current(null); err.current?.() },
          'before-interactive-callback': () => inter.current?.(true),
          'after-interactive-callback': () => inter.current?.(false)
        })
      })
      .catch(() => { cb.current(null); err.current?.() })
    return () => {
      dead = true
      if (id.current && window.turnstile) window.turnstile.remove(id.current)
      id.current = null
    }
  }, [lang, action, quiet])

  useEffect(() => {
    if (!resetKey || !id.current || !window.turnstile) return
    cb.current(null)
    window.turnstile.reset(id.current)
  }, [resetKey])

  return <div ref={box} className={quiet ? 'turnstile-box quiet' : 'turnstile-box'} />
}

/** True when the server refused because the bot check was missing or failed. */
export function isCaptchaError(e: unknown): boolean {
  const o = (e || {}) as { message?: unknown; code?: unknown }
  const m = typeof o.message === 'string' ? o.message.toLowerCase() : String(e).toLowerCase()
  return m.includes('captcha') || o.code === '42501'
}
