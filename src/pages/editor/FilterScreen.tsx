import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { Key, useI18n } from '../../lib/i18n'
import { geometry, Page, processed } from './doc'
import { applyFilter, FilterId, FILTERS, toCanvas } from './imgproc'

export const FILTER_LABEL: Record<FilterId, Key> = {
  original: 'edFOriginal', auto: 'edFAuto', magic: 'edFMagic', noshadow: 'edFNoShadow', lighten: 'edFLighten', gray: 'edFGray', bw: 'edFBw', bw2: 'edFBw2'
}

type Props = {
  pages: Page[]
  onChange: (id: string, patch: Partial<Page>) => void
  onApplyAll: (src: Page) => void
  onBack: () => void
  onDone: () => void
  doneLabel: string
}

const PREVIEW = 1300

export default function FilterScreen({ pages, onChange, onApplyAll, onBack, onDone, doneLabel }: Props) {
  const { t } = useI18n()
  const [idx, setIdx] = useState(0)
  const page = pages[Math.min(idx, pages.length - 1)]
  const stage = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 300, h: 400 })
  const [allDone, setAllDone] = useState(false)

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.max(100, r.width - 24), h: Math.max(100, r.height - 24) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // live thumbnails of every filter for this page
  const geoKey = `${page.id}|${page.srcVer}|${JSON.stringify(page.quad)}|${page.rot}`
  const thumbs = useMemo(() => {
    const small = toCanvas(geometry(page, PREVIEW), geometry(page, PREVIEW).width, geometry(page, PREVIEW).height, 150)
    const out = {} as Record<FilterId, string>
    for (const f of FILTERS) out[f] = applyFilter(small, f, { bright: 0, contrast: 0, detail: 0 }).toDataURL('image/jpeg', 0.7)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoKey])

  const base = processed(page, PREVIEW)
  const s = Math.min(box.w / base.width, box.h / base.height)
  const vw = Math.round(base.width * s)
  const vh = Math.round(base.height * s)
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = vw * dpr
    c.height = vh * dpr
    c.getContext('2d')!.drawImage(base, 0, 0, c.width, c.height)
  }, [base, vw, vh])

  const last = idx >= pages.length - 1
  const set = (patch: Partial<Page>) => { setAllDone(false); onChange(page.id, patch) }
  return (
    <div className="ed-full ed-filter" role="dialog" aria-modal="true" aria-label={t('edFilter')}>
      <header className="ed-top">
        <button type="button" className="ed-icon-btn" onClick={onBack} aria-label={t('edBack')}><Icon name="back" size={22} /></button>
        <strong className="ed-top-title">{t('edFilter')}{pages.length > 1 ? ` · ${idx + 1}/${pages.length}` : ''}</strong>
        <button type="button" className="btn primary small" onClick={() => (last ? onDone() : setIdx(idx + 1))}>{last ? doneLabel : t('edNext')}</button>
      </header>
      <div className="ed-stage" ref={stage}>
        <canvas ref={cv} className="ed-page-canvas" style={{ width: vw, height: vh }} />
      </div>
      {pages.length > 1 && (
        <div className="ed-pager">
          <button type="button" className="ed-icon-btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)} aria-label={t('edPrev')}><Icon name="chevl" size={22} /></button>
          <span>{idx + 1}/{pages.length}</span>
          <button type="button" className="ed-icon-btn" disabled={last} onClick={() => setIdx(idx + 1)} aria-label={t('edNext')}><Icon name="chevr" size={22} /></button>
        </div>
      )}
      <div className="ed-panel">
        <FilterControls page={page} thumbs={thumbs} onSet={set} />
        {pages.length > 1 && (
          <button type="button" className={`btn small ed-apply-all${allDone ? ' soft' : ''}`} onClick={() => { onApplyAll(page); setAllDone(true) }}>
            <Icon name={allDone ? 'check' : 'copy'} size={16} /> {allDone ? t('edAppliedAll') : t('edApplyAll')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Filter thumbnails + Brightness / Contrast / Detail sliders (also used by the editor's Filter tool). */
export function FilterControls({ page, thumbs, onSet }: { page: Page; thumbs: Record<FilterId, string> | null; onSet: (p: Partial<Page>) => void }) {
  const { t } = useI18n()
  return (
    <>
      <div className="ed-filters" role="radiogroup" aria-label={t('edFilter')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" role="radio" aria-checked={page.filter === f} className={`ed-fthumb${page.filter === f ? ' on' : ''}`} onClick={() => onSet({ filter: f })}>
            {thumbs ? <img src={thumbs[f]} alt="" /> : <span className="ed-fthumb-ph" />}
            <span>{t(FILTER_LABEL[f])}</span>
          </button>
        ))}
      </div>
      <Slider label={t('edBrightness')} min={-100} max={100} value={page.bright} onChange={(v) => onSet({ bright: v })} />
      <Slider label={t('edContrast')} min={-100} max={100} value={page.contrast} onChange={(v) => onSet({ contrast: v })} />
      <Slider label={t('edDetail')} min={0} max={100} value={page.detail} onChange={(v) => onSet({ detail: v })} />
    </>
  )
}

/** Range slider that reports the value when the finger lifts (heavy filters do not run on every pixel move). */
export function Slider({ label, min, max, value, onChange, step = 1, live = false, suffix = '' }: {
  label: string; min: number; max: number; value: number; onChange: (v: number) => void; step?: number; live?: boolean; suffix?: string
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { if (v !== value) onChange(v) }
  return (
    <label className="ed-slider">
      <span className="ed-lbl">{label}</span>
      <input type="range" min={min} max={max} step={step} value={v}
        onChange={(e) => { const n = Number(e.target.value); setV(n); if (live) onChange(n) }}
        onPointerUp={commit} onKeyUp={commit} onTouchEnd={commit} onBlur={commit} />
      <output>{v}{suffix}</output>
    </label>
  )
}
