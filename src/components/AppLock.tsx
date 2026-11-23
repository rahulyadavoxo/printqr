import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { ask as askConfirm } from './ConfirmHost'
import { Key, useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import {
  checkPin, deviceName, hasPin, IDLE_CHOICES, IdleMins, idleMins, onLockChange, PIN_RE, removePin, saveLocked, setIdle, setPin, wasLocked
} from '../lib/appLock'

/**
 * Dashboard lock state for this user: locked flag, lock(), unlock(), and the idle timer.
 * The dashboard stays mounted while locked (orders, sounds, notifications and auto-print keep running).
 */
export function useAppLock(uid: string | undefined) {
  const [enabled, setEnabled] = useState(() => !!uid && hasPin(uid))
  const [idle, setIdleState] = useState<IdleMins>(() => (uid ? idleMins(uid) : 0))
  const [locked, setLocked] = useState(() => !!uid && wasLocked(uid))
  useEffect(() => {
    if (!uid) return
    const sync = () => {
      setEnabled(hasPin(uid))
      setIdleState(idleMins(uid))
      if (!hasPin(uid)) setLocked(false)
    }
    sync()
    setLocked(wasLocked(uid))
    return onLockChange(sync)
  }, [uid])

  const lock = useCallback(() => {
    if (!uid || !hasPin(uid)) return false
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    saveLocked(uid, true)
    setLocked(true)
    return true
  }, [uid])
  const unlock = useCallback(() => {
    if (uid) saveLocked(uid, false)
    setLocked(false)
  }, [uid])

  // Idle timer: any touch, click, key or scroll counts as activity.
  const last = useRef(Date.now())
  useEffect(() => {
    if (!enabled || !idle || locked) return
    last.current = Date.now()
    const bump = () => { last.current = Date.now() }
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true, capture: true }))
    const timer = window.setInterval(() => {
      if (Date.now() - last.current >= idle * 60000) lock()
    }, 10000)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump, { capture: true }))
      window.clearInterval(timer)
    }
  }, [enabled, idle, locked, lock])

  return { enabled, locked, lock, unlock }
}

/** Full-screen PIN prompt over the (blurred) dashboard. */
export function LockOverlay({ uid, shopName, onUnlock }: { uid: string; shopName: string; onUnlock: () => void }) {
  const { t } = useI18n()
  const [pin, setPinText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const fails = useRef(0)
  const [waitUntil, setWaitUntil] = useState(0)
  const [, tick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    if (!waitUntil) return
    const i = window.setInterval(() => {
      tick((n) => n + 1)
      if (Date.now() >= waitUntil) { setWaitUntil(0); setErr('') }
    }, 1000)
    return () => window.clearInterval(i)
  }, [waitUntil])
  const waitSecs = waitUntil ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || waitSecs) return
    if (!pin) return
    setBusy(true)
    const ok = await checkPin(uid, pin).catch(() => false)
    setBusy(false)
    if (ok) {
      fails.current = 0
      onUnlock()
      return
    }
    fails.current += 1
    setPinText('')
    // After 5 wrong PINs: wait 30 seconds before the next try.
    if (fails.current >= 5) {
      fails.current = 0
      setWaitUntil(Date.now() + 30000)
      setErr(t('lockTooMany'))
    } else setErr(t('lockWrong'))
    input.current?.focus()
  }

  async function forgot() {
    if (!await askConfirm(t('lockForgotAsk'), { icon: 'logout', ok: t('logout') })) return
    // Local sign-out only: other devices stay logged in. The PIN of this login is removed from this device.
    removePin(uid)
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    window.location.hash = '#/login'
  }

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <form className="lock-box" onSubmit={submit}>
        <span className="lock-ic" aria-hidden="true"><Icon name="lock" size={30} /></span>
        <h2 id="lock-title">{t('lockTitle')}</h2>
        <p className="small muted">{t('lockSub', { name: shopName })}</p>
        <input ref={input} className="lock-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]*" maxLength={8}
          aria-label={t('lockPin')} placeholder="••••" value={pin} disabled={!!waitSecs}
          onChange={(e) => { setPinText(e.target.value.replace(/\D/g, '').slice(0, 8)); if (!waitSecs) setErr('') }} />
        <p className="lock-err" role="alert" aria-live="assertive">{waitSecs ? t('lockWait', { n: waitSecs }) : err}</p>
        <button className="btn primary block lg" disabled={busy || !!waitSecs || pin.length < 4}>{t('lockUnlock')}</button>
        <button type="button" className="lock-forgot" onClick={forgot}>{t('lockForgot')}</button>
      </form>
    </div>
  )
}

/** Settings card: set / change / remove the PIN and pick the idle timeout. */
export function AppLockCard({ uid }: { uid: string }) {
  const { t } = useI18n()
  const [on, setOn] = useState(() => hasPin(uid))
  const [idle, setIdleState] = useState<IdleMins>(() => idleMins(uid) || (hasPin(uid) ? 0 : 10))
  const [editing, setEditing] = useState(false)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  useEffect(() => onLockChange(() => { setOn(hasPin(uid)); if (hasPin(uid)) setIdleState(idleMins(uid)) }), [uid])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!PIN_RE.test(p1)) return setMsg({ text: t('lockPinRule'), error: true })
    if (p1 !== p2) return setMsg({ text: t('lockPinMismatch'), error: true })
    try {
      await setPin(uid, p1, idle)
    } catch {
      return setMsg({ text: t('errGeneric'), error: true })
    }
    setP1(''); setP2(''); setEditing(false)
    setMsg({ text: t('lockSaved'), error: false })
  }
  async function off() {
    if (!await askConfirm(t('lockOffAsk'), { icon: 'lock' })) return
    removePin(uid)
    setEditing(false)
    setMsg({ text: t('lockRemoved'), error: false })
  }
  function pickIdle(m: IdleMins) {
    setIdleState(m)
    if (on) { setIdle(uid, m); setMsg({ text: t('saved'), error: false }) }
  }
  const idleLabel = (m: IdleMins) => (m ? t('lockIdleMin', { n: m }) : t('lockIdleOff'))
  const showForm = !on || editing

  return (
    <div className="card form-card" id="app-lock">
      <h2 className="card-title">{t('lockCardTitle')}</h2>
      <p className="small muted">{t('lockCardSub')}</p>
      {on && <p className="notice success"><Icon name="lock" size={16} /> {t('lockIsOn')}</p>}
      <div className="field">
        <span>{t('lockIdle')}</span>
        <div className="seg" role="group" aria-label={t('lockIdle')}>
          {IDLE_CHOICES.map((m) => (
            <button key={m} type="button" className={idle === m ? 'on' : ''} aria-pressed={idle === m} onClick={() => pickIdle(m)}>{idleLabel(m)}</button>
          ))}
        </div>
      </div>
      {showForm ? (
        <form onSubmit={save} className="lock-form">
          <label className="field">
            <span>{on ? t('lockNewPin') : t('lockPin')}</span>
            <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={8} value={p1}
              onChange={(e) => setP1(e.target.value.replace(/\D/g, '').slice(0, 8))} />
            <small className="hint">{t('lockPinRule')}</small>
          </label>
          <label className="field">
            <span>{t('lockPinAgain')}</span>
            <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={8} value={p2}
              onChange={(e) => setP2(e.target.value.replace(/\D/g, '').slice(0, 8))} />
          </label>
          {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
          <div className="lock-actions">
            <button className="btn primary lg">{on ? t('lockChange') : t('lockTurnOn')}</button>
            {editing && <button type="button" className="btn lg" onClick={() => { setEditing(false); setP1(''); setP2(''); setMsg(null) }}>{t('cancel')}</button>}
          </div>
        </form>
      ) : (
        <>
          {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
          <div className="lock-actions">
            <button type="button" className="btn lg" onClick={() => { setEditing(true); setMsg(null) }}>{t('lockChange')}</button>
            <button type="button" className="btn danger lg" onClick={off}>{t('lockTurnOff')}</button>
          </div>
        </>
      )}
      <p className="small muted">{t('lockNote')}</p>
    </div>
  )
}

type Sess = { id: string; created_at: string; last_active: string; user_agent: string; ip: string | null; is_current: boolean }

function ago(iso: string, t: (k: Key, v?: Record<string, string | number>) => string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 120) return t('devNow')
  if (s < 3600) return t('devMinsAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('devHoursAgo', { n: Math.floor(s / 3600) })
  return t('devDaysAgo', { n: Math.floor(s / 86400) })
}

/** Settings card: where this login is signed in, with Log out per device and for all others. */
export function DevicesCard() {
  const { t, te } = useI18n()
  const [list, setList] = useState<Sess[] | null>(null)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_sessions')
    if (error) {
      setList([])
      setMsg({ text: te(error), error: true })
      return
    }
    setList((data || []) as Sess[])
  }, [te])
  useEffect(() => { void load() }, [load])

  async function end(s: Sess) {
    if (!await askConfirm(t('devEndAsk', { d: deviceName(s.user_agent) || t('devUnknown') }), { icon: 'logout', ok: t('logout') })) return
    setBusy(s.id)
    const { error } = await supabase.rpc('end_my_session', { p_id: s.id })
    setBusy('')
    if (error) return setMsg({ text: te(error), error: true })
    setMsg({ text: t('devEnded'), error: false })
    void load()
  }
  async function endOthers() {
    if (!await askConfirm(t('devEndAllAsk'), { icon: 'logout', ok: t('devEndAll'), danger: true })) return
    setBusy('others')
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    setBusy('')
    if (error) return setMsg({ text: te(error), error: true })
    setMsg({ text: t('devEndedAll'), error: false })
    void load()
  }
  const others = (list || []).filter((s) => !s.is_current)

  return (
    <div className="card form-card" id="devices">
      <h2 className="card-title">{t('devTitle')}</h2>
      <p className="small muted">{t('devSub')}</p>
      {list === null ? (
        <p className="small muted"><span className="spinner dark" aria-hidden="true" /> {t('pleaseWait')}</p>
      ) : (
        <ul className="dev-list">
          {list.map((s) => (
            <li key={s.id} className={`dev-row${s.is_current ? ' is-current' : ''}`}>
              <span className="dev-ic" aria-hidden="true"><Icon name={/Android|iPhone|iPad/i.test(s.user_agent) ? 'scan' : 'printer'} size={18} /></span>
              <span className="dev-txt">
                <strong>{deviceName(s.user_agent) || t('devUnknown')}{s.is_current && <span className="dev-this"> · {t('devThis')}</span>}</strong>
                <small className="muted">{t('devLast', { when: ago(s.last_active, t) })}{s.ip ? ' · ' + s.ip : ''}</small>
              </span>
              {!s.is_current && (
                <button type="button" className="btn small" disabled={!!busy} onClick={() => void end(s)}>
                  {busy === s.id ? <span className="spinner dark" aria-hidden="true" /> : t('logout')}
                </button>
              )}
            </li>
          ))}
          {!list.length && <li className="small muted">{t('devNone')}</li>}
        </ul>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      {others.length > 0 && (
        <button type="button" className="btn danger block lg" disabled={!!busy} onClick={() => void endOthers()}>
          {busy === 'others' ? <span className="spinner" aria-hidden="true" /> : <Icon name="logout" size={18} />} {t('devEndAll')}
        </button>
      )}
      <p className="small muted">{t('devNote')}</p>
    </div>
  )
}
