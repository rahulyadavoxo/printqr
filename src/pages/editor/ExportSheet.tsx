import { useRef, useState } from 'react'
import Icon from '../../components/Icon'
import { Key, useI18n } from '../../lib/i18n'
import { DocMeta, Page, safeFileName, snap } from './doc'
import { download, exportPdf, loadPdfSettings, Margin, Orient, PAGE_SIZES, PageNum, PageSize, PdfSettings, printImages, printPages, Quality, savePdfSettings, saveRecent, share } from './io'
import Sheet from './Sheet'

const SIZE_LABEL: Record<PageSize, Key> = {
  auto: 'edSizeAuto', a4: 'edSizeA4', a3: 'edSizeA3', a5: 'edSizeA5', b5: 'edSizeB5', letter: 'edSizeLetter', legal: 'edSizeLegal', card: 'edSizeCard'
}

function fmtSize(n: number) {
  return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}

/** "Done": PDF settings (page size, orientation, margin, compression, page numbers) + Download / Print / Share. */
export default function ExportSheet({ pages, meta, docId, onClose }: { pages: Page[]; meta: DocMeta; docId: string; onClose: () => void }) {
  const { t } = useI18n()
  const [st, setSt] = useState<PdfSettings>(() => loadPdfSettings())
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const made = useRef<{ key: string; blob: Blob } | null>(null)
  const name = safeFileName(meta.name) + '.pdf'
  const key = JSON.stringify(st) + meta.name + meta.titleMode + pages.map((p) => p.id + p.srcVer + snap(p)).join('|')

  const set = (p: Partial<PdfSettings>) => { const n = { ...st, ...p }; setSt(n); savePdfSettings(n); setMsg(null) }

  async function make(): Promise<Blob | null> {
    if (made.current?.key === key) return made.current.blob
    setBusy(t('edMakingPdf', { i: 1, n: pages.length }))
    try {
      const blob = await exportPdf(pages, meta, st, (i) => setBusy(t('edMakingPdf', { i: i + 1, n: pages.length })))
      made.current = { key, blob }
      void saveRecent(docId, pages, meta)
      return blob
    } catch {
      setMsg({ text: t('edPdfFail'), error: true })
      return null
    } finally {
      setBusy('')
    }
  }

  async function onDownload() {
    const b = await make()
    if (!b) return
    download(b, name)
    setMsg({ text: t('edSavedPdf', { name, size: fmtSize(b.size) }) })
  }
  async function onShare() {
    const b = await make()
    if (!b) return
    const r = await share(b, name)
    if (r === 'downloaded') setMsg({ text: t('edSavedPdf', { name, size: fmtSize(b.size) }) })
  }
  async function onPrint() {
    setBusy(t('edPreparingPrint'))
    try {
      const urls = await printImages(pages, meta, st)
      void saveRecent(docId, pages, meta)
      await printPages(urls, meta.name)
    } catch {
      setMsg({ text: t('edPdfFail'), error: true })
    } finally {
      setBusy('')
    }
  }

  return (
    <Sheet title={t('edPdfSettings')} onClose={onClose}
      actions={
        <div className="ed-export-actions">
          <button type="button" className="btn primary lg" disabled={!!busy} onClick={onDownload} data-act="download"><Icon name="download" size={18} /> {t('edDownloadPdf')}</button>
          <button type="button" className="btn lg" disabled={!!busy} onClick={onPrint} data-act="print"><Icon name="printer" size={18} /> {t('edPrint')}</button>
          <button type="button" className="btn lg" disabled={!!busy} onClick={onShare} data-act="share"><Icon name="share" size={18} /> {t('edShare')}</button>
        </div>
      }>
      <p className="ed-help">{t('edPdfInfo', { n: pages.length, name })}</p>
      <span className="ed-lbl">{t('edPageSize')}</span>
      <div className="ed-chips">
        {PAGE_SIZES.map((s) => (
          <button key={s} type="button" className={`ed-chip${st.size === s ? ' on' : ''}`} aria-pressed={st.size === s} onClick={() => set({ size: s })}>{t(SIZE_LABEL[s])}</button>
        ))}
      </div>
      {st.size !== 'auto' && (
        <>
          <span className="ed-lbl">{t('edOrientation')}</span>
          <div className="seg ed-seg">
            {(['auto', 'portrait', 'landscape'] as Orient[]).map((o) => (
              <button key={o} type="button" className={st.orient === o ? 'on' : ''} onClick={() => set({ orient: o })}>
                {t(o === 'auto' ? 'edOrientAuto' : o === 'portrait' ? 'edPortrait' : 'edLandscape')}
              </button>
            ))}
          </div>
        </>
      )}
      <span className="ed-lbl">{t('edMargin')}</span>
      <div className="seg ed-seg">
        {(['none', 'small', 'normal'] as Margin[]).map((m) => (
          <button key={m} type="button" className={st.margin === m ? 'on' : ''} onClick={() => set({ margin: m })}>
            {t(m === 'none' ? 'edMarginNone' : m === 'small' ? 'edMarginSmall' : 'edMarginNormal')}
          </button>
        ))}
      </div>
      <span className="ed-lbl">{t('edQuality')}</span>
      <div className="seg ed-seg">
        {(['small', 'medium', 'large', 'original'] as Quality[]).map((q) => (
          <button key={q} type="button" className={st.quality === q ? 'on' : ''} onClick={() => set({ quality: q })}>
            {t(q === 'small' ? 'edQSmall' : q === 'medium' ? 'edQMedium' : q === 'large' ? 'edQLarge' : 'edQOriginal')}
          </button>
        ))}
      </div>
      <span className="ed-lbl">{t('edPageNumber')}</span>
      <div className="seg ed-seg">
        {(['none', 'left', 'center', 'right'] as PageNum[]).map((p) => (
          <button key={p} type="button" className={st.pageNum === p ? 'on' : ''} onClick={() => set({ pageNum: p })}>
            {t(p === 'none' ? 'edPnNone' : p === 'left' ? 'edPnLeft' : p === 'center' ? 'edPnCenter' : 'edPnRight')}
          </button>
        ))}
      </div>
      {busy && <p className="ed-help" role="status"><span className="spinner" aria-hidden="true" /> {busy}</p>}
      {msg && <p className={msg.error ? 'ed-warn' : 'ed-ok'} role="status">{msg.text}</p>}
    </Sheet>
  )
}
