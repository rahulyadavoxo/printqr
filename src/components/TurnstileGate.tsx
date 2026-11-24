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
export function TurnstileGate({ action, onToken, resetKey = 0, lang, children }: {
  action: 'upload' | 'login' | 'signup' | 'reset'
  onToken: (token: string | null) => void
  resetKey?: number
  lang?: string
  children: ReactNode
}) {
  const { t } = useI18n()
  const [passed, setPassed] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const page = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const open = !passed || interactive || failed

  // The page behind can't be focused, clicked or read by screen readers while the check is up; no scrolling behind it.
  useEffect(() => {
    const el = page.current
    if (!el) return
    if (open) {
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
  }, [open])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function handleToken(tok: string | null) {
    onToken(tok)
    if (!tok) return
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
      <div className={`tg-overlay${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="tg-title" aria-hidden={!open}>
        <div className="tg-card">
          <div className="tg-icon" aria-hidden="true"><Icon name="lock" size={26} /></div>
          <h2 id="tg-title" className="tg-title">{t('gateTitle')}</h2>
          <p className="tg-sub">{failed ? t('gateFail') : t('gateSub')}</p>
          <Turnstile key={attempt} action={action} onToken={handleToken} resetKey={resetKey} lang={lang}
            onInteractive={setInteractive} onError={() => { if (!passed) setFailed(true) }} />
          {failed && <button type="button" className="btn primary block" onClick={retry}>{t('gateRetry')}</button>}
        </div>
      </div>
    </>
  )
}
