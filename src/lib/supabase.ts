import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)
export const SUPABASE_URL = url || 'https://example.supabase.co'
export const SUPABASE_KEY = key || 'missing-key'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
})

export type Rates = {
  bw_single: number
  bw_double: number
  color_single: number
  color_double: number
  /** Passport photo sheet (A4), price per sheet. Present once the v2 database migration has run. */
  passport_sheet?: number
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
}

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
  item_kind?: 'print' | 'passport'
  photos?: number | null
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
}

export const DEFAULT_RATES: Rates = { bw_single: 2, bw_double: 1.5, color_single: 10, color_double: 8 }
export const DEFAULT_PASSPORT_RATE = 40

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function errMsg(e: unknown): string {
  if (!e) return 'Something went wrong'
  if (typeof e === 'string') return e
  const m = (e as { message?: string }).message
  return m || 'Something went wrong'
}

/** Customer link for the shop. With a counter id the order is tagged with that counter (?c=<id>). */
export function shopUrl(slug: string, counterId?: string | null): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}#/s/${slug}`
  return counterId ? `${base}?c=${counterId}` : base
}
