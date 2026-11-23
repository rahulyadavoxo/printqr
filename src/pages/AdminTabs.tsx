import { FormEvent, Fragment, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { routeHref } from '../lib/router'
import { callFn } from '../lib/billing'
import { AppSettings, DEFAULT_SETTINGS, DESIGNS_FOR, LANDING_DESIGNS, LOGIN_PLATFORMS, LandingDesign, LoginDesign, LoginPlatform, landingDesignFor, loginDesignFor, setAppSettingsCache } from '../lib/appSettings'
import type { Key } from '../lib/i18n'

const LOGIN_DESIGN_LABEL: Record<LoginDesign, Key> = { classic: 'admLoginClassic', modern: 'admLoginModern', split: 'admLoginSplit', bento: 'admLoginBento', bentofull: 'admLoginBentoFull' }
const LANDING_DESIGN_LABEL: Record<LandingDesign, Key> = { classic: 'admLandingClassic', duo: 'admLandingDuo', bold: 'admLandingBold' }
const LOGIN_PLATFORM_LABEL: Record<LoginPlatform, Key> = { app: 'admLoginApp', mweb: 'admLoginMweb', web: 'admLoginWeb', desktop: 'admLoginDesktop' }
import { rupees } from '../lib/pricing'
import { FILE_REPORT_REASON_KEY } from '../lib/fileReports'
import { SkelForm, SkelList, SkelLog, SkelStats } from '../components/Skeletons'
import { ask as askConfirm } from '../components/ConfirmHost'

/* Admin panel tabs: Users, Orders, Payments, Spam watch, Settings. Every RPC checks is_admin() in SQL;
   the admin-action Edge Function checks public.admins too. */

/* Skeleton placeholders live with every other page skeleton (components/Skeletons). */
export { SkelForm, SkelList, SkelLog, SkelStats }

export function fmtDate(s: string | null, lang: string) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type Msg = (m: { text: string; error?: boolean } | null) => void
const PAGE = 50

function useDateTime() {
  const { lang } = useI18n()
  return (s: string | null) => s
    ? new Date(s).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '—'
}

function Search({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string }) {
  const { t } = useI18n()
  return (
    <form className="admin-search" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit() }}>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <button type="submit" className="btn">{t('admSearchBtn')}</button>
    </form>
  )
}

/* ---------------- Users ---------------- */

type UserRow = {
  // email: the login's email, or "+91..." for mobile-number accounts (v26)
  user_id: string; email: string | null; created_at: string; last_sign_in_at: string | null
  confirmed: boolean; banned: boolean; shop_id: string | null; shop_name: string | null; is_admin: boolean
}

export function AdminUsers({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw, lang } = useI18n()
  const dt = useDateTime()
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (search: string, offset: number) => {
    const { data, error } = await supabase.rpc('admin_users', { p_q: search, p_limit: PAGE, p_offset: offset })
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    const r = (data || []) as UserRow[]
    setRows((prev) => (offset === 0 ? r : [...(prev || []), ...r]))
    setMore(r.length === PAGE)
  }, [onMsg, teRaw])

  useEffect(() => { load(query, 0) }, [query, load])

  const act = async (u: UserRow, action: 'disable_user' | 'enable_user' | 'send_reset') => {
    const ask = action === 'disable_user' ? t('admDisableAsk', { email: u.email || '' }) : action === 'send_reset' ? t('admResetAsk', { email: u.email || '' }) : null
    if (ask && !await askConfirm(ask)) return
    setBusy(u.user_id)
    onMsg(null)
    try {
      await callFn('admin-action', { action, user_id: u.user_id })
      onMsg({ text: action === 'send_reset' ? t('admResetSent', { email: u.email || '' }) : t('admDone') })
      load(query, 0)
    } catch (e) {
      onMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('admUsers')}</h2>
      <Search value={q} onChange={setQ} onSubmit={() => setQuery(q.trim())} placeholder={t('admUserSearch')} />
      {!rows ? <SkelList /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {rows.map((u) => (
            <div className={`card admin-item${u.banned ? ' is-blocked' : ''}`} key={u.user_id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">{u.email || '—'}</b>
                <span className="admin-tags">
                  {u.is_admin && <span className="admin-tag pro">{t('admTagAdmin')}</span>}
                  {u.banned && <span className="admin-tag bad">{t('admTagDisabled')}</span>}
                  {!u.confirmed && <span className="admin-tag">{t('admTagUnconfirmed')}</span>}
                </span>
              </div>
              <div className="small muted">
                {t('admUserLine', { shop: u.shop_name || t('admNoShop'), joined: fmtDate(u.created_at, lang), last: dt(u.last_sign_in_at) })}
              </div>
              {!u.is_admin && (
                <div className="admin-row">
                  {/* Mobile-number (OTP) accounts have no email and no password to reset. */}
                  {u.email?.includes('@') && <button type="button" className="btn small soft" disabled={busy === u.user_id} onClick={() => act(u, 'send_reset')}>{t('admSendReset')}</button>}
                  {u.banned
                    ? <button type="button" className="btn small" disabled={busy === u.user_id} onClick={() => act(u, 'enable_user')}>{t('admEnableUser')}</button>
                    : <button type="button" className="btn small danger-outline" disabled={busy === u.user_id} onClick={() => act(u, 'disable_user')}>{t('admDisableUser')}</button>}
                </div>
              )}
            </div>
          ))}
          {more && <button type="button" className="btn block" onClick={() => load(query, rows.length)}>{t('admMore')}</button>}
        </div>
      )}
    </>
  )
}

/* ---------------- Orders ---------------- */

type OrderRow = {
  id: string; token: number; shop_id: string; shop_name: string; status: string; total: number; files: number; bytes: number
  files_deleted: boolean; counter_name: string | null; created_at: string; updated_at: string
}

export function AdminOrders({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw } = useI18n()
  const dt = useDateTime()
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'stuck' | 'files'>('all')
  const [rows, setRows] = useState<OrderRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (search: string, f: string, offset: number) => {
    const { data, error } = await supabase.rpc('admin_orders', { p_q: search, p_filter: f, p_limit: PAGE, p_offset: offset })
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    const r = (data || []) as OrderRow[]
    setRows((prev) => (offset === 0 ? r : [...(prev || []), ...r]))
    setMore(r.length === PAGE)
  }, [onMsg, teRaw])

  useEffect(() => { setRows(null); load(query, filter, 0) }, [query, filter, load])

  const delFiles = async (o: OrderRow) => {
    if (!await askConfirm(t('admDelFilesAsk', { n: o.token, shop: o.shop_name }), { icon: 'trash' })) return
    setBusy(o.id)
    onMsg(null)
    try {
      await callFn('admin-action', { action: 'delete_files', order_id: o.id })
      onMsg({ text: t('admDone') })
      load(query, filter, 0)
    } catch (e) {
      onMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="admin-sec adm-tab-h">{t('admOrders')}</h2>
      <p className="small muted">{t('admOrdersPrivacy')}</p>
      <Search value={q} onChange={setQ} onSubmit={() => setQuery(q.trim())} placeholder={t('admOrderSearch')} />
      <div className="seg" role="group" aria-label={t('admOrders')}>
        {(['all', 'stuck', 'files'] as const).map((f) => (
          <button type="button" key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? t('admFilterAll') : f === 'stuck' ? t('admFilterStuck') : t('admFilterFiles')}
          </button>
        ))}
      </div>
      {!rows ? <SkelList /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {rows.map((o) => (
            <div className="card admin-item" key={o.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">#{o.token} · {o.shop_name}</b>
                <span className="admin-tags"><span className="admin-tag">{o.status}</span></span>
              </div>
              <div className="small muted">
                {dt(o.created_at)} · {rupees(Number(o.total))} · {t('admFilesLine', { n: o.files, size: fmtBytes(Number(o.bytes)) })}
                {o.counter_name ? ` · ${o.counter_name}` : ''}{o.files_deleted ? ` · ${t('admFilesGone')}` : ''}
              </div>
              {!o.files_deleted && (
                <div className="admin-row">
                  <button type="button" className="btn small danger-outline" disabled={busy === o.id} onClick={() => delFiles(o)}>{t('admDelFiles')}</button>
                </div>
              )}
            </div>
          ))}
          {more && <button type="button" className="btn block" onClick={() => load(query, filter, rows.length)}>{t('admMore')}</button>}
        </div>
      )}
    </>
  )
}

/* ---------------- Payments ---------------- */

type Sub = { shop_id: string; name: string; email: string | null; plan?: string | null; plan_period: string | null; subscription_status: string | null; plan_expires_at: string | null; sub_id: string; is_pro: boolean }
type Ev = { event: string | null; received_at: string }

export function AdminPayments({ onMsg }: { onMsg: Msg }) {
  const { t, teRaw, lang } = useI18n()
  const dt = useDateTime()
  const [data, setData] = useState<{ subs: Sub[]; events: Ev[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('admin_payments')
    if (error) onMsg({ text: teRaw(error), error: true })
    else setData(d as { subs: Sub[]; events: Ev[] })
  }, [onMsg, teRaw])
  useEffect(() => { load() }, [load])

  const cancel = async (s: Sub) => {
    if (!await askConfirm(t('admCancelSubAsk', { name: s.name }))) return
    setBusy(s.shop_id)
    onMsg(null)
    try {
      await callFn('admin-action', { action: 'cancel_subscription', shop_id: s.shop_id })
      onMsg({ text: t('admDone') })
      load()
    } catch (e) {
      onMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const bad = (st: string | null) => st === 'halted' || st === 'pending'

  return (
    <>
      <div className="admin-head">
        <h2 className="admin-sec">{t('admPayments')}</h2>
        <a className="btn small soft" href="https://dashboard.razorpay.com/app/subscriptions" target="_blank" rel="noreferrer">{t('admRazorpay')}</a>
      </div>
      {!data ? <><SkelStats n={3} /><SkelList n={4} /></> : (
        <>
          {data.subs.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
            <div className="admin-list">
              {data.subs.map((s) => (
                <div className={`card admin-item${bad(s.subscription_status) ? ' is-blocked' : ''}`} key={s.shop_id}>
                  <div className="admin-item-top">
                    <b className="admin-ellipsis">{s.name}</b>
                    <span className="admin-tags">
                      {s.plan && <span className="admin-tag">{s.plan === 'plus' ? t('admTagPlus') : s.plan === 'pro' ? t('admTagPro') : t('admTagFree')}</span>}
                      <span className={`admin-tag${bad(s.subscription_status) ? ' bad' : s.is_pro ? ' pro' : ''}`}>{s.subscription_status || '—'}</span>
                    </span>
                  </div>
                  <div className="small muted">
                    {s.email || '—'} · {s.plan_period || '—'} · {t('admUntil', { date: fmtDate(s.plan_expires_at, lang) })} · <span className="mono">{s.sub_id}</span>
                  </div>
                  {s.subscription_status !== 'cancelled' && s.subscription_status !== 'completed' && (
                    <div className="admin-row">
                      <button type="button" className="btn small danger-outline" disabled={busy === s.shop_id} onClick={() => cancel(s)}>{t('admCancelSub')}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <h2 className="admin-sec">{t('admEvents')}</h2>
          {data.events.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
            <div className="card admin-log">
              {data.events.map((e, i) => (
                <div className="admin-log-row small" key={i}>
                  <span className="muted">{dt(e.received_at)}</span>
                  <span>{e.event || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

/* ---------------- Spam watch ---------------- */

type Spam = {
  shops: { shop_id: string; name: string; created_at: string; blocked: boolean; orders_day: number }[]
  networks: { ip_hash: string; orders_day: number; last_at: string; blocked: boolean }[]
  blocked_ips: { ip_hash: string; reason: string | null; created_at: string }[]
  reports: { id: number; shop_id: string; name: string; slug: string; reason: string; created_at: string; resolved: boolean }[]
}

/** v34: a shop reported an order's files. The order is on hold (files kept, hidden from the shop) until an admin acts. */
type FileReportRow = {
  id: number; order_id: string | null; shop_id: string | null; reason: string; note: string | null; token: number | null
  shop_name: string | null; file_names: string[]; paths: string[]; status: 'open' | 'dismissed' | 'files_deleted'
  created_at: string; resolved_at: string | null
}

function AdminFileReports({ onMsg, onChanged }: { onMsg: Msg; onChanged: () => void }) {
  const { t, teRaw } = useI18n()
  const dt = useDateTime()
  const [rows, setRows] = useState<FileReportRow[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('file_reports').select('*').order('created_at', { ascending: false }).limit(50)
    if (error) { onMsg({ text: teRaw(error), error: true }); setRows([]); return }
    const list = (data || []) as FileReportRow[]
    // Open ones first, newest first inside each group.
    setRows([...list.filter((r) => r.status === 'open'), ...list.filter((r) => r.status !== 'open')])
  }, [onMsg, teRaw])
  useEffect(() => { load() }, [load])

  const act = async (r: FileReportRow, action: 'report_dismiss' | 'report_delete_files') => {
    const ask = action === 'report_dismiss' ? t('frDismissAsk', { n: r.token ?? '?' }) : t('frDeleteAsk', { n: r.token ?? '?' })
    if (!await askConfirm(ask, { icon: action === 'report_dismiss' ? 'check' : 'trash' })) return
    setBusy(r.id)
    onMsg(null)
    try {
      await callFn('admin-action', { action, report_id: r.id })
      onMsg({ text: t('admDone') })
      load()
      onChanged()
    } catch (e) {
      onMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const open = (rows || []).filter((r) => r.status === 'open').length
  return (
    <>
      <h2 className="admin-sec">{t('frAdminTitle')} ({open})</h2>
      <p className="small muted">{t('frAdminHint')}</p>
      {!rows ? <SkelList n={2} /> : rows.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {rows.map((r) => (
            <div className={`card admin-item${r.status !== 'open' ? ' is-done' : ''}`} key={r.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis">#{r.token ?? '?'} · {r.shop_name || '—'}</b>
                <span className="admin-tags">
                  <span className={`admin-tag${r.reason === 'csam' ? ' fr-urgent' : ''}`}>{t(FILE_REPORT_REASON_KEY[r.reason] || 'frReasonOther')}</span>
                  {r.status !== 'open' && <span className="admin-tag">{r.status === 'dismissed' ? t('frStatusDismissed') : t('frStatusDeleted')}</span>}
                </span>
              </div>
              <div className="small muted">{dt(r.created_at)}{r.resolved_at ? ` · ${t('frClosedAt', { time: dt(r.resolved_at) })}` : ''}</div>
              {r.note && <p className="small admin-quote">{r.note}</p>}
              {r.file_names.length > 0 && <p className="small muted fr-files">{r.file_names.join(', ')}</p>}
              {r.status === 'open' && r.paths.length > 0 && (
                <p className="small muted mono fr-files">{t('frEvidence', { path: r.paths[0].split('/').slice(0, 2).join('/') + '/' })}</p>
              )}
              {r.status === 'open' && (
                <div className="admin-row">
                  <button type="button" className="btn small soft" disabled={busy === r.id} onClick={() => act(r, 'report_dismiss')}>{t('frDismiss')}</button>
                  <button type="button" className="btn small danger-outline" disabled={busy === r.id} onClick={() => act(r, 'report_delete_files')}>{t('frDeleteFiles')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export function AdminSpam({ onMsg, onChanged }: { onMsg: Msg; onChanged: () => void }) {
  const { t, teRaw, lang } = useI18n()
  const dt = useDateTime()
  const [data, setData] = useState<Spam | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('admin_spam')
    if (error) onMsg({ text: teRaw(error), error: true })
    else setData(d as Spam)
  }, [onMsg, teRaw])
  useEffect(() => { load() }, [load])

  const run = async (fn: () => PromiseLike<{ error: unknown }>, ask?: string) => {
    if (ask && !await askConfirm(ask)) return
    setBusy(true)
    onMsg(null)
    const { error } = await fn()
    setBusy(false)
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    onMsg({ text: t('admDone') })
    load()
    onChanged()
  }

  const blockIp = (hash: string, block: boolean) =>
    run(() => supabase.rpc('admin_block_ip', { p_hash: hash, p_block: block, p_reason: block ? 'admin' : null }),
      block ? t('admBlockIpAsk') : undefined)

  if (!data) return <SkelList n={4} />
  const openReports = data.reports.filter((r) => !r.resolved)

  return (
    <>
      <AdminFileReports onMsg={onMsg} onChanged={onChanged} />
      <h2 className="admin-sec">{t('admReports')} ({openReports.length})</h2>
      {data.reports.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="admin-list">
          {data.reports.map((r) => (
            <div className={`card admin-item${r.resolved ? ' is-done' : ''}`} key={r.id}>
              <div className="admin-item-top">
                <b className="admin-ellipsis"><a href={routeHref(`/s/${r.slug}`)} target="_blank" rel="noreferrer">{r.name}</a></b>
                <span className="small muted">{dt(r.created_at)}</span>
              </div>
              <p className="small admin-quote">{r.reason}</p>
              {!r.resolved && (
                <div className="admin-row">
                  <button type="button" className="btn small soft" disabled={busy}
                    onClick={() => run(() => supabase.rpc('admin_resolve_report', { p_id: r.id, p_resolved: true }))}>{t('admResolve')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 className="admin-sec">{t('admTopShops')}</h2>
      {data.shops.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="card admin-log">
          {data.shops.map((s) => (
            <div className="admin-log-row small" key={s.shop_id}>
              <span><b>{s.orders_day}</b></span>
              <span>{s.name}{s.blocked ? ` · ${t('admTagBlocked')}` : ''} · {t('admJoinedOn', { date: fmtDate(s.created_at, lang) })}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="admin-sec">{t('admTopNetworks')}</h2>
      <p className="small muted">{t('admNetworksHint')}</p>
      {data.networks.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="card admin-log">
          {data.networks.map((n) => (
            <div className="admin-log-row small admin-net" key={n.ip_hash}>
              <span><b>{n.orders_day}</b></span>
              <span className="mono">{n.ip_hash.slice(0, 10)}…</span>
              <span className="muted">{dt(n.last_at)}</span>
              {n.blocked
                ? <button type="button" className="btn small" disabled={busy} onClick={() => blockIp(n.ip_hash, false)}>{t('admUnblock')}</button>
                : <button type="button" className="btn small danger-outline" disabled={busy} onClick={() => blockIp(n.ip_hash, true)}>{t('admBlock')}</button>}
            </div>
          ))}
        </div>
      )}

      <h2 className="admin-sec">{t('admBlockedNets')}</h2>
      {data.blocked_ips.length === 0 ? <p className="muted">{t('admNothing')}</p> : (
        <div className="card admin-log">
          {data.blocked_ips.map((b) => (
            <div className="admin-log-row small admin-net" key={b.ip_hash}>
              <span className="mono">{b.ip_hash.slice(0, 10)}…</span>
              <span className="muted">{fmtDate(b.created_at, lang)}</span>
              <button type="button" className="btn small" disabled={busy} onClick={() => blockIp(b.ip_hash, false)}>{t('admUnblock')}</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ---------------- Settings ---------------- */

/** Save button in the admin bottom bar: shown in place of the tab's icon only while the tab has unsaved changes. */
export type SaveSlot = { run: () => void; busy: boolean } | null

type SetSec = 'announcement' | 'popup' | 'maintenance' | 'minversion' | 'freecounters' | 'login' | 'landing'
/** Phone Settings hub (like the shop owner's Settings): groups of rows; each row opens its own page (?s=<key>). */
const SET_GROUPS: [Key, [SetSec, string, Key][]][] = [
  ['admSetGrpAnn', [['announcement', 'bell', 'admSetAnn'], ['popup', 'clock', 'admSetPopup']]],
  ['admSetGrpApp', [['maintenance', 'alert', 'admSetMaint'], ['minversion', 'phone', 'admMinVersion']]],
  ['admSetGrpPlans', [['freecounters', 'qr', 'admSetFree']]],
  ['admSetGrpDesign', [['login', 'lock', 'admLoginDesign'], ['landing', 'image', 'admLandingDesign']]]
]
const SET_SECS = SET_GROUPS.flatMap(([, rows]) => rows)
const isSetSec = (v: string | null): v is SetSec => !!v && SET_SECS.some(([k]) => k === v)

/** Same breakpoint as the admin phone bar (AdminShell / .adm-bar). */
function useAdminPhone() {
  const q = '(max-width: 1023.98px)'
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const sync = () => setM(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return m
}

export function AdminSettings({ onMsg, onSaveSlot }: { onMsg: Msg; onSaveSlot?: (slot: SaveSlot) => void }) {
  const { t, teRaw } = useI18n()
  const [s, setS] = useState<AppSettings | null>(null)
  const [orig, setOrig] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  // Phone: grouped list; ?s=<section> opens one setting as its own page (Back / Android back returns).
  const phone = useAdminPhone()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const sp = params.get('s')
  const sec: SetSec | null = phone && isSetSec(sp) ? sp : null
  const openSec = (k: SetSec) => { setParams((p) => { const q = new URLSearchParams(p); q.set('s', k); return q }); window.scrollTo(0, 0) }
  const back = () => {
    // Opened straight from a link (no in-app history entry): replace instead of leaving the page.
    if ((window.history.state as { idx?: number } | null)?.idx) nav(-1)
    else setParams((p) => { const q = new URLSearchParams(p); q.delete('s'); return q }, { replace: true })
  }

  useEffect(() => {
    supabase.rpc('get_app_settings').then(({ data, error }) => {
      if (error) onMsg({ text: teRaw(error), error: true })
      const v = { ...DEFAULT_SETTINGS, ...((data as Partial<AppSettings>) || {}) }
      setS(v)
      setOrig(v)
    })
  }, [onMsg, teRaw])

  // Phone: leaving a setting's page without saving (on-screen Back, Android/browser back, or another row)
  // drops that page's unsaved edits, back to the last saved values. Computer (one card) keeps every edit.
  const leftRef = useRef({ phone, sec })
  useEffect(() => {
    const was = leftRef.current
    leftRef.current = { phone, sec }
    if (was.phone && phone && was.sec && was.sec !== sec && orig) setS(orig)
  }, [phone, sec, orig])

  const dirty = !!s && !!orig && JSON.stringify(s) !== JSON.stringify(orig)
  // Phone: Save only on a setting's page that has changes (never on the list).
  const showSave = dirty && (!phone || !!sec)
  useEffect(() => {
    // requestSubmit keeps the form's own checks (e.g. version pattern) and the maintenance confirm.
    onSaveSlot?.(showSave ? { run: () => formRef.current?.requestSubmit(), busy } : null)
  }, [showSave, busy, onSaveSlot])
  useEffect(() => () => onSaveSlot?.(null), [onSaveSlot])

  const backBtn = sec && (
    <button type="button" className="set-back" onClick={back}><Icon name="chevl" size={22} /> {t('admSettings')}</button>
  )
  if (!s) {
    if (!phone) return <SkelForm n={5} />
    if (sec) return <section aria-busy="true">{backBtn}<SkelForm n={2} /></section>
    return <AdminSetHub t={t} onOpen={openSec} />
  }
  const set = (patch: Partial<AppSettings>) => setS({ ...s, ...patch })

  const save = async (e: FormEvent) => {
    e.preventDefault()
    // The version field may not be on screen (phone: another setting's page), so check its pattern here too.
    if (s.min_app_version && !/^\d+\.\d+\.\d+$/.test(s.min_app_version)) {
      if (phone && sec !== 'minversion') openSec('minversion')
      else document.getElementById('set-minv')?.focus()
      onMsg({ text: t('admSetBadVersion'), error: true })
      return
    }
    if (s.maintenance && !await askConfirm(t('admMaintAsk'))) return
    setBusy(true)
    onMsg(null)
    const { data, error } = await supabase.rpc('admin_set_settings', { p: s })
    setBusy(false)
    if (error) { onMsg({ text: teRaw(error), error: true }); return }
    const next = { ...DEFAULT_SETTINGS, ...(data as Partial<AppSettings>) }
    setS(next)
    setOrig(next)
    setAppSettingsCache(next)
    onMsg({ text: t('saved') })
  }

  const fields: Record<SetSec, ReactNode> = {
    announcement: (<>
      <label htmlFor="set-ann">{t('admAnnouncement')}</label>
      <textarea id="set-ann" rows={2} maxLength={300} value={s.announcement || ''} onChange={(e) => set({ announcement: e.target.value })} placeholder={t('admAnnouncementPh')} />
      <label htmlFor="set-ann-hi">{t('admAnnouncementHi')}</label>
      <textarea id="set-ann-hi" rows={2} maxLength={300} value={s.announcement_hi || ''} onChange={(e) => set({ announcement_hi: e.target.value })} />
      <p className="small muted">{t('admAnnouncementHint')}</p>
    </>),
    popup: (<>
      <label htmlFor="set-ann-secs">{t('admAnnSecs')}</label>
      <input id="set-ann-secs" type="number" min={3} max={120} value={s.announcement_secs ?? 8} onChange={(e) => set({ announcement_secs: Math.max(3, Math.min(120, Math.floor(Number(e.target.value) || 8))) })} />
      <p className="small muted">{t('admAnnSecsHint')}</p>
    </>),
    maintenance: (<>
      <label className="admin-check">
        <input type="checkbox" checked={s.maintenance} onChange={(e) => set({ maintenance: e.target.checked })} />
        <span>{t('admMaintenance')}</span>
      </label>
      <input type="text" maxLength={300} value={s.maintenance_msg || ''} onChange={(e) => set({ maintenance_msg: e.target.value })} placeholder={t('maintDefault')} aria-label={t('admMaintMsg')} />
      <p className="small muted">{t('admMaintHint')}</p>
    </>),
    minversion: (<>
      <label htmlFor="set-minv">{t('admMinVersion')}</label>
      <input id="set-minv" type="text" inputMode="decimal" pattern="\d+\.\d+\.\d+" placeholder="1.5.19" value={s.min_app_version || ''} onChange={(e) => set({ min_app_version: e.target.value.trim() })} />
      <p className="small muted">{t('admMinVersionHint')}</p>
    </>),
    login: (<>
      {!phone && <p className="admin-sub-label"><b>{t('admLoginDesign')}</b></p>}
      {LOGIN_PLATFORMS.map((p) => (
        <div key={p}>
          <label htmlFor={`set-login-${p}`}>{t(LOGIN_PLATFORM_LABEL[p])}</label>
          <select id={`set-login-${p}`} value={loginDesignFor(s, p)}
            onChange={(e) => set({ login_designs: { ...s.login_designs, [p]: e.target.value as LoginDesign } })}>
            {DESIGNS_FOR[p].map((d) => <option key={d} value={d}>{t(LOGIN_DESIGN_LABEL[d])}</option>)}
          </select>
        </div>
      ))}
      <p className="small muted">{t('admLoginDesignHint')}</p>
    </>),
    landing: (<>
      {!phone && <p className="admin-sub-label"><b>{t('admLandingDesign')}</b></p>}
      {LOGIN_PLATFORMS.map((p) => (
        <div key={p}>
          <label htmlFor={`set-landing-${p}`}>{t(LOGIN_PLATFORM_LABEL[p])}</label>
          <select id={`set-landing-${p}`} value={landingDesignFor(s, p)}
            onChange={(e) => set({ landing_designs: { ...s.landing_designs, [p]: e.target.value as LandingDesign } })}>
            {LANDING_DESIGNS.map((d) => <option key={d} value={d}>{t(LANDING_DESIGN_LABEL[d])}</option>)}
          </select>
        </div>
      ))}
      <p className="small muted">{t('admLandingDesignHint')}</p>
    </>),
    freecounters: (<>
      <label htmlFor="set-fcl">{t('admFreeCounters')}</label>
      <input id="set-fcl" type="number" min={0} max={20} value={s.free_counter_limit} onChange={(e) => set({ free_counter_limit: Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))) })} />
      <p className="small muted">{t('admPricesHint', { m: '₹49', y: '₹539' })}</p>
    </>)
  }
  const saveBtn = <button type="submit" className="btn primary" disabled={busy}>{busy ? t('pleaseWait') : t('save')}</button>

  // Computer: one card with every setting, same order as before.
  if (!phone) {
    const order: SetSec[] = ['announcement', 'popup', 'maintenance', 'minversion', 'login', 'landing', 'freecounters']
    return (
      <form ref={formRef} className="card admin-settings" onSubmit={save}>
        <h2 className="admin-sec">{t('admSettings')}</h2>
        {order.map((k) => <Fragment key={k}>{fields[k]}</Fragment>)}
        {saveBtn}
      </form>
    )
  }

  // Phone: the form stays mounted on the hub too; unsaved edits are dropped when a page is left (see leftRef).
  const title = sec && SET_SECS.find(([k]) => k === sec)![2]
  return (
    <form ref={formRef} onSubmit={save}>
      {sec ? (<>
        {backBtn}
        <div className="card admin-settings">
          <h2 className="admin-sec">{t(title as Key)}</h2>
          {fields[sec]}
          {saveBtn}
        </div>
      </>) : <AdminSetHub t={t} s={s} onOpen={openSec} />}
    </form>
  )
}

/** The grouped list. Without settings yet (loading): same rows, shimmer where the current values go. */
function AdminSetHub({ t, s, onOpen }: { t: ReturnType<typeof useI18n>['t']; s?: AppSettings; onOpen: (k: SetSec) => void }) {
  const onOff = (on: boolean, warn = false) => <span className={`pro-badge adm-set-badge${on ? (warn ? ' is-warn' : '') : ' is-off'}`}>{t(on ? 'admSetOn' : 'admSetOff')}</span>
  const value = (k: SetSec): ReactNode => {
    if (!s) return k === 'login' || k === 'landing' ? null : <span className="skel" style={{ width: 44, height: 14, flex: 'none' }} />
    switch (k) {
      case 'announcement': return onOff(!!(s.announcement || '').trim() || !!(s.announcement_hi || '').trim())
      case 'popup': return <span className="set-val">{t('admSetSecs', { n: String(s.announcement_secs ?? 8) })}</span>
      case 'maintenance': return onOff(!!s.maintenance, true)
      case 'minversion': return <span className="set-val adm-set-minv">{s.min_app_version || t('admSetNoLimit')}</span>
      case 'freecounters': return <span className="set-val">{s.free_counter_limit}</span>
      default: return null
    }
  }
  return (
    <div className="set-hub adm-set-hub" aria-busy={s ? undefined : true}>
      {SET_GROUPS.map(([g, rows]) => (
        <Fragment key={g}>
          <div className="set-grp-lbl">{t(g)}</div>
          <div className="set-grp">
            {rows.map(([k, icon, label]) => {
              const inner = (<>
                <span className="set-ic"><Icon name={icon} size={18} /></span>
                <span className="set-lbl">{t(label)}</span>
                {value(k)}
                <Icon name="chevr" size={18} />
              </>)
              return s
                ? <button key={k} type="button" className="set-row" onClick={() => onOpen(k)}>{inner}</button>
                : <div key={k} className="set-row">{inner}</div>
            })}
          </div>
        </Fragment>
      ))}
      {!s && <span className="sr-only">{t('loading')}</span>}
    </div>
  )
}
