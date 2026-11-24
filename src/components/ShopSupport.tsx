import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import type { Key } from '../lib/i18n'
import { nativeBridge } from '../lib/app'
import { previewCoupon } from '../lib/billing'
import type { CouponDeal } from '../lib/billing'
import Icon from './Icon'

/* v39 shop side of the admin tools:
   - ShopNotices: messages from the PrintQR team (support replies, plan reminders, announcements to a group of shops)
   - SupportCard: "Help & support" form + the shop's requests with the team's replies
   - CouponBox: redeem a coupon code for free Pro days, or (v40) check a % off code that is applied when paying (Plan tab)
   All through owner-only SQL functions (v39). Before the v39 SQL has run they quietly show nothing. */

type Notice = { id: number; kind: 'support' | 'expiring' | 'nudge' | 'admin'; title: string | null; body: string | null
  data: { until?: string; question?: string } | null; created_at: string; read_at: string | null }

/* One shared list of the owner's unread team messages: the dashboard banners, the computer bell (count) and the
   Help & support dot all read it, so closing one anywhere clears it everywhere. Re-checked every 2 minutes. */
let noticeRows: Notice[] = []
let noticeLoaded = false
let noticeTimer = 0
const noticeSubs = new Set<() => void>()
const noticeEmit = () => noticeSubs.forEach((f) => f())
export function refreshNotices() {
  supabase.rpc('my_notices').then(({ data, error }) => {
    if (error) return
    noticeRows = ((data || []) as Notice[]).filter((n) => !n.read_at)
    noticeLoaded = true
    noticeEmit()
  }, () => {})
}
export function readNotice(id: number | null) {
  noticeRows = id == null ? [] : noticeRows.filter((n) => n.id !== id)
  noticeEmit()
  void supabase.rpc('notice_read', { p_id: id }).then(() => undefined, () => undefined)
}
/** Mark every unread support reply as read (the owner opened Help & support). */
export function readSupportNotices() {
  noticeRows.filter((n) => n.kind === 'support').forEach((n) => readNotice(n.id))
}
export function useNotices(): Notice[] {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    noticeSubs.add(f)
    if (!noticeLoaded) refreshNotices()
    if (!noticeTimer) noticeTimer = window.setInterval(refreshNotices, 120000)
    const onVis = () => { if (document.visibilityState === 'visible') refreshNotices() }
    document.addEventListener('visibilitychange', onVis)
    return () => { noticeSubs.delete(f); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return noticeRows
}
export type { Notice }

export function ShopNotices({ onPlan }: { onPlan: () => void }) {
  const { t, lang } = useI18n()
  const rows = useNotices()
  const close = (id: number) => readNotice(id)
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
  useEffect(() => { load(); readSupportNotices() }, [load])
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

export function CouponBox({ onDone, deal, onDeal }: { onDone: () => Promise<void> | void; deal?: CouponDeal | null; onDeal?: (d: CouponDeal | null) => void }) {
  const { t, te, lang } = useI18n()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const errKey: Record<string, Key> = { not_found: 'cpNotFound', expired: 'cpExpired', used_up: 'cpUsedUp', already: 'cpAlready', too_many: 'cpTooMany', blocked: 'cpNotFound', disabled: 'cpOff' }
  const redeem = async (e: FormEvent) => {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (c.length < 3) return
    setBusy(true)
    setMsg(null)
    try {
      const { data, error } = await supabase.rpc('redeem_coupon', { p_code: c })
      if (error) { setMsg({ text: te(error), error: true }); return }
      const r = data as { ok: boolean; error?: string; until?: string; days?: number }
      if (!r.ok && r.error === 'checkout') {
        // v40 % off code: the server checks it and gives the prices; it is applied when paying.
        if (!onDeal) { setMsg({ text: t('cpPctHere'), error: true }); return }
        const p = await previewCoupon(c)
        if (!p.ok) { setMsg({ text: t(errKey[p.error] || 'cpNotFound'), error: true }); return }
        if (p.kind !== 'percent') { setMsg({ text: t('cpNotFound'), error: true }); return }
        setCode('')
        onDeal({ code: p.code, percent: p.percent, mode: p.mode, tiers: p.tiers, periods: p.periods, expires_at: p.expires_at, prices: p.prices })
        return
      }
      if (!r.ok) { setMsg({ text: t(errKey[r.error || ''] || 'cpNotFound'), error: true }); return }
      const date = r.until ? new Date(r.until).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
      setCode('')
      setMsg({ text: t('cpDone', { n: r.days ?? 0, date }), error: false })
      await onDone()
    } catch (err) {
      setMsg({ text: te(err), error: true })
    } finally {
      setBusy(false)
    }
  }
  const tierName = (x: string) => (x === 'plus' ? 'Plus' : 'Pro')
  const perName = (x: string) => (x === 'yearly' ? t('planYearly') : t('planMonthly'))
  return (
    <form className="card form-card coupon-box" onSubmit={redeem}>
      <h2 className="card-title">{t('cpTitle')}</h2>
      {deal ? (
        <div className="coupon-deal">
          <div className="coupon-deal-top">
            <b className="mono">{deal.code}</b>
            <span className="pro-badge">{deal.percent ? t('cpPctOff', { n: deal.percent }) : t('cpOffer')}</span>
          </div>
          <p className="small">{deal.mode === 'auto' ? t('cpPctEvery') : t('cpPctOfferNote')}</p>
          <p className="small muted">{t('cpPctFor', { plans: deal.tiers.map(tierName).join(' / '), periods: deal.periods.map(perName).join(' / ') })}</p>
          <button type="button" className="btn small soft" onClick={() => onDeal?.(null)}>{t('cpRemove')}</button>
        </div>
      ) : (
        <div className="coupon-row">
          <input value={code} maxLength={30} autoCapitalize="characters" placeholder={t('cpPh')} aria-label={t('cpTitle')}
            onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={busy} />
          <button className="btn" disabled={busy || code.trim().length < 3}>{busy ? '…' : t('cpApply')}</button>
        </div>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </form>
  )
}
