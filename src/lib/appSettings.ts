import { useEffect, useState } from 'react'
import { supabase } from './supabase'

/** Settings the admin controls (public.app_settings via get_app_settings). Loaded once per page load. */
export type AppSettings = {
  announcement: string | null
  announcement_hi: string | null
  maintenance: boolean
  maintenance_msg: string | null
  min_app_version: string | null
  free_counter_limit: number
  login_design: LoginDesign
}

export type LoginDesign = 'classic' | 'modern'
const LD_KEY = 'pq_login_design'
/** Last known login design, so the login page does not flash the other design while settings load. */
function storedDesign(): LoginDesign {
  try { return localStorage.getItem(LD_KEY) === 'modern' ? 'modern' : 'classic' } catch { return 'classic' }
}
function remember(s: AppSettings) {
  try { localStorage.setItem(LD_KEY, s.login_design === 'modern' ? 'modern' : 'classic') } catch { /* private mode */ }
}

export const DEFAULT_SETTINGS: AppSettings = {
  announcement: null, announcement_hi: null, maintenance: false, maintenance_msg: null, min_app_version: null, free_counter_limit: 0, login_design: storedDesign()
}

let cache: AppSettings | null = null
let pending: Promise<AppSettings> | null = null
const listeners = new Set<(s: AppSettings) => void>()

export function loadAppSettings(force = false): Promise<AppSettings> {
  if (cache && !force) return Promise.resolve(cache)
  if (pending && !force) return pending
  pending = Promise.resolve(supabase.rpc('get_app_settings')).then(({ data, error }) => {
    // Before the v13 database update the function does not exist: keep the defaults.
    const s = !error && data ? { ...DEFAULT_SETTINGS, ...(data as Partial<AppSettings>) } : DEFAULT_SETTINGS
    cache = s
    remember(s)
    pending = null
    listeners.forEach((l) => l(s))
    return s
  }, () => {
    pending = null
    return cache || DEFAULT_SETTINGS
  })
  return pending
}

export function setAppSettingsCache(s: AppSettings) {
  cache = s
  remember(s)
  listeners.forEach((l) => l(s))
}

export function useAppSettings(): AppSettings {
  const [s, setS] = useState<AppSettings>(cache || DEFAULT_SETTINGS)
  useEffect(() => {
    listeners.add(setS)
    loadAppSettings().then(setS)
    return () => { listeners.delete(setS) }
  }, [])
  return s
}

/** a < b for x.y.z versions */
export function versionLess(a: string, b: string): boolean {
  const p = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) || []).slice(1).map(Number)
  const x = p(a), y = p(b)
  if (x.length !== 3 || y.length !== 3) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}
