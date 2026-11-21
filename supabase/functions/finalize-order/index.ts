// POST { order_id, key }  (no JWT: customers are not signed in; the order's access key is the proof)
// Downloads every uploaded PDF of the order, counts its real pages and hands the counts to
// finalize_order_counted(), which fixes the price, checks the files and queues the order (v11).
import { PDFDocument } from 'npm:pdf-lib@1.17.1'
import { corsHeaders, db, fail, HttpError, json } from '../_shared/billing.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FileRow = { id: string; storage_path: string; size_bytes: number; mime: string | null; item_kind: string }

/** Fast count without parsing: the biggest /Count of a /Type /Pages node (the page-tree root). */
function scanCount(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes)
  let max = 0
  const re = /<<(?:(?!>>)[\s\S]){0,800}?\/Type\s*\/Pages\b(?:(?!>>)[\s\S]){0,800}?>>/g
  for (const m of text.matchAll(re)) {
    const c = /\/Count\s+(\d+)/.exec(m[0])
    if (c) max = Math.max(max, parseInt(c[1], 10))
  }
  return max
}

async function countPages(bytes: Uint8Array): Promise<number> {
  // Big files: try the cheap scan first (Edge Functions have a small CPU budget).
  if (bytes.length > 20 * 1024 * 1024) {
    const n = scanCount(bytes)
    if (n > 0) return n
  }
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
    const n = doc.getPageCount()
    if (n > 0) return n
  } catch { /* fall through */ }
  const n = scanCount(bytes)
  if (n > 0) return n
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

/** The file's real kind from its first bytes. Families, not exact types: a PNG named .jpg is still a picture. */
function sniff(b: Uint8Array): 'pdf' | 'image' | 'office' | null {
  if (ascii(b, 0, b.length).includes('%PDF-')) return 'pdf'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image' // JPEG
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image' // PNG
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image'
  if (ascii(b, 4, 8) === 'ftyp') return 'image' // HEIC / HEIF
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
        checkKind(await head(f.storage_path, f.mime === 'application/pdf' ? 1024 : 32), f.mime)
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
    let res = await rpc('finalize_order_counted', { p_order_id: id, p_key: key, p_counts: counts })
    let text = await res.text()
    let counted = true
    // v11 SQL not run yet: finish the old way so orders keep working (no price fix until it is run).
    if (!res.ok && (res.status === 404 || text.includes('PGRST202'))) {
      console.warn('finalize_order_counted missing: run supabase/migrations/2026-11-19-v11-server-page-count.sql')
      res = await rpc('finalize_order', { p_order_id: id, p_key: key })
      text = await res.text()
      counted = false
    }
    if (!res.ok) {
      let message = 'Could not send the order. Please try again.'
      try { message = (JSON.parse(text) as { message?: string }).message || message } catch { /* keep */ }
      throw new HttpError(400, 'finalize_failed', message)
    }
    const row = counted ? (JSON.parse(text) as { total: number; changed: number }[])[0] : null
    return json({ ok: true, counted, total: row ? Number(row.total) : null, changed: row?.changed ?? 0 })
  } catch (e) {
    return fail(e)
  }
})
