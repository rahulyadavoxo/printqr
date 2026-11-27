/*
 * Customer upload checks done in the browser, before the order is priced and sent (QA 27 Nov #48 / #50 / #51).
 * The server (finalize-order) checks the same first bytes again; this only tells the customer earlier, by file name.
 */

export type Family = 'pdf' | 'image' | 'office'

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'])

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i])
  return s
}

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return sig.every((x, i) => b[i] === x)
}

/** Same rule as finalize-order: a HEIF major brand, and a HEIF brand among the compatible ones when any are listed. */
function heifBrand(b: Uint8Array): boolean {
  if (b.length < 16) return false
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  if (size < 16) return false
  if (!HEIF_BRANDS.has(ascii(b, 8, 12))) return false
  const end = Math.min(size, b.length)
  const compat: string[] = []
  for (let i = 16; i + 4 <= end; i += 4) compat.push(ascii(b, i, i + 4))
  return compat.length === 0 || compat.some((c) => HEIF_BRANDS.has(c))
}

/** The file's real kind from its first bytes (families, like the server: a PNG named .jpg is still a picture). */
export function sniff(b: Uint8Array): Family | null {
  if (ascii(b, 0, b.length).includes('%PDF-')) return 'pdf'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image'
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image'
  if (ascii(b, 4, 8) === 'ftyp') return heifBrand(b) ? 'image' : null
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'office'
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'office'
  return null
}

export function familyOfMime(mime: string | null): Family | null {
  if (!mime) return null
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  return 'office'
}

/** True when the file's first bytes match the type its name says (PDF / photo / Office). */
export async function isRealFile(file: File, mime: string | null): Promise<boolean> {
  const want = familyOfMime(mime)
  if (!want) return false
  try {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer())
    return sniff(head) === want
  } catch {
    return true // could not read it here: the server still checks
  }
}

/** pdf.js refuses a PDF that needs a password to open. */
export function isPasswordError(e: unknown): boolean {
  const o = (e || {}) as { name?: unknown; message?: unknown }
  return o.name === 'PasswordException' || /password/i.test(String(o.message || ''))
}

/**
 * A PDF with an /Encrypt entry (its trailer, or an xref stream near the end). Used when pdf.js could not open the
 * file for another reason, so a locked PDF is still called locked.
 */
export async function pdfHasEncrypt(file: File): Promise<boolean> {
  try {
    const n = file.size
    const tail = new Uint8Array(await file.slice(Math.max(0, n - 256 * 1024)).arrayBuffer())
    if (ascii(tail, 0, tail.length).includes('/Encrypt')) return true
    if (n > 256 * 1024) {
      const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
      return ascii(head, 0, head.length).includes('/Encrypt')
    }
    return false
  } catch {
    return false
  }
}

/* ---------- Office page count (docx: <Pages>, pptx: <Slides> in docProps/app.xml) ---------- */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream
  if (!DS) return null
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DS('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

type ZipEntry = { name: string; method: number; compSize: number; localOff: number }

/** The file list of a zip (Office files are zips), from its central directory. null when it can't be read. */
async function zipEntries(file: File): Promise<ZipEntry[] | null> {
  const n = file.size
  const tailLen = Math.min(n, 65557)
  const tail = new Uint8Array(await file.slice(n - tailLen).arrayBuffer())
  const dv = new DataView(tail.buffer)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOff = dv.getUint32(eocd + 16, true)
  if (cdOff + cdSize > n || cdSize > 8 * 1024 * 1024) return null
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer())
  const cv = new DataView(cd.buffer)
  const dec = new TextDecoder()
  const out: ZipEntry[] = []
  for (let p = 0; p + 46 <= cd.length;) {
    if (cv.getUint32(p, true) !== 0x02014b50) break
    const nameLen = cv.getUint16(p + 28, true)
    out.push({
      name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: cv.getUint16(p + 10, true),
      compSize: cv.getUint32(p + 20, true),
      localOff: cv.getUint32(p + 42, true)
    })
    p += 46 + nameLen + cv.getUint16(p + 30, true) + cv.getUint16(p + 32, true)
  }
  return out
}

/** The bytes of one zip entry (stored or deflated). null when it can't be read here. */
async function zipRead(file: File, e: ZipEntry): Promise<Uint8Array | null> {
  if (e.compSize > 4 * 1024 * 1024) return null
  const lh = new DataView(await file.slice(e.localOff, e.localOff + 30).arrayBuffer())
  if (lh.getUint32(0, true) !== 0x04034b50) return null
  const start = e.localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true)
  const raw = new Uint8Array(await file.slice(start, start + e.compSize).arrayBuffer())
  if (e.method === 0) return raw
  if (e.method === 8) return inflateRaw(raw)
  return null
}

/**
 * Pages of a .docx (Word saves the count) or slides of a .pptx, read from docProps/app.xml. null when the file
 * does not say (.xlsx, .doc / .xls / .ppt, files made by other apps, or an old browser): the customer types it.
 */
export async function officePageCount(file: File): Promise<number | null> {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || '').toLowerCase()
  if (ext !== 'docx' && ext !== 'pptx') return null
  try {
    const entries = await zipEntries(file)
    if (!entries) return null
    const app = entries.find((e) => e.name === 'docProps/app.xml')
    const xml = app ? await zipRead(file, app) : null
    if (xml) {
      const m = new RegExp(`<(?:\\w+:)?${ext === 'docx' ? 'Pages' : 'Slides'}>(\\d+)<`).exec(new TextDecoder().decode(xml))
      const n = m ? Number(m[1]) : 0
      if (n >= 1 && n <= 2000) return n
    }
    // PowerPoint: one ppt/slides/slideN.xml per slide, even when the file does not state a count.
    if (ext === 'pptx') {
      const n = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length
      if (n >= 1 && n <= 2000) return n
    }
    return null
  } catch {
    return null
  }
}
