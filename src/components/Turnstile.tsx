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
export function Turnstile({ action, onToken, resetKey = 0, lang }: {
  action: 'upload' | 'login' | 'signup' | 'reset'
  onToken: (token: string | null) => void
  resetKey?: number
  lang?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const id = useRef<string | null>(null)
  const cb = useRef(onToken)
  cb.current = onToken

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
          language: lang === 'hi' ? 'hi' : 'auto',
          callback: (tok: string) => cb.current(tok),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null)
        })
      })
      .catch(() => cb.current(null))
    return () => {
      dead = true
      if (id.current && window.turnstile) window.turnstile.remove(id.current)
      id.current = null
    }
  }, [lang, action])

  useEffect(() => {
    if (!resetKey || !id.current || !window.turnstile) return
    cb.current(null)
    window.turnstile.reset(id.current)
  }, [resetKey])

  return <div ref={box} className="turnstile-box" />
}

/** True when the server refused because the bot check was missing or failed. */
export function isCaptchaError(e: unknown): boolean {
  const o = (e || {}) as { message?: unknown; code?: unknown }
  const m = typeof o.message === 'string' ? o.message.toLowerCase() : String(e).toLowerCase()
  return m.includes('captcha') || o.code === '42501'
}
