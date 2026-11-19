import { PointerEvent as RPointerEvent, useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { useI18n } from '../../lib/i18n'
import { makeCanvas, Pt } from './imgproc'

const KEY = 'pq_signs'
export const SIGN_COLORS = ['#111111', '#1d4ed8', '#c81e1e', '#15803d']

export function loadSigns(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
export function saveSigns(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8))) } catch { /* storage full */ }
}

type Stroke = { pts: Pt[]; color: string; width: number }

function paint(g: CanvasRenderingContext2D, strokes: Stroke[], scale: number) {
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const s of strokes) {
    g.strokeStyle = s.color
    g.lineWidth = s.width * scale
    g.beginPath()
    const p = s.pts
    if (p.length === 1) {
      g.arc(p[0].x * scale, p[0].y * scale, (s.width * scale) / 2, 0, Math.PI * 2)
      g.fillStyle = s.color
      g.fill()
      continue
    }
    g.moveTo(p[0].x * scale, p[0].y * scale)
    for (let i = 1; i < p.length - 1; i++) {
      const mx = ((p[i].x + p[i + 1].x) / 2) * scale
      const my = ((p[i].y + p[i + 1].y) / 2) * scale
      g.quadraticCurveTo(p[i].x * scale, p[i].y * scale, mx, my)
    }
    const last = p[p.length - 1]
    g.lineTo(last.x * scale, last.y * scale)
    g.stroke()
  }
}

/** Full-screen pad to draw a signature: colour, thin/thick, undo, clear. Saves a trimmed transparent PNG. */
export default function SignPad({ onCancel, onSave }: { onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [redo, setRedo] = useState<Stroke[]>([])
  const [color, setColor] = useState(SIGN_COLORS[0])
  const [width, setWidth] = useState(4)
  const live = useRef<Stroke | null>(null)
  const [size, setSize] = useState({ w: 600, h: 260 })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(160, Math.floor(r.height)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const draw = () => {
    const c = cv.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    paint(g, live.current ? [...strokes, live.current] : strokes, dpr)
  }
  useEffect(draw)

  const pos = (e: RPointerEvent) => {
    const r = cv.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function down(e: RPointerEvent) {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    live.current = { pts: [pos(e)], color, width }
    draw()
  }
  function move(e: RPointerEvent) {
    if (!live.current) return
    live.current.pts.push(pos(e))
    draw()
  }
  function up() {
    if (!live.current) return
    const s = live.current
    live.current = null
    setStrokes((l) => [...l, s])
    setRedo([])
  }

  function save() {
    if (!strokes.length) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of strokes) for (const p of s.pts) {
      x0 = Math.min(x0, p.x - s.width); y0 = Math.min(y0, p.y - s.width)
      x1 = Math.max(x1, p.x + s.width); y1 = Math.max(y1, p.y + s.width)
    }
    const k = Math.min(3, 700 / Math.max(1, x1 - x0))
    const [c, g] = makeCanvas((x1 - x0) * k + 4, (y1 - y0) * k + 4)
    g.translate(2 - x0 * k, 2 - y0 * k)
    paint(g, strokes, k)
    onSave(c.toDataURL('image/png'))
  }

  return (
    <div className="ed-modal ed-signpad" role="dialog" aria-modal="true" aria-label={t('edSignNew')}>
      <div className="ed-modal-bar">
        <button type="button" className="ed-icon-btn" onClick={onCancel} aria-label={t('edCancel')}><Icon name="x" size={22} /></button>
        <strong>{t('edSignNew')}</strong>
        <button type="button" className="btn primary small" onClick={save} disabled={!strokes.length}>{t('edSave')}</button>
      </div>
      <div className="ed-signpad-area" ref={box}>
        <canvas ref={cv} style={{ width: size.w, height: size.h }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {!strokes.length && <span className="ed-signpad-hint">{t('edSignHere')}</span>}
        <span className="ed-signpad-line" aria-hidden="true" />
      </div>
      <div className="ed-opts">
        <div className="ed-row">
          <span className="ed-lbl">{t('edColor')}</span>
          <Swatches colors={SIGN_COLORS} value={color} onChange={setColor} />
        </div>
        <div className="ed-row">
          <span className="ed-lbl">{t('edThickness')}</span>
          <div className="seg ed-seg">
            <button type="button" className={width <= 3 ? 'on' : ''} onClick={() => setWidth(2.5)}>{t('edThin')}</button>
            <button type="button" className={width > 3 && width < 7 ? 'on' : ''} onClick={() => setWidth(4.5)}>{t('edMedium')}</button>
            <button type="button" className={width >= 7 ? 'on' : ''} onClick={() => setWidth(8)}>{t('edThick')}</button>
          </div>
        </div>
        <div className="ed-row ed-row-btns">
          <button type="button" className="btn small" disabled={!strokes.length}
            onClick={() => { setRedo((r) => [strokes[strokes.length - 1], ...r]); setStrokes((l) => l.slice(0, -1)) }}>
            <Icon name="undo" size={18} /> {t('edUndo')}
          </button>
          <button type="button" className="btn small" disabled={!redo.length}
            onClick={() => { setStrokes((l) => [...l, redo[0]]); setRedo((r) => r.slice(1)) }}>
            <Icon name="redo" size={18} /> {t('edRedo')}
          </button>
          <button type="button" className="btn small" disabled={!strokes.length} onClick={() => { setStrokes([]); setRedo([]) }}>
            <Icon name="trash" size={18} /> {t('edClear')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Swatches({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="ed-swatches" role="radiogroup">
      {colors.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c.toLowerCase()} aria-label={c}
          className={`ed-swatch${value.toLowerCase() === c.toLowerCase() ? ' on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
      <label className="ed-swatch ed-swatch-pick" title="+">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
        <span>+</span>
      </label>
    </div>
  )
}
