import { CSSProperties, memo, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { filePrice, rupees } from '../lib/pricing'
import { TopBar } from './TopBar'
import Icon from './Icon'
import { CopiesField, FileBadge, RatePapers, SideColor, UploadOpts } from './UploadParts'
import standeeUrl from '../assets/qr-standee.svg'

/* The real customer Upload page (pages/Upload.tsx), same markup, classes and i18n strings, rendered with demo data
   at phone width and scaled to fit its box. Used inside the landing pages' phone mockups.
   Non-interactive (inert, pointer-events: none), no network, no side effects. Styles: `.upv` in styles.css. */

const W = 390
const RATES = { bw_single: 2, bw_double: 1.5, color_single: 10, color_double: 8 }
const PAGES = 12
const OPTS: UploadOpts = { copies: 2, color: false, duplex: false, binding: false, lamination: false }
const noop = () => {}
/* CSS `zoom` scales the screen without a transform. A scale() transform inside the bobbing (animated, composited) phone
   could not be merged into the phone's GPU layer, so Chrome split the preview into ~7 extra layers + clip masks that were
   re-layerized every frame of the landing panel switch. `zoom` keeps it all in the phone's one layer.
   Older browsers without `zoom` (Firefox < 126) fall back to the transform. */
const ZOOM = typeof CSS !== 'undefined' && !!CSS.supports?.('zoom', '1')

function UploadPreview({ shopName = 'Sharma Xerox', address = 'Main Market' }: { shopName?: string; address?: string }) {
  const { t, tn } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ s: 212 / W, h: 776 })

  // Scale the 390px-wide screen to the width of the phone, and stretch it to the phone's height.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    let lw = 0, lh = 0, raf = 0
    const measure = () => {
      raf = 0
      const w = el.clientWidth, h = el.clientHeight
      // Ignore sub-pixel jitter so the (heavy) preview doesn't re-render during the landing panel transitions.
      if (w <= 0 || h <= 0 || (Math.abs(w - lw) < 1 && Math.abs(h - lh) < 1)) return
      lw = w
      lh = h
      setFit({ s: w / W, h: h / (w / W) })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(measure) })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [])

  const price = filePrice(RATES, PAGES, OPTS.copies, OPTS.color, OPTS.duplex)
  const flow = [t('flowAdd'), t('flowOptions'), t('flowSend')]
  const inert = { inert: '' } as Record<string, string>

  return (
    <div className="upv" ref={box} aria-hidden="true" {...inert}>
      <div className="upv-screen" style={{ width: W, height: fit.h, ...(ZOOM ? { zoom: fit.s } : { transform: `scale(${fit.s})` }), ['--upv-r' as string]: `${20 / fit.s}px` } as CSSProperties}>
        <div className="app-page has-sticky">
          <TopBar to={null} />
          <main className="page narrow">
            <header className="shop-head card">
              <div className="shop-head-row">
                <div className="shop-avatar" aria-hidden="true">{shopName.trim().charAt(0).toUpperCase()}</div>
                <div className="shop-head-text">
                  <h1>{shopName}</h1>
                  <p className="shop-addr"><Icon name="pin" size={15} /> {address}</p>
                </div>
                <span className="open-chip is-open"><span className="open-dot" aria-hidden="true" />{t('shopOpen')}</span>
              </div>
              <div className="shop-head-foot">
                <RatePapers bw={RATES.bw_single} color={RATES.color_single} />
                <img className="shop-standee" src={standeeUrl} alt="" aria-hidden="true" width={160} height={132} />
              </div>
            </header>

            <ol className="flow">
              {flow.map((label, i) => (
                <li key={i} className={i < 1 ? 'done' : i === 1 ? 'current' : ''}>
                  <span className="flow-dot">{i < 1 ? <Icon name="check" size={14} stroke={3} /> : i + 1}</span>
                  <span className="flow-lbl">{label}</span>
                </li>
              ))}
            </ol>

            <div className="step-head">
              <span className="step-dot" aria-hidden="true">2</span>
              <h2>{t('uStepFiles')}</h2>
              <span className="step-count">{tn('files_one', 'files_other', 1)}</span>
            </div>

            <div className="card file-card">
              <div className="file-top">
                <FileBadge kind="pdf" />
                <div className="fname">
                  <strong>Notes_Unit3.pdf</strong>
                  <span className="muted small">1.4 MB · {tn('uPages_one', 'uPages_other', PAGES)}</span>
                </div>
                <button type="button" className="icon-btn" tabIndex={-1}><Icon name="x" size={18} /></button>
              </div>
              <div className="grid2">
                <div className="field">
                  <span>{t('uWhichPages')}</span>
                  <button type="button" className="btn pp-open" tabIndex={-1}>
                    <Icon name="file" size={16} />
                    <span>{t('ppkAllPages')}</span>
                  </button>
                </div>
                <CopiesField o={OPTS} onChange={noop} />
              </div>
              <SideColor o={OPTS} onChange={noop} />
              <div className="file-price">
                <span className="small muted">{t('calcLine', { p: PAGES, c: OPTS.copies })}</span>
                <strong>{rupees(price)}</strong>
              </div>
            </div>
          </main>

          <div className="sticky-bar">
            <div className="sticky-in">
              <div className="sticky-row">
                <div className="sticky-total">
                  <span className="sticky-label">{t('total')} · {tn('files_one', 'files_other', 1)}</span>
                  <strong>{rupees(price)}</strong>
                </div>
                <button type="button" className="btn primary lg sticky-cta" tabIndex={-1}>{t('uSend')} <Icon name="arrow" size={20} /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Memoised: the landing pages re-render on every panel/estimator change; the preview has no changing props. */
export default memo(UploadPreview)
