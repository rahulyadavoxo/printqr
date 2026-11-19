import { FormEvent, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'

/* "Report this shop" link on the customer upload page. Reports reach the admin panel (Spam tab). */
export default function ReportShop({ slug }: { slug: string }) {
  const { t, te } = useI18n()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (text.trim().length < 3) return
    setBusy(true)
    setErr('')
    const { error } = await supabase.rpc('report_shop', { p_slug: slug, p_reason: text.trim() })
    setBusy(false)
    if (error) setErr(te(error))
    else setDone(true)
  }

  if (done) return <p className="small muted center report-shop">{t('repThanks')}</p>
  if (!open) {
    return (
      <p className="small muted center report-shop">
        <button type="button" className="link" onClick={() => setOpen(true)}>{t('repLink')}</button>
      </p>
    )
  }
  return (
    <form className="card report-form" onSubmit={send}>
      <label className="small" htmlFor="rep-text">{t('repLabel')}</label>
      <textarea id="rep-text" rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('repPh')} />
      {err && <p className="notice error small">{err}</p>}
      <div className="admin-row">
        <button type="button" className="btn small" onClick={() => setOpen(false)}>{t('cancel')}</button>
        <button type="submit" className="btn small primary" disabled={busy || text.trim().length < 3}>{busy ? t('pleaseWait') : t('repSend')}</button>
      </div>
    </form>
  )
}
