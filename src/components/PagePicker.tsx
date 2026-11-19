import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import Icon from './Icon'
import { openPdf, renderPage } from '../lib/pdf'
import { useI18n } from '../lib/i18n'

type Props = {
  file: File
  total: number
  /** null = all pages */
  initial: number[] | null
  onDone: (pages: number[] | null) => void
  onCancel: () => void
}

/** Full-screen preview of every page of a PDF; the customer ticks the pages to print (or All). */
export default function PagePicker({ file, total, initial, onDone, onCancel }: Props) {
  const { t, tn } = useI18n()
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [failed, setFailed] = useState(false)
  const [sel, setSel] = useState<Set<number>>(() => new Set(initial ?? Array.from({ length: total }, (_, i) => i + 1)))
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [zoom, setZoom] = useState<number | null>(null)
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const queue = useRef<Set<number>>(new Set())
  const busy = useRef(false)

  useEffect(() => {
    let alive = true
    let d: PDFDocumentProxy | null = null
    openPdf(file).then((x) => { d = x; if (alive) setDoc(x); else void x.destroy() }).catch(() => alive && setFailed(true))
    return () => { alive = false; if (d) void d.destroy() }
  }, [file])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (zoom) setZoom(null)
      else onCancel()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [zoom, onCancel])

  // Render thumbnails only when they scroll into view, one at a time (big PDFs stay smooth).
  useEffect(() => {
    if (!doc || !gridRef.current) return
    const pump = async () => {
      if (busy.current) return
      busy.current = true
      while (queue.current.size) {
        const n = queue.current.values().next().value as number
        queue.current.delete(n)
        try {
          const url = await renderPage(doc, n, 240)
          setThumbs((m) => ({ ...m, [n]: url }))
        } catch { /* leave the placeholder */ }
      }
      busy.current = false
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const n = Number((e.target as HTMLElement).dataset.page)
        io.unobserve(e.target)
        queue.current.add(n)
      }
      void pump()
    }, { root: gridRef.current, rootMargin: '400px 0px' })
    gridRef.current.querySelectorAll('[data-page]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [doc])

  useEffect(() => {
    if (!doc || !zoom) return setZoomUrl(null)
    let alive = true
    setZoomUrl(null)
    renderPage(doc, zoom, Math.min(1400, window.innerWidth * (window.devicePixelRatio || 1))).then((u) => alive && setZoomUrl(u)).catch(() => {})
    return () => { alive = false }
  }, [doc, zoom])

  const all = sel.size === total
  const toggle = (n: number) => setSel((s) => {
    const x = new Set(s)
    if (x.has(n)) x.delete(n)
    else x.add(n)
    return x
  })
  const setAll = (on: boolean) => setSel(on ? new Set(Array.from({ length: total }, (_, i) => i + 1)) : new Set())
  const done = () => {
    if (!sel.size) return
    onDone(all ? null : [...sel].sort((a, b) => a - b))
  }

  return (
    <div className="pp-wrap" role="dialog" aria-modal="true" aria-label={t('ppkTitle')}>
      <div className="pp-scrim" onClick={onCancel} />
      <div className="pp-box">
        <div className="pp-head">
          <div className="pp-title">
            <strong>{t('ppkTitle')}</strong>
            <span className="muted small">{file.name} · {tn('uPages_one', 'uPages_other', total)}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label={t('close')}><Icon name="x" size={20} /></button>
        </div>

        <div className="pp-bar">
          <label className="pp-all">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>{t('ppkAll')}</span>
          </label>
          {sel.size > 0 && !all && (
            <button type="button" className="pp-clear small" onClick={() => setAll(false)}>{t('ppkClear')}</button>
          )}
          <span className="pp-count small">{t('ppkCount', { n: sel.size, t: total })}</span>
        </div>

        <div className="pp-grid" ref={gridRef}>
          {failed && <p className="err-text small">{t('ppkPreviewFail')}</p>}
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
            const on = sel.has(n)
            return (
              <div key={n} data-page={n} className={`pp-page${on ? ' on' : ''}`}>
                <button type="button" className="pp-thumb" aria-pressed={on} onClick={() => toggle(n)}
                  aria-label={t('ppkPage', { n })}>
                  {thumbs[n] ? <img src={thumbs[n]} alt="" draggable={false} /> : <span className="pp-ph" />}
                  <span className="pp-tick" aria-hidden="true">{on && <Icon name="check" size={16} />}</span>
                </button>
                <div className="pp-foot">
                  <span>{n}</span>
                  <button type="button" className="pp-zoom" onClick={() => setZoom(n)} aria-label={t('ppkZoom', { n })}>
                    <Icon name="open" size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="pp-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>{t('ppkCancel')}</button>
          <button type="button" className="btn primary" disabled={!sel.size} onClick={done}>
            {sel.size ? t('ppkDone', { n: sel.size }) : t('ppkPickOne')}
          </button>
        </div>
      </div>

      {zoom && (
        <div className="pp-zoomview" onClick={() => setZoom(null)}>
          <div className="pp-zoombar" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="icon-btn" disabled={zoom <= 1} onClick={() => setZoom(zoom - 1)} aria-label="‹">‹</button>
            <label className="pp-all">
              <input type="checkbox" checked={sel.has(zoom)} onChange={() => toggle(zoom)} />
              <span>{t('ppkPage', { n: zoom })}</span>
            </label>
            <button type="button" className="icon-btn" disabled={zoom >= total} onClick={() => setZoom(zoom + 1)} aria-label="›">›</button>
            <button type="button" className="icon-btn" onClick={() => setZoom(null)} aria-label={t('close')}><Icon name="x" size={20} /></button>
          </div>
          {zoomUrl ? <img src={zoomUrl} alt={t('ppkPage', { n: zoom })} onClick={(e) => e.stopPropagation()} /> : <span className="pp-loading muted">…</span>}
        </div>
      )}
    </div>
  )
}
