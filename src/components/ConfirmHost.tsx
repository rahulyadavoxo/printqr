import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'

// App-style confirm popup instead of the browser's raw confirm() box
// (which shows "The page at https://appassets... says:" in the Android app).
// Usage: if (!(await ask(t('logoutAsk')))) return
type Opts = { ok?: string; danger?: boolean; icon?: string }
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
        <span className={'cf-icon' + (danger ? ' is-danger' : '')} aria-hidden="true"><Icon name={req.opts.icon || (danger ? 'alert' : 'info')} size={22} /></span>
        <p id="cf-msg" className="cf-msg">{req.msg}</p>
        <div className="cf-row">
          <button type="button" className="btn" onClick={() => close(false)}>{t('cancel')}</button>
          <button type="button" ref={okRef} className={'btn ' + (danger ? 'danger' : 'primary')} onClick={() => close(true)}>{req.opts.ok || t('cfYes')}</button>
        </div>
      </div>
    </div>
  )
}
