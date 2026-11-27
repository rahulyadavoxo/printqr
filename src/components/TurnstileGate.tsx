import { ReactNode, useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { Turnstile } from './Turnstile'
import { useI18n } from '../lib/i18n'

/**
 * Full-screen Cloudflare Turnstile check on top of a page (the page stays behind it, blurred and dimmed).
 * Opens when the page opens; closes a moment after the first token. The widget stays mounted after that,
 * so a reset (after a token was used) renews the token quietly; the check comes back on screen only when
 * Cloudflare wants the box ticked again, or the first check failed (then: Try again).
 */
/** When this tab last got a token: the full-screen check is not shown again on every page change (QA #3). */
let lastPass = 0
const RECENT_MS = 30 * 60 * 1000

export function TurnstileGate({ action, onToken, resetKey = 0, lang, children }: {
  action: 'upload' | 'login' | 'signup' | 'reset'
  onToken: (token: string | null) => void
  resetKey?: number
  lang?: string
  children: ReactNode
}) {
  const { t } = useI18n()
  // Passed a moment ago in this tab (login -> signup -> forgot, or back from another page): start with the page
  // shown; the check runs quietly and comes up only if Cloudflare wants a tick or no token arrives soon.
  const [passed, setPassed] = useState(() => Date.now() - lastPass < RECENT_MS)
  const gotToken = useRef(false)
  const [interactive, setInteractive] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const page = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const open = !passed || interactive || failed
  // After the first pass a new tick (after a resend, a used token) is a small card at the bottom: the code
  // card and the page stay visible and usable instead of being covered and blurred (QA #3).
  const again = passed && open
  useEffect(() => {
    if (!passed) return
    const id = window.setTimeout(() => { if (!gotToken.current) setPassed(false) }, 4000)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The page behind can't be focused, clicked or read by screen readers while the check is up; no scrolling behind it.
  useEffect(() => {
    const el = page.current
    if (!el) return
    if (open && !again) {
      el.setAttribute('inert', '')
      el.setAttribute('aria-hidden', 'true')
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        el.removeAttribute('inert')
        el.removeAttribute('aria-hidden')
        document.body.style.overflow = prev
      }
    }
  }, [open, again])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function handleToken(tok: string | null) {
    onToken(tok)
    if (!tok) return
    gotToken.current = true
    lastPass = Date.now()
    setFailed(false)
    setInteractive(false)
    // Let the tick show for a moment, then reveal the page.
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPassed(true), 600)
  }

  function retry() {
    setFailed(false)
    setAttempt((n) => n + 1)
  }

  return (
    <>
      <div ref={page} className="tg-page">{children}</div>
      <div className={`tg-overlay${open ? ' open' : ''}${again ? ' again' : ''}`} role="dialog" aria-modal={again ? undefined : true} aria-labelledby="tg-title" aria-hidden={!open}>
        <div className="tg-card">
          <div className="tg-icon" aria-hidden="true"><Icon name="lock" size={26} /></div>
          <h2 id="tg-title" className="tg-title">{t('gateTitle')}</h2>
          <p className="tg-sub">{failed ? t('gateFail') : t('gateSub')}</p>
          <Turnstile key={attempt} action={action} onToken={handleToken} resetKey={resetKey} lang={lang}
            onInteractive={setInteractive} onError={() => { if (!gotToken.current) setFailed(true) }} />
          {failed && <button type="button" className="btn primary block" onClick={retry}>{t('gateRetry')}</button>}
        </div>
      </div>
    </>
  )
}
