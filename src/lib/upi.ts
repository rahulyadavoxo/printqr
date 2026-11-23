/**
 * UPI payment link (upi://pay) for the customer's status page (item 16).
 * Every value is percent-encoded; the amount always has 2 decimals; the note (tn) and payee name (pn) keep only
 * letters, digits and spaces, because several UPI apps reject or garble other characters in P2P links.
 */

/** name@bank: what NPCI allows in a VPA (letters, digits, dot, dash, underscore before the @). */
const VPA = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/

export function validUpiId(id: string | null | undefined): boolean {
  return !!id && VPA.test(id.trim())
}

/** Letters, digits and single spaces only, at most `max` characters. */
export function upiText(s: string, max: number): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

export function upiNote(token: number | string): string {
  return upiText(`PrintQR Token ${token}`, 50)
}

export function upiLink(p: { upiId: string; payee: string; amount: number; token: number | string }): string | null {
  if (!validUpiId(p.upiId)) return null
  const amount = Number(p.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const params: [string, string][] = [
    ['pa', p.upiId.trim()],
    ['pn', upiText(p.payee, 40) || 'PrintQR'],
    ['am', amount.toFixed(2)],
    ['cu', 'INR'],
    ['tn', upiNote(p.token)]
  ]
  // '@' is legal in a query and a few older UPI apps fail to read pa=name%40bank, so it stays as is.
  return 'upi://pay?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%40/g, '@')}`).join('&')
}
