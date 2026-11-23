import type { Key } from './i18n'

/** Dashboard tabs and menu layout. Shared by the Dashboard and its loading skeleton (no heavy imports here). */
export type Tab = 'orders' | 'rates' | 'qr' | 'edit' | 'report' | 'settings' | 'plan'

export const TABS: { id: Tab; label: Key; icon: string }[] = [
  { id: 'orders', label: 'tabOrders', icon: 'orders' },
  { id: 'rates', label: 'tabRates', icon: 'rupee' },
  { id: 'qr', label: 'tabQr', icon: 'qrnav' },
  { id: 'edit', label: 'tabEdit', icon: 'editnav' },
  { id: 'report', label: 'tabReport', icon: 'earnings' },
  { id: 'settings', label: 'tabSettings', icon: 'settings' },
  { id: 'plan', label: 'tabPlan', icon: 'plans' }
]

/** Android app and Android web: bottom bar, left to right (Orders in the centre, Settings on the right). */
export const BOTTOM: Tab[] = ['report', 'qr', 'orders', 'edit', 'settings']

export const NAV: { group: Key; items: Tab[] }[] = [
  { group: 'navShop', items: ['orders', 'rates', 'qr', 'edit'] },
  { group: 'navBusiness', items: ['report', 'plan'] },
  { group: 'navAccount', items: ['settings'] }
]

export type SbMode = 'expanded' | 'collapsed' | 'hover'
export function savedSidebar(): SbMode {
  try {
    const v = localStorage.getItem('pq_sidebar')
    return v === 'expanded' || v === 'collapsed' ? v : 'hover'
  } catch { return 'hover' }
}
export const isTab = (v: string | null): v is Tab => !!v && TABS.some((x) => x.id === v)
