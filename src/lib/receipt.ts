import { SELLER } from './seller'

/** One row of public.billing_payments (v33). amount is in paise. */
export type BillingPayment = {
  payment_id: string
  subscription_id: string | null
  tier: 'pro' | 'plus'
  period: 'monthly' | 'yearly' | null
  amount: number
  currency: string
  paid_at: string
  period_start: string | null
  period_end: string | null
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '-'

/** "INR 539.00" (the built-in PDF fonts have no rupee sign). */
export function money(p: Pick<BillingPayment, 'amount' | 'currency'>): string {
  return `${p.currency || 'INR'} ${(p.amount / 100).toFixed(2)}`
}

export function planLabel(p: Pick<BillingPayment, 'tier' | 'period'>): string {
  const tier = p.tier === 'plus' ? 'Plus' : 'Pro'
  return `PrintQR ${tier}${p.period ? ` (${p.period === 'yearly' ? 'yearly' : 'monthly'})` : ''}`
}

/** A one-page A5 payment receipt (pdf-lib, loaded only when needed). English only: standard PDF fonts. */
export async function receiptPdf(p: BillingPayment, shopName: string): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  doc.setTitle(`PrintQR receipt ${p.payment_id}`)
  doc.setAuthor(SELLER)
  doc.setCreator('PrintQR')
  const page = doc.addPage([420, 595]) // A5 portrait
  const reg = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0.1, 0.1, 0.1)
  const muted = rgb(0.42, 0.42, 0.42)
  const green = rgb(0.247, 0.384, 0.071) // #3f6212
  // Standard fonts only know WinAnsi: drop anything else (e.g. a Hindi shop name) instead of failing.
  const safe = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()
  const left = 36
  let y = 545

  page.drawText('PrintQR', { x: left, y, size: 22, font: bold, color: green })
  page.drawText('Payment receipt', { x: left, y: y - 22, size: 12, font: reg, color: muted })
  y -= 60
  page.drawLine({ start: { x: left, y }, end: { x: 384, y }, thickness: 1, color: rgb(0.85, 0.85, 0.85) })
  y -= 26

  const shop = safe(shopName)
  const rows: [string, string][] = [
    ['Date', fmtDate(p.paid_at)],
    ['Plan', planLabel(p)],
    ['Period', p.period_start || p.period_end ? `${fmtDate(p.period_start)} to ${fmtDate(p.period_end)}` : '-'],
    ['Amount paid', money(p)],
    ['Payment ID', p.payment_id],
    ...(p.subscription_id ? ([['Subscription ID', p.subscription_id]] as [string, string][]) : []),
    ...(shop ? ([['Billed to', shop]] as [string, string][]) : []),
    ['Seller', SELLER],
    ['Paid through', 'Razorpay']
  ]
  for (const [k, v] of rows) {
    page.drawText(k, { x: left, y, size: 10, font: reg, color: muted })
    page.drawText(safe(v), { x: 150, y, size: 11, font: k === 'Amount paid' ? bold : reg, color: ink, maxWidth: 234 })
    y -= 26
  }

  y -= 10
  page.drawLine({ start: { x: left, y }, end: { x: 384, y }, thickness: 1, color: rgb(0.85, 0.85, 0.85) })
  y -= 22
  for (const line of ['Thank you for using PrintQR.', 'print.receipto.in', 'This receipt is computer generated and needs no signature.']) {
    page.drawText(line, { x: left, y, size: 9, font: reg, color: muted })
    y -= 14
  }
  const bytes = await doc.save()
  return new Blob([bytes], { type: 'application/pdf' })
}

/** Builds the receipt and saves it as PrintQR-receipt-<payment id>.pdf. */
export async function downloadReceipt(p: BillingPayment, shopName: string): Promise<void> {
  const blob = await receiptPdf(p, shopName)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `PrintQR-receipt-${p.payment_id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 8000)
}
