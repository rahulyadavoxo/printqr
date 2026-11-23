import { PUBLIC_BASE } from './app'
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)
export const SUPABASE_URL = url || 'https://example.supabase.co'
export const SUPABASE_KEY = key || 'missing-key'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
})

/** True for errors that mean the request went out without a valid login (expired token after being offline). */
export function isAuthError(e: unknown): boolean {
  const m = String((e as { message?: string } | null)?.message ?? e ?? '')
  const code = String((e as { code?: string } | null)?.code ?? '')
  return code === '42501' || code === 'PGRST301' || code === 'PGRST303' || /permission denied for (table|relation|schema)|jwt expired|invalid jwt/i.test(m)
}

/** After an auth error: refresh the login once. true = refreshed (retry the request), false = really signed out. */
let refreshing: Promise<boolean> | null = null
export function recoverSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession()
        if (data.session && !error) return true
        // Offline: keep the saved login, try again when the internet is back.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
        await supabase.auth.signOut({ scope: 'local' })
        return false
      } catch {
        return false
      } finally {
        setTimeout(() => { refreshing = null }, 0)
      }
    })()
  }
  return refreshing
}

export type Rates = {
  bw_single: number
  bw_double: number
  color_single: number
  color_double: number
  /** Passport photo sheet (A4), price per sheet. Present once the v2 database migration has run. */
  passport_sheet?: number
  /** ID card sheet (A4, front + back at card size), price per sheet. Pro / Plus, v23 database update. */
  idcard_sheet?: number
  /** v17 extras (0 / missing = not offered): binding per copy, lamination per sheet. */
  binding?: number
  lamination?: number
}

export type Counter = {
  id: string
  shop_id: string
  name: string
  created_at: string
}

export type Shop = {
  id: string
  owner_id: string
  name: string
  slug: string
  address: string | null
  phone: string | null
  upi_id: string | null
  is_open: boolean
  rates: Rates
  auto_delete_hours: number
  created_at: string
  /** Profile picture (public URL). Present once the v6 update (2026-11-18-v6-shop-photo.sql) has run. */
  logo_url?: string | null
  blocked?: boolean
  blocked_reason?: string | null
  /** Plan columns: present once the v3 database update (2026-11-17-v3-plans.sql) has run. */
  plan?: 'free' | 'pro' | 'plus'
  plan_period?: 'monthly' | 'yearly' | null
  plan_expires_at?: string | null
  razorpay_subscription_id?: string | null
  subscription_status?: string | null
  /** v17: Plus brand colour (#rrggbb), QR card design (Pro/Plus), shop timings */
  brand_color?: string | null
  qr_design?: QrDesign | null
  hours?: unknown
  /** v23: paper stock in sheets (null = not tracked), alert below paper_low_at sheets. */
  paper_sheets?: number | null
  paper_low_at?: number
  paper_alerted_at?: string | null
  /** Set when this login is staff at the shop (my_staff_shop), not the owner. */
  staff?: boolean
  staff_active?: boolean
}

/** Custom QR card (Pro/Plus, shops.qr_design). */
export type QrDesign = { template?: 'classic' | 'dark' | 'minimal'; color?: string; headline?: string; footer?: string }

/** Plans exist in the database (v3 update ran). Before that the app behaves as before: no ads, no locks. */
export function plansReady(s: Shop): boolean {
  return s.plan !== undefined
}

/** Paid = plan 'pro' or 'plus' and not expired (same rule as public.is_pro in the database). */
export function shopIsPro(s: Shop): boolean {
  return (s.plan === 'pro' || s.plan === 'plus') && !!s.plan_expires_at && new Date(s.plan_expires_at).getTime() > Date.now()
}

/** Plus = plan 'plus' and not expired: no ads for the owner either, unlimited counters. */
export function shopIsPlus(s: Shop): boolean {
  return s.plan === 'plus' && !!s.plan_expires_at && new Date(s.plan_expires_at).getTime() > Date.now()
}

/** New counters a Pro shop may add (public.pro_counter_limit). Plus has no limit. */
export const PRO_COUNTER_LIMIT = 2

/** Default named counters a free shop may use; the live value is app_settings.free_counter_limit (useAppSettings). */
export const FREE_COUNTER_LIMIT = 0

export type OrderStatus = 'uploading' | 'received' | 'printing' | 'ready' | 'done' | 'cancelled'

export type OrderFile = {
  id: string
  order_id: string
  storage_path: string
  file_name: string
  mime: string | null
  size_bytes: number | null
  total_pages: number
  page_range: string | null
  pages_to_print: number
  copies: number
  color: boolean
  duplex: boolean
  price: number
  item_kind?: 'print' | 'passport' | 'idcard'
  photos?: number | null
  binding?: boolean
  lamination?: boolean
}

export type Order = {
  id: string
  shop_id: string
  token: number
  customer_name: string | null
  note: string | null
  status: OrderStatus
  total: number
  files_deleted: boolean
  counter_id?: string | null
  counter_name?: string | null
  created_at: string
  updated_at: string
  order_files?: OrderFile[]
  /** v34: when the shop marked it paid (null = unpaid). */
  paid_at?: string | null
  /** v34: reported with "Report file": files are kept for review and hidden from the shop. */
  hold?: boolean
}

export const DEFAULT_RATES: Rates = { bw_single: 2, bw_double: 1.5, color_single: 10, color_double: 8 }
export const DEFAULT_PASSPORT_RATE = 40
/** Same default as the database (create_order / get_shop_public, v23). */
export const DEFAULT_IDCARD_RATE = 20

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function errMsg(e: unknown): string {
  if (!e) return 'Something went wrong'
  if (typeof e === 'string') return e
  const m = (e as { message?: string }).message
  return m || 'Something went wrong'
}

/** Dynamic (Pro) QR row: a short code whose target the owner can change after printing. */
export type QrLink = {
  code: string
  shop_id: string
  slot: string
  target_counter_id: string | null
  paused: boolean
  scans: number
  last_scan_at: string | null
}

/** Link printed in a dynamic QR. */
export function qrCodeUrl(code: string): string {
  return `${PUBLIC_BASE}#/q/${code}`
}

/** Customer link for the shop. With a counter id the order is tagged with that counter (?c=<id>). */
export function shopUrl(slug: string, counterId?: string | null): string {
  const base = `${PUBLIC_BASE}#/s/${slug}`
  return counterId ? `${base}?c=${counterId}` : base
}
