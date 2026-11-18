import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'

/** #/q/:code — a Pro shop's dynamic QR. Looks up where the code points now, then opens that queue. */
export default function QrRedirect() {
  const { code = '' } = useParams()
  const nav = useNavigate()
  const { t } = useI18n()
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    supabase.rpc('resolve_qr', { p_code: code }).then(({ data, error }) => {
      if (!alive) return
      const row = Array.isArray(data) ? data[0] : null
      if (error || !row) return setErr(t('qrNotFound'))
      if (row.paused) return setErr(t('qrPausedMsg'))
      nav(`/s/${row.slug}${row.counter_id ? `?c=${row.counter_id}` : ''}`, { replace: true })
    })
    return () => { alive = false }
  }, [code, nav, t])
  return (
    <div className="app-page">
      <TopBar to={null} />
      <div className="page">
        {err ? <p className="notice error">{err}</p> : <p className="muted">{t('loading')}</p>}
      </div>
    </div>
  )
}
