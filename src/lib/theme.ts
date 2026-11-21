import { useCallback, useEffect, useState } from 'react'
import { nativeBridge } from './app'

/** Light / dark / follow the phone. Saved on this device. index.html applies it before React loads. */
export type ThemePref = 'light' | 'dark' | 'system'
const KEY = 'pq-theme'
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function isDark(pref: ThemePref): boolean {
  return pref === 'dark' || (pref === 'system' && !!mq?.matches)
}

export function applyTheme(pref: ThemePref) {
  const dark = isDark(pref)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
  const top = topColor ? (dark ? topColor.dark : topColor.light) : dark ? '#0b1210' : '#faf9f6'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', top)
  try {
    const b = nativeBridge()
    b?.setBars?.(dark)
    if (topColor) b?.setStatusColor?.(top, !dark)
  } catch {
    /* older app without setBars */
  }
}

/** A page whose top bar has its own colour sets it here, so the phone status bar (app) and
 *  Android browser bar (theme-color) match it; null puts back the normal page colour. */
let topColor: { light: string; dark: string } | null = null
export function setTopColor(c: { light: string; dark: string } | null) {
  topColor = c
  applyTheme(readTheme())
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readTheme)
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system' || !mq) return
    const on = () => applyTheme('system')
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [pref])
  const set = useCallback((p: ThemePref) => {
    try {
      if (p === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, p)
    } catch {
      /* private mode */
    }
    setPref(p)
  }, [])
  return { pref, dark: isDark(pref), setTheme: set }
}
