import { ReactElement, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSession } from '../lib/useSession'
import { Key, useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'
import { LegalLinks } from './Legal'
import { AppDownloadButton } from '../components/AppDownload'

/* A decorative, QR-looking grid (not a real code). */
const QR_N = 21
const QR_CELLS: boolean[] = (() => {
  const cells: boolean[] = []
  let seed = 7
  const finder = (r: number, c: number) => {
    const inBox = (r0: number, c0: number) => r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7
    for (const [r0, c0] of [[0, 0], [0, QR_N - 7], [QR_N - 7, 0]]) {
      if (inBox(r0, c0)) {
        const rr = r - r0
        const cc = c - c0
        const ring = rr === 0 || rr === 6 || cc === 0 || cc === 6
        const core = rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4
        return ring || core ? 1 : 0
      }
      if (r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7) return 0
    }
    return -1
  }
  for (let r = 0; r < QR_N; r++) {
    for (let c = 0; c < QR_N; c++) {
      const f = finder(r, c)
      if (f >= 0) cells.push(f === 1)
      else {
        seed = (seed * 9301 + 49297) % 233280
        cells.push(seed / 233280 > 0.52)
      }
    }
  }
  return cells
})()

function FakeQr({ size = 140 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${QR_N} ${QR_N}`} aria-hidden="true" shapeRendering="crispEdges">
      <rect width={QR_N} height={QR_N} fill="#fff" />
      {QR_CELLS.map((on, i) => (on ? <rect key={i} x={i % QR_N} y={Math.floor(i / QR_N)} width="1" height="1" fill="#0f172a" /> : null))}
    </svg>
  )
}

const ICONS: Record<string, ReactElement> = {
  shop: <path d="M4 10h16v10H4zM3 10l2-6h14l2 6M9 20v-5h6v5" />,
  qr: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" />,
  print: <path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z" />,
  phone: <path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2" />,
  rupee: <path d="M7 4h10M7 8h10M9 4c5 0 5 8 0 8H7l8 8" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  upi: <path d="M3 6h18v12H3zM3 10h18M7 15h4" />
}

function Icon({ name }: { name: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const STEPS: { icon: string; title: Key; body: Key }[] = [
  { icon: 'shop', title: 'how1Title', body: 'how1Body' },
  { icon: 'qr', title: 'how2Title', body: 'how2Body' },
  { icon: 'upload', title: 'how3Title', body: 'how3Body' },
  { icon: 'print', title: 'how4Title', body: 'how4Body' }
]

const FEATURES: { icon: string; title: Key; body: Key }[] = [
  { icon: 'phone', title: 'feat1Title', body: 'feat1Body' },
  { icon: 'rupee', title: 'feat2Title', body: 'feat2Body' },
  { icon: 'bell', title: 'feat3Title', body: 'feat3Body' },
  { icon: 'trash', title: 'feat4Title', body: 'feat4Body' },
  { icon: 'upi', title: 'feat5Title', body: 'feat5Body' }
]

export default function Home() {
  const { session } = useSession()
  const nav = useNavigate()
  const { t } = useI18n()
  useEffect(() => {
    if (session) nav('/dashboard', { replace: true })
  }, [session, nav])

  return (
    <div className="landing lp">
      <TopBar>
        <Link className="btn ghost small" to="/login">{t('login')}</Link>
      </TopBar>

      <section className="hero lp-hero">
        <div className="hero-in lp-hero-in">
          <div className="hero-copy lp-hero-copy">
            <span className="badge lp-badge">{t('homeBadge')}</span>
            <h1>
              {t('homeTitle1')} <span className="accent">{t('homeTitle2')}</span>
            </h1>
            <p className="lead">{t('homeSub')}</p>
            <div className="cta-row lp-cta-row">
              <Link className="btn primary lg lp-btn" to="/login?mode=signup">{t('ctaRegister')}</Link>
              <Link className="btn lg lp-btn" to="/login">{t('login')}</Link>
            </div>
            <ul className="trust-row lp-trust">
              {t('homeTrust').split(' · ').map((x) => (
                <li key={x}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  {x}
                </li>
              ))}
            </ul>
            <div className="app-dl"><AppDownloadButton /></div>
          </div>

          <div className="lp-visual-wrap" aria-hidden="true">
            <div className="hero-visual lp-visual">
              <div className="mock-poster">
                <div className="mock-poster-head">
                  <LogoMark size={22} />
                  <span>{t('mockWant')}</span>
                </div>
                <FakeQr size={150} />
                <div className="mock-poster-foot">{t('mockScan')}</div>
              </div>
              <div className="mock-phone">
                <div className="mock-notch" />
                <div className="mock-screen">
                  <div className="small muted">{t('mockToken')}</div>
                  <div className="mock-token">#12</div>
                  <div className="pill s-ready">{t('mockReady')}</div>
                  <div className="mock-bars">
                    <span className="on" />
                    <span className="on" />
                    <span className="on" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-band lp-how">
        <div className="lp-wrap">
          <h2 className="lp-title">{t('howTitle')}</h2>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li className="lp-step" key={s.title}>
                <div className="lp-step-top">
                  <span className="lp-step-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="lp-step-icon"><Icon name={s.icon} /></span>
                </div>
                <h3>{t(s.title)}</h3>
                <p>{t(s.body)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-band lp-feats">
        <div className="lp-wrap">
          <h2 className="lp-title">{t('featTitle')}</h2>
          <div className="lp-feat-grid">
            {FEATURES.map((f) => (
              <div className="lp-feat" key={f.title}>
                <div className="lp-feat-icon"><Icon name={f.icon} /></div>
                <h3>{t(f.title)}</h3>
                <p>{t(f.body)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-band lp-cta">
        <div className="lp-wrap lp-cta-in">
          <div>
            <h2>{t('homeCtaTitle')}</h2>
            <p>{t('homeCtaSub')}</p>
          </div>
          <Link className="btn lg cta-band-btn lp-btn" to="/login?mode=signup">{t('ctaRegister')}</Link>
        </div>
      </section>

      <footer className="footer lp-footer">
        <span className="footer-brand"><LogoMark size={26} /> {t('footer')}</span>
        <LegalLinks />
      </footer>
    </div>
  )
}
