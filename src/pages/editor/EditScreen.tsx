import { PointerEvent as RPointerEvent, ReactNode, TouchEvent as RTouchEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { Key, useI18n } from '../../lib/i18n'
import {
  DocMeta, drawPage, EraseOp, geometry, Layer, Page, processed, RetextOp, SignLayer, snap, StrokeLayer, TextLayer, textBox, titleFor, uid, Watermark
} from './doc'
import { applyFilter, drawFittedText, FilterId, FILTERS, makeCanvas, Pt, Rect, sampleBackground, sampleInk, toCanvas } from './imgproc'
import { FilterControls, Slider } from './FilterScreen'
import SignPad, { loadSigns, saveSigns, SIGN_COLORS, Swatches } from './SignPad'
import ExportSheet from './ExportSheet'
import Sheet from './Sheet'
import { ask as askConfirm } from '../../components/ConfirmHost'

export const PREV = 1600
const COLORS = ['#111111', '#ffffff', '#e11d48', '#f97316', '#facc15', '#16a34a', '#2563eb', '#7c3aed']
const HL_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74']

type Tab = 'images' | 'markup' | 'page'
type Tool = 'filter' | 'rotate' | 'edittext' | 'erase' | 'sign' | 'wm' | 'brush' | 'text' | 'title' | 'reorder' | 'addpage' | 'export'

export type EditApi = {
  pages: Page[]
  cur: number
  setCur: (i: number) => void
  meta: DocMeta
  setMeta: (m: DocMeta) => void
  docId: string
  upd: (id: string, patch: Partial<Page>) => void
  pushUndo: (id: string, before: string) => void
  undo: (id: string) => void
  applyToAll: (patch: (p: Page) => Partial<Page>) => void
  onClose: () => void
  onCrop: (id: string) => void
  onRetake: (id: string) => void
  onAdd: (kind: 'camera' | 'gallery' | 'pdf') => void
  onDelete: (id: string) => void
  onReorder: (ids: string[]) => void
}

const measure = (() => {
  let g: CanvasRenderingContext2D | null = null
  return () => (g ||= makeCanvas(4, 4)[1])
})()

function signBox(l: SignLayer, dw: number) {
  const w = l.w * dw
  return { w, h: w * l.ratio }
}

export default function EditScreen(api: EditApi) {
  const { t } = useI18n()
  const { pages, cur, setCur, meta, upd } = api
  const page = pages[Math.min(cur, pages.length - 1)]
  const [tab, setTab] = useState<Tab>('images')
  const [tool, setTool] = useState<Tool | null>(null)
  const before = useRef('')
  const stage = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 300, h: 400 })
  const [, force] = useState(0)

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.max(80, r.width - 32), h: Math.max(80, r.height - 28) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- tool state
  const [sel, setSel] = useState<string | null>(null)
  const [brush, setBrush] = useState({ mode: 'pen' as 'pen' | 'hl' | 'eraser', color: '#111111', hlColor: '#fde047', size: 4, hlSize: 18, opacity: 100 })
  const [live, setLive] = useState<StrokeLayer | null>(null)
  const hist = useRef<{ undo: Layer[][]; redo: Layer[][] }>({ undo: [], redo: [] })
  const [erase, setErase] = useState({ mode: 'brush' as 'brush' | 'rect', size: 14 })
  const eraseHist = useRef<{ start: number; redo: EraseOp[] }>({ start: 0, redo: [] })
  const [eraseLive, setEraseLive] = useState<{ pts: Pt[] } | null>(null)
  const [rectSel, setRectSel] = useState<{ a: Pt; b: Pt } | null>(null)
  const [compare, setCompare] = useState(false)
  const [retext, setRetext] = useState<{ phase: 'select' | 'ocr' | 'edit'; op: RetextOp | null; err: string }>({ phase: 'select', op: null, err: '' })
  const [wmAll, setWmAll] = useState(true)
  const [signPad, setSignPad] = useState(false)
  const [signs, setSigns] = useState<string[]>(() => loadSigns())
  const drag = useRef<{ kind: 'move' | 'resize'; id: string; start: Pt; orig: TextLayer | SignLayer | null } | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)

  // ---- page rendering
  const showPage: Page = compare ? { ...page, id: page.id + '~cmp', ops: page.ops.slice(0, eraseHist.current.start) } : page
  const base = processed(showPage, PREV)
  const s = Math.min(box.w / base.width, box.h / base.height)
  const dw = Math.max(1, Math.round(base.width * s))
  const dh = Math.max(1, Math.round(base.height * s))

  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    c.width = Math.round(dw * dpr)
    c.height = Math.round(dh * dpr)
    const g = c.getContext('2d')!
    drawPage(g, showPage, base, c.width, c.height, { title: titleFor(meta, cur), liveStroke: live, onAsset: () => force((n) => n + 1) })
    const op = retext.op
    if (tool === 'edittext' && op) {
      const r = { x: op.rect.x * c.width, y: op.rect.y * c.height, w: op.rect.w * c.width, h: op.rect.h * c.height }
      g.fillStyle = op.bg
      g.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2)
      if (op.text.trim()) drawFittedText(g, op.text, r, op.color, op.bold)
    }
  })

  // ---- helpers
  const layers = page.layers
  const setLayers = (ls: Layer[]) => upd(page.id, { layers: ls })
  const selected = layers.find((l) => l.id === sel) || null

  function open(tl: Tool) {
    before.current = snap(page)
    setSel(null)
    setLive(null)
    setRectSel(null)
    hist.current = { undo: [], redo: [] }
    eraseHist.current = { start: page.ops.length, redo: [] }
    setRetext({ phase: 'select', op: null, err: '' })
    if (tl === 'wm' && !page.wm) upd(page.id, { wm: { text: t('edWmDefault'), color: '#6b7280', size: 0.07, opacity: 0.3, angle: -30, mode: 'tile' } })
    setTool(tl)
  }
  function apply() {
    if (tool === 'wm' && wmAll && page.wm) {
      const wm = page.wm
      for (const p of pages) if (p.id !== page.id) { api.pushUndo(p.id, snap(p)); upd(p.id, { wm: { ...wm } }) }
    }
    api.pushUndo(page.id, before.current)
    close()
  }
  function cancel() {
    const st = JSON.parse(before.current)
    upd(page.id, st)
    close()
  }
  function close() {
    setTool(null)
    setSel(null)
    setLive(null)
    setRectSel(null)
    setCompare(false)
  }

  function local(e: { clientX: number; clientY: number }): Pt {
    const r = cv.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

  function hit(n: Pt, kind: 'text' | 'sign'): Layer | null {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.kind !== kind) continue
      const b = l.kind === 'text' ? textBox(measure(), l, dw) : signBox(l as SignLayer, dw)
      const x = l.x * dw, y = l.y * dh
      const px = n.x * dw, py = n.y * dh
      if (px >= x - 8 && px <= x + b.w + 8 && py >= y - 8 && py <= y + b.h + 8) return l
    }
    return null
  }

  function eraseStrokesAt(n: Pt) {
    const r = (brush.size * 2.5) / 500
    const keep = layers.filter((l) => l.kind !== 'stroke' || !l.pts.some((p) => Math.hypot((p.x - n.x) * dw, (p.y - n.y) * dh) < Math.max(10, r * dw)))
    if (keep.length !== layers.length) {
      hist.current.undo.push(layers)
      hist.current.redo = []
      setLayers(keep)
    }
  }

  // ---- pointer handling on the page
  function down(e: RPointerEvent) {
    if (!tool) return
    const n = local(e)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    if (tool === 'brush') {
      if (brush.mode === 'eraser') { eraseStrokesAt(n); drag.current = { kind: 'move', id: '', start: n, orig: null }; return }
      const hl = brush.mode === 'hl'
      setLive({ id: uid(), kind: 'stroke', tool: hl ? 'hl' : 'pen', color: hl ? brush.hlColor : brush.color, width: (hl ? brush.hlSize : brush.size) / 500, opacity: hl ? 0.45 : brush.opacity / 100, pts: [n] })
    } else if (tool === 'text' || tool === 'sign') {
      const l = hit(n, tool)
      setSel(l ? l.id : null)
      if (l && (l.kind === 'text' || l.kind === 'sign')) drag.current = { kind: 'move', id: l.id, start: n, orig: l }
    } else if (tool === 'edittext') {
      if (retext.phase !== 'ocr') { setRetext({ phase: 'select', op: null, err: '' }); setRectSel({ a: n, b: n }) }
    } else if (tool === 'erase') {
      if (erase.mode === 'brush') setEraseLive({ pts: [n] })
      else setRectSel({ a: n, b: n })
    }
  }
  function move(e: RPointerEvent) {
    if (!tool) return
    const n = local(e)
    if (tool === 'brush') {
      if (brush.mode === 'eraser') { if (drag.current) eraseStrokesAt(n); return }
      if (live) setLive({ ...live, pts: [...live.pts, n] })
    } else if ((tool === 'text' || tool === 'sign') && drag.current) {
      const d = drag.current
      const o = d.orig
      if (!o) return
      if (d.kind === 'move') {
        const nx = clamp01(o.x + n.x - d.start.x)
        setLayers(layers.map((l) => (l.id === d.id ? { ...l, x: Math.min(0.98, nx), y: Math.min(0.98, clamp01(o.y + n.y - d.start.y)) } as Layer : l)))
      } else {
        const d0 = Math.hypot((d.start.x - o.x) * dw, (d.start.y - o.y) * dh)
        const d1 = Math.hypot((n.x - o.x) * dw, (n.y - o.y) * dh)
        const k = Math.max(0.15, d1 / Math.max(8, d0))
        setLayers(layers.map((l) => {
          if (l.id !== d.id) return l
          if (o.kind === 'text') return { ...(l as TextLayer), size: Math.min(0.3, Math.max(0.012, o.size * k)) }
          if (o.kind === 'sign') return { ...(l as SignLayer), w: Math.min(1, Math.max(0.05, o.w * k)) }
          return l
        }))
      }
    } else if ((tool === 'edittext' || tool === 'erase') && rectSel) {
      setRectSel({ ...rectSel, b: { x: clamp01(n.x), y: clamp01(n.y) } })
    } else if (tool === 'erase' && eraseLive) {
      setEraseLive({ pts: [...eraseLive.pts, n] })
    }
  }
  function up() {
    if (!tool) return
    if (tool === 'brush') {
      drag.current = null
      if (live) {
        hist.current.undo.push(layers)
        hist.current.redo = []
        setLayers([...layers, live])
        setLive(null)
      }
    } else if (tool === 'text' || tool === 'sign') {
      drag.current = null
    } else if (tool === 'edittext' && rectSel) {
      const r = normRect(rectSel)
      setRectSel(null)
      if (r.w * dw > 12 && r.h * dh > 8) void runOcr(r)
    } else if (tool === 'erase') {
      let op: EraseOp | null = null
      if (eraseLive) { op = { kind: 'erase', strokes: [{ pts: eraseLive.pts, r: erase.size / 1000 }], rects: [] }; setEraseLive(null) }
      if (rectSel) {
        const r = normRect(rectSel)
        setRectSel(null)
        if (r.w * dw > 4 && r.h * dh > 4) op = { kind: 'erase', strokes: [], rects: [r] }
      }
      if (op) {
        eraseHist.current.redo = []
        upd(page.id, { ops: [...page.ops, op] })
      }
    }
  }
  const normRect = (r: { a: Pt; b: Pt }): Rect => ({
    x: clamp01(Math.min(r.a.x, r.b.x)), y: clamp01(Math.min(r.a.y, r.b.y)), w: Math.abs(r.a.x - r.b.x), h: Math.abs(r.a.y - r.b.y)
  })

  async function runOcr(r: Rect) {
    const W = base.width, H = base.height
    const px = { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H }
    const bg = sampleBackground(base, px)
    const ink = sampleInk(base, px)
    const op: RetextOp = { kind: 'retext', rect: r, bg, color: ink, text: '', bold: false }
    setRetext({ phase: 'ocr', op: null, err: '' })
    // the source region (from the unfiltered crop for better recognition), enlarged when small
    const k = Math.max(1, Math.min(4, 64 / Math.max(1, px.h)))
    const [c, g] = makeCanvas(px.w * k + 16, px.h * k + 16)
    g.fillStyle = bg
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(base, px.x, px.y, px.w, px.h, 8, 8, px.w * k, px.h * k)
    try {
      const { recognise } = await import('./ocr')
      const text = await recognise(c)
      setRetext({ phase: 'edit', op: { ...op, text }, err: text ? '' : t('edOcrNone') })
    } catch {
      setRetext({ phase: 'edit', op, err: t('edOcrFail') })
    } finally {
      c.width = c.height = 1
    }
  }

  // ---- swipe between pages
  const tStart = (e: RTouchEvent) => { if (!tool && e.touches.length === 1) swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }
  const tEnd = (e: RTouchEvent) => {
    const st = swipe.current
    swipe.current = null
    if (!st || tool) return
    const dx = e.changedTouches[0].clientX - st.x
    const dy = e.changedTouches[0].clientY - st.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) setCur(Math.max(0, Math.min(pages.length - 1, cur + (dx < 0 ? 1 : -1))))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool || (e.target as HTMLElement)?.closest?.('input,textarea')) return
      if (e.key === 'ArrowRight') setCur(Math.min(pages.length - 1, cur + 1))
      if (e.key === 'ArrowLeft') setCur(Math.max(0, cur - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, cur, pages.length, setCur])

  // ---- filter thumbnails for the Filter tool
  const geoKey = `${page.id}|${page.srcVer}|${JSON.stringify(page.quad)}|${page.rot}`
  const thumbs = useMemo(() => {
    if (tool !== 'filter') return null
    const geo = geometry(page, PREV)
    const small = toCanvas(geo, geo.width, geo.height, 150)
    const out = {} as Record<FilterId, string>
    for (const f of FILTERS) out[f] = applyFilter(small, f, { bright: 0, contrast: 0, detail: 0 }).toDataURL('image/jpeg', 0.7)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoKey, tool === 'filter'])

  // ---- selection box overlay (text / sign)
  let selBox: ReactNode = null
  if (selected && (tool === 'text' || tool === 'sign') && (selected.kind === 'text' || selected.kind === 'sign')) {
    const b = selected.kind === 'text' ? textBox(measure(), selected, dw) : signBox(selected, dw)
    const x = selected.x * dw, y = selected.y * dh
    selBox = (
      <div className="ed-sel" style={{ left: x, top: y, width: b.w, height: b.h }}>
        <button type="button" className="ed-sel-del" aria-label={t('edDelete')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setLayers(layers.filter((l) => l.id !== selected.id)); setSel(null) }}>
          <Icon name="x" size={14} stroke={3} />
        </button>
        <span className="ed-sel-rs" aria-label={t('edResize')} role="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
            drag.current = { kind: 'resize', id: selected.id, start: local(e), orig: selected }
          }}
          onPointerMove={move} onPointerUp={up} />
      </div>
    )
  }

  // rectangle / brush feedback overlay
  let overlay: ReactNode = null
  if (rectSel) {
    const r = normRect(rectSel)
    overlay = <div className={`ed-rect${tool === 'erase' ? ' erase' : ''}`} style={{ left: r.x * dw, top: r.y * dh, width: r.w * dw, height: r.h * dh }} />
  } else if (tool === 'edittext' && retext.op) {
    const r = retext.op.rect
    overlay = <div className="ed-rect done" style={{ left: r.x * dw, top: r.y * dh, width: r.w * dw, height: r.h * dh }} />
  }
  const eraseSvg = eraseLive && (
    <svg className="ed-erase-live" width={dw} height={dh} aria-hidden="true">
      <polyline points={eraseLive.pts.map((p) => `${p.x * dw},${p.y * dh}`).join(' ')} fill="none" stroke="rgba(239,68,68,.55)"
        strokeWidth={(erase.size / 1000) * 2 * dw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )

  // ---- tool rows
  const TOOLS: Record<Tab, { id: string; icon: string; label: Key; run: () => void }[]> = {
    images: [
      { id: 'crop', icon: 'crop', label: 'edCrop', run: () => api.onCrop(page.id) },
      { id: 'filter', icon: 'filter', label: 'edFilter', run: () => open('filter') },
      { id: 'rotate', icon: 'rotate', label: 'edRotate', run: () => open('rotate') },
      { id: 'edittext', icon: 'textedit', label: 'edEditText', run: () => open('edittext') },
      { id: 'erase', icon: 'erase', label: 'edSmartErase', run: () => open('erase') }
    ],
    markup: [
      { id: 'sign', icon: 'sign', label: 'edSign', run: () => open('sign') },
      { id: 'wm', icon: 'watermark', label: 'edWatermark', run: () => open('wm') },
      { id: 'brush', icon: 'brush', label: 'edBrush', run: () => open('brush') },
      { id: 'text', icon: 'type', label: 'edAddText', run: () => open('text') }
    ],
    page: [
      { id: 'retake', icon: 'retake', label: 'edRetake', run: () => api.onRetake(page.id) },
      { id: 'addpage', icon: 'addpage', label: 'edAddPage', run: () => setTool('addpage') },
      { id: 'reorder', icon: 'reorder', label: 'edReorder', run: () => setTool('reorder') },
      { id: 'title', icon: 'title', label: 'edPageTitle', run: () => setTool('title') }
    ]
  }
  const TOOL_TITLE: Partial<Record<Tool, Key>> = {
    filter: 'edFilter', rotate: 'edRotate', edittext: 'edEditText', erase: 'edSmartErase', sign: 'edSign', wm: 'edWatermark', brush: 'edBrush', text: 'edAddText'
  }
  const panelTool = tool && TOOL_TITLE[tool] ? tool : null

  function addText() {
    const l: TextLayer = { id: uid(), kind: 'text', x: 0.3, y: 0.45, size: 0.06, text: t('edTextDefault'), color: '#111111', bold: false }
    setLayers([...layers, l])
    setSel(l.id)
    setTimeout(() => (document.querySelector('.ed-textarea') as HTMLTextAreaElement | null)?.select(), 50)
  }
  function placeSign(src: string) {
    const im = new Image()
    im.onload = () => {
      const ratio = im.naturalHeight / Math.max(1, im.naturalWidth)
      const w = 0.32
      const hNorm = (w * dw * ratio) / dh
      const l: SignLayer = { id: uid(), kind: 'sign', x: 0.6 - w / 2, y: Math.max(0, 0.82 - hNorm), w, ratio, src, color: '', opacity: 1 }
      setLayers([...layers, l])
      setSel(l.id)
    }
    im.src = src
  }
  const updSel = (patch: Partial<TextLayer> | Partial<SignLayer>) => sel && setLayers(layers.map((l) => (l.id === sel ? ({ ...l, ...patch } as Layer) : l)))
  const wm = page.wm
  const setWm = (patch: Partial<Watermark>) => wm && upd(page.id, { wm: { ...wm, ...patch } })

  const strokes = layers.filter((l) => l.kind === 'stroke').length
  const sessionOps = page.ops.length - eraseHist.current.start

  return (
    <div className={`ed-full ed-edit${tool ? ' tool-' + tool : ''}`} role="dialog" aria-modal="true" aria-label={t('edTitle')}>
      <header className="ed-top">
        <button type="button" className="ed-icon-btn" onClick={api.onClose} aria-label={t('edCloseDoc')}><Icon name="x" size={22} /></button>
        <button type="button" className="ed-icon-btn" disabled={!page.undo.length || !!tool} onClick={() => api.undo(page.id)} aria-label={t('edUndo')} title={t('edUndo')}>
          <Icon name="undo" size={21} />
        </button>
        <button type="button" className="ed-top-title ed-name" onClick={() => !tool && setTool('title')} title={t('edPageTitle')}>{meta.name}</button>
        <button type="button" className="ed-icon-btn" disabled={!!tool} onClick={() => setTool('export')} aria-label={t('edShare')} title={t('edShare')} data-share="1">
          <Icon name="share" size={21} />
        </button>
        <button type="button" className="btn primary small" disabled={!!tool && tool !== 'export'} onClick={() => setTool('export')}>{t('edDone')}</button>
      </header>

      <div className="ed-stage" ref={stage} onTouchStart={tStart} onTouchEnd={tEnd}>
        <div className="ed-page" style={{ width: dw, height: dh }}>
          <canvas ref={cv} className="ed-page-canvas" style={{ width: dw, height: dh }} />
          <div className={`ed-hit${tool ? ' active' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            {overlay}
            {eraseSvg}
            {selBox}
          </div>
          {!tool && (
            <button type="button" className="ed-del-page" onClick={() => api.onDelete(page.id)} aria-label={t('edDeletePage')} title={t('edDeletePage')}>
              <Icon name="trash" size={18} />
            </button>
          )}
          {tool === 'edittext' && retext.phase === 'select' && !retext.op && !rectSel && <div className="ed-hint">{t('edEditTextHint')}</div>}
          {tool === 'erase' && !sessionOps && !eraseLive && !rectSel && <div className="ed-hint">{t('edEraseHint')}</div>}
        </div>
      </div>

      {!panelTool && (
        <div className="ed-pager">
          <button type="button" className="ed-icon-btn" disabled={cur === 0} onClick={() => setCur(cur - 1)} aria-label={t('edPrev')}><Icon name="chevl" size={22} /></button>
          <span>{cur + 1}/{pages.length}</span>
          <button type="button" className="ed-icon-btn" disabled={cur >= pages.length - 1} onClick={() => setCur(cur + 1)} aria-label={t('edNext')}><Icon name="chevr" size={22} /></button>
        </div>
      )}

      {panelTool && (
        <div className="ed-panel">
          <div className="ed-panel-head">
            <button type="button" className="ed-icon-btn" onClick={cancel} aria-label={t('edCancel')}><Icon name="x" size={22} /></button>
            <strong>{t(TOOL_TITLE[panelTool]!)}</strong>
            <button type="button" className="ed-icon-btn ok" onClick={apply} aria-label={t('edApply')} disabled={retext.phase === 'ocr'}><Icon name="check" size={24} /></button>
          </div>

          {tool === 'filter' && (
            <>
              <FilterControls page={page} thumbs={thumbs} onSet={(p) => upd(page.id, p)} />
              {pages.length > 1 && (
                <button type="button" className="btn small ed-apply-all" onClick={() => {
                  const { filter, bright, contrast, detail } = page
                  for (const p of pages) if (p.id !== page.id) { api.pushUndo(p.id, snap(p)); upd(p.id, { filter, bright, contrast, detail }) }
                }}><Icon name="copy" size={16} /> {t('edApplyAll')}</button>
              )}
            </>
          )}

          {tool === 'rotate' && (
            <div className="ed-row ed-row-btns">
              <button type="button" className="btn" onClick={() => upd(page.id, { rot: (page.rot + 270) % 360 })}><Icon name="rotl" size={20} /> {t('edRotateLeft')}</button>
              <button type="button" className="btn" onClick={() => upd(page.id, { rot: (page.rot + 90) % 360 })}><Icon name="rotate" size={20} /> {t('edRotateRight')}</button>
              <button type="button" className="btn" onClick={() => upd(page.id, { rot: (page.rot + 180) % 360 })}>180°</button>
              {pages.length > 1 && (
                <button type="button" className="btn ghost" onClick={() => {
                  for (const p of pages) if (p.id !== page.id) { api.pushUndo(p.id, snap(p)); upd(p.id, { rot: page.rot }) }
                }}><Icon name="copy" size={16} /> {t('edApplyAll')}</button>
              )}
            </div>
          )}

          {tool === 'edittext' && (
            <div className="ed-opts">
              {retext.phase === 'select' && <p className="ed-help">{t('edEditTextHint')}</p>}
              {retext.phase === 'ocr' && <p className="ed-help"><span className="spinner" aria-hidden="true" /> {t('edOcrBusy')}</p>}
              {retext.phase === 'edit' && retext.op && (() => {
                const op = retext.op
                const set = (p: Partial<RetextOp>) => setRetext({ ...retext, op: { ...op, ...p } })
                return (
                  <>
                    {retext.err && <p className="ed-warn">{retext.err}</p>}
                    <textarea className="ed-textarea" rows={2} value={op.text} placeholder={t('edTypeText')} onChange={(e) => set({ text: e.target.value })} />
                    <div className="ed-row">
                      <span className="ed-lbl">{t('edColor')}</span>
                      <Swatches colors={[...new Set([op.color, ...COLORS.slice(0, 4), '#2563eb'])]} value={op.color} onChange={(c) => set({ color: c })} />
                      <button type="button" className={`ed-chip${op.bold ? ' on' : ''}`} onClick={() => set({ bold: !op.bold })} aria-pressed={op.bold}><Icon name="bold" size={16} /> {t('edBold')}</button>
                    </div>
                    <div className="ed-row ed-row-btns">
                      <button type="button" className="btn small" onClick={() => { upd(page.id, { ops: [...page.ops, { ...op, text: '' }] }); setRetext({ phase: 'select', op: null, err: '' }) }}>
                        <Icon name="erase" size={16} /> {t('edRemoveText')}
                      </button>
                      <button type="button" className="btn small primary" onClick={() => { upd(page.id, { ops: [...page.ops, op] }); setRetext({ phase: 'select', op: null, err: '' }) }}>
                        <Icon name="check" size={16} /> {t('edReplaceText')}
                      </button>
                    </div>
                  </>
                )
              })()}
            </div>
          )}

          {tool === 'erase' && (
            <div className="ed-opts">
              <div className="ed-row">
                <div className="seg ed-seg">
                  <button type="button" className={erase.mode === 'brush' ? 'on' : ''} onClick={() => setErase({ ...erase, mode: 'brush' })}><Icon name="brush" size={16} /> {t('edBrush')}</button>
                  <button type="button" className={erase.mode === 'rect' ? 'on' : ''} onClick={() => setErase({ ...erase, mode: 'rect' })}><Icon name="rect" size={16} /> {t('edRectangle')}</button>
                </div>
              </div>
              {erase.mode === 'brush' && <Slider label={t('edSize')} min={4} max={60} value={erase.size} live onChange={(v) => setErase({ ...erase, size: v })} />}
              <div className="ed-row ed-row-btns">
                <button type="button" className="btn small" disabled={sessionOps <= 0} onClick={() => {
                  const last = page.ops[page.ops.length - 1] as EraseOp
                  eraseHist.current.redo.unshift(last)
                  upd(page.id, { ops: page.ops.slice(0, -1) })
                }}><Icon name="undo" size={16} /> {t('edUndo')}</button>
                <button type="button" className="btn small" disabled={!eraseHist.current.redo.length} onClick={() => {
                  const op = eraseHist.current.redo.shift()!
                  upd(page.id, { ops: [...page.ops, op] })
                }}><Icon name="redo" size={16} /> {t('edRedo')}</button>
                <button type="button" className={`btn small${compare ? ' soft' : ''}`} disabled={sessionOps <= 0}
                  onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)}
                  onKeyDown={(e) => e.key === ' ' && setCompare(true)} onKeyUp={() => setCompare(false)}>
                  <Icon name="compare" size={16} /> {t('edCompare')}
                </button>
              </div>
            </div>
          )}

          {tool === 'brush' && (
            <div className="ed-opts">
              <div className="ed-row">
                <div className="seg ed-seg">
                  <button type="button" className={brush.mode === 'pen' ? 'on' : ''} onClick={() => setBrush({ ...brush, mode: 'pen' })}><Icon name="edit" size={16} /> {t('edPen')}</button>
                  <button type="button" className={brush.mode === 'hl' ? 'on' : ''} onClick={() => setBrush({ ...brush, mode: 'hl' })}><Icon name="highlighter" size={16} /> {t('edHighlighter')}</button>
                  <button type="button" className={brush.mode === 'eraser' ? 'on' : ''} onClick={() => setBrush({ ...brush, mode: 'eraser' })}><Icon name="eraser" size={16} /> {t('edEraser')}</button>
                </div>
              </div>
              {brush.mode !== 'eraser' && (
                <div className="ed-row">
                  <span className="ed-lbl">{t('edColor')}</span>
                  {brush.mode === 'pen'
                    ? <Swatches colors={COLORS} value={brush.color} onChange={(c) => setBrush({ ...brush, color: c })} />
                    : <Swatches colors={HL_COLORS} value={brush.hlColor} onChange={(c) => setBrush({ ...brush, hlColor: c })} />}
                </div>
              )}
              {brush.mode === 'pen' && <Slider label={t('edThickness')} min={1} max={30} live value={brush.size} onChange={(v) => setBrush({ ...brush, size: v })} />}
              {brush.mode === 'hl' && <Slider label={t('edThickness')} min={6} max={50} live value={brush.hlSize} onChange={(v) => setBrush({ ...brush, hlSize: v })} />}
              {brush.mode === 'pen' && <Slider label={t('edOpacity')} min={10} max={100} live value={brush.opacity} suffix="%" onChange={(v) => setBrush({ ...brush, opacity: v })} />}
              {brush.mode === 'eraser' && <p className="ed-help">{t('edEraserHint')}</p>}
              <div className="ed-row ed-row-btns">
                <button type="button" className="btn small" disabled={!hist.current.undo.length} onClick={() => {
                  const prev = hist.current.undo.pop()!
                  hist.current.redo.push(layers)
                  setLayers(prev)
                }}><Icon name="undo" size={16} /> {t('edUndo')}</button>
                <button type="button" className="btn small" disabled={!hist.current.redo.length} onClick={() => {
                  const next = hist.current.redo.pop()!
                  hist.current.undo.push(layers)
                  setLayers(next)
                }}><Icon name="redo" size={16} /> {t('edRedo')}</button>
                <button type="button" className="btn small" disabled={!strokes} onClick={() => {
                  hist.current.undo.push(layers)
                  hist.current.redo = []
                  setLayers(layers.filter((l) => l.kind !== 'stroke'))
                }}><Icon name="trash" size={16} /> {t('edEraseAll')}</button>
              </div>
            </div>
          )}

          {tool === 'text' && (
            <div className="ed-opts">
              {selected && selected.kind === 'text' ? (
                <>
                  <textarea className="ed-textarea" rows={2} value={selected.text} onChange={(e) => updSel({ text: e.target.value })} placeholder={t('edTypeText')} />
                  <div className="ed-row">
                    <span className="ed-lbl">{t('edColor')}</span>
                    <Swatches colors={COLORS} value={selected.color} onChange={(c) => updSel({ color: c })} />
                    <button type="button" className={`ed-chip${selected.bold ? ' on' : ''}`} aria-pressed={selected.bold} onClick={() => updSel({ bold: !selected.bold })}><Icon name="bold" size={16} /> {t('edBold')}</button>
                  </div>
                  <Slider label={t('edSize')} min={1} max={30} live value={Math.round(selected.size * 200)} onChange={(v) => updSel({ size: v / 200 })} />
                </>
              ) : <p className="ed-help">{t('edTextHint')}</p>}
              <div className="ed-row ed-row-btns">
                <button type="button" className="btn small" onClick={addText}><Icon name="plus" size={16} /> {t('edAddText')}</button>
              </div>
            </div>
          )}

          {tool === 'sign' && (
            <div className="ed-opts">
              <div className="ed-signs">
                <button type="button" className="ed-sign-new" onClick={() => setSignPad(true)}><Icon name="plus" size={20} /><span>{t('edSignNew')}</span></button>
                {signs.map((src, i) => (
                  <div key={i} className="ed-sign-item">
                    <button type="button" className="ed-sign-thumb" onClick={() => placeSign(src)} aria-label={t('edSignUse')}><img src={src} alt="" /></button>
                    <button type="button" className="ed-sign-x" aria-label={t('edDelete')} onClick={async () => {
                      if (!await askConfirm(t('edSignDeleteQ'), { icon: 'trash' })) return
                      const l = signs.filter((_, k) => k !== i)
                      setSigns(l)
                      saveSigns(l)
                    }}><Icon name="x" size={12} stroke={3} /></button>
                  </div>
                ))}
              </div>
              {selected && selected.kind === 'sign' ? (
                <>
                  <div className="ed-row">
                    <span className="ed-lbl">{t('edColor')}</span>
                    <Swatches colors={SIGN_COLORS} value={selected.color || SIGN_COLORS[0]} onChange={(c) => updSel({ color: c })} />
                  </div>
                  <Slider label={t('edOpacity')} min={20} max={100} live value={Math.round(selected.opacity * 100)} suffix="%" onChange={(v) => updSel({ opacity: v / 100 })} />
                </>
              ) : <p className="ed-help">{signs.length ? t('edSignPick') : t('edSignFirst')}</p>}
            </div>
          )}

          {tool === 'wm' && wm && (
            <div className="ed-opts">
              <input className="ed-input" value={wm.text} maxLength={60} placeholder={t('edWmPlaceholder')} onChange={(e) => setWm({ text: e.target.value })} />
              <div className="ed-row">
                <span className="ed-lbl">{t('edColor')}</span>
                <Swatches colors={['#6b7280', '#111111', '#e11d48', '#2563eb', '#16a34a', '#f97316']} value={wm.color} onChange={(c) => setWm({ color: c })} />
              </div>
              <div className="ed-row">
                <div className="seg ed-seg">
                  <button type="button" className={wm.mode === 'single' ? 'on' : ''} onClick={() => setWm({ mode: 'single' })}>{t('edSingle')}</button>
                  <button type="button" className={wm.mode === 'tile' ? 'on' : ''} onClick={() => setWm({ mode: 'tile' })}>{t('edTile')}</button>
                </div>
              </div>
              <Slider label={t('edSize')} min={2} max={25} live value={Math.round(wm.size * 100)} onChange={(v) => setWm({ size: v / 100 })} />
              <Slider label={t('edTransparency')} min={0} max={95} live value={Math.round((1 - wm.opacity) * 100)} suffix="%" onChange={(v) => setWm({ opacity: 1 - v / 100 })} />
              <Slider label={t('edAngle')} min={-90} max={90} live value={wm.angle} suffix="°" onChange={(v) => setWm({ angle: v })} />
              <div className="ed-row ed-row-btns">
                {pages.length > 1 && (
                  <label className="ed-check"><input type="checkbox" checked={wmAll} onChange={(e) => setWmAll(e.target.checked)} /> {t('edApplyAll')}</label>
                )}
                <button type="button" className="btn small danger-outline" onClick={() => {
                  upd(page.id, { wm: null })
                  if (wmAll) for (const p of pages) if (p.id !== page.id && p.wm) { api.pushUndo(p.id, snap(p)); upd(p.id, { wm: null }) }
                  api.pushUndo(page.id, before.current)
                  close()
                }}><Icon name="trash" size={16} /> {t('edWmRemove')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {!tool || !panelTool ? (
        <>
          <nav className="ed-toolrow" aria-label={t('edTools')}>
            {TOOLS[tab].map((x) => (
              <button key={x.id} type="button" className="ed-tool" onClick={x.run} data-tool={x.id}>
                <Icon name={x.icon} size={23} /><span>{t(x.label)}</span>
              </button>
            ))}
          </nav>
          <nav className="ed-tabs" role="tablist">
            {(['images', 'markup', 'page'] as Tab[]).map((x) => (
              <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                {t(x === 'images' ? 'edTabImages' : x === 'markup' ? 'edTabMarkup' : 'edTabPage')}
              </button>
            ))}
          </nav>
        </>
      ) : null}

      {signPad && (
        <SignPad onCancel={() => setSignPad(false)} onSave={(src) => {
          const l = [src, ...signs].slice(0, 8)
          setSigns(l)
          saveSigns(l)
          setSignPad(false)
          placeSign(src)
        }} />
      )}

      {tool === 'addpage' && (
        <Sheet title={t('edAddPage')} onClose={() => setTool(null)}>
          <div className="ed-sheet-grid">
            <button type="button" className="ed-big" onClick={() => { setTool(null); api.onAdd('camera') }}><Icon name="camera" size={26} /><span>{t('edCamera')}</span></button>
            <button type="button" className="ed-big" onClick={() => { setTool(null); api.onAdd('gallery') }}><Icon name="image" size={26} /><span>{t('edGallery')}</span></button>
            <button type="button" className="ed-big" onClick={() => { setTool(null); api.onAdd('pdf') }}><Icon name="file" size={26} /><span>{t('edImportPdf')}</span></button>
          </div>
        </Sheet>
      )}
      {tool === 'title' && <TitleSheet meta={meta} onClose={() => setTool(null)} onSave={(m) => { api.setMeta(m); setTool(null) }} />}
      {tool === 'reorder' && <ReorderSheet pages={pages} meta={meta} cur={cur} onClose={() => setTool(null)}
        onDone={(ids, newCur) => { api.onReorder(ids); setCur(newCur); setTool(null) }} />}
      {tool === 'export' && <ExportSheet pages={pages} meta={meta} docId={api.docId} onClose={() => setTool(null)} />}
    </div>
  )
}

function TitleSheet({ meta, onClose, onSave }: { meta: DocMeta; onClose: () => void; onSave: (m: DocMeta) => void }) {
  const { t } = useI18n()
  const [m, setM] = useState(meta)
  return (
    <Sheet title={t('edPageTitle')} onClose={onClose}
      actions={<button type="button" className="btn primary block" onClick={() => onSave({ ...m, name: m.name.trim() || meta.name })}>{t('edSave')}</button>}>
      <label className="field">
        <span>{t('edDocName')}</span>
        <input className="ed-input" value={m.name} maxLength={80} autoFocus onChange={(e) => setM({ ...m, name: e.target.value })} />
      </label>
      <p className="ed-help">{t('edDocNameHelp')}</p>
      <span className="ed-lbl">{t('edShowTitle')}</span>
      <div className="seg ed-seg">
        {(['off', 'first', 'all'] as const).map((x) => (
          <button key={x} type="button" className={m.titleMode === x ? 'on' : ''} onClick={() => setM({ ...m, titleMode: x })}>
            {t(x === 'off' ? 'edTitleOff' : x === 'first' ? 'edTitleFirst' : 'edTitleAll')}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

const thumbCache = new Map<string, string>()
export function pageThumb(p: Page, meta: DocMeta, i: number, size = 220): string {
  const key = p.id + '|' + p.srcVer + '|' + snap(p) + '|' + titleFor(meta, i) + '|' + size
  const hit = thumbCache.get(key)
  if (hit) return hit
  const base = processed(p, PREV)
  const k = size / Math.max(base.width, base.height)
  const [c, g] = makeCanvas(base.width * k, base.height * k)
  drawPage(g, p, base, c.width, c.height, { title: titleFor(meta, i) })
  const url = c.toDataURL('image/jpeg', 0.7)
  c.width = c.height = 1
  if (thumbCache.size > 200) thumbCache.clear()
  thumbCache.set(key, url)
  return url
}

function ReorderSheet({ pages, meta, cur, onClose, onDone }: { pages: Page[]; meta: DocMeta; cur: number; onClose: () => void; onDone: (ids: string[], cur: number) => void }) {
  const { t } = useI18n()
  const [order, setOrder] = useState(pages.map((p) => p.id))
  const [dragId, setDragId] = useState<string | null>(null)
  const thumbs = useMemo(() => new Map(pages.map((p, i) => [p.id, pageThumb(p, meta, i)])), [pages, meta])
  const curId = pages[cur]?.id
  const moveTo = (id: string, to: number) => setOrder((o) => {
    const from = o.indexOf(id)
    if (from < 0 || to < 0 || to >= o.length || from === to) return o
    const n = [...o]
    n.splice(from, 1)
    n.splice(to, 0, id)
    return n
  })
  function onMove(e: RPointerEvent) {
    if (!dragId) return
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-idx]') as HTMLElement | null
    if (el) moveTo(dragId, Number(el.dataset.idx))
  }
  return (
    <Sheet title={t('edReorder')} onClose={onClose}
      actions={<button type="button" className="btn primary block" onClick={() => onDone(order, Math.max(0, order.indexOf(curId)))}>{t('edDone')}</button>}>
      <p className="ed-help">{t('edReorderHelp')}</p>
      <div className="ed-grid" onPointerMove={onMove} onPointerUp={() => setDragId(null)} onPointerCancel={() => setDragId(null)}>
        {order.map((id, i) => (
          <div key={id} data-idx={i} className={`ed-grid-item${dragId === id ? ' dragging' : ''}`}>
            <div className="ed-grid-thumb" onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); setDragId(id) }}>
              <img src={thumbs.get(id)} alt="" draggable={false} />
              <span className="ed-grid-no">{i + 1}</span>
            </div>
            <div className="ed-grid-btns">
              <button type="button" className="ed-icon-btn" disabled={i === 0} onClick={() => moveTo(id, i - 1)} aria-label={t('edMoveUp')}><Icon name="chevl" size={18} /></button>
              <button type="button" className="ed-icon-btn" disabled={i === order.length - 1} onClick={() => moveTo(id, i + 1)} aria-label={t('edMoveDown')}><Icon name="chevr" size={18} /></button>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
