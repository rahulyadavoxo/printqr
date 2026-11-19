import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { Key, useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'
import { callFn } from '../lib/billing'
import { AdminOrders, AdminPayments, AdminSettings, AdminSpam, AdminUsers, fmtBytes, fmtDate } from './AdminTabs'

/* Admin panel. The page only hides itself; the real check is is_admin() inside every admin_* SQL function. */

type Overview = {
  shops_total: number; shops_today: number; shops_week: number
  pro_active: number; pro_paid: number; pro_monthly: number; pro_yearly: number; blocked: number
  orders_today: number; orders_week: number; orders_total: number
  storage_bytes: number; files_waiting: number
  pay_failed?: number; orders_stuck?: number; reports_open?: number; users_total?: number
  cleanup_last?: string | null; cleanup_failed_day?: number | null
}

type ShopRow = {
  id: string; name: string; slug: string; owner_email: string | null; phone: string | null; created_at: string
  plan: string; plan_period: string | null; plan_expires_at: string | null; is_pro: boolean; paid: boolean
  subscription_status: string | null; blocked: boolean; blocked_reason: string | null; is_open: boolean
  counters: number; orders_total: number; orders_week: number; last_order_at: string | null; scans: number
}

type LogRow = { created_at: string; action: string; shop_id: string | null; shop_name: string | null; detail: Record<string, unknown> | null }

// Pro prices (₹) used only for the monthly income estimate.
const PRICE_MONTHLY = 49
const PRICE_YEARLY = 539

const PAGE = 50

const TAB_KEYS: Record<Tab, Key> = {
  overview: 'admOverview', shops: 'admShops', users: 'admUsers', orders: 'admOrders', payments: 'admPayments',
  spam: 'admSpam', settings: 'admSettings', log: 'admLog'
}
const LOG_KEYS: Record<string, Key> = {
  pro_given: 'admLogProGiven', pro_removed: 'admLogProRemoved', blocked: 'admLogBlocked', unblocked: 'admLogUnblocked',
  qr_reset: 'admLogQrReset', shop_edited: 'admLogShopEdited', settings: 'admLogSettings', ip_blocked: 'admLogIpBlocked',
  ip_unblocked: 'admLogIpUnblocked', report_resolved: 'admLogReport', user_disabled: 'admLogUserDisabled',
  user_enabled: 'admLogUserEnabled', reset_sent: 'admLogResetSent', sub_cancelled: 'admLogSubCancelled', files_deleted: 'admLogFilesDeleted'
}
type Tab = 'overview' | 'shops' | 'users' | 'orders' | 'payments' | 'spam' | 'settings' | 'log'
const TABS: Tab[] = ['overview', 'shops', 'users', 'orders', 'payments', 'spam', 'settings', 'log']


export default function Admin() {
  const { session, loading } = useSession()
  const { t, te, lang } = useI18n()
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [shops, setShops] = useState<ShopRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [log, setLog] = useState<LogRow[] | null>(null)
  const [days, setDays] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<Tab>('overview')

  useEffect(() => {
    if (!session) return
    supabase.rpc('is_admin').then(({ data, error }) => setAllowed(!error && data === true))
  }, [session])

  const loadOverview = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_overview')
    if (error) setMsg({ text: te(error), error: true })
    else setOv(data as Overview)
  }, [te])

  const loadShops = useCallback(async (search: string, offset: number) => {
    const { data, error } = await supabase.rpc('admin_shops', { p_q: search, p_limit: PAGE, p_offset: offset })
    if (error) { setMsg({ text: te(error), error: true }); return }
    const rows = (data || []) as ShopRow[]
    setShops((prev) => (offset === 0 ? rows : [...(prev || []), ...rows]))
    setMore(rows.length === PAGE)
  }, [te])

  const loadLog = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_recent_log', { p_limit: 20 })
    if (!error) setLog((data || []) as LogRow[])
  }, [])

  useEffect(() => {
    if (!allowed) return
    loadOverview()
    loadLog()
  }, [allowed, loadOverview, loadLog])

  useEffect(() => {
    if (!allowed) return
    loadShops(query, 0)
  }, [allowed, query, loadShops])

  const refreshAll = () => {
    loadOverview()
    loadShops(query, 0)
    loadLog()
  }

  const setPro = async (s: ShopRow, d: number) => {
    if (d === 0 && !window.confirm(s.paid ? t('admRemoveProPaid', { name: s.name }) : t('admRemoveProAsk', { name: s.name }))) return
    setBusy(s.id)
    setMsg(null)
    const { data, error } = await supabase.rpc('admin_set_pro', { p_shop: s.id, p_days: d })
    setBusy(null)
    if (error) { setMsg({ text: te(error), error: true }); return }
    setMsg({ text: d === 0 ? t('admProRemoved', { name: s.name }) : t('admProGiven', { name: s.name, date: fmtDate(data as string, lang) }) })
    refreshAll()
  }

  const setBlocked = async (s: ShopRow, block: boolean) => {
    if (block && !window.confirm(t('admBlockAsk', { name: s.name }))) return
    setBusy(s.id)
    setMsg(null)
    const { error } = await supabase.rpc('admin_set_blocked', { p_shop: s.id, p_blocked: block, p_reason: reason[s.id] || null })
    setBusy(null)
    if (error) { setMsg({ text: te(error), error: true }); return }
    setMsg({ text: block ? t('admBlocked', { name: s.name }) : t('admUnblocked', { name: s.name }) })
    refreshAll()
  }

  const shopTool = async (s: ShopRow, kind: 'qr' | 'name' | 'logo' | 'cancel') => {
    const ask = kind === 'qr' ? t('admResetQrAsk', { name: s.name }) : kind === 'logo' ? t('admRemoveLogoAsk', { name: s.name })
      : kind === 'cancel' ? t('admCancelSubAsk', { name: s.name }) : null
    if (ask && !window.confirm(ask)) return
    if (kind === 'name' && !(names[s.id] || '').trim()) return
    setBusy(s.id)
    setMsg(null)
    try {
      if (kind === 'cancel') {
        await callFn('admin-action', { action: 'cancel_subscription', shop_id: s.id })
      } else {
        const { error } = kind === 'qr'
          ? await supabase.rpc('admin_reset_qr', { p_shop: s.id })
          : await supabase.rpc('admin_edit_shop', { p_shop: s.id, p_name: kind === 'name' ? names[s.id].trim() : null, p_remove_logo: kind === 'logo' })
        if (error) throw error
      }
      setMsg({ text: t('admDone') })
      refreshAll()
    } catch (e) {
      setMsg({ text: te(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  if (loading) return null
  if (!session) return <Navigate to="/login" replace />

  const shell = (body: ReactElement) => (
    <div className="app-page">
      <TopBar to="/dashboard" wide />
      <main className="page">{body}</main>
    </div>
  )

  if (allowed === null) return shell(<p className="muted">{t('loading')}</p>)
  if (!allowed) return shell(<div className="card"><h2>{t('admNoAccess')}</h2><p className="muted">{t('admNoAccessHint')}</p></div>)

  const mrr = ov ? Math.round(ov.pro_monthly * PRICE_MONTHLY + (ov.pro_yearly * PRICE_YEARLY) / 12) : 0

  const actionLabel = (a: string) => (LOG_KEYS[a] ? t(LOG_KEYS[a]) : a)

  return shell(
    <>
      <div className="admin-head">
        <h1>{t('admTitle')}</h1>
        <button type="button" className="btn small soft" onClick={refreshAll}>{t('admRefresh')}</button>
      </div>

      {msg && <div className={`notice${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}

      <nav className="tabs admin-tabs" aria-label={t('admTitle')}>
        {TABS.map((x) => (
          <button type="button" key={x} className={tab === x ? 'on' : ''} aria-current={tab === x ? 'page' : undefined} onClick={() => setTab(x)}>{t(TAB_KEYS[x])}</button>
        ))}
      </nav>

      {tab === 'overview' && (<>
      <h2 className="admin-sec">{t('admOverview')}</h2>
      {!ov ? <p className="muted">{t('loading')}</p> : (
        <div className="stats">
          <div className="card stat accent">
            <div className="small stat-label">{t('admMrr')}</div>
            <div className="big-num">₹{mrr.toLocaleString('en-IN')}</div>
            <div className="small stat-sub">{t('admPaidLine', { m: ov.pro_monthly, y: ov.pro_yearly })}</div>
          </div>
          <div className="card stat">
            <div className="small stat-label">{t('admShops')}</div>
            <div className="big-num">{ov.shops_total}</div>
            <div className="small stat-sub">{t('admNewLine', { d: ov.shops_today, w: ov.shops_week })}</div>
          </div>
          <div className="card stat">
            <div className="small stat-label">{t('admPro')}</div>
            <div className="big-num">{ov.pro_active}</div>
            <div className="small stat-sub">{t('admProLine', { p: ov.pro_paid, f: ov.pro_active - ov.pro_paid, b: ov.blocked })}</div>
          </div>
          <div className="card stat">
            <div className="small stat-label">{t('admOrders')}</div>
            <div className="big-num">{ov.orders_today}</div>
            <div className="small stat-sub">{t('admOrdersLine', { w: ov.orders_week, a: ov.orders_total })}</div>
          </div>
          <div className="card stat">
            <div className="small stat-label">{t('admStorage')}</div>
            <div className="big-num">{fmtBytes(ov.storage_bytes)}</div>
            <div className="small stat-sub">{t('admStorageLine', { n: ov.files_waiting })}</div>
          </div>
          {ov.users_total !== undefined && (
            <>
              <div className={`card stat${ov.pay_failed ? ' warn' : ''}`}>
                <div className="small stat-label">{t('admPayFailed')}</div>
                <div className="big-num">{ov.pay_failed ?? 0}</div>
                <div className="small stat-sub">{t('admUsersLine', { n: ov.users_total })}</div>
              </div>
              <div className={`card stat${ov.orders_stuck || ov.reports_open ? ' warn' : ''}`}>
                <div className="small stat-label">{t('admAttention')}</div>
                <div className="big-num">{(ov.orders_stuck ?? 0) + (ov.reports_open ?? 0)}</div>
                <div className="small stat-sub">{t('admAttentionLine', { s: ov.orders_stuck ?? 0, r: ov.reports_open ?? 0 })}</div>
              </div>
              <div className={`card stat${ov.cleanup_failed_day ? ' warn' : ''}`}>
                <div className="small stat-label">{t('admCleanup')}</div>
                <div className="big-num small-num">{ov.cleanup_last ? new Date(ov.cleanup_last).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'}</div>
                <div className="small stat-sub">{t('admCleanupLine', { n: ov.cleanup_failed_day ?? 0 })}</div>
              </div>
            </>
          )}
        </div>
      )}

      </>)}

      {tab === 'shops' && (<>
      <h2 className="admin-sec">{t('admShops')}</h2>
      <form className="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()) }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admSearch')} aria-label={t('admSearch')} />
        <button type="submit" className="btn">{t('admSearchBtn')}</button>
      </form>

      {!shops ? <p className="muted">{t('loading')}</p> : shops.length === 0 ? <p className="muted">{t('admNoShops')}</p> : (
        <div className="admin-list">
          {shops.map((s) => (
            <div className={`card admin-shop${s.blocked ? ' is-blocked' : ''}`} key={s.id}>
              <button type="button" className="admin-shop-head" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <span className="admin-shop-name">{s.name}</span>
                <span className="admin-tags">
                  {s.blocked && <span className="admin-tag bad">{t('admTagBlocked')}</span>}
                  {s.is_pro ? <span className="admin-tag pro">{s.paid ? t('admTagPaid') : t('admTagFreePro')}</span> : <span className="admin-tag">{t('admTagFree')}</span>}
                </span>
                <span className="small muted admin-shop-sub">{s.owner_email || '—'} · {t('admOrdersWeek', { n: s.orders_week })}</span>
              </button>
              {open === s.id && (
                <div className="admin-shop-body">
                  <dl className="admin-facts">
                    <dt>{t('admLink')}</dt><dd><a href={`#/s/${s.slug}`} target="_blank" rel="noreferrer">/s/{s.slug}</a></dd>
                    <dt>{t('admPhone')}</dt><dd>{s.phone || '—'}</dd>
                    <dt>{t('admJoined')}</dt><dd>{fmtDate(s.created_at, lang)}</dd>
                    <dt>{t('admPlan')}</dt><dd>{s.is_pro ? `${t('admTagPro')} · ${t('admUntil', { date: fmtDate(s.plan_expires_at, lang) })}` : t('admTagFree')}{s.paid && s.plan_period ? ` · ${s.plan_period}` : ''}{s.subscription_status ? ` · ${s.subscription_status}` : ''}</dd>
                    <dt>{t('admOrders')}</dt><dd>{t('admOrdersShop', { a: s.orders_total, w: s.orders_week })}</dd>
                    <dt>{t('admLastOrder')}</dt><dd>{fmtDate(s.last_order_at, lang)}</dd>
                    <dt>{t('admCounters')}</dt><dd>{s.counters}</dd>
                    <dt>{t('admScans')}</dt><dd>{s.scans}</dd>
                    <dt>{t('admOpenNow')}</dt><dd>{s.is_open ? t('admYes') : t('admNo')}</dd>
                    {s.blocked && <><dt>{t('admReason')}</dt><dd>{s.blocked_reason || '—'}</dd></>}
                  </dl>

                  <div className="admin-actions">
                    <div className="small muted">{t('admGivePro')}</div>
                    <div className="admin-row">
                      {[7, 30, 365].map((d) => (
                        <button type="button" key={d} className="btn small soft" disabled={busy === s.id} onClick={() => setPro(s, d)}>+{d} {t('admDays')}</button>
                      ))}
                      <input type="number" min={1} max={3660} inputMode="numeric" className="admin-days" value={days[s.id] || ''} placeholder={t('admDays')}
                        onChange={(e) => setDays((m) => ({ ...m, [s.id]: e.target.value }))} aria-label={t('admDays')} />
                      <button type="button" className="btn small" disabled={busy === s.id || !(Number(days[s.id]) > 0)}
                        onClick={() => setPro(s, Math.floor(Number(days[s.id])))}>{t('admGive')}</button>
                      {s.is_pro && <button type="button" className="btn small danger-outline" disabled={busy === s.id} onClick={() => setPro(s, 0)}>{t('admRemovePro')}</button>}
                    </div>

                    <div className="small muted">{s.blocked ? t('admUnblockTitle') : t('admBlockTitle')}</div>
                    <div className="admin-row">
                      {s.blocked ? (
                        <button type="button" className="btn small" disabled={busy === s.id} onClick={() => setBlocked(s, false)}>{t('admUnblock')}</button>
                      ) : (
                        <>
                          <input type="text" maxLength={200} className="admin-reason" value={reason[s.id] || ''} placeholder={t('admReasonPh')}
                            onChange={(e) => setReason((m) => ({ ...m, [s.id]: e.target.value }))} aria-label={t('admReason')} />
                          <button type="button" className="btn small danger-outline" disabled={busy === s.id} onClick={() => setBlocked(s, true)}>{t('admBlock')}</button>
                        </>
                      )}
                    </div>
                    {s.paid && <p className="small muted">{t('admPaidNote')}</p>}

                    <div className="small muted">{t('admShopTools')}</div>
                    <div className="admin-row">
                      <input type="text" maxLength={80} className="admin-reason" value={names[s.id] ?? ''} placeholder={t('admNewName')}
                        onChange={(e) => setNames((m) => ({ ...m, [s.id]: e.target.value }))} aria-label={t('admNewName')} />
                      <button type="button" className="btn small" disabled={busy === s.id || (names[s.id] || '').trim().length < 2} onClick={() => shopTool(s, 'name')}>{t('admRename')}</button>
                    </div>
                    <div className="admin-row">
                      <button type="button" className="btn small soft" disabled={busy === s.id} onClick={() => shopTool(s, 'logo')}>{t('admRemoveLogo')}</button>
                      <button type="button" className="btn small soft" disabled={busy === s.id} onClick={() => shopTool(s, 'qr')}>{t('admResetQr')}</button>
                      {s.paid && s.subscription_status !== 'cancelled' && (
                        <button type="button" className="btn small danger-outline" disabled={busy === s.id} onClick={() => shopTool(s, 'cancel')}>{t('admCancelSub')}</button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {more && <button type="button" className="btn block" onClick={() => loadShops(query, shops.length)}>{t('admMore')}</button>}
        </div>
      )}

      </>)}

      {tab === 'users' && <AdminUsers onMsg={setMsg} />}
      {tab === 'orders' && <AdminOrders onMsg={setMsg} />}
      {tab === 'payments' && <AdminPayments onMsg={setMsg} />}
      {tab === 'spam' && <AdminSpam onMsg={setMsg} onChanged={loadLog} />}
      {tab === 'settings' && <AdminSettings onMsg={setMsg} />}

      {tab === 'log' && (<>
      <h2 className="admin-sec">{t('admLog')}</h2>
      {!log ? <p className="muted">{t('loading')}</p> : log.length === 0 ? <p className="muted">{t('admLogEmpty')}</p> : (
        <div className="card admin-log">
          {log.map((l, i) => (
            <div className="admin-log-row small" key={i}>
              <span className="muted">{new Date(l.created_at).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
              <span><b>{actionLabel(l.action)}</b> · {l.shop_name || '—'}{l.action === 'pro_given' && l.detail?.days ? ` · +${String(l.detail.days)} ${t('admDays')}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      </>)}
    </>
  )
}
