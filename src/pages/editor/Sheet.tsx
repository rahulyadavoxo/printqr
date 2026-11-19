import { ReactNode, useEffect } from 'react'
import Icon from '../../components/Icon'
import { useI18n } from '../../lib/i18n'

export default function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const { t } = useI18n()
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="ed-sheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ed-sheet-scrim" onClick={onClose} />
      <div className="ed-sheet">
        <div className="ed-sheet-head">
          <strong>{title}</strong>
          <button type="button" className="ed-icon-btn" onClick={onClose} aria-label={t('close')}><Icon name="x" size={22} /></button>
        </div>
        <div className="ed-sheet-body">{children}</div>
        {actions && <div className="ed-sheet-actions">{actions}</div>}
      </div>
    </div>
  )
}

