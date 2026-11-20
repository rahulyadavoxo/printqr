import { plansReady, Shop, shopIsPlus, shopIsPro } from './supabase'

/** Plan limits (same numbers as public.plan_file_hours / plan_order_bytes / plan_history_days, v17 SQL). */
export type PlanTier = 'free' | 'pro' | 'plus'
export const FILE_HOURS: Record<PlanTier, number> = { free: 1, pro: 24, plus: 168 }
export const ORDER_MB: Record<PlanTier, number> = { free: 50, pro: 100, plus: 200 }
export const HISTORY_DAYS: Record<PlanTier, number> = { free: 7, pro: 183, plus: 365 }

/** Before the v3 database update there are no plans (old behaviour: nothing locked). */
export function shopTier(s: Shop): PlanTier {
  if (!plansReady(s)) return 'plus'
  return shopIsPlus(s) ? 'plus' : shopIsPro(s) ? 'pro' : 'free'
}

/** Hours files really stay: the owner's choice, capped by the plan (public.shop_file_hours). */
export function fileHours(s: Shop): number {
  return Math.min(Math.max(1, Number(s.auto_delete_hours) || 24), FILE_HOURS[shopTier(s)])
}

/** The cheapest plan that has a limit at least `need` in `table`. */
export function tierFor(table: Record<PlanTier, number>, need: number): PlanTier {
  return table.free >= need ? 'free' : table.pro >= need ? 'pro' : 'plus'
}

const AUTO_KEY = 'pq-autoprint'
export function autoPrintOn(): boolean {
  try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false }
}
export function setAutoPrint(on: boolean) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0') } catch { /* ignore */ }
}
