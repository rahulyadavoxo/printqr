import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

export const supabase = createClient(url || 'https://example.supabase.co', key || 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
})

export type Rates = {
  bw_single: number
  bw_double: number
  color_single: number
  color_double: number
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
  created_at: string
  updated_at: string
  order_files?: OrderFile[]
}

export const DEFAULT_RATES: Rates = { bw_single: 2, bw_double: 1.5, color_single: 10, color_double: 8 }

export function errMsg(e: unknown): string {
  if (!e) return 'Kuch gadbad ho gayi'
  if (typeof e === 'string') return e
  const m = (e as { message?: string }).message
  return m || 'Kuch gadbad ho gayi'
}

export function shopUrl(slug: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}#/s/${slug}`
}
