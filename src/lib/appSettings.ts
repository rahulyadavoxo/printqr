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
  /** Per platform (v28); a missing key uses login_design. */
  login_designs: Partial<Record<LoginPlatform, LoginDesign>>
  /** Landing (home) page design (v31), same pattern as the login design; a missing key uses landing_design. */
  landing_design: LandingDesign
  landing_designs: Partial<Record<LoginPlatform, LandingDesign>>
}

/** classic = the current landing page, duo = two big panels (customer / shop) + cost estimator,
 * bold = big "Scan. Upload. Print." headline + live queue scene (v32). */
export const LANDING_DESIGNS = ['classic', 'duo', 'bold'] as const
export type LandingDesign = typeof LANDING_DESIGNS[number]
const isLanding = (v: unknown): v is LandingDesign => (LANDING_DESIGNS as readonly unknown[]).includes(v)
export function landingDesignFor(s: AppSettings, p: LoginPlatform = currentLoginPlatform()): LandingDesign {
  const v = s.landing_designs?.[p]
  if (isLanding(v)) return v
  if (isLanding(s.landing_design)) return s.landing_design
  return 'classic'
}
const LAND_KEY = 'pq_landing_design'
/** Last known landing design, so the home page does not flash the other design while settings load. */
function storedLanding(): LandingDesign {
  try { const v = localStorage.getItem(LAND_KEY); return isLanding(v) ? v : 'classic' } catch { return 'classic' }
}

/** classic = old card, modern = lime phone card, split = lime brand panel + card, bento = card + tiles,
 *  bentofull = full-screen tiles. The desktop ones stack into one column on narrow screens. */
export const LOGIN_DESIGNS = ['classic', 'modern', 'split', 'bento', 'bentofull'] as const
export type LoginDesign = typeof LOGIN_DESIGNS[number]
const isDesign = (v: unknown): v is LoginDesign => (LOGIN_DESIGNS as readonly unknown[]).includes(v)
/** app = Android app, mweb = website on a phone, web = website on a computer, desktop = Windows app. */
export type LoginPlatform = 'app' | 'mweb' | 'web' | 'desktop'
export const LOGIN_PLATFORMS: LoginPlatform[] = ['app', 'mweb', 'web', 'desktop']

export function currentLoginPlatform(): LoginPlatform {
  const w = window as unknown as { PQ?: unknown; PQDesktop?: unknown }
  if (w.PQ || location.hostname === 'appassets.androidplatform.net') return 'app'
  if (w.PQDesktop || /electron/i.test(navigator.userAgent)) return 'desktop'
  const phone = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) || window.matchMedia?.('(max-width: 760px)').matches
  return phone ? 'mweb' : 'web'
}

/** The login design for this device: its platform's choice, else the general one. */
/** Which designs each platform may use: the lime card is for phones, the 3 wide designs are for computers. */
export const DESIGNS_FOR: Record<LoginPlatform, readonly LoginDesign[]> = {
  app: ['classic', 'modern'],
  mweb: ['classic', 'modern'],
  web: ['classic', 'split', 'bento', 'bentofull'],
  desktop: ['classic', 'split', 'bento', 'bentofull'],
}
export function loginDesignFor(s: AppSettings, p: LoginPlatform = currentLoginPlatform()): LoginDesign {
  const ok = DESIGNS_FOR[p]
  const v = s.login_designs?.[p]
  if (isDesign(v) && ok.includes(v)) return v
  if (isDesign(s.login_design) && ok.includes(s.login_design)) return s.login_design
  return 'classic'
}
const LD_KEY = 'pq_login_design'
/** Last known login design, so the login page does not flash the other design while settings load. */
function storedDesign(): LoginDesign {
  try { const v = localStorage.getItem(LD_KEY); return isDesign(v) ? v : 'classic' } catch { return 'classic' }
}
function remember(s: AppSettings) {
  try { localStorage.setItem(LD_KEY, loginDesignFor(s)) } catch { /* private mode */ }
  try { localStorage.setItem(LAND_KEY, landingDesignFor(s)) } catch { /* private mode */ }
}

export const DEFAULT_SETTINGS: AppSettings = {
  announcement: null, announcement_hi: null, maintenance: false, maintenance_msg: null, min_app_version: null, free_counter_limit: 0, login_design: storedDesign(), login_designs: {},
  landing_design: storedLanding(), landing_designs: {}
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

/** True once the admin's settings are known: loaded this session, or a design remembered from an earlier visit.
 *  First visit (nothing remembered): false until get_app_settings answers, so Home / Login show the QR loader
 *  instead of flashing the default design. */
function rememberedDesigns(): boolean {
  try { return localStorage.getItem(LD_KEY) !== null && localStorage.getItem(LAND_KEY) !== null } catch { return false }
}
export function useSettingsKnown(): boolean {
  const [known, setKnown] = useState<boolean>(() => cache !== null || rememberedDesigns())
  useEffect(() => {
    if (known) return
    let alive = true
    loadAppSettings().then(() => { if (alive) setKnown(true) }, () => { if (alive) setKnown(true) })
    return () => { alive = false }
  }, [known])
  return known
}

/** a < b for x.y.z versions */
export function versionLess(a: string, b: string): boolean {
  const p = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) || []).slice(1).map(Number)
  const x = p(a), y = p(b)
  if (x.length !== 3 || y.length !== 3) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}
