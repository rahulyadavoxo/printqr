import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { errMsg, supabase } from '../lib/supabase'

export default function Login() {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'signup'>(params.get('mode') === 'signup' ? 'signup' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const nav = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) nav('/dashboard', { replace: true })
    })
  }, [nav])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL }
        })
        if (error) throw error
        if (!data.session) {
          setMsg('Email pe confirm link bheja hai. Link kholo, phir yahan login karo.')
          setMode('login')
          return
        }
        nav('/setup')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        nav('/dashboard')
      }
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }


  return (
    <div className="page narrow">
      <Link to="/" className="logo">PrintQR</Link>
      <form className="card" onSubmit={submit}>
        <h2>{mode === 'signup' ? 'Shop register karo' : 'Login'}</h2>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
        </label>
        {msg && <p className="notice">{msg}</p>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Ruko...' : mode === 'signup' ? 'Account banao' : 'Login'}
        </button>
        <div className="row between small">
          <button type="button" className="link" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
            {mode === 'signup' ? 'Pehle se account hai? Login' : 'Naya account banao'}
          </button>
        </div>
      </form>
    </div>
  )
}
