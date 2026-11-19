import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_RATES, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export default function Setup() {
  const { session, loading } = useSession()
  const { t, te } = useI18n()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [upi, setUpi] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (loading) return
    if (!session) {
      nav('/login', { replace: true })
      return
    }
    supabase.from('shops').select('id').eq('owner_id', session.user.id).maybeSingle().then(({ data, error }) => {
      // On a network/server error we don't know if a shop exists: let the dashboard show its retry screen.
      if (data || error) nav('/dashboard', { replace: true })
      else setChecking(false)
    }, () => nav('/dashboard', { replace: true }))
  }, [session, loading, nav])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    setBusy(true)
    setMsg(null)
    try {
      let base = slugify(name)
      if (base.length < 3) base = 'shop'
      let slug = base
      for (let i = 0; i < 5; i++) {
        const { data: ok, error } = await supabase.rpc('slug_available', { p_slug: slug })
        if (error) throw error
        if (ok) break
        slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
      }
      const { error } = await supabase.from('shops').insert({
        owner_id: session.user.id,
        name: name.trim(),
        slug,
        address: address.trim() || null,
        phone: phone.trim() || null,
        upi_id: upi.trim() || null,
        rates: DEFAULT_RATES
      })
      if (error) throw error
      nav('/dashboard?tab=rates', { replace: true })
    } catch (e) {
      setMsg(te(e))
    } finally {
      setBusy(false)
    }
  }

  if (checking) {
    return (
      <div className="auth-page">
        <TopBar to={null} />
        <main className="auth-wrap">
          <div className="card auth-card skeleton-wrap skel-form" aria-busy="true">
            <span className="sr-only">{t('loading')}</span>
            <div className="skel skel-avatar" />
            <div className="skel skel-line w60 skel-title" />
            <div className="skel skel-line w40" /><div className="skel skel-input" />
            <div className="skel skel-line w40" /><div className="skel skel-input" />
            <div className="skel skel-line w40" /><div className="skel skel-input" />
            <div className="skel skel-btn" />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <TopBar to={null} />
      <main className="auth-wrap">
        <form className="card auth-card" onSubmit={submit}>
          <div className="auth-logo"><LogoMark size={44} /></div>
          <p className="step-chip">{t('setupStep')}</p>
          <h1 className="auth-title">{t('setupTitle')}</h1>
          <p className="muted center">{t('setupSub')}</p>
          <label className="field">
            <span>{t('shopName')} <b className="req">*</b></span>
            <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sharma Cyber Cafe" />
          </label>
          <label className="field">
            <span>{t('address')}</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Boring Road, Patna" />
          </label>
          <label className="field">
            <span>{t('phone')} <em className="opt">({t('optional')})</em></span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="98xxxxxx10" />
            <small className="hint">{t('phoneHint')}</small>
          </label>
          <label className="field">
            <span>{t('upiId')} <em className="opt">({t('optional')})</em></span>
            <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="shopname@okaxis" />
            <small className="hint">{t('upiHint')}</small>
          </label>
          {msg && <p className="notice error" role="alert">{msg}</p>}
          <button className="btn primary block lg" disabled={busy}>{busy ? t('creating') : t('createShop')}</button>
        </form>
      </main>
    </div>
  )
}
