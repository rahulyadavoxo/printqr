import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'

// App-style confirm popup instead of the browser's raw confirm() box
// (which shows "The page at https://appassets... says:" in the Android app).
// Usage: if (!(await ask(t('logoutAsk')))) return
/** body: smaller grey text under the title; cancel: label of the left button; icon 'trash' = animated bin. */
type Opts = { ok?: string; cancel?: string; body?: string; danger?: boolean; icon?: string }
type Req = { msg: string; opts: Opts; done: (v: boolean) => void }

let push: ((r: Req) => void) | null = null

export function ask(msg: string, opts: Opts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.confirm(msg))
    push({ msg, opts, done: resolve })
  })
}

export default function ConfirmHost() {
  const { t } = useI18n()
  const [req, setReq] = useState<Req | null>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    push = (r) => setReq((old) => { old?.done(false); return r })
    return () => { push = null }
  }, [])
  useEffect(() => {
    if (!req) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req]) // eslint-disable-line react-hooks/exhaustive-deps
  function close(v: boolean) {
    if (!req) return
    req.done(v)
    setReq(null)
  }
  if (!req) return null
  const danger = req.opts.danger !== false
  return (
    <div className="cf-back" onClick={() => close(false)}>
      <div className="cf-box" role="alertdialog" aria-modal="true" aria-labelledby="cf-msg" onClick={(e) => e.stopPropagation()}>
        <div className="cf-head">
          <span className={'cf-icon' + (danger ? ' is-danger' : '')} aria-hidden="true">
            {req.opts.icon === 'trash' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <g className="cf-lid"><path d="M4 7h16" /><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /></g>
                <path d="M6 7l.9 12a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 7" /><path d="M10 11v5" /><path d="M14 11v5" />
              </svg>
            ) : <Icon name={req.opts.icon || (danger ? 'alert' : 'info')} size={22} />}
          </span>
          <p id="cf-msg" className="cf-msg">{req.msg}</p>
        </div>
        {req.opts.body && <p className="cf-body">{req.opts.body}</p>}
        <div className="cf-row">
          <button type="button" className="btn" onClick={() => close(false)}>{req.opts.cancel || t('cancel')}</button>
          <button type="button" ref={okRef} className={'btn ' + (danger ? 'danger' : 'primary')} onClick={() => close(true)}>{req.opts.ok || t('cfYes')}</button>
        </div>
      </div>
    </div>
  )
}
