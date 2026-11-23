import { CSSProperties, MouseEvent, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Key, useI18n } from '../lib/i18n'
import { LangToggle, LogoMark, Wordmark } from '../components/TopBar'
import { AppDownloadButton } from '../components/AppDownload'

/* Landing design "bold" (admin picks it in Settings -> Landing page design): big "Scan. Upload. Print."
   headline, animated live-queue scene, marquee, 3 steps, bento tiles, customer/shop cards, FAQ.
   All styles are under `.lpb`. Preview with /#/?landing=bold */

const SIGNUP = '/login?mode=signup'

/** HashRouter owns the URL hash, so in-page links scroll instead of changing the route. */
function go(id: string) {
  return (e: MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const MQ: Key[] = ['lbMq1', 'lbMq2', 'lbMq3', 'lbMq4', 'lbMq5', 'lbMq6', 'lbMq7', 'lbMq8']
const STEPS: [Key, Key][] = [['lbS1T', 'lbS1B'], ['lbS2T', 'lbS2B'], ['lbS3T', 'lbS3B']]
const FAQ: [Key, Key][] = [['ldQ1', 'ldA1'], ['ldQ2', 'ldA2'], ['ldQ3', 'ldA3'], ['ldQ4', 'ldA4'], ['lbQ5', 'ldA5']]

const QR_SVG = (
  <svg viewBox="0 0 7 7" shapeRendering="crispEdges">
    <g fill="#0d1210"><rect width="3" height="3" /><rect x="4" width="3" height="3" /><rect y="4" width="3" height="3" /><rect x="4" y="4" width="1" height="1" /><rect x="6" y="5" width="1" height="2" /><rect x="5" y="6" width="1" height="1" /></g>
    <g fill="#fff"><rect x=".7" y=".7" width="1.6" height="1.6" /><rect x="4.7" y=".7" width="1.6" height="1.6" /><rect x=".7" y="4.7" width="1.6" height="1.6" /></g>
  </svg>
)

export default function LandingBold() {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)

  /* Reveal-on-scroll. */
  useEffect(() => {
    const el = root.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    el.classList.add('lpb-js')
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('show')
          io.unobserve(e.target)
        }
      })
    }, { threshold: 0.15 })
    el.querySelectorAll<HTMLElement>('.lpb-rv').forEach((x, i) => {
      x.style.transitionDelay = (i % 3) * 110 + 'ms'
      io.observe(x)
    })
    return () => io.disconnect()
  }, [])

  const logo = (
    <a className="lpb-logo" href="#top" onClick={go('lpb-top')} aria-label="print by Receipto">
      <span className="lpb-logo-full"><Wordmark height={44} light /></span>
      <span className="lpb-logo-mark"><LogoMark size={40} /></span>
    </a>
  )
  const w = (i: number) => ({ '--i': i } as CSSProperties)

  return (
    <div className="lpb" ref={root}>
      <header className="lpb-nav"><div className="lpb-in">
        {logo}
        <div className="lpb-links">
          <a href="#how" onClick={go('lpb-how')}>{t('lbNavHow')}</a>
          <a href="#why" onClick={go('lpb-why')}>{t('ldNavWhy')}</a>
          <a href="#shops" onClick={go('lpb-shops')}>{t('lbNavShops')}</a>
          <a href="#faq" onClick={go('lpb-faq')}>{t('ldNavFaq')}</a>
        </div>
        <div className="lpb-navr">
          <LangToggle />
          <Link className="lpb-btn light sm lpb-hide-sm" to="/login">{t('ldLogin')}</Link>
          <Link className="lpb-btn dark sm" to={SIGNUP}>{t('ldGetStarted')}</Link>
        </div>
      </div></header>

      <main id="lpb-top">
        <section className="lpb-hero"><div className="lpb-in">
          <div>
            <span className="lpb-pill">{t('lbPill')}</span>
            <h1>
              <span className="w" style={w(0)}>{t('ldH1a')}</span>
              <span className="w" style={w(1)}>{t('ldH1b')}</span>
              <span className="w" style={w(2)}>{t('ldH1c')}</span>
            </h1>
            <p className="lpb-lead">{t('lbLead')}</p>
            <div className="lpb-cta">
              <Link className="lpb-btn dark" to={SIGNUP}>{t('ldCtaStart')}</Link>
              <a className="lpb-btn light" href="#shops" onClick={go('lpb-shops')}>{t('ldPeekShop')}</a>
            </div>
            <div className="lpb-trust"><span>{t('lbTrust1')}</span><span>{t('ldW4T')}</span><span>{t('lbTrust3')}</span></div>
          </div>

          <div className="lpb-sbox" aria-hidden="true">
            <div className="lpb-blob" />
            <div className="lpb-scene">
              <div className="lpb-win">
                <div className="wb"><i /><i /><i /><span>print.receipto.in/shop</span></div>
                <div className="wc">
                  <div className="wh">{t('ldQueue')}<em>{t('ldLive')}</em></div>
                  <div className="stats"><div>{t('lbOrdersToday')}<b>24</b></div><div>{t('lbCollected')}<b>₹1,240</b></div></div>
                  <div className="row new"><div className="ic">PDF</div><div>Notes_Unit3.pdf<small>{t('ldM1')}</small></div><div className="ch"><span className="chip c1">{t('ldStNew')}</span><span className="chip p c2">{t('ldStPrinting')}</span><span className="chip rd c3">{t('ldStReadyTick')}</span></div></div>
                  <div className="row"><div className="ic">DOC</div><div>Resume_Rahul.docx<small>{t('ldM2')}</small></div><div className="ch"><span className="chip p">{t('ldStPrinting')}</span></div></div>
                  <div className="row"><div className="ic">JPG</div><div>Passport_photo.jpg<small>{t('ldM3')}</small></div><div className="ch"><span className="chip rd">{t('ldStReadyTick')}</span></div></div>
                  <div className="row"><div className="ic">PDF</div><div>Form_Aadhaar.pdf<small>{t('ldM4')}</small></div><div className="ch"><span className="chip q">{t('ldStQueued')}</span></div></div>
                </div>
              </div>
              <div className="lpb-phone"><div className="ps">
                <div className="pt"><b>print</b><span>Sharma Xerox</span></div>
                <h4>{t('ldPhUpload')}</h4>
                <div className="pf">Notes_Unit3.pdf<small>{t('ldPhPages')}</small><div className="bar"><i /></div></div>
                <div className="po"><div className="on">{t('ldPhBw')}</div><div>{t('ldPhColour')}</div></div>
                <div className="pf tot"><span>{t('ldPhTotal')}</span><b>₹48</b></div>
                <div className="pay">{t('ldPhPay')}</div>
              </div></div>
              <div className="lpb-fly"><i>PDF</i>{t('ldOrderSent')}</div>
              <div className="lpb-qrc">{QR_SVG}{t('lbScanToPrint')}</div>
            </div>
          </div>
        </div></section>

        <div className="lpb-mq" aria-hidden="true"><div>
          {[...MQ, ...MQ].map((k, i) => <span key={i}>{t(k)}</span>)}
        </div></div>

        <section className="lpb-sec lpb-how" id="lpb-how"><div className="lpb-in">
          <div className="lpb-eyebrow">{t('lbNavHow')}</div>
          <h2>{t('lbHowH2')}</h2>
          <div className="lpb-steps">
            {STEPS.map(([h, p], i) => (
              <div className="lpb-step lpb-rv" key={h}><div className="n">{i + 1}</div><h3>{t(h)}</h3><p>{t(p)}</p></div>
            ))}
          </div>
        </div></section>

        <section className="lpb-sec" id="lpb-why"><div className="lpb-in">
          <div className="lpb-eyebrow">{t('ldNavWhy')}</div>
          <h2>{t('lbWhyH2')}</h2>
          <div className="lpb-bento">
            <div className="lpb-t A lpb-rv">
              <h3>{t('ldW1T')}<br />{t('lbAT2')}</h3>
              <p>{t('lbAB')}</p>
              <div className="qs">
                <div className="qr">Resume_Rahul.docx<em>{t('ldStPrinting')}</em></div>
                <div className="qr">Form_Aadhaar.pdf<em className="w">{t('ldStQueued')}</em></div>
              </div>
            </div>
            <div className="lpb-t B lpb-rv"><h3>{t('lbBT')}</h3><p>{t('lbBB')}</p><div className="big">₹</div></div>
            <div className="lpb-t C lpb-rv"><h3>{t('ldW4T')}</h3><p>{t('lbCB')}</p><div className="big" lang="hi">हि</div></div>
            <div className="lpb-t D lpb-rv"><h3>{t('ldW2T')}</h3><p>{t('lbDB')}</p><div className="big">⚡</div></div>
            <div className="lpb-t E lpb-rv"><h3>{t('lbET')}</h3><p>{t('lbEB')}</p><div className="big">◎</div></div>
          </div>
        </div></section>

        <section className="lpb-sec lpb-pt0" id="lpb-shops"><div className="lpb-in">
          <div className="lpb-split">
            <div className="lpb-card w lpb-rv">
              <div className="lpb-eyebrow">{t('ldForCustomers')}</div>
              <h3>{t('lbCustH3')}</h3>
              <ul className="lpb-ck"><li>{t('lbC1')}</li><li>{t('lbC2')}</li><li>{t('lbC3')}</li></ul>
              <div className="lpb-cbtn"><Link className="lpb-btn dark" to="/login">{t('lbCustCta')}</Link></div>
            </div>
            <div className="lpb-card l lpb-rv">
              <div className="lpb-eyebrow ink">{t('ldForShops')}</div>
              <h3>{t('lbShopH3')}</h3>
              <ul className="lpb-ck"><li>{t('ldShop1')}</li><li>{t('ldShop2')}</li><li>{t('ldShop3')}</li></ul>
              <div className="lpb-cbtn">
                <Link className="lpb-btn dark" to={SIGNUP}>{t('ldShopCta')}</Link>
                <AppDownloadButton className="lpb-btn light" />
              </div>
            </div>
          </div>
        </div></section>

        <section className="lpb-sec lpb-pt0" id="lpb-faq"><div className="lpb-in lpb-faqg">
          <div><div className="lpb-eyebrow">{t('ldNavFaq')}</div><h2 className="lpb-faqh">{t('lbFaqH2')}</h2></div>
          <div>
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0}><summary>{t(q)}</summary><p>{t(a)}</p></details>
            ))}
          </div>
        </div></section>
      </main>

      <div className="lpb-final">
        <h2>{t('ldFinH2a')}<br />{t('lbFinH2b')}</h2>
        <Link className="lpb-btn dark" to="/login">{t('lbFinCta')}</Link>
      </div>

      <footer className="lpb-foot"><div className="lpb-in">
        <div><div className="lpb-foot-logo">{logo}</div>© Receipto · print.receipto.in</div>
        <div>
          <b>{t('ldFootProduct')}</b>
          <a href="#how" onClick={go('lpb-how')}>{t('lbNavHow')}</a>
          <a href="#why" onClick={go('lpb-why')}>{t('ldNavWhy')}</a>
          <a href="#faq" onClick={go('lpb-faq')}>{t('ldNavFaq')}</a>
        </div>
        <div>
          <b>{t('ldFootLegal')}</b>
          <Link to="/legal/terms">{t('ldTerms')}</Link>
          <Link to="/legal/refund">{t('ldRefund')}</Link>
          <Link to="/legal/privacy">{t('ldPrivacy')}</Link>
        </div>
      </div></footer>
    </div>
  )
}
