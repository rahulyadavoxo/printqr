import type { Rates } from './supabase'

/** Parses "1-3,5,8-10" into a count of pages (within 1..total). Returns null if invalid. */
export function countRange(range: string, total: number): number | null {
  const r = range.replace(/\s+/g, '')
  if (!r) return total
  const pages = new Set<number>()
  for (const part of r.split(',')) {
    if (!part) continue
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) return null
    const a = parseInt(m[1], 10)
    const b = m[2] ? parseInt(m[2], 10) : a
    if (a < 1 || b < a || b > total) return null
    for (let i = a; i <= b; i++) pages.add(i)
  }
  return pages.size || null
}

export function rateFor(rates: Rates, color: boolean, duplex: boolean): number {
  const key = `${color ? 'color' : 'bw'}_${duplex ? 'double' : 'single'}` as keyof Rates
  return Number(rates[key] ?? 0)
}

/** Price of one printed file (same rule as public.file_price, v17): pages x copies x page rate,
 *  + binding per copy, + lamination per sheet (pages, or pages / 2 rounded up when both sides) per copy. */
export function filePrice(rates: Rates, pages: number, copies: number, color: boolean, duplex: boolean, binding = false, lamination = false): number {
  const bind = binding ? copies * Number(rates.binding ?? 0) : 0
  const lam = lamination ? (duplex ? Math.ceil(pages / 2) : pages) * copies * Number(rates.lamination ?? 0) : 0
  return pages * copies * rateFor(rates, color, duplex) + bind + lam
}

export function rupees(n: number): string {
  const v = Math.round(n * 100) / 100
  return '₹' + (Number.isInteger(v) ? v.toString() : v.toFixed(2))
}
