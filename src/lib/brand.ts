import { CSSProperties } from 'react'

/** Colours a Plus shop can pick for its customer pages (any #rrggbb also works). */
export const BRAND_SWATCHES = ['#3f6212', '#1d4ed8', '#7c3aed', '#be123c', '#c2410c', '#0f766e', '#0e1628', '#a16207']

export function validHex(c: string | null | undefined): c is string {
  return !!c && /^#[0-9a-fA-F]{6}$/.test(c)
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function hex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b)
  return hex(x.map((v, i) => v + (y[i] - v) * t))
}
/** Text colour that reads on this background. */
export function inkOn(c: string): string {
  const [r, g, b] = rgb(c)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0b1210' : '#ffffff'
}

/** CSS variables for a page wrapper with class "branded" (Plus shop colour). Empty when no colour. */
export function brandStyle(c: string | null | undefined): CSSProperties | undefined {
  if (!validHex(c)) return undefined
  const d = mix(c, '#000000', 0.25)
  return {
    '--own': c,
    '--own-d': d,
    '--own-ink': inkOn(c),
    '--own-50': mix(c, '#ffffff', 0.9),
    '--own-100': mix(c, '#ffffff', 0.8),
    '--own-200': mix(c, '#ffffff', 0.6)
  } as CSSProperties
}
