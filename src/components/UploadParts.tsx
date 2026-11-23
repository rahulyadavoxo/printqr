import { useI18n } from '../lib/i18n'
import { rupees } from '../lib/pricing'

/* Presentational pieces of the customer Upload page, shared with the landing pages'
   phone preview (components/UploadPreview.tsx) so that preview is the real UI. */

export type UploadOpts = { copies: number; color: boolean; duplex: boolean; binding: boolean; lamination: boolean }
type OptProps = { o: UploadOpts; onChange: (p: Partial<UploadOpts>) => void; disabled?: boolean }

export function CopiesField({ o, onChange, disabled }: OptProps) {
  const { t } = useI18n()
  return (
      <div className="field">
        <span>{t('uCopies')}</span>
        <div className="stepper">
          <button type="button" aria-label={`${t('uCopies')} −`} disabled={disabled || o.copies <= 1}
            onClick={() => onChange({ copies: Math.max(1, o.copies - 1) })}>−</button>
          <input type="number" min={1} max={100} value={o.copies} aria-label={t('uCopies')} disabled={disabled}
            onChange={(e) => onChange({ copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
          <button type="button" aria-label={`${t('uCopies')} +`} disabled={disabled || o.copies >= 100}
            onClick={() => onChange({ copies: Math.min(100, o.copies + 1) })}>+</button>
        </div>
      </div>
  )
}

export function SideColor({ o, onChange }: OptProps) {
  const { t } = useI18n()
  return (
    <div className="opt-group">
      <div className="opt-row">
        <span className="opt-label">{t('optPrint')}</span>
        <div className="seg" role="group" aria-label={t('optPrint')}>
          <button type="button" className={!o.color ? 'on' : ''} aria-pressed={!o.color} onClick={() => onChange({ color: false })}>
            <span className="swatch sw-bw" aria-hidden="true" />{t('bw')}
          </button>
          <button type="button" className={o.color ? 'on' : ''} aria-pressed={o.color} onClick={() => onChange({ color: true })}>
            <span className="swatch sw-color" aria-hidden="true" />{t('color')}
          </button>
        </div>
      </div>
      <div className="opt-row">
        <span className="opt-label">{t('optSides')}</span>
        <div className="seg" role="group" aria-label={t('optSides')}>
          <button type="button" className={!o.duplex ? 'on' : ''} aria-pressed={!o.duplex} onClick={() => onChange({ duplex: false })}>{t('oneSide')}</button>
          <button type="button" className={o.duplex ? 'on' : ''} aria-pressed={o.duplex} onClick={() => onChange({ duplex: true })}>{t('bothSides')}</button>
        </div>
      </div>
    </div>
  )
}

export function FileBadge({ kind }: { kind: 'pdf' | 'image' | 'doc' }) {
  const label = kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : 'DOC'
  return <span className={`file-badge k-${kind}`}>{label}</span>
}

/** The two little paper sheets with the shop's B/W and colour page rates (shop header). */
export function RatePapers({ bw, color }: { bw: number; color: number }) {
  const { t } = useI18n()
  return (
          <div className="rate-papers" role="img" aria-label={t('ratesLine', { bw: rupees(bw), color: rupees(color) })}>
            <span className="rate-paper">
              <svg viewBox="0 0 30 38" width="30" height="38" aria-hidden="true"><path d="M2 2h18l8 8v26H2z" fill="#fff" stroke="#9a9484" strokeWidth="1.5" strokeLinejoin="round"/><path d="M20 2v8h8" fill="#ece8dd" stroke="#9a9484" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="9" width="10" height="7" rx="1" fill="#2b2b2b"/><rect x="6" y="20" width="18" height="2.2" rx="1.1" fill="#555"/><rect x="6" y="25" width="15" height="2.2" rx="1.1" fill="#888"/><rect x="6" y="30" width="17" height="2.2" rx="1.1" fill="#555"/></svg>
              <b>{rupees(bw)}</b><small>/page</small>
            </span>
            <span className="rate-paper">
              <svg viewBox="0 0 30 38" width="30" height="38" aria-hidden="true"><path d="M2 2h18l8 8v26H2z" fill="#fff" stroke="#9a9484" strokeWidth="1.5" strokeLinejoin="round"/><path d="M20 2v8h8" fill="#fde9b0" stroke="#9a9484" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="9" width="10" height="7" rx="1" fill="#3b82f6"/><circle cx="13" cy="12" r="2" fill="#fbbf24"/><rect x="6" y="20" width="18" height="2.2" rx="1.1" fill="#ef4444"/><rect x="6" y="25" width="15" height="2.2" rx="1.1" fill="#22c55e"/><rect x="6" y="30" width="17" height="2.2" rx="1.1" fill="#a855f7"/></svg>
              <b>{rupees(color)}</b><small>/page</small>
            </span>
          </div>
  )
}
