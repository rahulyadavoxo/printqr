import { PointerEvent as RPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { useI18n } from '../../lib/i18n'
import { Page } from './doc'
import { detectQuad, fullQuad, isConvex, Pt, Quad } from './imgproc'

type Props = {
  pages: Page[]
  onChange: (id: string, patch: Partial<Page>) => void
  onBack: () => void
  onDone: () => void
  doneLabel: string
}

/** Rotation-aware mapping between source pixels and the on-screen view. */
function mapper(w: number, h: number, rot: number, s: number) {
  const r = ((rot % 360) + 360) % 360
  const toView = (p: Pt): Pt => {
    let x = p.x, y = p.y
    if (r === 90) { x = h - p.y; y = p.x } else if (r === 180) { x = w - p.x; y = h - p.y } else if (r === 270) { x = p.y; y = w - p.x }
    return { x: x * s, y: y * s }
  }
  const toSrc = (v: Pt): Pt => {
    const x = v.x / s, y = v.y / s
    let p: Pt
    if (r === 90) p = { x: y, y: h - x }
    else if (r === 180) p = { x: w - x, y: h - y }
    else if (r === 270) p = { x: w - y, y: x }
    else p = { x, y }
    return { x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) }
  }
  return { toView, toSrc }
}

export default function CropScreen({ pages, onChange, onBack, onDone, doneLabel }: Props) {
  const { t } = useI18n()
  const [idx, setIdx] = useState(0)
  const page = pages[Math.min(idx, pages.length - 1)]
  const stage = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const mag = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 300, h: 400 })
  const [drag, setDrag] = useState<{ kind: 'c' | 'm'; i: number; at: Pt } | null>(null)

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.max(100, r.width - 36), h: Math.max(100, r.height - 36) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W = page.src.width
  const H = page.src.height
  const swap = page.rot % 180 !== 0
  const vw0 = swap ? H : W
  const vh0 = swap ? W : H
  const s = Math.min(box.w / vw0, box.h / vh0)
  const vw = Math.round(vw0 * s)
  const vh = Math.round(vh0 * s)
  const m = mapper(W, H, page.rot, s)

  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = vw * dpr
    c.height = vh * dpr
    const g = c.getContext('2d')!
    g.save()
    g.translate(c.width / 2, c.height / 2)
    g.rotate((page.rot * Math.PI) / 180)
    const dw = W * s * dpr
    const dh = H * s * dpr
    g.drawImage(page.src, -dw / 2, -dh / 2, dw, dh)
    g.restore()
  }, [page.src, page.srcVer, page.rot, vw, vh, W, H, s])

  // magnifier: 2.5× around the handle being dragged
  useEffect(() => {
    if (!drag || !mag.current || !cv.current) return
    const c = mag.current
    const src = cv.current
    const R = 56
    const dpr = src.width / vw
    c.width = c.height = R * 2 * 2
    const g = c.getContext('2d')!
    const z = 2.5
    const sx = drag.at.x * dpr - (R / z) * dpr
    const sy = drag.at.y * dpr - (R / z) * dpr
    g.fillStyle = '#000'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(src, sx, sy, ((R * 2) / z) * dpr, ((R * 2) / z) * dpr, 0, 0, c.width, c.height)
    g.strokeStyle = '#a6e22e'
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(c.width / 2, c.height / 2 - 18); g.lineTo(c.width / 2, c.height / 2 + 18)
    g.moveTo(c.width / 2 - 18, c.height / 2); g.lineTo(c.width / 2 + 18, c.height / 2)
    g.stroke()
  }, [drag, vw])

  const q = page.quad
  const vq = q.map(m.toView)
  const ok = isConvex(q)

  function setQuad(nq: Quad) { onChange(page.id, { quad: nq }) }

  function local(e: RPointerEvent): Pt {
    const r = cv.current!.getBoundingClientRect()
    return { x: Math.min(vw, Math.max(0, e.clientX - r.left)), y: Math.min(vh, Math.max(0, e.clientY - r.top)) }
  }
  function startDrag(kind: 'c' | 'm', i: number) {
    return (e: RPointerEvent) => {
      e.preventDefault()
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      setDrag({ kind, i, at: local(e) })
    }
  }
  function onMove(e: RPointerEvent) {
    if (!drag) return
    const at = local(e)
    const nq = q.map((p) => ({ ...p })) as Quad
    if (drag.kind === 'c') {
      nq[drag.i] = m.toSrc(at)
    } else {
      // move the edge i -> i+1 by the pointer movement
      const prev = m.toSrc(drag.at)
      const cur = m.toSrc(at)
      const dx = cur.x - prev.x
      const dy = cur.y - prev.y
      for (const k of [drag.i, (drag.i + 1) % 4]) {
        nq[k] = { x: Math.min(W, Math.max(0, nq[k].x + dx)), y: Math.min(H, Math.max(0, nq[k].y + dy)) }
      }
    }
    setQuad(nq)
    setDrag({ ...drag, at })
  }

  const auto = () => setQuad(detectQuad(page.src) || fullQuad(W, H))
  const full = () => setQuad(fullQuad(W, H))
  const rot = (d: number) => onChange(page.id, { rot: (((page.rot + d) % 360) + 360) % 360 })

  const last = idx >= pages.length - 1
  return (
    <div className="ed-full ed-crop" role="dialog" aria-modal="true" aria-label={t('edCrop')}>
      <header className="ed-top">
        <button type="button" className="ed-icon-btn" onClick={onBack} aria-label={t('edBack')}><Icon name="back" size={22} /></button>
        <strong className="ed-top-title">{t('edCrop')}{pages.length > 1 ? ` · ${idx + 1}/${pages.length}` : ''}</strong>
        <button type="button" className="btn primary small" disabled={!ok} onClick={() => (last ? onDone() : setIdx(idx + 1))}>
          {last ? doneLabel : t('edNext')}
        </button>
      </header>
      <div className="ed-stage" ref={stage}>
        <div className="ed-crop-box" style={{ width: vw, height: vh }} onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
          <canvas ref={cv} style={{ width: vw, height: vh }} />
          <svg className="ed-crop-svg" width={vw} height={vh} aria-hidden="true">
            <defs>
              <mask id="edcm"><rect width={vw} height={vh} fill="#fff" /><polygon points={vq.map((p) => `${p.x},${p.y}`).join(' ')} fill="#000" /></mask>
            </defs>
            <rect width={vw} height={vh} fill="rgba(0,0,0,.45)" mask="url(#edcm)" />
            <polygon points={vq.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ok ? '#a6e22e' : '#ef4444'} strokeWidth={2.5} />
          </svg>
          {vq.map((p, i) => (
            <button key={'c' + i} type="button" className={`ed-handle${ok ? '' : ' bad'}`} style={{ left: p.x, top: p.y }}
              aria-label={t('edCorner', { n: i + 1 })} onPointerDown={startDrag('c', i)} />
          ))}
          {vq.map((p, i) => {
            const n = vq[(i + 1) % 4]
            const horiz = Math.abs(n.x - p.x) > Math.abs(n.y - p.y)
            return (
              <button key={'m' + i} type="button" className={`ed-handle-mid ${horiz ? 'h' : 'v'}`} style={{ left: (p.x + n.x) / 2, top: (p.y + n.y) / 2 }}
                aria-label={t('edEdge', { n: i + 1 })} onPointerDown={startDrag('m', i)} />
            )
          })}
          {drag && (
            <canvas ref={mag} className="ed-magnifier" style={drag.at.x < vw / 2 && drag.at.y < vh / 3 ? { right: 8, top: 8 } : { left: 8, top: 8 }} />
          )}
        </div>
      </div>
      {!ok && <p className="ed-warn">{t('edCropBad')}</p>}
      {pages.length > 1 && (
        <div className="ed-pager">
          <button type="button" className="ed-icon-btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)} aria-label={t('edPrev')}><Icon name="chevl" size={22} /></button>
          <span>{idx + 1}/{pages.length}</span>
          <button type="button" className="ed-icon-btn" disabled={last} onClick={() => setIdx(idx + 1)} aria-label={t('edNext')}><Icon name="chevr" size={22} /></button>
        </div>
      )}
      <nav className="ed-toolrow ed-toolrow-fixed" aria-label={t('edCrop')}>
        <button type="button" className="ed-tool" onClick={auto}><Icon name="magic" size={22} /><span>{t('edAutoCrop')}</span></button>
        <button type="button" className="ed-tool" onClick={full}><Icon name="full" size={22} /><span>{t('edFullImage')}</span></button>
        <button type="button" className="ed-tool" onClick={() => rot(-90)}><Icon name="rotl" size={22} /><span>{t('edRotateLeft')}</span></button>
        <button type="button" className="ed-tool" onClick={() => rot(90)}><Icon name="rotate" size={22} /><span>{t('edRotateRight')}</span></button>
      </nav>
    </div>
  )
}
