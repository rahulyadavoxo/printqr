import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { recoverySessionReady } from '../lib/recovery'
import { useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'

export default function ResetPassword() {
  const { t, te } = useI18n()
  const nav = useNavigate()
  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'done'>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let stop = false
    void recoverySessionReady().then((ok) => {
      if (!stop) setState(ok ? 'ready' : 'invalid')
    })
    return () => {
      stop = true
    }
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    if (password !== confirm) return setMsg(t('rpMismatch'))
    setBusy(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setState('done')
      setTimeout(() => nav('/dashboard', { replace: true }), 1500)
    } catch (err) {
      setMsg(te(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <TopBar />
      <main className="auth-wrap">
        <form className="card auth-card" onSubmit={submit}>
          <div className="auth-logo"><LogoMark size={44} /></div>
          <h1 className="auth-title">{t('rpTitle')}</h1>
          {state === 'checking' && (
            <div className="skeleton-wrap skel-form" aria-busy="true">
              <span className="sr-only">{t('loading')}</span>
              <div className="skel skel-line w40" /><div className="skel skel-input" />
              <div className="skel skel-line w40" /><div className="skel skel-input" />
              <div className="skel skel-btn" />
            </div>
          )}
          {state === 'invalid' && (
            <>
              <p className="notice error">{t('rpInvalid')}</p>
              <button type="button" className="btn primary block lg" onClick={() => nav('/login?mode=forgot', { replace: true })}>
                {t('rpRequestNew')}
              </button>
            </>
          )}
          {state === 'done' && <p className="notice success">{t('rpDone')}</p>}
          {state === 'ready' && (
            <>
              <p className="muted center">{t('rpSub')}</p>
              <label className="field">
                <span>{t('rpNew')}</span>
                <input type="password" required minLength={6} value={password} autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)} />
                <small className="hint">{t('passwordHint')}</small>
              </label>
              <label className="field">
                <span>{t('rpConfirm')}</span>
                <input type="password" required minLength={6} value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} />
              </label>
              {msg && <p className="notice error">{msg}</p>}
              <button className="btn primary block lg" disabled={busy}>{busy ? t('pleaseWait') : t('rpSave')}</button>
            </>
          )}
        </form>
      </main>
    </div>
  )
}
