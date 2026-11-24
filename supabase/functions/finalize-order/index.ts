// POST { order_id, key }  (no JWT: customers are not signed in; the order's access key is the proof)
// Downloads every uploaded PDF of the order, counts its real pages and hands the results to
// finalize_order_verified() (v41), which fixes pages and price with the shop's rates, records per file whether the
// pages were verified / corrected / unverified, checks the files and queues the order.
// A PDF that cannot be counted (encrypted, broken, too big or too complex for the function's limits) no longer
// fails the order: it is sent as 'unverified' and the shop sees a warning. Photos are 1 page; Office files are
// always unverified (no converter here).
// ID card sheets (v23) are not repriced (copies x idcard_sheet) but must be a one-page PDF.
// Before the v41 database update the old finalize_order_counted() is used (unreadable PDFs fail as before).
import { Buffer } from 'node:buffer'
import { PDFDocument } from 'npm:pdf-lib@1.17.1'
import { corsHeaders, db, fail, HttpError, json } from '../_shared/billing.ts'
import { logOps } from '../_shared/ops.ts'

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

/** Pages the server counted, or why it could not count them (the order then goes on as 'unverified'). */
type Count = { pages: number } | { why: 'encrypted' | 'too_big' | 'too_complex' | 'unreadable' | 'timeout' }

/** pdf-lib needs several times the file size in memory: above this the Edge Function (Free plan: 256 MB,
 *  2 s CPU) can be killed, which cannot be caught. Such files are marked unverified instead of parsed. */
const MAX_PARSE = 20 * 1024 * 1024

/** Leaf page objects written as plain text ("/Type /Page", not "/Pages"). */
function leafCount(text: string): number {
  let n = 0
  for (const _ of text.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)) n++
  return n
}

async function countPages(bytes: Uint8Array): Promise<Count> {
  const text = latin1(bytes)
  const encrypted = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(text)
  const why = (): Count => ({ why: encrypted ? 'encrypted' : 'unreadable' })
  // 1. No object streams: every page-tree node is plain text. The biggest /Count of a /Pages node is trusted
  //    unless more plain /Type /Page leaves exist than it says (a forged small root /Count): then only the
  //    real parser, which walks the /Kids tree, is trusted.
  if (!/\/Type\s*\/ObjStm\b/.test(text)) {
    const n = scanCount(bytes, text)
    if (n > 0 && leafCount(text) <= n) return { pages: n }
  }
  // 2. Too big or too many objects for the parser's CPU / memory budget: not counted (unverified).
  if (bytes.byteLength > MAX_PARSE) return { why: 'too_big' }
  if (objectCount(text) > MAX_OBJECTS) return { why: 'too_complex' }
  // 3. The real parser (page count = pages found by walking the page tree).
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
    const n = doc.getPageCount()
    if (n > 0) return { pages: n }
  } catch { /* unreadable */ }
  return why()
}

async function download(path: string): Promise<Uint8Array> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/uploads/${path.split('/').map(encodeURIComponent).join('/')}`
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!r.ok) throw new HttpError(409, 'files_incomplete', 'Some files did not upload completely. Please try again.')
  return new Uint8Array(await r.arrayBuffer())
}

const MAX_FILE = 52428800 // 50 MB, same as create_order
const MAX_THUMB = 200 * 1024 // phone-made thumbnails are about 10 KB (v24)
const MAX_ATTEMPTS = 5 // finalize calls per order (v25)
/** Free plan wall-clock limit is 150 s: stop downloading PDFs after this and send the rest as unverified. */
const TIME_BUDGET_MS = 90_000

function storageHeaders(): Record<string, string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

/** Real sizes of everything stored in the order's folder (name -> bytes). */
async function storedSizes(folder: string): Promise<Map<string, number>> {
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/list/uploads`, {
    method: 'POST',
    headers: storageHeaders(),
    body: JSON.stringify({ prefix: folder, limit: 200, offset: 0, sortBy: { column: 'name', order: 'asc' } })
  })
  if (!r.ok) throw new Error(`storage list ${r.status}`)
  const rows = (await r.json()) as { name: string; metadata?: { size?: number } | null }[]
  const m = new Map<string, number>()
  for (const x of rows) m.set(`${folder}/${x.name}`, Number(x.metadata?.size) || 0)
  return m
}

async function removeObjects(paths: string[]) {
  if (!paths.length) return
  await fetch(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/uploads`, {
    method: 'DELETE',
    headers: storageHeaders(),
    body: JSON.stringify({ prefixes: paths })
  }).catch(() => {})
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

    // v25: each order may be finalized only a few times (every call downloads its PDFs).
    const att = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/finalize_begin`, {
      method: 'POST', headers: storageHeaders(), body: JSON.stringify({ p_order_id: id, p_key: key })
    })
    if (att.ok) {
      const n = Number(await att.json())
      if (!n) throw new HttpError(404, 'not_found', 'Order not found')
      if (n > MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'This order could not be sent. Please start a new order.')
    } // before the v25 database update the function is missing: no limit

    const files = await db<FileRow[]>(
      `order_files?order_id=eq.${id}&select=id,storage_path,size_bytes,mime,item_kind`)
    if (!files.length) throw new HttpError(409, 'files_incomplete', 'Some files did not upload completely. Please try again.')

    // v25: the stored bytes must be what the customer declared (the order size limit is checked on those),
    // and the small photo previews must really be small. Oversized previews are removed (the app then
    // shows the full photo).
    const folder = files[0].storage_path.split('/').slice(0, 2).join('/')
    let sizes = new Map<string, number>()
    try {
      sizes = await storedSizes(folder)
    } catch (e) {
      await logOps('finalize-order', `size check skipped: ${e instanceof Error ? e.message : e}`, 'warn')
    }
    // Only trust the listing when it shows the order's files (fail open: never block real orders on a storage hiccup).
    if (files.some((f) => (sizes.get(f.storage_path) || 0) > 0)) {
      for (const f of files) {
        const real = sizes.get(f.storage_path) || 0
        if (real > MAX_FILE || (real > 0 && real !== Number(f.size_bytes))) {
          throw new HttpError(422, 'bad_file', 'One of the files changed while uploading. Please send it again.')
        }
      }
      const known = new Set(files.map((f) => f.storage_path))
      const extra = [...sizes.entries()].filter(([p, n]) =>
        !known.has(p) && (!p.endsWith('.thumb.jpg') || !known.has(p.slice(0, -'.thumb.jpg'.length)) || n > MAX_THUMB))
      await removeObjects(extra.map(([p]) => p))
    }
    // v41: one result per file. Missing files count as 'not_checked' (unverified) in the database.
    const started = Date.now()
    const results: Record<string, Count> = {}
    const pdfFile = (f: FileRow) => f.mime === 'application/pdf'
    for (const f of files) {
      if (!pdfFile(f)) {
        checkKind(await head(f.storage_path, 64), f.mime)
        continue
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        checkKind(await head(f.storage_path, 1024), f.mime)
        results[f.id] = { why: 'timeout' }
        continue
      }
      const bytes = await download(f.storage_path)
      checkKind(bytes.slice(0, 1024), f.mime)
      const c = await countPages(bytes)
      // v23: an ID card sheet is priced as one page per copy, so it must really be one page.
      if (f.item_kind === 'idcard' && 'pages' in c && c.pages !== 1) {
        throw new HttpError(422, 'bad_file', 'The ID card sheet must be one page. Please make it again.')
      }
      results[f.id] = c
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
    const missing = (res: Response, text: string) => !res.ok && (res.status === 404 || text.includes('PGRST202'))
    const failed = (text: string) => {
      let message = 'Could not send the order. Please try again.'
      try { message = (JSON.parse(text) as { message?: string }).message || message } catch { /* keep */ }
      return new HttpError(400, 'finalize_failed', message)
    }
    // v41: server-checked pages, per-file status. Never a client-side fallback: the shop's total comes from here.
    let res = await rpc('finalize_order_verified', { p_order_id: id, p_key: key, p_result: results })
    let text = await res.text()
    if (!missing(res, text)) {
      if (!res.ok) throw failed(text)
      const row = (JSON.parse(text) as { total: number; changed: number; unverified: number }[])[0]
      return json({ ok: true, counted: true, total: row ? Number(row.total) : null, changed: row?.changed ?? 0, unverified: row?.unverified ?? 0 })
    }

    // Database not on v41 yet: the v11 path, where every print / ID card PDF must be counted.
    console.error('finalize_order_verified missing: run supabase/migrations/2026-11-24-v41-verified-pages.sql')
    const counts: Record<string, number> = {}
    for (const f of files) {
      const c = results[f.id]
      if (!c || f.item_kind === 'passport') continue
      if (!('pages' in c)) {
        if (c.why === 'too_complex' || c.why === 'too_big') {
          throw new HttpError(422, 'pdf_too_complex', 'This PDF is too complex to read. Open it, use Print -> Save as PDF, and send that copy.')
        }
        throw new HttpError(422, 'pdf_unreadable', 'This PDF could not be read. Please send another copy of it.')
      }
      if (f.item_kind === 'print') counts[f.id] = c.pages
    }
    res = await rpc('finalize_order_counted', { p_order_id: id, p_key: key, p_counts: counts })
    text = await res.text()
    if (missing(res, text)) {
      console.error('finalize_order_counted missing: run supabase/migrations/2026-11-19-v11-server-page-count.sql')
      throw new HttpError(503, 'unavailable', 'Orders are temporarily unavailable. Please try again shortly.')
    }
    if (!res.ok) throw failed(text)
    const row = (JSON.parse(text) as { total: number; changed: number }[])[0]
    return json({ ok: true, counted: true, total: row ? Number(row.total) : null, changed: row?.changed ?? 0 })
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) await logOps('finalize-order', e)
    return fail(e)
  }
})
