/** Windows app (desktop/preload.js) adds window.PQDesktop: print order files straight to a printer. */
export type DesktopPrinter = { name: string; displayName: string; isDefault: boolean }
export type DesktopPrintJob = {
  url: string
  name: string
  copies: number
  color: boolean
  duplex: boolean
  pages?: string | null
  kind?: string
  printer?: string
}
type DesktopApi = {
  version?: number
  printers: () => Promise<DesktopPrinter[]>
  print: (job: DesktopPrintJob) => Promise<{ ok: boolean; error?: string }>
  /** Windows app 1.5.34+: language of its own notifications and tray menu. */
  setLang?: (lang: string) => void
}

export function desktopApi(): DesktopApi | undefined {
  return (window as unknown as { PQDesktop?: DesktopApi }).PQDesktop
}

const PRINTABLE = /\.(pdf|jpe?g|png|gif|bmp|tiff?|webp)$/i
/** Word files etc. still go through Open / Print. */
export function canDirectPrint(fileName: string): boolean {
  return PRINTABLE.test(fileName)
}

const PRINTER_KEY = 'pq-printer'
export function savedPrinter(): string {
  try { return localStorage.getItem(PRINTER_KEY) || '' } catch { return '' }
}
export function savePrinter(name: string) {
  try { localStorage.setItem(PRINTER_KEY, name) } catch { /* ignore */ }
}
