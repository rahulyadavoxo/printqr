import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_RATES, errMsg, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export default function Setup() {
  const { session, loading } = useSession()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [upi, setUpi] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (loading) return
    if (!session) {
      nav('/login', { replace: true })
      return
    }
    supabase.from('shops').select('id').eq('owner_id', session.user.id).maybeSingle().then(({ data }) => {
      if (data) nav('/dashboard', { replace: true })
    })
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
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page narrow">
      <div className="logo">PrintQR</div>
      <form className="card" onSubmit={submit}>
        <h2>Apni shop ki details</h2>
        <label>
          Shop ka naam *
          <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sharma Cyber Cafe" />
        </label>
        <label>
          Address
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Boring Road, Patna" />
        </label>
        <label>
          Phone (poster pe dikhega, optional)
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </label>
        <label>
          UPI ID (customer seedha pay kar sake, optional)
          <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="shopname@okaxis" />
        </label>
        {msg && <p className="notice error">{msg}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Ban raha hai...' : 'Shop banao'}</button>
      </form>
    </div>
  )
}
