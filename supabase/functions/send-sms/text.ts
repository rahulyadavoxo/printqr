// OTP SMS text. English only (GSM-7) so it stays one short SMS and fits the Android SMS Retriever rules
// (developers.google.com/identity/sms-retriever/verify): at most 140 bytes, contains the code, and carries the
// app's 11-character hash. The hash goes last, on its own line (the long-standing Retriever format).
// Google's current docs no longer ask for the old "<#>" prefix, so it is not used.
//
// SMS_APP_HASH (Supabase secret, not secret in itself): the hash, or several comma separated
// (GitHub-signed APK, later the Play App Signing build). Compute it with scripts/sms-app-hash.sh.
// Empty: plain SMS without a hash (the app then cannot read it by itself; typing still works).

export const SMS_MAX_BYTES = 140
const HASH = /^[A-Za-z0-9+/]{11}$/
const enc = new TextEncoder()

export function appHashes(raw: string | undefined): string[] {
  const out: string[] = []
  for (const h of String(raw || '').split(/[,\s]+/)) {
    if (HASH.test(h) && !out.includes(h)) out.push(h)
  }
  return out
}

export function byteLength(s: string): number {
  return enc.encode(s).length
}

/** "PrintQR code: 123456. Do not share." + one line per app hash that still fits in 140 bytes. */
export function smsText(otp: string, hashes: string[] = []): string {
  let text = `PrintQR code: ${otp}. Do not share.`
  for (const h of hashes) {
    const next = `${text}\n${h}`
    if (byteLength(next) > SMS_MAX_BYTES) break
    text = next
  }
  return text
}
