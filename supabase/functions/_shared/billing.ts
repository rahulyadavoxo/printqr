// Shared helpers for the PrintQR billing Edge Functions (Deno, no external imports).
import { logOps } from './ops.ts'
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, (webhook) RAZORPAY_WEBHOOK_SECRET,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-provided by the Edge Runtime).

export type Period = 'monthly' | 'yearly'
export type Tier = 'pro' | 'plus'
type Price = { amount: number; total_count: number; label: string; description: string }

export const PLANS: Record<Tier, Record<Period, Price>> = {
  pro: {
    monthly: { amount: 4900, total_count: 120, label: 'PrintQR Pro – monthly', description: 'Dynamic QR, no ads for customers, passport photo sheet' },
    yearly: { amount: 53900, total_count: 10, label: 'PrintQR Pro – yearly', description: 'Dynamic QR, no ads for customers, passport photo sheet' }
  },
  plus: {
    monthly: { amount: 9900, total_count: 120, label: 'PrintQR Plus – monthly', description: 'Everything in Pro, no ads anywhere, unlimited counters' },
    yearly: { amount: 99900, total_count: 10, label: 'PrintQR Plus – yearly', description: 'Everything in Pro, no ads anywhere, unlimited counters' }
  }
}
/** Old name, Pro prices. */
export const PRICES = PLANS.pro

/** Extra days of Pro after the paid cycle ends, so a late renewal does not drop features. */
export const GRACE_DAYS = 2

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message?: string) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

export function fail(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
  console.error(e)
  // Details stay in the function logs; the browser gets a plain message (no keys, URLs or SQL).
  return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500)
}

function env(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new HttpError(500, 'missing_env', `Server is missing ${name}`)
  return v
}

/* ---------------- Supabase (service role, PostgREST) ---------------- */

function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra }
}

export async function db<T = unknown>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const headers = sbHeaders(init.prefer ? { Prefer: init.prefer } : {})
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`DB ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : null) as T
}

export type ShopRow = {
  id: string
  owner_id: string
  name: string
  plan?: string
  plan_period?: string | null
  plan_expires_at?: string | null
  razorpay_subscription_id?: string | null
  subscription_status?: string | null
}

const SHOP_COLS = 'id,owner_id,name,plan,plan_period,plan_expires_at,razorpay_subscription_id,subscription_status'

export async function getShopById(id: string): Promise<ShopRow | null> {
  const rows = await db<ShopRow[]>(`shops?id=eq.${encodeURIComponent(id)}&select=${SHOP_COLS}`)
  return rows[0] || null
}

export async function updateShop(id: string, patch: Partial<ShopRow>): Promise<void> {
  await db(`shops?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=minimal' })
}

export function isPro(s: ShopRow): boolean {
  return (s.plan === 'pro' || s.plan === 'plus') && !!s.plan_expires_at && new Date(s.plan_expires_at).getTime() > Date.now()
}

/** The logged-in owner's shop, from the caller's JWT. */
/** email is null for mobile-number (OTP) accounts; phone is then set (E.164, e.g. +919876543210). */
export async function ownerShop(req: Request): Promise<{ shop: ShopRow; email: string | null; phone: string | null }> {
  const auth = req.headers.get('Authorization') || ''
  if (!auth.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: auth }
  })
  if (!res.ok) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const user = (await res.json()) as { id?: string; email?: string; phone?: string }
  if (!user.id) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  let rows: ShopRow[]
  try {
    rows = await db<ShopRow[]>(`shops?owner_id=eq.${encodeURIComponent(user.id)}&select=${SHOP_COLS}`)
  } catch (e) {
    // 42703 = column does not exist: the v3 database update has not been run yet.
    if (String(e).includes('42703')) {
      throw new HttpError(409, 'needs_migration', 'Run supabase/migrations/2026-11-17-v3-plans.sql first')
    }
    throw e
  }
  if (!rows[0]) throw new HttpError(404, 'no_shop', 'Shop not found')
  const phone = user.phone ? (user.phone.startsWith('+') ? user.phone : `+${user.phone}`) : null
  return { shop: rows[0], email: user.email || null, phone }
}

/* ---------------- Razorpay ---------------- */

export function razorpayKeyId(): string {
  return env('RAZORPAY_KEY_ID')
}

export async function rzp<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const basic = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`)
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const desc = (data as { error?: { description?: string } } | null)?.error?.description || text
    throw new HttpError(502, 'razorpay_error', `Razorpay: ${desc}`)
  }
  return data as T
}

export type Subscription = {
  id: string
  plan_id: string
  status: string
  current_start?: number | null
  current_end?: number | null
  charge_at?: number | null
  start_at?: number | null
  created_at?: number | null
  notes?: Record<string, string> | unknown[] | null
}

export function subNotes(s: Subscription): Record<string, string> {
  return s.notes && !Array.isArray(s.notes) ? (s.notes as Record<string, string>) : {}
}

/** Razorpay plan id for this tier + period (created once, then cached in public.billing_plans by amount). */
export async function planId(period: Period, tier: Tier = 'pro'): Promise<string> {
  const p = PLANS[tier][period]
  const q = `billing_plans?period=eq.${period}&amount=eq.${p.amount}&select=razorpay_plan_id`
  const cached = await db<{ razorpay_plan_id: string }[]>(q)
  if (cached[0]) return cached[0].razorpay_plan_id
  const plan = await rzp<{ id: string }>('plans', 'POST', {
    period,
    interval: 1,
    item: { name: p.label, amount: p.amount, currency: 'INR', description: p.description },
    notes: { app: 'printqr', period, tier }
  })
  await db('billing_plans?on_conflict=period,amount', {
    method: 'POST',
    body: JSON.stringify({ period, amount: p.amount, razorpay_plan_id: plan.id }),
    prefer: 'resolution=ignore-duplicates,return=minimal'
  })
  // Another request may have won the race; use whatever is stored.
  const again = await db<{ razorpay_plan_id: string }[]>(q)
  return again[0]?.razorpay_plan_id || plan.id
}

/** Which period a Razorpay subscription is for (notes first, then the cached plan ids). */
export async function periodOf(s: Subscription): Promise<Period | null> {
  const n = subNotes(s).period
  if (n === 'monthly' || n === 'yearly') return n
  const rows = await db<{ period: Period }[]>(`billing_plans?razorpay_plan_id=eq.${encodeURIComponent(s.plan_id)}&select=period`)
  return rows[0]?.period || null
}

/** Which tier a subscription is for (notes first, then the plan's amount). Old subscriptions are Pro. */
export async function tierOf(s: Subscription): Promise<Tier> {
  const n = subNotes(s).tier
  if (n === 'pro' || n === 'plus') return n
  const rows = await db<{ amount: number }[]>(`billing_plans?razorpay_plan_id=eq.${encodeURIComponent(s.plan_id)}&select=amount`)
  const a = rows[0]?.amount
  return a === PLANS.plus.monthly.amount || a === PLANS.plus.yearly.amount ? 'plus' : 'pro'
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400 * 1000)
}

const DAY_MS = 86400 * 1000

/** End of the shop's paid period (expiry without the grace days), in ms. 0 when there is none. */
export function paidEndMs(shop: ShopRow): number {
  return shop.plan_expires_at ? new Date(shop.plan_expires_at).getTime() - GRACE_DAYS * DAY_MS : 0
}

/** Whole unused paid days of the plan the shop is on now (rounded down). */
function unusedDays(shop: ShopRow, now: number): number {
  if (!isPro(shop)) return 0
  return Math.max(0, Math.floor((paidEndMs(shop) - now) / DAY_MS))
}

/** Extra days stored for this subscription (v22 billing_credits), or null when none. */
async function storedCredit(subId: string): Promise<number | null> {
  try {
    const rows = await db<{ days: number }[]>(`billing_credits?sub_id=eq.${encodeURIComponent(subId)}&select=days`)
    return rows[0] ? Number(rows[0].days) || 0 : null
  } catch (e) {
    // v22 not run yet: no table means no credits stored.
    const t = String(e)
    if (t.includes('PGRST205') || t.includes('42P01')) {
      console.warn('billing_credits missing: run supabase/migrations/2026-11-21-v22-billing-idem.sql')
      return null
    }
    throw e
  }
}

/** Store the extra days once per subscription; the first stored value always wins (repeats add nothing). */
async function saveCredit(subId: string, shopId: string, days: number, reason: string): Promise<number> {
  await db('billing_credits?on_conflict=sub_id', {
    method: 'POST',
    body: JSON.stringify({ sub_id: subId, shop_id: shopId, days, reason }),
    prefer: 'resolution=ignore-duplicates,return=minimal'
  })
  const stored = await storedCredit(subId)
  return stored === null ? days : stored
}

/** Is s older than the shop's current subscription (a late event from one the shop already replaced)? */
async function olderThanCurrent(s: Subscription, currentId: string): Promise<boolean> {
  if (!s.created_at) return false
  try {
    const cur = await rzp<Subscription>(`subscriptions/${encodeURIComponent(currentId)}`)
    return !!cur.created_at && s.created_at < cur.created_at
  } catch (e) {
    console.warn('current sub lookup', e)
    return false
  }
}

/**
 * Turn the paid plan on (or extend it) for the shop in the subscription notes.
 * Expiry = current_end + grace + any extra days stored for this subscription. If Razorpay has not filled
 * current_end yet (just paid), fall back to now + one period + grace. Same tier: expiry never moves
 * backwards, so repeats are harmless.
 *
 * A new subscription replacing another one while that one's paid period is still running gets the
 * unused days as extra days, computed once and stored per subscription id (billing_credits):
 *   same tier (re-bought after cancelling)  -> the unused days as they are
 *   other tier (Pro -> Plus, or Plus -> Pro) -> unused days x old price / new price (same period basis), rounded down
 * A Pro subscription that starts later (start_at, bought while a cancelled Plus runs) is only recorded;
 * Plus stays until it ends and Razorpay starts the Pro cycle then.
 */
export async function activate(s: Subscription, expectShopId?: string): Promise<ShopRow> {
  const shopId = subNotes(s).shop_id
  if (!shopId) throw new HttpError(400, 'bad_subscription', 'Subscription has no shop')
  if (expectShopId && shopId !== expectShopId) throw new HttpError(403, 'wrong_shop', 'This payment is for another shop')
  const shop = await getShopById(shopId)
  if (!shop) throw new HttpError(404, 'no_shop', 'Shop not found')
  const period = (await periodOf(s)) || (shop.plan_period as Period | null) || 'monthly'
  const tier = await tierOf(s)
  const now = Date.now()
  const running = isPro(shop)
  const currentId = shop.razorpay_subscription_id || null
  const isNew = !!currentId && currentId !== s.id

  if (isNew) {
    // A late event from a subscription whose paid cycle is already over grants nothing and must not
    // replace the shop's current subscription.
    if (s.current_end && s.current_end * 1000 + GRACE_DAYS * DAY_MS <= now) return shop
    // A late event from an older subscription the shop has since replaced (e.g. the old Pro after an
    // upgrade to Plus) must not pull the shop back. Only checked while a paid plan runs, so a late
    // payment on a free shop is still honoured.
    if (running && (await olderThanCurrent(s, currentId))) return shop
  }

  // Not started yet (start_at in the future, no cycle): record it, keep the running plan as it is.
  if (s.start_at && s.start_at * 1000 > now && !s.current_end) {
    const patch: Partial<ShopRow> = { razorpay_subscription_id: s.id, subscription_status: s.status }
    await updateShop(shop.id, patch)
    return { ...shop, ...patch }
  }

  let credit = (await storedCredit(s.id)) ?? 0
  if (isNew && running && credit === 0) {
    const unused = unusedDays(shop, now)
    const oldTier: Tier = shop.plan === 'plus' ? 'plus' : 'pro'
    const basis = (shop.plan_period as Period | null) || period
    const days = oldTier === tier ? unused : Math.floor((unused * PLANS[oldTier][basis].amount) / PLANS[tier][basis].amount)
    if (days > 0) credit = await saveCredit(s.id, shop.id, days, `${oldTier}->${tier} ${basis}`)
  }

  const base = s.current_end
    ? new Date(s.current_end * 1000)
    : addDays(new Date(now), period === 'yearly' ? 365 : 31)
  const end = addDays(base, GRACE_DAYS + credit)
  const prev = shop.plan_expires_at ? new Date(shop.plan_expires_at) : null
  // Same tier: never move expiry backwards. Tier change: the new subscription's cycle (+ credit) decides.
  const expires = shop.plan === tier && prev && prev > end ? prev : end
  const patch: Partial<ShopRow> = {
    plan: tier,
    plan_period: period,
    plan_expires_at: expires.toISOString(),
    razorpay_subscription_id: s.id,
    subscription_status: s.status
  }
  await updateShop(shop.id, patch)
  // Replaced another subscription (upgrade, or re-bought after cancelling): its unused days are now
  // credited above, so stop billing the old one now.
  if (isNew && currentId) {
    await rzp(`subscriptions/${encodeURIComponent(currentId)}/cancel`, 'POST', { cancel_at_cycle_end: 0 }).catch((e) => console.warn('old sub cancel', e))
  }
  return { ...shop, ...patch }
}

/* ---------------- Crypto ---------------- */

export async function hmacHex(secret: string, message: string | Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const data = typeof message === 'string' ? enc.encode(message) : message
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export function keySecret(): string {
  return env('RAZORPAY_KEY_SECRET')
}

/* ---------------- Payments (receipts, v33) ---------------- */

export type Payment = {
  id: string
  amount?: number | null
  currency?: string | null
  status?: string | null
  created_at?: number | null
}

function isoOrNull(sec?: number | null): string | null {
  return sec ? new Date(sec * 1000).toISOString() : null
}

/**
 * Store one row per Razorpay payment in public.billing_payments (owner sees it as a receipt).
 * payment_id is unique: repeats (webhook retries, verify after webhook) only refresh the same row.
 * Never throws: a missing receipt row must not stop the plan from switching on.
 */
export async function recordPayment(s: Subscription, p: Payment, shopId?: string): Promise<void> {
  try {
    const shop = shopId || subNotes(s).shop_id
    if (!p?.id || !shop) return
    if (p.status && !['captured', 'authorized'].includes(p.status)) return
    const tier = await tierOf(s)
    const period = await periodOf(s)
    const amount = typeof p.amount === 'number' ? p.amount : period ? PLANS[tier][period].amount : 0
    const row: Record<string, unknown> = {
      payment_id: p.id,
      shop_id: shop,
      subscription_id: s.id,
      tier,
      period,
      amount,
      currency: (p.currency || 'INR').toUpperCase(),
      paid_at: isoOrNull(p.created_at), // unknown: the column default (now) on first insert
      period_start: isoOrNull(s.current_start),
      period_end: isoOrNull(s.current_end)
    }
    // A repeat must not blank a value an earlier write had (e.g. the cycle dates Razorpay fills later).
    for (const k of Object.keys(row)) if (row[k] === null) delete row[k]
    await db('billing_payments?on_conflict=payment_id', {
      method: 'POST',
      body: JSON.stringify(row),
      prefer: 'resolution=merge-duplicates,return=minimal'
    })
  } catch (e) {
    const t = String(e)
    if (t.includes('PGRST205') || t.includes('42P01')) {
      console.warn('billing_payments missing: run supabase/migrations/2026-11-23-v33-billing-payments.sql')
      return
    }
    console.error('record payment', e)
    await logOps('billing-payments', e, 'warn')
  }
}
