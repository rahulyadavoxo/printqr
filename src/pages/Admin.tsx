import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { Key, useI18n } from '../lib/i18n'
import { ADMIN_TABS, ADMIN_TAB_KEYS, AdminShell, type AdminTab } from '../components/AdminShell'
import { callFn } from '../lib/billing'
import { AdminOrders, AdminPayments, AdminSettings, AdminSpam, AdminUsers, fmtBytes, fmtDate, type SaveSlot } from './AdminTabs'
import { AdminSkelBody, AdminSkeleton, SkelList, SkelLog, SkelStats } from '../components/Skeletons'
import { ask as askConfirm } from '../components/ConfirmHost'
import { setupPush } from '../lib/push'
import Icon from '../components/Icon'

/* Admin panel. The page only hides itself; the real check is is_admin() inside every admin_* SQL function. */

type Overview = {
  shops_total: number; shops_today: number; shops_week: number
  pro_active: number; pro_paid: number; pro_monthly: number; pro_yearly: number; blocked: number
  plus_active?: number; plus_monthly?: number; plus_yearly?: number
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

// Plan prices (₹) used only for the monthly income estimate.
const PRICE_MONTHLY = 49
const PRICE_YEARLY = 539
const PLUS_MONTHLY = 99
const PLUS_YEARLY = 999

type Tier = 'pro' | 'plus'
/** The paid plan a shop is on right now (null = Free). */
function paidTier(s: { is_pro: boolean; plan?: string | null }): Tier | null {
  return s.is_pro ? (s.plan === 'plus' ? 'plus' : 'pro') : null
}

const PAGE = 50

const LOG_KEYS: Record<string, Key> = {
  pro_given: 'admLogProGiven', pro_removed: 'admLogProRemoved', blocked: 'admLogBlocked', unblocked: 'admLogUnblocked',
  qr_reset: 'admLogQrReset', shop_edited: 'admLogShopEdited', settings: 'admLogSettings', ip_blocked: 'admLogIpBlocked',
  ip_unblocked: 'admLogIpUnblocked', report_resolved: 'admLogReport', user_disabled: 'admLogUserDisabled',
  user_enabled: 'admLogUserEnabled', reset_sent: 'admLogResetSent', sub_cancelled: 'admLogSubCancelled', files_deleted: 'admLogFilesDeleted'
}


export default function Admin() {
  const { session, loading } = useSession()
  const { t, teRaw, lang } = useI18n()
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
  const [tierPick, setTierPick] = useState<Record<string, Tier>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<AdminTab>('overview')
  const [health, setHealth] = useState<HealthData | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  const [saveSlot, setSaveSlot] = useState<SaveSlot>(null)
  // A new success message (even the same text, e.g. "Saved" twice) restarts the toast.
  const toastId = useMemo(() => Math.random(), [msg])

  useEffect(() => {
    if (!session) return
    supabase.rpc('is_admin').then(({ data, error }) => setAllowed(!error && data === true))
  }, [session])

  const loadOverview = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_overview')
    if (error) setMsg({ text: teRaw(error), error: true })
    else setOv(data as Overview)
  }, [teRaw])

  const loadShops = useCallback(async (search: string, offset: number) => {
    const { data, error } = await supabase.rpc('admin_shops', { p_q: search, p_limit: PAGE, p_offset: offset })
    if (error) { setMsg({ text: teRaw(error), error: true }); return }
    const rows = (data || []) as ShopRow[]
    setShops((prev) => (offset === 0 ? rows : [...(prev || []), ...rows]))
    setMore(rows.length === PAGE)
  }, [teRaw])

  // v30: health alerts for the bell (before v30 SQL the call fails and the bell stays hidden)
  const loadHealth = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_alerts')
    setHealth(error ? null : (data as HealthData))
  }, [])

  const loadLog = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_recent_log', { p_limit: 20 })
    if (!error) setLog((data || []) as LogRow[])
  }, [])

  useEffect(() => {
    if (!allowed) return
    loadOverview()
    loadLog()
    loadHealth()
    setupPush() // v30: this phone / browser gets health alerts for admins
  }, [allowed, loadOverview, loadLog, loadHealth])

  useEffect(() => {
    if (!allowed) return
    loadShops(query, 0)
  }, [allowed, query, loadShops])

  const refreshAll = () => Promise.all([loadOverview(), loadShops(query, 0), loadLog(), loadHealth()])

  // Refresh button: clear the old notice, reload overview/shops/log, and remount the open tab
  // (Users, Orders, Payments, Spam) so it fetches fresh data too. Settings is not remounted (unsaved edits).
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    if (refreshing) return
    setMsg(null)
    setRefreshing(true)
    setRefreshKey((k) => k + 1)
    try { await refreshAll() } finally { setRefreshing(false) }
  }

  const setPro = async (s: ShopRow, d: number) => {
    if (d === 0 && !await askConfirm(s.paid ? t('admRemoveProPaid', { name: s.name }) : t('admRemoveProAsk', { name: s.name }))) return
    setBusy(s.id)
    setMsg(null)
    // No pick: the server keeps the shop's current plan (Plus stays Plus). p_tier only when the admin chose one.
    const pick = tierPick[s.id]
    const args: Record<string, unknown> = { p_shop: s.id, p_days: d }
    if (d > 0 && pick) args.p_tier = pick
    const { data, error } = await supabase.rpc('admin_set_pro', args)
    setBusy(null)
    if (error) { setMsg({ text: teRaw(error), error: true }); return }
    const tier = d > 0 ? (pick || paidTier(s) || 'pro') : 'pro'
    setMsg({ text: d === 0 ? t('admProRemoved', { name: s.name }) : t('admProGiven', { name: s.name, date: fmtDate(data as string, lang), plan: tier === 'plus' ? 'Plus' : 'Pro' }) })
    refreshAll()
  }

  const setBlocked = async (s: ShopRow, block: boolean) => {
    if (block && !await askConfirm(t('admBlockAsk', { name: s.name }))) return
    setBusy(s.id)
    setMsg(null)
    const { error } = await supabase.rpc('admin_set_blocked', { p_shop: s.id, p_blocked: block, p_reason: reason[s.id] || null })
    setBusy(null)
    if (error) { setMsg({ text: teRaw(error), error: true }); return }
    setMsg({ text: block ? t('admBlocked', { name: s.name }) : t('admUnblocked', { name: s.name }) })
    refreshAll()
  }

  const shopTool = async (s: ShopRow, kind: 'qr' | 'name' | 'logo' | 'cancel') => {
    const ask = kind === 'qr' ? t('admResetQrAsk', { name: s.name }) : kind === 'logo' ? t('admRemoveLogoAsk', { name: s.name })
      : kind === 'cancel' ? t('admCancelSubAsk', { name: s.name }) : null
    if (ask && !(await askConfirm(ask))) return
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
      setMsg({ text: teRaw(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <AdminSkeleton />
  if (!session) return <Navigate to="/login" replace />

  const alertCount = health ? health.alerts.filter((a) => !a.closed_at).length + (healthStale(health) ? 1 : 0) : 0
  const bell = health ? { count: alertCount, onClick: () => { setNotifOpen(true); void loadHealth() } } : undefined
  const shell = (body: ReactElement, nav = false) => (
    nav
      ? <AdminShell tab={tab} onTab={setTab} onRefresh={onRefresh} refreshing={refreshing} bell={bell} save={saveSlot}>
          {body}
          {notifOpen && health && <AdminNotifications h={health} onClose={() => setNotifOpen(false)} />}
        </AdminShell>
      : <AdminShell>{body}</AdminShell>
  )

  if (allowed === null) return shell(<AdminSkelBody />, true)
  if (!allowed) return shell(<div className="card"><h2>{t('admNoAccess')}</h2><p className="muted">{t('admNoAccessHint')}</p></div>)

  // Before v19 SQL the pro_* counts include Plus and plus_* are missing (then all is priced as Pro).
  const mrr = ov ? Math.round(ov.pro_monthly * PRICE_MONTHLY + (ov.pro_yearly * PRICE_YEARLY) / 12
    + (ov.plus_monthly ?? 0) * PLUS_MONTHLY + ((ov.plus_yearly ?? 0) * PLUS_YEARLY) / 12) : 0

  const actionLabel = (a: string) => (LOG_KEYS[a] ? t(LOG_KEYS[a]) : a)

  return shell(
    <>
      <div className="admin-head">
        <h1>{t('admTitle')}</h1>
        {bell && (
          <button type="button" className="btn small soft adm-bell-d" onClick={bell.onClick} aria-label={t('admNotifs')}>
            <Icon name="bell" size={18} />{bell.count > 0 && <span className="adm-badge">{bell.count}</span>}
          </button>
        )}
        <button type="button" className="btn small soft" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>{refreshing ? '…' : t('admRefresh')}</button>
      </div>

      {msg?.error && <div className="notice error" role="alert">{msg.text}</div>}
      {msg && !msg.error && <AdminToast key={msg.text + toastId} text={msg.text} onDone={() => setMsg((m) => (m && !m.error ? null : m))} />}

      <nav className="tabs admin-tabs" aria-label={t('admTitle')}>
        {ADMIN_TABS.map((x) => (
          <button type="button" key={x} className={tab === x ? 'on' : ''} aria-current={tab === x ? 'page' : undefined} onClick={() => setTab(x)}>{t(ADMIN_TAB_KEYS[x])}</button>
        ))}
      </nav>

      {tab === 'overview' && (<>
      <h2 className="admin-sec">{t('admOverview')}</h2>
      {!ov ? <SkelStats n={8} /> : (
        <div className="stats">
          <div className="card stat accent stat-wide">
            <div className="small stat-label">{t('admMrr')}</div>
            <div className="big-num">₹{mrr.toLocaleString('en-IN')}</div>
            <div className="small stat-sub">{t('admPaidLine', { m: ov.pro_monthly + (ov.plus_monthly ?? 0), y: ov.pro_yearly + (ov.plus_yearly ?? 0) })}</div>
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
          <div className="card stat stat-wide">
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

      {!shops ? <SkelList /> : shops.length === 0 ? <p className="muted">{t('admNoShops')}</p> : (
        <div className="admin-list">
          {shops.map((s) => (
            <div className={`card admin-shop${s.blocked ? ' is-blocked' : ''}`} key={s.id}>
              <button type="button" className="admin-shop-head" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <span className="admin-shop-name">{s.name}</span>
                <span className="admin-tags">
                  {s.blocked && <span className="admin-tag bad">{t('admTagBlocked')}</span>}
                  {s.is_pro
                    ? <span className="admin-tag pro">{paidTier(s) === 'plus' ? (s.paid ? t('admTagPlusPaid') : t('admTagPlusGiven')) : (s.paid ? t('admTagPaid') : t('admTagFreePro'))}</span>
                    : <span className="admin-tag">{t('admTagFree')}</span>}
                </span>
                <span className="small muted admin-shop-sub">{s.owner_email || '—'} · {t('admOrdersWeek', { n: s.orders_week })}</span>
              </button>
              {open === s.id && (
                <div className="admin-shop-body">
                  <dl className="admin-facts">
                    <dt>{t('admLink')}</dt><dd><a href={`#/s/${s.slug}`} target="_blank" rel="noreferrer">/s/{s.slug}</a></dd>
                    <dt>{t('admPhone')}</dt><dd>{s.phone || '—'}</dd>
                    <dt>{t('admJoined')}</dt><dd>{fmtDate(s.created_at, lang)}</dd>
                    <dt>{t('admPlan')}</dt><dd>{s.is_pro ? `${paidTier(s) === 'plus' ? t('admTagPlus') : t('admTagPro')} · ${t('admUntil', { date: fmtDate(s.plan_expires_at, lang) })}` : t('admTagFree')}{s.paid && s.plan_period ? ` · ${s.plan_period}` : ''}{s.subscription_status ? ` · ${s.subscription_status}` : ''}</dd>
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
                      <select className="admin-tier" value={tierPick[s.id] || paidTier(s) || 'pro'} disabled={busy === s.id}
                        onChange={(e) => setTierPick((m) => ({ ...m, [s.id]: e.target.value as Tier }))} aria-label={t('admPlan')}>
                        <option value="pro">{t('admTagPro')}</option>
                        <option value="plus">{t('admTagPlus')}</option>
                      </select>
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

      {tab === 'users' && <AdminUsers key={refreshKey} onMsg={setMsg} />}
      {tab === 'orders' && <AdminOrders key={refreshKey} onMsg={setMsg} />}
      {tab === 'payments' && <AdminPayments key={refreshKey} onMsg={setMsg} />}
      {tab === 'spam' && <AdminSpam key={refreshKey} onMsg={setMsg} onChanged={loadLog} />}
      {tab === 'settings' && <AdminSettings onMsg={setMsg} onSaveSlot={setSaveSlot} />}

      {tab === 'log' && (<>
      <h2 className="admin-sec">{t('admLog')}</h2>
      {!log ? <SkelLog /> : log.length === 0 ? <p className="muted">{t('admLogEmpty')}</p> : (
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
    </>, true
  )
}

type HealthAlert = { key: string; title: string; detail: string; opened_at: string; last_seen: string; closed_at: string | null }
type HealthData = { checked_at: string | null; alerts: HealthAlert[] }

function healthStale(h: HealthData) {
  return !h.checked_at || Date.now() - new Date(h.checked_at).getTime() > 45 * 60 * 1000
}

/** v30: every health alert (open first, then fixed ones of the last 30 days). Opened from the bell in the top bar. */
function AdminNotifications({ h, onClose }: { h: HealthData; onClose: () => void }) {
  const { t, lang } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const when = (s: string | null) => s ? new Date(s).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
  const open = h.alerts.filter((a) => !a.closed_at)
  const fixed = h.alerts.filter((a) => a.closed_at)
  return (
    <div className="adm-notif-back no-print" onClick={onClose}>
      <div className="adm-notif" role="dialog" aria-modal="true" aria-label={t('admNotifs')} onClick={(e) => e.stopPropagation()}>
        <div className="adm-notif-head">
          <b>{t('admNotifs')}</b>
          <button type="button" className="menu-btn" onClick={onClose} aria-label={t('close')}><Icon name="x" size={20} /></button>
        </div>
        <p className={`adm-notif-sum${open.length || healthStale(h) ? ' bad' : ''}`}>
          {open.length ? t('admHealthBad', { n: open.length }) : healthStale(h) ? t('admHealthStale') : t('admHealthOk')}
        </p>
        <div className="adm-notif-list">
          {open.map((a) => (
            <div key={a.key} className="adm-notif-item bad">
              <div>⚠️ <b>{a.title}</b></div>
              <div className="small muted">{t('admHealthSince', { d: when(a.opened_at) })}</div>
              <div className="small">{a.detail}</div>
            </div>
          ))}
          {fixed.map((a) => (
            <div key={a.key + a.closed_at} className="adm-notif-item">
              <div>✅ {a.title}</div>
              <div className="small muted">{t('admHealthSince', { d: when(a.opened_at) })} · {t('admHealthFixed', { d: when(a.closed_at) })}</div>
            </div>
          ))}
          {!h.alerts.length && <p className="small muted">{t('admNotifsNone')}</p>}
        </div>
        <div className="small muted adm-notif-foot">{t('admHealthChecked', { d: when(h.checked_at) })}</div>
      </div>
    </div>
  )
}

/** Success message: slides down from the top like a notification, goes back up after 2 seconds. Errors stay as a notice. */
function AdminToast({ text, onDone }: { text: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const a = window.setTimeout(() => setLeaving(true), 2000)
    const b = window.setTimeout(onDone, 2300)
    return () => { window.clearTimeout(a); window.clearTimeout(b) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className={`adm-toast no-print${leaving ? ' out' : ''}`} role="status" aria-live="polite">
      <Icon name="check" size={18} /><span>{text}</span>
    </div>
  )
}
