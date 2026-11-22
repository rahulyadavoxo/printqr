/*
 * "Edit" section of the dashboard: a phone-first document scanner and editor.
 * Start (camera / gallery / PDF) -> crop each page -> filter -> editor (images, markup, page tools) -> PDF.
 * Everything runs on the device; nothing is uploaded.
 */
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { useI18n } from '../../lib/i18n'
import CropScreen from './CropScreen'
import { defaultName, DocMeta, forgetPage, Orig, Page, snap, uid } from './doc'
import EditScreen from './EditScreen'
import FilterScreen from './FilterScreen'
import { detectQuad, fullQuad } from './imgproc'
import { deleteRecent, fileToCanvas, listRecents, openPdfSource, PDF_PREVIEW, Recent, releaseAllPdfSources, renderPdfPage, withSource } from './io'
import { makeCanvas } from './imgproc'
import { ask as askConfirm } from '../../components/ConfirmHost'

type Screen = 'start' | 'crop' | 'filter' | 'edit'
type Target = { mode: 'new' } | { mode: 'retake'; id: string }
const MAX_PAGES = 60

function makePage(src: HTMLCanvasElement, scanned: boolean, orig?: Orig, loading = false): Page {
  const quad = scanned ? detectQuad(src) || fullQuad(src.width, src.height) : fullQuad(src.width, src.height)
  return {
    id: uid(), src, srcVer: 1, quad, rot: 0, filter: scanned ? 'auto' : 'original', bright: 0, contrast: 0, detail: 0,
    ops: [], layers: [], wm: null, undo: [], orig, loading
  }
}

export default function Editor() {
  const { t } = useI18n()
  const [pages, setPages] = useState<Page[]>([])
  const [meta, setMeta] = useState<DocMeta>(() => ({ name: defaultName(), titleMode: 'off' }))
  const [docId, setDocId] = useState(uid)
  const [screen, setScreen] = useState<Screen>('start')
  const [queue, setQueue] = useState<string[]>([])
  const [single, setSingle] = useState<{ id: string; before: string; oldPage?: Page } | null>(null)
  const [cur, setCur] = useState(0)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [recents, setRecents] = useState<Recent[]>([])
  const target = useRef<Target>({ mode: 'new' })
  const cam = useRef<HTMLInputElement>(null)
  const gal = useRef<HTMLInputElement>(null)
  const pdf = useRef<HTMLInputElement>(null)
  // background rendering of PDF pages: bumping the run id stops an older run
  const bgRun = useRef(0)
  const [bg, setBg] = useState<{ done: number; total: number } | null>(null)
  useEffect(() => () => { bgRun.current++; releaseAllPdfSources() }, [])

  const refreshRecents = useCallback(() => { void listRecents().then(setRecents) }, [])
  useEffect(() => { if (screen === 'start') refreshRecents() }, [screen, refreshRecents])

  useEffect(() => {
    if (screen === 'start') return
    document.body.classList.add('no-scroll', 'ed-open')
    return () => document.body.classList.remove('no-scroll', 'ed-open')
  }, [screen])

  // ---- page state helpers
  const upd = useCallback((id: string, patch: Partial<Page>) => setPages((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))), [])
  const pushUndo = useCallback((id: string, before: string) => setPages((ps) => ps.map((p) =>
    p.id === id && snap(p) !== before ? { ...p, undo: [...p.undo.slice(-24), before] } : p)), [])
  const undo = useCallback((id: string) => setPages((ps) => ps.map((p) => {
    if (p.id !== id || !p.undo.length) return p
    const st = JSON.parse(p.undo[p.undo.length - 1])
    return { ...p, ...st, undo: p.undo.slice(0, -1) }
  })), [])

  function pick(kind: 'camera' | 'gallery' | 'pdf', tg: Target = { mode: 'new' }) {
    target.current = tg
    setErr('')
    const el = kind === 'camera' ? cam.current : kind === 'gallery' ? gal.current : pdf.current
    if (el) { el.value = ''; el.click() }
  }

  async function onImages(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name))
    e.target.value = ''
    if (!files.length) return
    const tg = target.current
    setBusy(t('edLoadingPages'))
    try {
      if (tg.mode === 'retake') {
        const old = pages.find((p) => p.id === tg.id)
        if (!old) return
        const src = await fileToCanvas(files[0])
        const fresh = makePage(src, true)
        forgetPage(old.id)
        upd(old.id, { src, srcVer: old.srcVer + 1, quad: fresh.quad, rot: 0, ops: [], filter: fresh.filter, bright: 0, contrast: 0, detail: 0, orig: { kind: 'img', blob: files[0] }, loading: false })
        setSingle({ id: old.id, before: snap(old), oldPage: old })
        setQueue([old.id])
        setScreen('crop')
        return
      }
      const room = MAX_PAGES - pages.length
      const made: Page[] = []
      for (const f of files.slice(0, room)) {
        try {
          setBusy(t('edLoadingPage', { i: made.length + 1, n: Math.min(files.length, room) }))
          await new Promise((r) => setTimeout(r, 0))
          made.push(makePage(await fileToCanvas(f), true, { kind: 'img', blob: f }))
        } catch { /* unreadable picture: skipped */ }
      }
      if (!made.length) return setErr(t('edBadImage'))
      if (files.length > room) setErr(t('edMaxPages', { n: MAX_PAGES }))
      insert(made)
      setSingle(null)
      setQueue(made.map((p) => p.id))
      setScreen('crop')
    } finally {
      setBusy('')
    }
  }

  async function onPdf(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBusy(t('edLoadingPages'))
    try {
      const room = MAX_PAGES - pages.length
      const { key, sizes } = await openPdfSource(f, room)
      if (!sizes.length) return setErr(t('edBadPdf'))
      // Open at once: the first page is rendered now, the rest are blank placeholders filled in the background.
      const first = await renderPdfPage(key, 0, PDF_PREVIEW)
      const made = sizes.map((sz, i) => {
        if (i === 0) return makePage(first, false, { kind: 'pdf', key, index: 0 })
        const k = PDF_PREVIEW / Math.max(sz.w, sz.h) / 8
        const [ph, g] = makeCanvas(sz.w * k, sz.h * k)
        g.fillStyle = '#fff'
        g.fillRect(0, 0, ph.width, ph.height)
        return makePage(ph, false, { kind: 'pdf', key, index: i }, true)
      })
      const at = insert(made)
      setCur(at)
      setScreen('edit')
      void fillPdf(made.slice(1), key)
    } catch {
      setErr(t('edBadPdf'))
    } finally {
      setBusy('')
    }
  }

  /** Renders the placeholder pages one by one in the background, swapping each in. */
  async function fillPdf(todo: Page[], key: string) {
    if (!todo.length) return
    const run = ++bgRun.current
    let done = 1
    const total = todo.length + 1
    setBg({ done, total })
    for (const p of todo) {
      if (bgRun.current !== run) return
      await new Promise((r) => setTimeout(r, 0))
      try {
        const c = await renderPdfPage(key, (p.orig as { index: number }).index, PDF_PREVIEW)
        if (bgRun.current !== run) { c.width = c.height = 1; return }
        setPages((ps) => ps.map((x) => {
          if (x.id !== p.id || !x.loading) return x
          forgetPage(x.id)
          return withSource(x, c)
        }))
      } catch { /* pdf closed or page broken: leave the placeholder; export still reads the original */ }
      done++
      setBg({ done, total })
    }
    if (bgRun.current === run) setBg(null)
  }

  /** Adds pages at the end of the document; returns the first new index. */
  function insert(made: Page[]): number {
    const at = pages.length
    setPages((ps) => [...ps, ...made])
    if (!pages.length) setMeta({ name: defaultName(), titleMode: 'off' })
    return at
  }

  function reset() {
    bgRun.current++
    setBg(null)
    releaseAllPdfSources()
    pages.forEach((p) => forgetPage(p.id))
    setPages([])
    setQueue([])
    setSingle(null)
    setCur(0)
    setDocId(uid())
    setMeta({ name: defaultName(), titleMode: 'off' })
    setScreen('start')
  }

  async function openRecent(r: Recent) {
    setBusy(t('edLoadingPages'))
    try {
      const made: Page[] = []
      for (const b of r.pages) made.push(makePage(await fileToCanvas(b), false, { kind: 'img', blob: b }))
      if (!made.length) return
      pages.forEach((p) => forgetPage(p.id))
      setPages(made)
      setMeta({ name: r.name, titleMode: 'off' })
      setDocId(r.id)
      setCur(0)
      setScreen('edit')
    } catch {
      setErr(t('edBadImage'))
    } finally {
      setBusy('')
    }
  }

  const qPages = queue.map((id) => pages.find((p) => p.id === id)).filter((p): p is Page => !!p)

  // ---- crop / filter flow
  async function cropBack() {
    if (single) {
      if (single.oldPage) {
        const o = single.oldPage
        forgetPage(o.id)
        setPages((ps) => ps.map((p) => (p.id === o.id ? o : p)))
      } else upd(single.id, JSON.parse(single.before))
      setSingle(null)
      setScreen('edit')
      return
    }
    if (!await askConfirm(t('edDiscardNewQ'))) return
    const drop = new Set(queue)
    queue.forEach(forgetPage)
    const left = pages.filter((p) => !drop.has(p.id))
    setPages(left)
    setQueue([])
    setCur((c) => Math.min(c, Math.max(0, left.length - 1)))
    setScreen(left.length ? 'edit' : 'start')
  }
  function cropDone() {
    if (single) {
      if (single.oldPage) {
        // retake keeps going to the filter step for the new photo
        setScreen('filter')
        return
      }
      pushUndo(single.id, single.before)
      setSingle(null)
      setScreen('edit')
      return
    }
    setScreen('filter')
  }
  function filterDone() {
    if (single) {
      // a retaken photo starts a fresh undo history (older steps belong to the old photo)
      if (single.oldPage) upd(single.id, { undo: [] })
      else pushUndo(single.id, single.before)
      setSingle(null)
    }
    const first = pages.findIndex((p) => p.id === queue[0])
    if (first >= 0) setCur(first)
    setQueue([])
    setScreen('edit')
  }

  // ---- render
  if (screen === 'crop' && qPages.length) {
    return <CropScreen key={queue.join()} pages={qPages} onChange={upd} onBack={cropBack} onDone={cropDone}
      doneLabel={single && !single.oldPage ? t('edDone') : t('edNext')} />
  }
  if (screen === 'filter' && qPages.length) {
    return <FilterScreen key={queue.join()} pages={qPages} onChange={upd} onBack={() => setScreen('crop')} onDone={filterDone} doneLabel={t('edDone')}
      onApplyAll={(src) => { for (const p of qPages) if (p.id !== src.id) upd(p.id, { filter: src.filter, bright: src.bright, contrast: src.contrast, detail: src.detail }) }} />
  }

  const inputs = (
    <>
      <input ref={cam} type="file" accept="image/*" capture="environment" multiple hidden onChange={onImages} data-input="camera" />
      <input ref={gal} type="file" accept="image/*" multiple hidden onChange={onImages} data-input="gallery" />
      <input ref={pdf} type="file" accept="application/pdf,.pdf" hidden onChange={onPdf} data-input="pdf" />
      {busy && (
        <div className="ed-busy" role="status" aria-live="polite"><div className="ed-busy-box"><span className="spinner" aria-hidden="true" /> {busy}</div></div>
      )}
    </>
  )

  if (screen === 'edit' && pages.length) {
    return (
      <>
        <EditScreen pages={pages} cur={Math.min(cur, pages.length - 1)} setCur={setCur} meta={meta} setMeta={setMeta} docId={docId}
          upd={upd} pushUndo={pushUndo} undo={undo}
          applyToAll={(fn) => setPages((ps) => ps.map((p) => ({ ...p, ...fn(p) })))}
          onClose={async () => { if (await askConfirm(t('edDiscardQ'))) reset() }}
          onCrop={(id) => {
            const p = pages.find((x) => x.id === id)
            if (!p) return
            setSingle({ id, before: snap(p) })
            setQueue([id])
            setScreen('crop')
          }}
          onRetake={(id) => pick('camera', { mode: 'retake', id })}
          onAdd={(k) => pick(k)}
          onDelete={async (id) => {
            if (!await askConfirm(t('edDeletePageQ'), { icon: 'trash' })) return
            forgetPage(id)
            const left = pages.filter((p) => p.id !== id)
            setPages(left)
            setCur((c) => Math.min(c, Math.max(0, left.length - 1)))
            if (!left.length) reset()
          }}
          onReorder={(ids) => setPages((ps) => ids.map((id) => ps.find((p) => p.id === id)!).filter(Boolean))}
        />
        {err && <div className="ed-toast" role="alert" onClick={() => setErr('')}>{err}</div>}
        {bg && <div className="ed-bgload" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> {t('edBgLoading', { i: bg.done, n: bg.total })}</div>}
        {inputs}
      </>
    )
  }

  return (
    <div className="ed-start">
      <div className="card ed-start-card">
        <h2>{t('edStartTitle')}</h2>
        <p className="muted">{t('edStartSub')}</p>
        <div className="ed-start-btns">
          <button type="button" className="ed-big primary" onClick={() => pick('camera')} data-start="camera">
            <Icon name="camera" size={30} /><strong>{t('edCamera')}</strong><span>{t('edCameraSub')}</span>
          </button>
          <button type="button" className="ed-big" onClick={() => pick('gallery')} data-start="gallery">
            <Icon name="image" size={30} /><strong>{t('edGallery')}</strong><span>{t('edGallerySub')}</span>
          </button>
          <button type="button" className="ed-big" onClick={() => pick('pdf')} data-start="pdf">
            <Icon name="file" size={30} /><strong>{t('edImportPdf')}</strong><span>{t('edImportPdfSub')}</span>
          </button>
        </div>
        {err && <p className="ed-warn" role="alert">{err}</p>}
        <p className="ed-privacy"><Icon name="shield" size={16} /> {t('edPrivacy')}</p>
      </div>
      {recents.length > 0 && (
        <div className="card">
          <h3 className="ed-recent-h">{t('edRecent')}</h3>
          <div className="ed-recents">
            {recents.map((r) => (
              <div key={r.id} className="ed-recent">
                <button type="button" className="ed-recent-open" onClick={() => openRecent(r)}>
                  {r.thumb ? <img src={r.thumb} alt="" /> : <span className="ed-recent-ph"><Icon name="file" size={26} /></span>}
                  <strong>{r.name}</strong>
                  <span className="muted">{t('edPagesCount', { n: r.pages.length })} · {new Date(r.at).toLocaleDateString()}</span>
                </button>
                <button type="button" className="ed-recent-del" aria-label={t('edDelete')} onClick={async () => {
                  if (!await askConfirm(t('edDeleteRecentQ'), { icon: 'trash' })) return
                  await deleteRecent(r.id)
                  refreshRecents()
                }}><Icon name="trash" size={16} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      {inputs}
    </div>
  )
}
