import { useEffect, useRef, useState } from 'react'

type Props = {
  src: string
  alt: string
  className?: string
  /** Called on a single tap while not zoomed in (e.g. close the viewer). */
  onTap?: () => void
}

const MAX = 6
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Picture with its own pinch-zoom, drag and double-tap zoom.
 * The app locks page zoom (viewport + WebView), so previews zoom here instead, in the app and in the browser alike.
 */
export default function ZoomPan({ src, alt, className = '', onTap }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const tr = useRef(t)
  tr.current = t
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ d: number; s: number; cx: number; cy: number; x: number; y: number } | null>(null)
  const moved = useRef(false)
  const lastTap = useRef(0)
  const tapTimer = useRef<number | undefined>(undefined)

  // New picture: back to fit
  useEffect(() => { setT({ s: 1, x: 0, y: 0 }) }, [src])
  useEffect(() => () => window.clearTimeout(tapTimer.current), [])

  /** Keep the picture covering the box when zoomed (no panning it off screen). */
  const bound = (s: number, x: number, y: number) => {
    const b = box.current?.getBoundingClientRect()
    const i = img.current
    if (!b || !i || s <= 1) return { s: Math.max(1, s), x: 0, y: 0 }
    const w = i.offsetWidth * s
    const h = i.offsetHeight * s
    const mx = Math.max(0, (w - b.width) / 2)
    const my = Math.max(0, (h - b.height) / 2)
    return { s, x: clamp(x, -mx, mx), y: clamp(y, -my, my) }
  }

  /** Zoom to scale s keeping the screen point (px, py) still. */
  const zoomAt = (s: number, px: number, py: number, from = tr.current) => {
    const b = box.current?.getBoundingClientRect()
    if (!b) return from
    const ox = px - (b.left + b.width / 2)
    const oy = py - (b.top + b.height / 2)
    const k = s / from.s
    return bound(s, ox - (ox - from.x) * k, oy - (oy - from.y) * k)
  }

  const down = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size === 1) moved.current = false
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: tr.current.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: tr.current.x, y: tr.current.y }
      moved.current = true
    }
  }

  const move = (e: React.PointerEvent) => {
    const p = pts.current.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size >= 2 && gesture.current) {
      const [a, b] = [...pts.current.values()]
      const g = gesture.current
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const s = clamp((g.s * d) / (g.d || 1), 1, MAX)
      const z = zoomAt(s, g.cx, g.cy, { s: g.s, x: g.x, y: g.y })
      setT(bound(z.s, z.x + (cx - g.cx), z.y + (cy - g.cy)))
      return
    }
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      if (Math.hypot(dx, dy) > 2) moved.current = true
      if (tr.current.s > 1) setT((c) => bound(c.s, c.x + dx, c.y + dy))
    }
  }

  const up = (e: React.PointerEvent) => {
    const had = pts.current.size
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) gesture.current = null
    if (had !== 1 || moved.current) return
    // A tap: double tap zooms in/out, single tap (not zoomed) calls onTap
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      window.clearTimeout(tapTimer.current)
      setT(tr.current.s > 1 ? { s: 1, x: 0, y: 0 } : zoomAt(2.5, e.clientX, e.clientY))
      return
    }
    lastTap.current = now
    if (onTap && tr.current.s <= 1) tapTimer.current = window.setTimeout(() => { if (tr.current.s <= 1) onTap() }, 300)
  }

  const cancel = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) gesture.current = null
  }

  // Mouse wheel / trackpad pinch on desktop
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = clamp(tr.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), 1, MAX)
      setT(zoomAt(s, e.clientX, e.clientY))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  return (
    <div ref={box} className={`zoompan ${t.s > 1 ? 'zoomed ' : ''}${className}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
      onClick={(e) => e.stopPropagation()}>
      <img ref={img} src={src} alt={alt} draggable={false}
        style={{ transform: `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.s})` }} />
    </div>
  )
}
