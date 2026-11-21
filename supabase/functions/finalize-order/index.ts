// POST { order_id, key }  (no JWT: customers are not signed in; the order's access key is the proof)
// Downloads every uploaded PDF of the order, counts its real pages and hands the counts to
// finalize_order_counted(), which fixes the price, checks the files and queues the order (v11, required).
import { Buffer } from 'node:buffer'
import { PDFDocument } from 'npm:pdf-lib@1.17.1'
import { corsHeaders, db, fail, HttpError, json } from '../_shared/billing.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FileRow = { id: string; storage_path: string; size_bytes: number; mime: string | null; item_kind: string }

/**
 * Fast count without parsing: the biggest /Count found in any object that is a /Type /Pages node
 * (the page-tree root has the biggest). The whole object is searched, from its "obj" to its "endobj",
 * so a root with a long /Kids array (thousands of pages) or nested dictionaries is still found.
 */
const SCAN_WINDOW = 512 * 1024

/** Bytes as a one-char-per-byte string. Buffer is ~50x faster than TextDecoder('latin1') on big files
 *  (45 MB: ~17 ms vs ~860 ms CPU), which matters inside the Edge Function CPU budget. */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}
function scanCount(bytes: Uint8Array, decoded?: string): number {
  const text = decoded ?? latin1(bytes)
  let max = 0
  for (const m of text.matchAll(/\/Type\s*\/Pages\b/g)) {
    const at = m.index ?? 0
    const objAt = text.lastIndexOf('obj', at)
    const start = objAt >= 0 && at - objAt <= SCAN_WINDOW ? objAt : Math.max(0, at - SCAN_WINDOW)
    const endAt = text.indexOf('endobj', at)
    const end = endAt >= 0 && endAt - at <= SCAN_WINDOW ? endAt : Math.min(text.length, at + SCAN_WINDOW)
    for (const c of text.slice(start, end).matchAll(/\/Count\s+(\d+)/g)) max = Math.max(max, parseInt(c[1], 10))
  }
  return max
}

/** Above this many objects pdf-lib can exceed the Edge Function CPU / memory limit (tested: 200k objects
 *  took ~2.3 s CPU and ~370 MB). A kill there cannot be caught, so such files are refused up front. */
const MAX_OBJECTS = 60_000

/** Rough object count without parsing: plain "n g obj" headers plus the objects packed in object streams. */
function objectCount(text: string): number {
  let n = 0
  for (const _ of text.matchAll(/\b\d+\s+\d+\s+obj\b/g)) n++
  for (const m of text.matchAll(/\/Type\s*\/ObjStm\b(?:(?!>>)[\s\S]){0,400}?\/N\s+(\d+)/g)) n += parseInt(m[1], 10)
  return n
}

async function countPages(bytes: Uint8Array): Promise<number> {
  const text = latin1(bytes)
  // 1. No object streams: every /Pages dictionary is plain text, so the biggest /Count can never be lower
  //    than the real page count (a fake small one cannot hide the real root). Trust the scan, skip pdf-lib.
  if (!/\/Type\s*\/ObjStm\b/.test(text)) {
    const n = scanCount(bytes, text)
    if (n > 0) return n
  }
  // 2. Too many objects for the parser's CPU / memory budget: refuse with a clear message.
  if (objectCount(text) > MAX_OBJECTS) {
    throw new HttpError(422, 'pdf_too_complex', 'This PDF is too complex to read. Open it, use Print -> Save as PDF, and send that copy.')
  }
  // 3. Object streams present (the real page tree may be hidden in them): only the real parser is trusted.
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
    const n = doc.getPageCount()
    if (n > 0) return n
  } catch { /* unreadable */ }
  throw new HttpError(422, 'pdf_unreadable', 'This PDF could not be read. Please send another copy of it.')
}

async function download(path: string): Promise<Uint8Array> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/uploads/${path.split('/').map(encodeURIComponent).join('/')}`
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!r.ok) throw new HttpError(409, 'files_incomplete', 'Some files did not upload completely. Please try again.')
  return new Uint8Array(await r.arrayBuffer())
}

/** First bytes of a stored file (Range request, so big files are not downloaded twice). */
async function head(path: string, n = 32): Promise<Uint8Array> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/uploads/${path.split('/').map(encodeURIComponent).join('/')}`
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `bytes=0-${n - 1}` } })
  if (!r.ok) throw new HttpError(409, 'files_incomplete', 'Some files did not upload completely. Please try again.')
  return new Uint8Array(await r.arrayBuffer()).slice(0, n)
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to))

/** HEIF still-image / sequence brands (HEIC, AVIF). Video containers (isom, mp42, qt ...) are not allowed. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'])

/** ftyp box: major brand must be a HEIF brand and the compatible brands must name one too. */
function heifBrand(b: Uint8Array): boolean {
  if (b.length < 16) return false
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  if (size < 16) return false
  const major = ascii(b, 8, 12)
  if (!HEIF_BRANDS.has(major)) return false
  const end = Math.min(size, b.length)
  const compat: string[] = []
  for (let i = 16; i + 4 <= end; i += 4) compat.push(ascii(b, i, i + 4))
  // Files whose ftyp lists no compatible brands (or a box cut off by the read) rely on the major brand.
  return compat.length === 0 || compat.some((c) => HEIF_BRANDS.has(c))
}

/** The file's real kind from its first bytes. Families, not exact types: a PNG named .jpg is still a picture. */
function sniff(b: Uint8Array): 'pdf' | 'image' | 'office' | null {
  if (ascii(b, 0, b.length).includes('%PDF-')) return 'pdf'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image' // JPEG
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image' // PNG
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image'
  if (ascii(b, 4, 8) === 'ftyp') return heifBrand(b) ? 'image' : null // HEIC / HEIF / AVIF only (not MP4 / MOV)
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'office' // docx / xlsx / pptx (zip)
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'office' // doc / xls / ppt
  return null
}

function familyOf(mime: string | null): 'pdf' | 'image' | 'office' | null {
  if (!mime) return null
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  return 'office'
}

/** The bytes must match the declared type, so a disguised file never reaches the shop PC's printer. */
function checkKind(bytes: Uint8Array, mime: string | null) {
  const want = familyOf(mime)
  if (want && sniff(bytes) !== want) {
    throw new HttpError(422, 'bad_file', 'One of the files is not a real PDF, photo or Office file. Please send it again.')
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const b = (await req.json().catch(() => ({}))) as { order_id?: unknown; key?: unknown }
    const id = typeof b.order_id === 'string' ? b.order_id : ''
    const key = typeof b.key === 'string' ? b.key : ''
    if (!UUID.test(id) || !UUID.test(key)) throw new HttpError(404, 'not_found', 'Order not found')

    const orders = await db<{ id: string }[]>(
      `orders?id=eq.${id}&access_key=eq.${key}&status=eq.uploading&select=id`)
    if (!orders[0]) throw new HttpError(404, 'not_found', 'Order not found')

    const files = await db<FileRow[]>(
      `order_files?order_id=eq.${id}&select=id,storage_path,size_bytes,mime,item_kind`)
    const counts: Record<string, number> = {}
    for (const f of files) {
      if (f.item_kind === 'print' && f.mime === 'application/pdf') {
        const bytes = await download(f.storage_path)
        checkKind(bytes.slice(0, 1024), f.mime)
        counts[f.id] = await countPages(bytes)
      } else {
        checkKind(await head(f.storage_path, f.mime === 'application/pdf' ? 1024 : 64), f.mime)
      }
    }

    const rpc = (fn: string, body: unknown) => fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    // Server-counted path only (v11+). No fallback to finalize_order: a missing migration must fail loudly.
    const res = await rpc('finalize_order_counted', { p_order_id: id, p_key: key, p_counts: counts })
    const text = await res.text()
    if (!res.ok && (res.status === 404 || text.includes('PGRST202'))) {
      console.error('finalize_order_counted missing: run supabase/migrations/2026-11-19-v11-server-page-count.sql')
      throw new HttpError(503, 'unavailable', 'Orders are temporarily unavailable. Please try again shortly.')
    }
    if (!res.ok) {
      let message = 'Could not send the order. Please try again.'
      try { message = (JSON.parse(text) as { message?: string }).message || message } catch { /* keep */ }
      throw new HttpError(400, 'finalize_failed', message)
    }
    const row = (JSON.parse(text) as { total: number; changed: number }[])[0]
    return json({ ok: true, counted: true, total: row ? Number(row.total) : null, changed: row?.changed ?? 0 })
  } catch (e) {
    return fail(e)
  }
})
