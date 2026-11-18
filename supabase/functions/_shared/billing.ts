// Shared helpers for the PrintQR billing Edge Functions (Deno, no external imports).
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, (webhook) RAZORPAY_WEBHOOK_SECRET,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-provided by the Edge Runtime).

export const PRICES = {
  monthly: { amount: 4900, total_count: 120, label: 'PrintQR Pro – monthly' },
  yearly: { amount: 53900, total_count: 10, label: 'PrintQR Pro – yearly' }
} as const
export type Period = keyof typeof PRICES

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
  return s.plan === 'pro' && !!s.plan_expires_at && new Date(s.plan_expires_at).getTime() > Date.now()
}

/** The logged-in owner's shop, from the caller's JWT. */
export async function ownerShop(req: Request): Promise<{ shop: ShopRow; email: string | null }> {
  const auth = req.headers.get('Authorization') || ''
  if (!auth.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: auth }
  })
  if (!res.ok) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const user = (await res.json()) as { id?: string; email?: string }
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
  return { shop: rows[0], email: user.email || null }
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
  notes?: Record<string, string> | unknown[] | null
}

export function subNotes(s: Subscription): Record<string, string> {
  return s.notes && !Array.isArray(s.notes) ? (s.notes as Record<string, string>) : {}
}

/** Razorpay plan id for this period (created once, then cached in public.billing_plans). */
export async function planId(period: Period): Promise<string> {
  const p = PRICES[period]
  const q = `billing_plans?period=eq.${period}&amount=eq.${p.amount}&select=razorpay_plan_id`
  const cached = await db<{ razorpay_plan_id: string }[]>(q)
  if (cached[0]) return cached[0].razorpay_plan_id
  const plan = await rzp<{ id: string }>('plans', 'POST', {
    period,
    interval: 1,
    item: { name: p.label, amount: p.amount, currency: 'INR', description: 'No ads, unlimited counters, passport photo sheet' },
    notes: { app: 'printqr', period }
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

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400 * 1000)
}

/**
 * Turn Pro on (or extend it) for the shop in the subscription notes.
 * Expiry = current_end + grace. If Razorpay has not filled current_end yet (just paid),
 * fall back to now + one period + grace. Expiry never moves backwards, so repeats are harmless.
 */
export async function activate(s: Subscription, expectShopId?: string): Promise<ShopRow> {
  const shopId = subNotes(s).shop_id
  if (!shopId) throw new HttpError(400, 'bad_subscription', 'Subscription has no shop')
  if (expectShopId && shopId !== expectShopId) throw new HttpError(403, 'wrong_shop', 'This payment is for another shop')
  const shop = await getShopById(shopId)
  if (!shop) throw new HttpError(404, 'no_shop', 'Shop not found')
  const period = (await periodOf(s)) || (shop.plan_period as Period | null) || 'monthly'
  const end = s.current_end
    ? addDays(new Date(s.current_end * 1000), GRACE_DAYS)
    : addDays(period === 'yearly' ? addDays(new Date(), 365) : addDays(new Date(), 31), GRACE_DAYS)
  const prev = shop.plan_expires_at ? new Date(shop.plan_expires_at) : null
  const expires = prev && prev > end ? prev : end
  const patch: Partial<ShopRow> = {
    plan: 'pro',
    plan_period: period,
    plan_expires_at: expires.toISOString(),
    razorpay_subscription_id: s.id,
    subscription_status: s.status
  }
  await updateShop(shop.id, patch)
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
