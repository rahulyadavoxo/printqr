import { CSSProperties, KeyboardEvent, ReactNode, MouseEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Key, useI18n } from '../lib/i18n'
import { LangToggle, LogoMark, Wordmark } from '../components/TopBar'
import { AppDownloadButton } from '../components/AppDownload'
import UploadPreview from '../components/UploadPreview'
import Icon from '../components/Icon'

/* Landing design "duo" (admin picks it in Settings -> Landing page design). All styles are under `.lpd`. */

const SIGNUP = '/login?mode=signup'

/** HashRouter owns the URL hash, so in-page links scroll instead of changing the route. */
function go(id: string) {
  return (e: MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const WHY: [ReactNode, Key, Key][] = [['◎', 'ldW1T', 'ldW1B'], [<Icon name="bolt" size={26} />, 'ldW2T', 'ldW2B'], ['₹', 'ldW3T', 'ldW3B'], ['हि', 'ldW4T', 'ldW4B']]
const FAQ: [Key, Key][] = [['ldQ1', 'ldA1'], ['ldQ2', 'ldA2'], ['ldQ3', 'ldA3'], ['ldQ4', 'ldA4'], ['ldQ5', 'ldA5']]
const TICKER: [string, Key][] = [
  ['Rahul · Notes.pdf', 'ldStPrinting'], ['Anjali · Resume.docx', 'ldStReady'], ['Sumit · Photo.jpg', 'ldStQueued'],
  ['Priya · Form.pdf', 'ldStPaid'], ['Karan · Poster.pdf', 'ldStPrinting'], ['Meera · Assignment.pdf', 'ldStReady']
]
const RATES = { bw: 2, colour: 10 }

const wide = () => window.innerWidth > 1100
const hoverable = () => !!window.matchMedia?.('(hover: hover)').matches

function useCountUp(target: number) {
  const [shown, setShown] = useState(target)
  const cur = useRef(target)
  useEffect(() => {
    const from = cur.current
    let raf = 0
    let t0: number | null = null
    const tick = (ts: number) => {
      if (t0 === null) t0 = ts
      const k = Math.min(1, (ts - t0) / 450)
      const v = from + (target - from) * (1 - Math.pow(1 - k, 3))
      cur.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return shown
}

export default function LandingDuo() {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  /* Which hero panel is open lives in the DOM, not in React state: a setState here re-rendered the whole landing page
     (estimator, FAQ, ticker...) in the very frame the 0.8s panel transition starts - a visible hitch. React renders the
     panels' initial class / aria-expanded once and, since those props never change, never touches them again. */
  const open = useRef<'c' | 's'>('c')
  const pns = useRef<Record<'c' | 's', HTMLDivElement | null>>({ c: null, s: null })
  const setOpen = (id: 'c' | 's') => {
    if (open.current === id) return
    open.current = id
    for (const k of ['c', 's'] as const) {
      const el = pns.current[k]
      if (!el) continue
      el.classList.toggle('open', k === id)
      el.setAttribute('aria-expanded', String(k === id))
    }
  }
  const hoverTimer = useRef<number>()
  const [pages, setPages] = useState(24)
  const [copies, setCopies] = useState(2)
  const [kind, setKind] = useState<'bw' | 'colour'>('bw')
  const [faq, setFaq] = useState(0)

  const rate = RATES[kind]
  const total = pages * copies * rate
  const shown = useCountUp(total)
  const totalText = Math.round(shown).toLocaleString('en-IN')

  /* Reveal-on-scroll. */
  useEffect(() => {
    const el = root.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    el.classList.add('lpd-js')
    const items = Array.from(el.querySelectorAll<HTMLElement>('.lpd-rv'))
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('show')
          io.unobserve(e.target)
        }
      })
    }, { threshold: 0.15 })
    items.forEach((x, i) => {
      x.style.transitionDelay = (i % 4) * 90 + 'ms'
      io.observe(x)
    })
    return () => io.disconnect()
  }, [])
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const panel = (id: 'c' | 's', label: Key) => ({
    ref: (el: HTMLDivElement | null) => { pns.current[id] = el },
    className: `lpd-pn ${id}${id === 'c' ? ' open' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-expanded': id === 'c',
    'aria-label': t(label),
    onClick: () => setOpen(id),
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault()
        setOpen(id)
      }
    },
    onMouseEnter: () => {
      if (!wide() || !hoverable()) return
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => setOpen(id), 160)
    },
    onMouseLeave: () => window.clearTimeout(hoverTimer.current)
  })

  const tilt = (e: MouseEvent<HTMLDivElement>) => {
    if (!hoverable()) return
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    c.style.transform = `perspective(900px) rotateY(${(x - 0.5) * 14}deg) rotateX(${(0.5 - y) * 14}deg) translateY(-6px)`
    c.style.setProperty('--mx', x * 100 + '%')
    c.style.setProperty('--my', y * 100 + '%')
  }
  const untilt = (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.transform = '' }

  const logo = (
    <a className="lpd-logo" href="#top" onClick={go('lpd-top')} aria-label="print by Receipto">
      <span className="lpd-logo-full"><Wordmark height={44} light /></span>
      <span className="lpd-logo-mark"><LogoMark size={40} /></span>
    </a>
  )

  return (
    <div className="lpd" ref={root}>
      <nav className="lpd-nav">
        {logo}
        <div className="lpd-links">
          <a href="#top" onClick={go('lpd-top')}>{t('ldNavOverview')}</a>
          <a href="#estimate" onClick={go('lpd-estimate')}>{t('ldNavEstimate')}</a>
          <a href="#why" onClick={go('lpd-why')}>{t('ldNavWhy')}</a>
          <a href="#faq" onClick={go('lpd-faq')}>{t('ldNavFaq')}</a>
        </div>
        <div className="lpd-navr">
          <LangToggle />
          <Link className="lpd-btn out sm lpd-hide-sm" to="/login">{t('ldLogin')}</Link>
          <Link className="lpd-btn dark sm" to={SIGNUP}>{t('ldGetStarted')}</Link>
        </div>
      </nav>

      <main id="lpd-top">
        <div className="lpd-duo">
          <div {...panel('c', 'ldForCustomers')}>
            <div className="lpd-peek" aria-hidden="true"><i>→</i><span>{t('ldPeekCustomer')}</span><em>{t('ldPeekHint')}</em></div>
            <div className="lpd-body">
              <div className="lpd-tx">
                <span className="lpd-tag">{t('ldForCustomers')}</span>
                <h1>
                  <span className="lpd-w" style={{ '--i': 0 } as CSSProperties}>{t('ldH1a')}</span>
                  <span className="lpd-w u" style={{ '--i': 1 } as CSSProperties}>{t('ldH1b')}</span>
                  <span className="lpd-w" style={{ '--i': 2 } as CSSProperties}>{t('ldH1c')}</span>
                </h1>
                <p className="lpd-lead">{t('ldLead')}</p>
                <div className="lpd-cta">
                  <Link className="lpd-btn dark" to={SIGNUP}>{t('ldCtaStart')}</Link>
                  <a className="lpd-btn out" href="#estimate" onClick={go('lpd-estimate')}>{t('ldCtaEstimate')}</a>
                </div>
              </div>
              <div className="lpd-mp" aria-hidden="true">
                <div className="lpd-phone">
                  <div className="lpd-scr"><UploadPreview /></div>
                </div>
                <div className="lpd-chipf"><i>✓</i>{t('ldOrderSent')}</div>
              </div>
            </div>
          </div>

          <div {...panel('s', 'ldForShops')}>
            <div className="lpd-peek" aria-hidden="true"><i>←</i><span>{t('ldPeekShop')}</span><em>{t('ldPeekHint')}</em></div>
            <div className="lpd-body">
              <div className="lpd-tx">
                <span className="lpd-tag">{t('ldForShops')}</span>
                <h2 className="lpd-sh">{t('ldShopH2a')} <em>{t('ldShopH2em')}</em> {t('ldShopH2b')}</h2>
                <ul className="lpd-ck"><li>{t('ldShop1')}</li><li>{t('ldShop2')}</li><li>{t('ldShop3')}</li></ul>
                <div className="lpd-cta">
                  <Link className="lpd-btn dark" to={SIGNUP}>{t('ldShopCta')}</Link>
                  <AppDownloadButton className="lpd-btn out" />
                </div>
              </div>
              <div className="lpd-qc" aria-hidden="true">
                <div className="lpd-qh">{t('ldQueue')}<em>{t('ldLive')}</em></div>
                <div className="lpd-qr n" style={{ '--k': 0 } as CSSProperties}><div className="lpd-ic">PDF</div><div>Notes_Unit3.pdf<small>{t('ldM1')}</small></div><span className="lpd-st">{t('ldStNew')}</span></div>
                <div className="lpd-qr" style={{ '--k': 1 } as CSSProperties}><div className="lpd-ic">DOC</div><div>Resume_Rahul.docx<small>{t('ldM2')}</small></div><span className="lpd-st p">{t('ldStPrinting')}</span></div>
                <div className="lpd-qr" style={{ '--k': 2 } as CSSProperties}><div className="lpd-ic">JPG</div><div>Passport_photo.jpg<small>{t('ldM3')}</small></div><span className="lpd-st r">{t('ldStReadyTick')}</span></div>
                <div className="lpd-qr" style={{ '--k': 3 } as CSSProperties}><div className="lpd-ic">PDF</div><div>Form_Aadhaar.pdf<small>{t('ldM4')}</small></div><span className="lpd-st">{t('ldStQueued')}</span></div>
              </div>
            </div>
          </div>
        </div>

        <div className="lpd-tk" aria-hidden="true">
          <div>
            {[...TICKER, ...TICKER].map(([who, st], i) => (
              <span key={i}><i>{who.charAt(0)}</i>{who}<em>{t(st)}</em></span>
            ))}
          </div>
        </div>

        <section className="lpd-sec" id="lpd-estimate">
          <div className="lpd-in lpd-eg">
            <div>
              <div className="lpd-eyebrow">{t('ldNavEstimate')}</div>
              <h2>{t('ldEstH2a')} <em>{t('ldEstH2em')}</em> {t('ldEstH2b')}</h2>
              <div className="lpd-ctl">
                <div>
                  <label htmlFor="lpd-pg">{t('ldPages')} <b>{pages}</b></label>
                  <input type="range" id="lpd-pg" min={1} max={200} value={pages}
                    style={{ '--p': ((pages - 1) / 199) * 100 + '%' } as CSSProperties}
                    onChange={(e) => setPages(Number(e.target.value) || 1)} />
                </div>
                <div>
                  <label>{t('ldCopies')}</label>
                  <div className="lpd-step">
                    <button type="button" aria-label={t('ldFewer')} onClick={() => setCopies((c) => Math.max(1, c - 1))}>−</button>
                    <output aria-live="polite">{copies}</output>
                    <button type="button" aria-label={t('ldMore')} onClick={() => setCopies((c) => Math.min(99, c + 1))}>+</button>
                  </div>
                </div>
                <div>
                  <label>{t('ldPrintType')}</label>
                  <div className="lpd-seg" role="group" aria-label={t('ldPrintType')}>
                    <button type="button" className={kind === 'bw' ? 'on' : ''} aria-pressed={kind === 'bw'} onClick={() => setKind('bw')}>{t('ldBwBtn')}</button>
                    <button type="button" className={kind === 'colour' ? 'on' : ''} aria-pressed={kind === 'colour'} onClick={() => setKind('colour')}>{t('ldColour')}</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="lpd-rc lpd-rv">
              <div className="l">{t('ldEstTotal')}</div>
              <div className={`tot${totalText.length > 7 ? ' xl' : totalText.length > 5 ? ' lg' : ''}`}><small>₹</small><span>{totalText}</span></div>
              <dl>
                <div><dt>{t('ldTotalPrints')}</dt><dd>{t('ldNPages', { n: pages * copies })}</dd></div>
                <div><dt>{t('ldRate')}</dt><dd>{t('ldRateLine', { r: rate, name: kind === 'bw' ? t('ldBwName') : t('ldColour') })}</dd></div>
              </dl>
              <p>{t('ldEstNote')}</p>
            </div>
          </div>
        </section>

        <section className="lpd-sec lpd-pt0" id="lpd-why">
          <div className="lpd-in">
            <div className="lpd-eyebrow">{t('ldNavWhy')}</div>
            <h2>{t('ldWhyH2a')} <em>{t('ldWhyH2em')}</em> {t('ldWhyH2b')}</h2>
            <div className="lpd-tg">
              {WHY.map(([ico, h, p]) => (
                <div className="lpd-tc lpd-rv" key={h} onMouseMove={tilt} onMouseLeave={untilt}>
                  <div className="ico">{ico}</div>
                  <h3>{t(h)}</h3>
                  <p>{t(p)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lpd-sec lpd-pt0" id="lpd-faq">
          <div className="lpd-in">
            <div className="lpd-eyebrow">{t('ldNavFaq')}</div>
            <h2>{t('ldFaqH2a')} <em>{t('ldFaqH2em')}</em></h2>
            <div className="lpd-fq">
              <div className="lpd-tabs" role="tablist">
                {FAQ.map(([q], i) => (
                  <button type="button" role="tab" key={q} id={`lpd-tab-${i}`} aria-selected={faq === i} aria-controls="lpd-ans" onClick={() => setFaq(i)}>{t(q)}</button>
                ))}
              </div>
              <div className="lpd-ans" id="lpd-ans" role="tabpanel" aria-labelledby={`lpd-tab-${faq}`} key={faq}>
                <p className="q">{t(FAQ[faq][0])}</p>
                <p className="a">{t(FAQ[faq][1])}</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div className="lpd-fin lpd-rv">
        <h2>{t('ldFinH2a')} <em>{t('ldFinH2em')}</em> {t('ldFinH2b')}</h2>
        <div className="lpd-fb">
          <Link to="/login"><span>{t('ldFinCust')}<small>{t('ldFinCustSub')}</small></span><b>→</b></Link>
          <Link to={SIGNUP}><span>{t('ldFinShop')}<small>{t('ldFinShopSub')}</small></span><b>→</b></Link>
        </div>
      </div>

      <footer className="lpd-foot">
        <div className="lpd-in">
          <div>
            <div className="lpd-foot-logo">{logo}</div>
            © Receipto · print.receipto.in
          </div>
          <div>
            <b>{t('ldFootProduct')}</b>
            <a href="#estimate" onClick={go('lpd-estimate')}>{t('ldNavEstimate')}</a>
            <a href="#why" onClick={go('lpd-why')}>{t('ldNavWhy')}</a>
            <a href="#faq" onClick={go('lpd-faq')}>{t('ldNavFaq')}</a>
          </div>
          <div>
            <b>{t('ldFootLegal')}</b>
            <Link to="/legal/terms">{t('ldTerms')}</Link>
            <Link to="/legal/refund">{t('ldRefund')}</Link>
            <Link to="/legal/privacy">{t('ldPrivacy')}</Link>
            <Link to="/legal/contact">{t('ldContact')}</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
