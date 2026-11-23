import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../components/Icon'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import type { Key } from '../lib/i18n'
import { routeHref } from '../lib/router'
import { callFn } from '../lib/billing'
import { rupees } from '../lib/pricing'
import { ask as askConfirm } from '../components/ConfirmHost'
import { SkelList, SkelStats } from '../components/Skeletons'
import { fmtBytes, fmtDate } from './AdminTabs'

/* v39 admin tools: error viewer, growth graphs + CSV export, support inbox, coupon codes, reach (expiring plans,
   inactive shops, targeted push), view as shop, admin roles, backup status, admin new-device check.
   Every RPC checks is_admin() / is_owner_admin() in SQL; the page only hides what a role cannot use. */

type Msg = (m: { text: string; error?: boolean } | null) => void

function useDT() {
  const { lang } = useI18n()
  return (s: string | null | undefined) => s
    ? new Date(s).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '—'
}

/** Modal sheet (same look as the bell). */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="adm-notif-back no-print" onClick={onClose}>
      <div className="adm-notif adx-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="adm-notif-head">
          <b className="admin-ellipsis">{title}</b>
          <button type="button" className="menu-btn" onClick={onClose} aria-label={t('close')}><Icon name="x" size={20} /></button>
        </div>
        <div className="adm-notif-list adx-sheet-body">{children}</div>
      </div>
    </div>
  )
}

/* ---------------- Admin login from a new device ---------------- */

const DEVICE_KEY = 'pq_admin_device'
/** Records this browser / phone for the signed-in admin (once per page load). A new device alerts every admin. */
export function recordAdminDevice(): void {
  try {
    let id = localStorage.getItem(DEVICE_KEY) || ''
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      const b = new Uint8Array(16)
      crypto.getRandomValues(b)
      id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(DEVICE_KEY, id)
    }
    void supabase.rpc('admin_device_seen', { p_device: id, p_ua: navigator.userAgent.slice(0, 300) }).then(() => undefined, () => undefined)
  } catch { /* private mode etc. */ }
}

/* ---------------- Backup status (Overview) ---------------- */

type BackupStatus = { last: { ran_at: string; status: string; size_bytes: number | null } | null; last_ok: { ran_at: string; size_bytes: number | null } | null }

export function BackupCard() {
  const { t } = useI18n()
  const dt = useDT()
  const [b, setB] = useState<BackupStatus | null | undefined>(undefined)
  useEffect(() => {
    supabase.rpc('admin_backup_status').then(({ data, error }) => setB(error ? null : (data as BackupStatus)), () => setB(null))
  }, [])
  if (b === null) return null // before v39 SQL
  const okAt = b?.last_ok?.ran_at
  const stale = !!b && (!okAt || Date.now() - new Date(okAt).getTime() > 36 * 3600 * 1000)
  const st = b?.last?.status
  return (
    <div className={`card stat stat-wide${stale ? ' warn' : ''}`}>
      <div className="small stat-label">{t('adxBackup')}</div>
      <div className="big-num small-num">{b === undefined ? '…' : okAt ? dt(okAt) : '—'}</div>
      <div className="small stat-sub">
        {b === undefined ? '' : !b.last ? t('adxBackupNone') : t('adxBackupLine', {
          size: b.last_ok?.size_bytes ? fmtBytes(Number(b.last_ok.size_bytes)) : '—',
          status: st === 'ok' ? t('adxBackupOk') : st === 'failed' ? t('adxBackupFailed') : t('adxBackupSkipped')
        })}
      </div>
    </div>
  )
}

/* ---------------- Error viewer ---------------- */

type ErrItem = { at: string; source: string; route: string | null; version: string | null; ua: string | null; stack: string | null }
type ErrGroup = { message: string; count: number; first_seen: string; last_seen: string; sources: string[]; items: ErrItem[] }
const SRC_KEY: Record<string, Key> = { 'client-web': 'adxSrcWeb', 'client-app': 'adxSrcApp', 'client-desktop': 'adxSrcDesktop' }

function shortUa(ua: string | null): string {
  if (!ua) return '—'
  const app = /PrintQR(?:App)?\/[\w.]+/.exec(ua)?.[0]
  const os = /Android [\d.]+|iPhone OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|Linux/.exec(ua)?.[0]
  const br = /(Edg|Chrome|Firefox|Version)\/[\d]+/.exec(ua)?.[0]
  return [app, os, br].filter(Boolean).join(' · ') || ua.slice(0, 60)
}

export function AdminErrors({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw } = useI18n()
  const dt = useDT()
  const [hours, setHours] = useState(24)
  const [rows, setRows] = useState<ErrGroup[] | null>(null)
  const [open, setOpen] = useState<ErrGroup | null>(null)
  useEffect(() => {
    setRows(null)
    supabase.rpc('admin_client_errors', { p_hours: hours }).then(({ data, error }) => {
      if (error) { onMsg({ text: teRaw(error), error: true }); setRows([]); return }
      setRows((data || []) as ErrGroup[])
    })
  }, [hours, onMsg, teRaw])
  const total = rows ? rows.reduce((s, r) => s + r.count, 0) : 0
  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('adxErrors')}</h2>
      <p className="small muted">{t('adxErrorsHint')}</p>
      <div className="seg" role="group" aria-label={t('adxErrors')}>
        {[24, 168].map((h) => (
          <button type="button" key={h} className={hours === h ? 'on' : ''} aria-pressed={hours === h} onClick={() => setHours(h)}>
            {h === 24 ? t('adx24h') : t('adx7d')}
          </button>
        ))}
      </div>
      {!rows ? <SkelList /> : rows.length === 0 ? <p className="muted">{t('adxNoErrors')}</p> : (
        <div className="admin-list">
          <p className="small muted">{t('adxErrTotal', { n: total, g: rows.length })}</p>
          {rows.map((g) => {
            const last = g.items[0]
            return (
              <button type="button" className="card admin-item adx-tap" key={g.message} onClick={() => setOpen(g)}>
                <div className="admin-item-top">
                  <b className="adx-err-msg">{g.message}</b>
                  <span className="admin-tag bad">{g.count}×</span>
                </div>
                <div className="small muted">
                  {t('adxLastSeen', { d: dt(g.last_seen) })} · {g.sources.map((s) => (SRC_KEY[s] ? t(SRC_KEY[s]) : s)).join(', ')}
                  {last?.route ? ` · ${last.route}` : ''}{last?.version ? ` · v${last.version}` : ''}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {open && (
        <Sheet title={t('adxErrDetail')} onClose={() => setOpen(null)}>
          <p className="small adx-mono-wrap"><b>{open.message}</b></p>
          <p className="small muted">{t('adxErrSeen', { n: open.count, a: dt(open.first_seen), b: dt(open.last_seen) })}</p>
          {open.items.map((it, i) => (
            <div className="adm-notif-item" key={i}>
              <div className="small"><b>{dt(it.at)}</b> · {SRC_KEY[it.source] ? t(SRC_KEY[it.source]) : it.source}</div>
              <dl className="admin-facts adx-facts">
                <dt>{t('adxRoute')}</dt><dd>{it.route || '—'}</dd>
                <dt>{t('adxVersion')}</dt><dd>{it.version || '—'}</dd>
                <dt>{t('adxDevice')}</dt><dd title={it.ua || ''}>{shortUa(it.ua)}</dd>
              </dl>
              {it.ua && <details className="small"><summary>{t('adxFullUa')}</summary><code className="adx-mono-wrap">{it.ua}</code></details>}
              {it.stack && <details className="small" open={i === 0}><summary>{t('adxStack')}</summary><pre className="adx-pre">{it.stack}</pre></details>}
            </div>
          ))}
        </Sheet>
      )}
    </>
  )
}

/* ---------------- Growth graphs + CSV export ---------------- */

type Day = { day: string; shops: number; orders: number; pages: number; payments: number; amount: number; upgrades: number }

function BarChart({ data, pick, label, money, lang }: { data: Day[]; pick: (d: Day) => number; label: string; money?: boolean; lang: string }) {
  const { t } = useI18n()
  const [sel, setSel] = useState<number | null>(null)
  const vals = data.map(pick)
  const max = Math.max(1, ...vals)
  const total = vals.reduce((a, b) => a + b, 0)
  const n = vals.length
  const W = n * 10
  const H = 60
  const fmt = (v: number) => (money ? rupees(v) : v.toLocaleString('en-IN'))
  const dayText = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short' })
  const i = sel ?? n - 1
  return (
    <div className="card adx-chart">
      <div className="adx-chart-top">
        <span className="small stat-label">{label}</span>
        <b>{fmt(total)}</b>
      </div>
      <div className="small muted adx-chart-sel">{n ? `${dayText(data[i].day)}: ${fmt(vals[i])}` : ''}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="adx-svg" role="img" aria-label={`${label}: ${fmt(total)}`}
        onMouseLeave={() => setSel(null)}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="adx-axis" />
        {vals.map((v, k) => {
          const h = v ? Math.max(1.5, (v / max) * (H - 4)) : 0
          return (
            <g key={k} onMouseEnter={() => setSel(k)} onClick={() => setSel(k)}>
              <rect x={k * 10} y="0" width="10" height={H} fill="transparent" />
              <rect x={k * 10 + 1.5} y={H - h} width="7" height={h} rx="1.5" className={`adx-bar${k === i ? ' on' : ''}`} />
            </g>
          )
        })}
      </svg>
      <div className="small muted adx-chart-axis"><span>{n ? dayText(data[0].day) : ''}</span><span>{t('adxMax', { n: fmt(max) })}</span><span>{n ? dayText(data[n - 1].day) : ''}</span></div>
    </div>
  )
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n')
}

function downloadText(name: string, text: string) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

function ExportCard({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw } = useI18n()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (kind: 'shops' | 'orders' | 'payments') => {
    setBusy(kind)
    onMsg(null)
    const { data, error } = await supabase.rpc('admin_export', { p_kind: kind, p_from: from || null, p_to: to || null })
    setBusy(null)
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    const rows = (data || []) as Record<string, unknown>[]
    if (!rows.length) { onMsg({ text: t('adxExportEmpty') }); return }
    downloadText(`printqr-${kind}-${from || 'all'}${to ? '-' + to : ''}.csv`, toCsv(rows))
    onMsg({ text: t('adxExported', { n: rows.length }) })
  }
  const label: Record<string, Key> = { shops: 'admShops', orders: 'admOrders', payments: 'admPayments' }
  return (
    <div className="card admin-settings">
      <h2 className="admin-sec">{t('adxExport')}</h2>
      <p className="small muted">{t('adxExportHint')}</p>
      <div className="grid2">
        <label className="field"><span>{t('adxFrom')}</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>{t('adxTo')}</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="admin-row">
        {(['shops', 'orders', 'payments'] as const).map((k) => (
          <button type="button" key={k} className="btn small soft" disabled={busy !== null} onClick={() => void run(k)}>
            <Icon name="download" size={16} /> {busy === k ? '…' : t(label[k])}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AdminGrowth({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw, lang } = useI18n()
  const [rows, setRows] = useState<Day[] | null>(null)
  useEffect(() => {
    supabase.rpc('admin_growth', { p_days: 30 }).then(({ data, error }) => {
      if (error) { onMsg({ text: teRaw(error), error: true }); setRows([]); return }
      setRows((data || []) as Day[])
    })
  }, [onMsg, teRaw])
  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('adxGrowth')}</h2>
      <p className="small muted">{t('adxGrowthHint')}</p>
      {!rows ? <SkelStats n={4} /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="adx-charts">
          <BarChart data={rows} pick={(d) => d.shops} label={t('adxNewShops')} lang={lang} />
          <BarChart data={rows} pick={(d) => d.orders} label={t('admOrders')} lang={lang} />
          <BarChart data={rows} pick={(d) => Number(d.pages)} label={t('adxPages')} lang={lang} />
          <BarChart data={rows} pick={(d) => d.upgrades} label={t('adxUpgrades')} lang={lang} />
          <BarChart data={rows} pick={(d) => d.payments} label={t('adxPaymentsN')} lang={lang} />
          <BarChart data={rows} pick={(d) => Number(d.amount)} label={t('adxIncome')} money lang={lang} />
        </div>
      )}
      <ExportCard onMsg={onMsg} />
    </>
  )
}

/* ---------------- Support inbox ---------------- */

type Ticket = { id: number; shop_id: string; shop_name: string; slug: string; owner_email: string | null; phone: string | null
  topic: string; message: string; app: string | null; status: string; reply: string | null; replied_at: string | null; created_at: string }
export const TOPIC_KEY: Record<string, Key> = { problem: 'supTopicProblem', feedback: 'supTopicFeedback', billing: 'supTopicBilling', other: 'supTopicOther' }

export function AdminSupport({ onMsg, onView }: { onMsg: Msg; onView: (shopId: string) => void }) {
  const { t, teRaw } = useI18n()
  const dt = useDT()
  const [filter, setFilter] = useState<'open' | 'solved' | 'all'>('open')
  const [rows, setRows] = useState<Ticket[] | null>(null)
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const load = useCallback(async (f: string) => {
    const { data, error } = await supabase.rpc('admin_support', { p_status: f, p_limit: 200 })
    if (error) { onMsg({ text: teRaw(error), error: true }); setRows([]); return }
    setRows((data || []) as Ticket[])
  }, [onMsg, teRaw])
  useEffect(() => { setRows(null); void load(filter) }, [filter, load])
  const act = async (r: Ticket, status: 'open' | 'solved' | null) => {
    const reply = (draft[r.id] || '').trim()
    if (!reply && !status) return
    setBusy(r.id)
    onMsg(null)
    const { error } = await supabase.rpc('admin_support_reply', { p_id: r.id, p_reply: reply || null, p_status: status })
    setBusy(null)
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    setDraft((m) => ({ ...m, [r.id]: '' }))
    onMsg({ text: reply ? t('adxReplied') : t('admDone') })
    void load(filter)
  }
  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('adxSupport')}</h2>
      <p className="small muted">{t('adxSupportHint')}</p>
      <div className="seg" role="group" aria-label={t('adxSupport')}>
        {(['open', 'solved', 'all'] as const).map((f) => (
          <button type="button" key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'open' ? t('adxOpen') : f === 'solved' ? t('adxSolved') : t('admFilterAll')}
          </button>
        ))}
      </div>
      {!rows ? <SkelList /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {rows.map((r) => (
            <div className={`card admin-item${r.status === 'solved' ? ' is-done' : ''}`} key={r.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">{r.shop_name}</b>
                <span className="admin-tags">
                  <span className="admin-tag">{t(TOPIC_KEY[r.topic] || 'supTopicOther')}</span>
                  <span className={`admin-tag${r.status === 'open' ? ' bad' : ''}`}>{r.status === 'open' ? t('adxOpen') : t('adxSolved')}</span>
                </span>
              </div>
              <div className="small muted admin-ellipsis">{dt(r.created_at)} · {r.owner_email || '—'}{r.phone ? ` · ${r.phone}` : ''}{r.app ? ` · ${r.app}` : ''}</div>
              <p className="small admin-quote">{r.message}</p>
              {r.reply && <p className="small admin-quote adx-reply"><b>{t('adxYourReply')}</b> {r.reply} <span className="muted">· {dt(r.replied_at)}</span></p>}
              <textarea className="adx-ta" rows={2} maxLength={2000} value={draft[r.id] || ''} placeholder={t('adxReplyPh')} disabled={busy === r.id}
                onChange={(e) => setDraft((m) => ({ ...m, [r.id]: e.target.value }))} aria-label={t('adxReplyPh')} />
              <div className="admin-row">
                <button type="button" className="btn small" disabled={busy === r.id || !(draft[r.id] || '').trim()} onClick={() => void act(r, null)}>{t('adxSendReply')}</button>
                {r.status === 'open'
                  ? <button type="button" className="btn small soft" disabled={busy === r.id} onClick={() => void act(r, 'solved')}>{(draft[r.id] || '').trim() ? t('adxReplySolve') : t('adxMarkSolved')}</button>
                  : <button type="button" className="btn small soft" disabled={busy === r.id} onClick={() => void act(r, 'open')}>{t('adxReopen')}</button>}
                <button type="button" className="btn small soft" onClick={() => onView(r.shop_id)}>{t('adxViewShop')}</button>
                <a className="btn small soft" href={routeHref(`/s/${r.slug}`)} target="_blank" rel="noreferrer">/s/{r.slug}</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ---------------- Coupons ---------------- */

type Coupon = { code: string; kind: string; days: number; tier: string; expires_at: string | null; max_uses: number | null; uses: number; active: boolean; note: string | null; created_at: string }

export function AdminCoupons({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw, lang } = useI18n()
  const [rows, setRows] = useState<Coupon[] | null>(null)
  const [f, setF] = useState({ code: '', days: '30', tier: 'pro', expires: '', max: '', note: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_coupons')
    if (error) { onMsg({ text: teRaw(error), error: true }); setRows([]); return }
    setRows((data || []) as Coupon[])
  }, [onMsg, teRaw])
  useEffect(() => { void load() }, [load])
  const save = async (c: { code: string; days: number; tier: string; expires_at: string | null; max_uses: number | null; active: boolean; note: string | null }) => {
    setBusy(true)
    onMsg(null)
    const { error } = await supabase.rpc('admin_coupon_save', {
      p_code: c.code, p_days: c.days, p_tier: c.tier, p_expires_at: c.expires_at, p_max_uses: c.max_uses, p_active: c.active, p_note: c.note
    })
    setBusy(false)
    if (error) { onMsg({ text: teRaw(error), error: true }); return false }
    onMsg({ text: t('saved') })
    void load()
    return true
  }
  const create = async (e: FormEvent) => {
    e.preventDefault()
    const code = f.code.trim().toUpperCase()
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) { onMsg({ text: t('adxCodeBad'), error: true }); return }
    // End of the chosen day, India time
    const exp = f.expires ? new Date(`${f.expires}T23:59:59+05:30`).toISOString() : null
    const ok = await save({ code, days: Math.floor(Number(f.days)), tier: f.tier, expires_at: exp, max_uses: f.max ? Math.floor(Number(f.max)) : null, active: true, note: f.note.trim() || null })
    if (ok) setF({ code: '', days: '30', tier: 'pro', expires: '', max: '', note: '' })
  }
  const expired = (c: Coupon) => !!c.expires_at && new Date(c.expires_at).getTime() < Date.now()
  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('adxCoupons')}</h2>
      <form className="card admin-settings" onSubmit={create}>
        <h2 className="admin-sec">{t('adxNewCoupon')}</h2>
        <p className="small muted">{t('adxCouponHint')}</p>
        <div className="grid2">
          <label className="field"><span>{t('adxCode')}</span>
            <input required value={f.code} maxLength={30} autoCapitalize="characters" placeholder="DIWALI30" onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>{t('adxFreeDays')}</span>
            <input required type="number" min={1} max={366} inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
          <label className="field"><span>{t('admPlan')}</span>
            <select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
              <option value="pro">{t('admTagPro')}</option><option value="plus">{t('admTagPlus')}</option>
            </select></label>
          <label className="field"><span>{t('adxExpires')}</span>
            <input type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></label>
          <label className="field"><span>{t('adxMaxUses')}</span>
            <input type="number" min={1} inputMode="numeric" value={f.max} placeholder={t('adxNoLimit')} onChange={(e) => setF({ ...f, max: e.target.value })} /></label>
          <label className="field"><span>{t('adxNote')}</span>
            <input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        <button className="btn primary" disabled={busy || !(Number(f.days) >= 1)}>{busy ? t('pleaseWait') : t('adxCreate')}</button>
      </form>
      <p className="small muted">{t('adxPctNote')}</p>
      {!rows ? <SkelList n={2} /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {rows.map((c) => (
            <div className={`card admin-item${!c.active || expired(c) ? ' is-done' : ''}`} key={c.code}>
              <div className="admin-item-top">
                <b className="mono admin-ellipsis">{c.code}</b>
                <span className="admin-tags">
                  <span className="admin-tag pro">+{c.days} {t('admDays')} {c.tier === 'plus' ? t('admTagPlus') : t('admTagPro')}</span>
                  {!c.active ? <span className="admin-tag">{t('adxOff')}</span> : expired(c) ? <span className="admin-tag bad">{t('adxExpired')}</span> : null}
                </span>
              </div>
              <div className="small muted">
                {t('adxUses', { n: c.uses, m: c.max_uses ?? '∞' })} · {c.expires_at ? t('admUntil', { date: fmtDate(c.expires_at, lang) }) : t('adxNoExpiry')}{c.note ? ` · ${c.note}` : ''}
              </div>
              <div className="admin-row">
                <button type="button" className="btn small soft" disabled={busy}
                  onClick={() => void save({ code: c.code, days: c.days, tier: c.tier, expires_at: c.expires_at, max_uses: c.max_uses, active: !c.active, note: c.note })}>
                  {c.active ? t('adxTurnOff') : t('adxTurnOn')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ---------------- Reach: expiring plans, inactive shops, targeted push ---------------- */

type Expiring = { id: string; name: string; slug: string; owner_email: string | null; phone: string | null; plan: string; plan_expires_at: string; paid: boolean; subscription_status: string | null; last_reminded: string | null }
type Inactive = { id: string; name: string; slug: string; owner_email: string | null; phone: string | null; created_at: string; is_pro: boolean; orders_total: number; last_order_at: string | null; last_nudged: string | null }

function PushCompose({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw } = useI18n()
  const [seg, setSeg] = useState<'all' | 'pro' | 'free' | 'city'>('all')
  const [city, setCity] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [inApp, setInApp] = useState(true)
  const [count, setCount] = useState<{ shops: number; devices: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setCount(null)
    if (seg === 'city' && city.trim().length < 2) return
    const h = window.setTimeout(() => {
      supabase.rpc('admin_segment_count', { p_segment: seg, p_city: seg === 'city' ? city.trim() : null })
        .then(({ data, error }) => { if (!error) setCount(data as { shops: number; devices: number }) })
    }, 350)
    return () => window.clearTimeout(h)
  }, [seg, city])
  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!await askConfirm(t('adxPushAsk', { n: count?.shops ?? 0 }), { danger: false, icon: 'bell' })) return
    setBusy(true)
    onMsg(null)
    try {
      const r = await callFn<{ shops: number; devices: number; sent: number; push_ready: boolean }>('admin-action',
        { action: 'push_send', segment: seg, city: seg === 'city' ? city.trim() : undefined, title: title.trim(), body: body.trim(), in_app: inApp })
      onMsg({ text: r.push_ready ? t('adxPushSent', { s: r.shops, d: r.sent }) : t('adxPushNoFcm', { s: r.shops }) })
      setTitle('')
      setBody('')
    } catch (err) {
      onMsg({ text: teRaw(err), error: true })
    } finally {
      setBusy(false)
    }
  }
  const segKey: Record<string, Key> = { all: 'adxSegAll', pro: 'adxSegPro', free: 'adxSegFree', city: 'adxSegCity' }
  return (
    <form className="card admin-settings" onSubmit={send}>
      <h2 className="admin-sec">{t('adxPush')}</h2>
      <p className="small muted">{t('adxPushHint')}</p>
      <div className="seg" role="group" aria-label={t('adxPushTo')}>
        {(['all', 'pro', 'free', 'city'] as const).map((s) => (
          <button type="button" key={s} className={seg === s ? 'on' : ''} aria-pressed={seg === s} onClick={() => setSeg(s)}>{t(segKey[s])}</button>
        ))}
      </div>
      {seg === 'city' && <label className="field"><span>{t('adxCity')}</span><input value={city} maxLength={60} onChange={(e) => setCity(e.target.value)} placeholder={t('adxCityPh')} /></label>}
      <label className="field"><span>{t('adxPushTitle')}</span><input required minLength={2} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>{t('adxPushBody')}</span><textarea className="adx-ta" required minLength={2} maxLength={300} rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="admin-check"><input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} /> <span>{t('adxAlsoInApp')}</span></label>
      <p className="small muted">{count ? t('adxReach', { s: count.shops, d: count.devices }) : '…'}</p>
      <button className="btn primary" disabled={busy || !count?.shops || title.trim().length < 2 || body.trim().length < 2}>{busy ? t('pleaseWait') : t('adxSend')}</button>
    </form>
  )
}

export function AdminReach({ onMsg, onView }: { onMsg: Msg; onView: (shopId: string) => void }) {
  const { t, teRaw, lang } = useI18n()
  const dt = useDT()
  const [exp, setExp] = useState<Expiring[] | null>(null)
  const [ina, setIna] = useState<Inactive[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([supabase.rpc('admin_expiring', { p_days: 7 }), supabase.rpc('admin_inactive', { p_days: 14, p_limit: 100 })])
    if (a.error || b.error) onMsg({ text: teRaw(a.error || b.error), error: true })
    setExp((a.data || []) as Expiring[])
    setIna((b.data || []) as Inactive[])
  }, [onMsg, teRaw])
  useEffect(() => { void load() }, [load])
  const notify = async (id: string, kind: 'expiring' | 'nudge') => {
    setBusy(id + kind)
    onMsg(null)
    try {
      const r = await callFn<{ devices: number; sent: number; push_ready: boolean }>('admin-action', { action: 'notify_shop', shop_id: id, kind })
      onMsg({ text: r.sent ? t('adxNotified', { n: r.sent }) : t('adxNotifiedApp') })
      void load()
    } catch (e) {
      onMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('adxReachTab')}</h2>
      <h2 className="admin-sec">{t('adxExpiring')} {exp ? `(${exp.length})` : ''}</h2>
      <p className="small muted">{t('adxExpiringHint')}</p>
      {!exp ? <SkelList n={2} /> : exp.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {exp.map((s) => (
            <div className="card admin-item" key={s.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">{s.name}</b>
                <span className="admin-tags">
                  <span className="admin-tag pro">{s.plan === 'plus' ? t('admTagPlus') : t('admTagPro')}</span>
                  {s.paid && s.subscription_status === 'active' && <span className="admin-tag">{t('adxAutoRenew')}</span>}
                </span>
              </div>
              <div className="small muted admin-ellipsis">{t('admUntil', { date: fmtDate(s.plan_expires_at, lang) })} · {s.owner_email || '—'}{s.phone ? ` · ${s.phone}` : ''}</div>
              {s.last_reminded && <div className="small muted">{t('adxLastReminded', { d: dt(s.last_reminded) })}</div>}
              <div className="admin-row">
                <button type="button" className="btn small" disabled={busy !== null} onClick={() => void notify(s.id, 'expiring')}>{busy === s.id + 'expiring' ? '…' : t('adxRemind')}</button>
                <button type="button" className="btn small soft" onClick={() => onView(s.id)}>{t('adxViewShop')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="admin-sec">{t('adxInactive')} {ina ? `(${ina.length})` : ''}</h2>
      <p className="small muted">{t('adxInactiveHint')}</p>
      {!ina ? <SkelList n={2} /> : ina.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {ina.map((s) => (
            <div className="card admin-item" key={s.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">{s.name}</b>
                <span className="admin-tags">{s.is_pro ? <span className="admin-tag pro">{t('admTagPro')}</span> : <span className="admin-tag">{t('admTagFree')}</span>}</span>
              </div>
              <div className="small muted admin-ellipsis">
                {s.last_order_at ? t('adxLastOrder', { d: fmtDate(s.last_order_at, lang), n: s.orders_total }) : t('adxNoOrders', { d: fmtDate(s.created_at, lang) })} · {s.owner_email || '—'}
              </div>
              {s.last_nudged && <div className="small muted">{t('adxLastNudged', { d: dt(s.last_nudged) })}</div>}
              <div className="admin-row">
                <button type="button" className="btn small" disabled={busy !== null} onClick={() => void notify(s.id, 'nudge')}>{busy === s.id + 'nudge' ? '…' : t('adxNudge')}</button>
                <button type="button" className="btn small soft" onClick={() => onView(s.id)}>{t('adxViewShop')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <PushCompose onMsg={onMsg} />
    </>
  )
}

/* ---------------- View as shop (read-only) ---------------- */

type ShopView = {
  shop: { id: string; name: string; slug: string; address: string | null; phone: string | null; upi: boolean; is_open: boolean
    rates: Record<string, number>; auto_delete_hours: number; paper_sheets: number | null; brand_color: string | null; logo: boolean
    plan: string; is_pro: boolean; plan_period: string | null; plan_expires_at: string | null; subscription_status: string | null
    blocked: boolean; blocked_reason: string | null; created_at: string }
  owner_email: string | null
  counters: string[]; staff: number
  orders: { token: number; status: string; total: number; counter: string | null; created_at: string; files_deleted: boolean; files: number; pages: number }[]
  tickets: { id: number; status: string; message: string; created_at: string }[]
  payments: { amount: number; tier: string; period: string | null; paid_at: string }[] | null
}

const RATE_KEY: Record<string, Key> = { bw_single: 'adxRateBw', bw_double: 'adxRateBwD', color_single: 'adxRateColor', color_double: 'adxRateColorD', passport_sheet: 'adxRatePassport' }

export function AdminShopView({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const { t, teRaw, lang } = useI18n()
  const dt = useDT()
  const [v, setV] = useState<ShopView | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    supabase.rpc('admin_shop_view', { p_shop: shopId }).then(({ data, error }) => {
      if (error) setErr(teRaw(error))
      else setV(data as ShopView)
    })
  }, [shopId, teRaw])
  const rates = useMemo(() => Object.entries(v?.shop.rates || {}).filter(([k]) => RATE_KEY[k]), [v])
  return (
    <Sheet title={v ? t('adxViewTitle', { name: v.shop.name }) : t('adxViewShop')} onClose={onClose}>
      <p className="small adx-ro"><Icon name="lock" size={14} className="ico-inl" /> {t('adxReadOnly')}</p>
      {err && <p className="notice error">{err}</p>}
      {!v && !err && <SkelList n={2} />}
      {v && (
        <>
          <dl className="admin-facts adx-facts">
            <dt>{t('admLink')}</dt><dd><a href={routeHref(`/s/${v.shop.slug}`)} target="_blank" rel="noreferrer">/s/{v.shop.slug}</a></dd>
            <dt>{t('adxOwner')}</dt><dd>{v.owner_email || '—'}</dd>
            <dt>{t('admPhone')}</dt><dd>{v.shop.phone || '—'}</dd>
            <dt>{t('adxAddress')}</dt><dd>{v.shop.address || '—'}</dd>
            <dt>{t('admPlan')}</dt><dd>{v.shop.is_pro ? `${v.shop.plan === 'plus' ? t('admTagPlus') : t('admTagPro')} · ${t('admUntil', { date: fmtDate(v.shop.plan_expires_at, lang) })}` : t('admTagFree')}{v.shop.subscription_status ? ` · ${v.shop.subscription_status}` : ''}</dd>
            <dt>{t('admOpenNow')}</dt><dd>{v.shop.is_open ? t('admYes') : t('admNo')}</dd>
            <dt>{t('adxUpi')}</dt><dd>{v.shop.upi ? t('admYes') : t('admNo')}</dd>
            <dt>{t('adxKeepFiles')}</dt><dd>{v.shop.auto_delete_hours} h</dd>
            <dt>{t('adxPaper')}</dt><dd>{v.shop.paper_sheets ?? '—'}</dd>
            <dt>{t('admCounters')}</dt><dd>{v.counters.length ? v.counters.join(', ') : '—'}</dd>
            <dt>{t('adxStaff')}</dt><dd>{v.staff}</dd>
            <dt>{t('admJoined')}</dt><dd>{fmtDate(v.shop.created_at, lang)}</dd>
            {v.shop.blocked && <><dt>{t('admReason')}</dt><dd>{v.shop.blocked_reason || '—'}</dd></>}
          </dl>
          {rates.length > 0 && (
            <div className="adm-notif-item">
              <b className="small">{t('adxRates')}</b>
              <div className="small">{rates.map(([k, r]) => `${t(RATE_KEY[k])}: ${rupees(Number(r))}`).join(' · ')}</div>
            </div>
          )}
          <div className="adm-notif-item">
            <b className="small">{t('adxRecentOrders', { n: v.orders.length })}</b>
            {v.orders.length === 0 ? <span className="small muted">{t('admNothing')}</span> : (
              <div className="adx-table-wrap">
                <table className="adx-table small">
                  <thead><tr><th>#</th><th>{t('adxWhen')}</th><th>{t('adxStatus')}</th><th>{t('adxPagesShort')}</th><th>{t('adxTotal')}</th></tr></thead>
                  <tbody>
                    {v.orders.map((o) => (
                      <tr key={o.token + o.created_at}><td>{o.token}</td><td>{dt(o.created_at)}</td><td>{o.status}</td><td>{o.pages}</td><td>{rupees(Number(o.total))}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {v.tickets.length > 0 && (
            <div className="adm-notif-item">
              <b className="small">{t('adxSupport')}</b>
              {v.tickets.map((x) => <div className="small" key={x.id}>{dt(x.created_at)} · {x.status === 'open' ? t('adxOpen') : t('adxSolved')} · {x.message}</div>)}
            </div>
          )}
          {v.payments && (
            <div className="adm-notif-item">
              <b className="small">{t('admPayments')}</b>
              {v.payments.length === 0 ? <span className="small muted">{t('admNothing')}</span>
                : v.payments.map((p, i) => <div className="small" key={i}>{fmtDate(p.paid_at, lang)} · {rupees(p.amount / 100)} · {p.tier} {p.period || ''}</div>)}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

/* ---------------- Admin roles (Users tab, owner only) ---------------- */

type AdminRow = { user_id: string; email: string | null; role: string; created_at: string; is_me: boolean }

export function AdminRoles({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw } = useI18n()
  const [rows, setRows] = useState<AdminRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_list')
    if (error) { setRows([]); return } // before v39 SQL: section stays empty
    setRows((data || []) as AdminRow[])
  }, [])
  useEffect(() => { void load() }, [load])
  const change = async (a: AdminRow, role: string) => {
    if (a.is_me && role !== 'owner' && !await askConfirm(t('adxRoleSelfAsk'))) return
    setBusy(a.user_id)
    onMsg(null)
    const { error } = await supabase.rpc('admin_set_role', { p_user: a.user_id, p_role: role })
    setBusy(null)
    if (error) { onMsg({ text: /last owner/.test(error.message) ? t('adxLastOwner') : teRaw(error), error: true }); return }
    onMsg({ text: t('saved') })
    void load()
  }
  if (!rows || rows.length === 0) return null
  return (
    <>
      <h2 className="admin-sec">{t('adxAdmins')}</h2>
      <p className="small muted">{t('adxRolesHint')}</p>
      <div className="card admin-log">
        {rows.map((a) => (
          <div className="admin-log-row small adx-role-row" key={a.user_id}>
            <span className="admin-ellipsis">{a.email || a.user_id.slice(0, 8)}{a.is_me ? ` (${t('adxYou')})` : ''}</span>
            <select value={a.role} disabled={busy === a.user_id} onChange={(e) => void change(a, e.target.value)} aria-label={t('adxRole')}>
              <option value="owner">{t('adxRoleOwner')}</option>
              <option value="support">{t('adxRoleSupport')}</option>
            </select>
          </div>
        ))}
      </div>
    </>
  )
}
