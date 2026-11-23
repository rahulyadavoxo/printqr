import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import type { Key } from '../lib/i18n'
import { nativeBridge } from '../lib/app'
import Icon from './Icon'

/* v39 shop side of the admin tools:
   - ShopNotices: messages from the PrintQR team (support replies, plan reminders, announcements to a group of shops)
   - SupportCard: "Help & support" form + the shop's requests with the team's replies
   - CouponBox: redeem a coupon code for free Pro days (Plan tab)
   All through owner-only SQL functions (v39). Before the v39 SQL has run they quietly show nothing. */

type Notice = { id: number; kind: 'support' | 'expiring' | 'nudge' | 'admin'; title: string | null; body: string | null
  data: { until?: string; question?: string } | null; created_at: string; read_at: string | null }

export function ShopNotices({ onPlan }: { onPlan: () => void }) {
  const { t, lang } = useI18n()
  const [rows, setRows] = useState<Notice[]>([])
  useEffect(() => {
    let live = true
    supabase.rpc('my_notices').then(({ data, error }) => { if (live && !error) setRows(((data || []) as Notice[]).filter((n) => !n.read_at)) }, () => {})
    return () => { live = false }
  }, [])
  const close = (id: number) => {
    setRows((r) => r.filter((n) => n.id !== id))
    void supabase.rpc('notice_read', { p_id: id }).then(() => undefined, () => undefined)
  }
  if (!rows.length) return null
  const date = (s?: string) => s ? new Date(s).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short' }) : ''
  return (
    <div className="shop-notices no-print">
      {rows.slice(0, 3).map((n) => {
        const title = n.kind === 'support' ? t('ntSupportTitle') : n.kind === 'expiring' ? t('ntExpTitle') : n.kind === 'nudge' ? t('ntNudgeTitle') : (n.title || t('ntAdminTitle'))
        const body = n.kind === 'expiring' ? t('ntExpBody', { date: date(n.data?.until) }) : n.kind === 'nudge' ? t('ntNudgeBody') : (n.body || '')
        return (
          <div className="notice shop-notice" role="status" key={n.id}>
            <Icon name={n.kind === 'support' ? 'mail' : n.kind === 'expiring' ? 'star' : 'bell'} size={18} />
            <div className="shop-notice-txt">
              <strong>{title}</strong>
              {n.kind === 'support' && n.data?.question && <span className="small muted shop-notice-q">“{n.data.question}”</span>}
              <span className="shop-notice-body">{body}</span>
              {n.kind === 'expiring' && <button type="button" className="link small" onClick={() => { close(n.id); onPlan() }}>{t('ntExpBtn')}</button>}
            </div>
            <button type="button" className="menu-btn" onClick={() => close(n.id)} aria-label={t('close')}><Icon name="x" size={18} /></button>
          </div>
        )
      })}
    </div>
  )
}

type Ticket = { id: number; topic: string; message: string; status: string; reply: string | null; replied_at: string | null; created_at: string }
const TOPICS = ['problem', 'feedback', 'billing', 'other'] as const
const TOPIC_KEY: Record<string, Key> = { problem: 'supTopicProblem', feedback: 'supTopicFeedback', billing: 'supTopicBilling', other: 'supTopicOther' }

function appInfo(): string {
  try {
    const v = nativeBridge()?.appVersion?.() || (navigator.userAgent.match(/PrintQR(?:App)?\/(\d[\d.]*)/i) || [])[1] || ''
    return (v ? 'app ' + v : 'web') + ' · ' + __BUILD__
  } catch { return '' }
}

export function SupportCard() {
  const { t, te, lang } = useI18n()
  const [topic, setTopic] = useState<string>('problem')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [rows, setRows] = useState<Ticket[] | null>(null)
  const load = useCallback(() => {
    supabase.rpc('my_support').then(({ data, error }) => setRows(error ? [] : (data || []) as Ticket[]), () => setRows([]))
  }, [])
  useEffect(() => { load() }, [load])
  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (text.trim().length < 3) return
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.rpc('support_submit', { p_topic: topic, p_message: text.trim(), p_app: appInfo() })
    setBusy(false)
    if (error) {
      setMsg({ text: /too many/i.test(error.message) ? t('supTooMany') : te(error), error: true })
      return
    }
    setText('')
    setMsg({ text: t('supSent'), error: false })
    load()
  }
  const when = (s: string | null) => s ? new Date(s).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <form className="card form-card" onSubmit={send}>
      <h2 className="card-title">{t('supTitle')}</h2>
      <p className="small muted">{t('supHint')}</p>
      <label className="field">
        <span>{t('supTopic')}</span>
        <select value={topic} onChange={(e) => setTopic(e.target.value)}>
          {TOPICS.map((x) => <option key={x} value={x}>{t(TOPIC_KEY[x])}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t('supMessage')}</span>
        <textarea className="adx-ta" rows={4} maxLength={2000} value={text} disabled={busy} placeholder={t('supMessagePh')} onChange={(e) => setText(e.target.value)} />
      </label>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg" disabled={busy || text.trim().length < 3}>{busy ? t('pleaseWait') : t('supSend')}</button>
      {rows && rows.length > 0 && (
        <div className="sup-list">
          <div className="small muted">{t('supMine')}</div>
          {rows.map((r) => (
            <div className="sup-item" key={r.id}>
              <div className="small"><b>{t(TOPIC_KEY[r.topic] || 'supTopicOther')}</b> · <span className="muted">{when(r.created_at)}</span>
                {' · '}<span className={r.status === 'solved' ? 'sup-ok' : 'muted'}>{r.status === 'solved' ? t('supSolved') : t('supOpen')}</span></div>
              <p className="small sup-msg">{r.message}</p>
              {r.reply && <p className="small sup-reply"><b>{t('supReply')}</b> {r.reply}</p>}
            </div>
          ))}
        </div>
      )}
    </form>
  )
}

export function CouponBox({ onDone }: { onDone: () => Promise<void> | void }) {
  const { t, te, lang } = useI18n()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const errKey: Record<string, Key> = { not_found: 'cpNotFound', expired: 'cpExpired', used_up: 'cpUsedUp', already: 'cpAlready', too_many: 'cpTooMany' }
  const redeem = async (e: FormEvent) => {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (c.length < 3) return
    setBusy(true)
    setMsg(null)
    const { data, error } = await supabase.rpc('redeem_coupon', { p_code: c })
    setBusy(false)
    if (error) { setMsg({ text: te(error), error: true }); return }
    const r = data as { ok: boolean; error?: string; until?: string; days?: number }
    if (!r.ok) { setMsg({ text: t(errKey[r.error || ''] || 'cpNotFound'), error: true }); return }
    const date = r.until ? new Date(r.until).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
    setCode('')
    setMsg({ text: t('cpDone', { n: r.days ?? 0, date }), error: false })
    await onDone()
  }
  return (
    <form className="card form-card coupon-box" onSubmit={redeem}>
      <h2 className="card-title">{t('cpTitle')}</h2>
      <div className="coupon-row">
        <input value={code} maxLength={30} autoCapitalize="characters" placeholder={t('cpPh')} aria-label={t('cpTitle')}
          onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={busy} />
        <button className="btn" disabled={busy || code.trim().length < 3}>{busy ? '…' : t('cpApply')}</button>
      </div>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </form>
  )
}
