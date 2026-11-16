import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSession } from '../lib/useSession'

export default function Home() {
  const { session } = useSession()
  const nav = useNavigate()
  useEffect(() => {
    if (session) nav('/dashboard', { replace: true })
  }, [session, nav])
  return (
    <div className="page narrow">
      <header className="hero">
        <div className="logo">PrintQR</div>
        <h1>Scan karo, file bhejo, print lo.</h1>
        <p className="muted">
          Cyber cafe ke liye. Customer ko aapka WhatsApp number save nahi karna padega. Counter pe QR chipkao,
          customer scan karke PDF ya photo upload karega aur file seedha aapke dashboard pe aa jayegi.
        </p>
        <div className="row gap">
          <Link className="btn primary" to="/login?mode=signup">Apni shop register karo</Link>
          <Link className="btn" to="/login">Login</Link>
        </div>
      </header>

      <section className="card">
        <h3>Kaise kaam karta hai</h3>
        <ol className="steps">
          <li>Shop register karo aur apna print rate set karo.</li>
          <li>Apna QR poster print karke counter pe chipkao.</li>
          <li>Customer scan kare, file upload kare, price pehle hi dikh jaye.</li>
          <li>Aapko token number ke saath order mile, print karo, Ready mark karo.</li>
          <li>Files kuch ghanton baad apne aap delete ho jaati hain.</li>
        </ol>
      </section>
    </div>
  )
}
