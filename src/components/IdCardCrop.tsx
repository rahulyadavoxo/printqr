/*
 * One side of an ID card on the upload page: the editor's crop screen (card corners found by themselves,
 * drag to fix, rotate), then the straightened card picture goes back to the page. Lazy-loaded, so the
 * editor code is only downloaded when a customer actually adds an ID card.
 */
import { useEffect, useState } from 'react'
import CropScreen from '../pages/editor/CropScreen'
import { forgetPage, geometry, Page, uid } from '../pages/editor/doc'
import { detectQuad, fullQuad, makeCanvas } from '../pages/editor/imgproc'
import { fileToCanvas } from '../pages/editor/io'
import { useI18n } from '../lib/i18n'

/** Longest side of the cropped card picture (a card is ~1011 px wide at 300 dpi). */
const CARD_MAX = 2000

export default function IdCardCrop({ file, onDone, onCancel, onError }: {
  file: File
  onDone: (card: HTMLCanvasElement) => void
  onCancel: () => void
  onError: () => void
}) {
  const { t } = useI18n()
  const [page, setPage] = useState<Page | null>(null)

  useEffect(() => {
    let stop = false
    fileToCanvas(file).then((src) => {
      if (stop) return
      setPage({
        id: uid(), src, srcVer: 1, quad: detectQuad(src) || fullQuad(src.width, src.height), rot: 0,
        filter: 'original', bright: 0, contrast: 0, detail: 0, ops: [], layers: [], wm: null, undo: []
      })
    }, () => { if (!stop) onError() })
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  useEffect(() => {
    document.body.classList.add('no-scroll', 'ed-open')
    return () => document.body.classList.remove('no-scroll', 'ed-open')
  }, [])

  if (!page) {
    return (
      <div className="ed-busy" role="status" aria-live="polite">
        <div className="ed-busy-box"><span className="spinner" aria-hidden="true" /> {t('idOpening')}</div>
      </div>
    )
  }

  function done() {
    if (!page) return
    // Copy out of the editor's cache before it is freed.
    const geo = geometry(page, CARD_MAX)
    const [c, g] = makeCanvas(geo.width, geo.height)
    g.drawImage(geo, 0, 0)
    forgetPage(page.id)
    onDone(c)
  }

  return (
    <CropScreen pages={[page]} onChange={(_, patch) => setPage((p) => (p ? { ...p, ...patch } : p))}
      onBack={() => { forgetPage(page.id); onCancel() }} onDone={done} doneLabel={t('edDone')} />
  )
}
