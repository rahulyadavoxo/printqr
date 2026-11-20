/** Shop timings (shops.hours, v17). Days are 0 = Sunday ... 6 = Saturday, India time. */
export type DayHours = { open: string; close: string; closed: boolean }
export type ShopHours = { enabled: boolean; days: Record<string, DayHours> }

export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function defaultHours(): ShopHours {
  const days: Record<string, DayHours> = {}
  for (let d = 0; d < 7; d++) days[String(d)] = { open: '09:00', close: '21:00', closed: d === 0 }
  return { enabled: false, days }
}

export function normHours(h: unknown): ShopHours {
  const base = defaultHours()
  if (!h || typeof h !== 'object') return base
  const x = h as Partial<ShopHours>
  const days = { ...base.days }
  for (let d = 0; d < 7; d++) {
    const v = x.days?.[String(d)]
    if (v && typeof v === 'object') days[String(d)] = { open: v.open || '09:00', close: v.close || '21:00', closed: !!v.closed }
  }
  return { enabled: !!x.enabled, days }
}

/** Now in India: weekday and minutes since midnight. */
function indiaNow(at = new Date()): { dow: number; min: number } {
  const ist = new Date(at.getTime() + (330 + at.getTimezoneOffset()) * 60000)
  return { dow: ist.getDay(), min: ist.getHours() * 60 + ist.getMinutes() }
}
const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** "9:00 AM" from "09:00". */
export function timeLabel(s: string, lang: string): string {
  const m = mins(s)
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60)
  return d.toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit' })
}

/** When the shop opens next (within a week), e.g. { day: 1, time: '09:00', today: false }; null without a schedule. */
export function nextOpening(h: ShopHours | null | undefined, at = new Date()): { dow: number; time: string; today: boolean } | null {
  if (!h?.enabled) return null
  const now = indiaNow(at)
  for (let i = 0; i < 8; i++) {
    const dow = (now.dow + i) % 7
    const d = h.days[String(dow)]
    if (!d || d.closed) continue
    if (i === 0 && mins(d.open) <= now.min) continue
    return { dow, time: d.open, today: i === 0 }
  }
  return null
}
