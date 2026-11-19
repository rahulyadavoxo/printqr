/*
 * Image processing for the document editor. Everything is written for this app and runs on plain canvases:
 * corner detection, perspective warp (homography), rotation, scan filters, background estimation,
 * simple diffusion inpainting and helpers for colour sampling and fitted text.
 */

export type Pt = { x: number; y: number }
export type Quad = [Pt, Pt, Pt, Pt] // top-left, top-right, bottom-right, bottom-left
export type Rect = { x: number; y: number; w: number; h: number }

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('Canvas not supported')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  return [c, g]
}

/** Copies any drawable into a canvas whose longest side is at most `max`. */
export function toCanvas(src: CanvasImageSource & { width?: number; height?: number }, w: number, h: number, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(w, h))
  const [c, g] = makeCanvas(w * s, h * s)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(src, 0, 0, c.width, c.height)
  return c
}

export function fullQuad(w: number, h: number): Quad {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
}

export function isFullQuad(q: Quad, w: number, h: number): boolean {
  const f = fullQuad(w, h)
  return q.every((p, i) => Math.abs(p.x - f[i].x) < 1.5 && Math.abs(p.y - f[i].y) < 1.5)
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export function polyArea(p: Pt[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export function isConvex(q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])
    if (Math.abs(c) < 1e-6) return false
    const s = Math.sign(c)
    if (sign && s !== sign) return false
    sign = s
  }
  return true
}

/** Puts 4 points in top-left, top-right, bottom-right, bottom-left order (clockwise on screen). */
export function orderQuad(pts: Pt[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // atan2 order on screen (y down) is clockwise; start at the point nearest the top-left
  let start = 0
  let best = Infinity
  sorted.forEach((p, i) => {
    const v = p.x + p.y
    if (v < best) { best = v; start = i }
  })
  const r = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4])
  return [r[0], r[1], r[2], r[3]]
}

/* ------------------------------------------------------------------ corner detection */

function grayOf(d: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
  return g
}

/** Separable box blur on a single-channel image (in place, returns the array). */
function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length)
  const win = r * 2 + 1
  for (let y = 0; y < h; y++) {
    let s = 0
    const row = y * w
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / win
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      a[y * w + x] = s / win
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return a
}

function otsu(g: Float32Array): number {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++
  const total = g.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > best) { best = v; thr = t }
  }
  return thr
}

function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  // square structuring element, separable (max / min)
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x
          const yy = horizontal ? y : y + k
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const s = src[yy * w + xx]
          if (grow ? s : !s) { v = grow ? 1 : 0; break }
        }
        out[y * w + x] = v
      }
    }
    return out
  }
  return pass(pass(m, true), false)
}

/** Largest 4-connected component of mask==1. Returns its pixel labels mask (1 inside) and size. */
function largestComponent(m: Uint8Array, w: number, h: number): { comp: Uint8Array; size: number } {
  const label = new Int32Array(w * h)
  const queue = new Int32Array(w * h)
  let bestLabel = 0
  let bestSize = 0
  let next = 1
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || label[i]) continue
    let head = 0
    let tail = 0
    queue[tail++] = i
    label[i] = next
    while (head < tail) {
      const p = queue[head++]
      const x = p % w
      const y = (p - x) / w
      if (x > 0 && m[p - 1] && !label[p - 1]) { label[p - 1] = next; queue[tail++] = p - 1 }
      if (x < w - 1 && m[p + 1] && !label[p + 1]) { label[p + 1] = next; queue[tail++] = p + 1 }
      if (y > 0 && m[p - w] && !label[p - w]) { label[p - w] = next; queue[tail++] = p - w }
      if (y < h - 1 && m[p + w] && !label[p + w]) { label[p + w] = next; queue[tail++] = p + w }
    }
    if (tail > bestSize) { bestSize = tail; bestLabel = next }
    next++
  }
  const comp = new Uint8Array(w * h)
  if (bestLabel) for (let i = 0; i < comp.length; i++) comp[i] = label[i] === bestLabel ? 1 : 0
  return { comp, size: bestSize }
}

function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** The 4 hull points that span the largest area (hull is reduced to at most ~48 points first). */
function bestQuadOnHull(hp: Pt[]): Pt[] | null {
  if (hp.length < 4) return null
  let pts = hp
  if (pts.length > 48) {
    const step = pts.length / 48
    pts = Array.from({ length: 48 }, (_, i) => hp[Math.floor(i * step)])
  }
  const n = pts.length
  let best = -1
  let res: Pt[] | null = null
  const tri = (a: Pt, b: Pt, c: Pt) => Math.abs(cross(a, b, c)) / 2
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const base = tri(pts[i], pts[j], pts[k])
        for (let l = k + 1; l < n; l++) {
          // points are in hull order, so i-j-k-l is a convex quadrilateral
          const a = base + tri(pts[i], pts[k], pts[l])
          if (a > best) { best = a; res = [pts[i], pts[j], pts[k], pts[l]] }
        }
      }
  return res
}

function quadFromMask(comp: Uint8Array, w: number, h: number, size: number): { quad: Pt[]; score: number } | null {
  const area = w * h
  if (size < area * 0.08) return null
  const boundary: Pt[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!comp[i]) continue
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !comp[i - 1] || !comp[i + 1] || !comp[i - w] || !comp[i + w])
        boundary.push({ x: x + 0.5, y: y + 0.5 })
    }
  const q = bestQuadOnHull(hull(boundary))
  if (!q) return null
  const qa = polyArea(q)
  if (qa < area * 0.1 || qa > area * 0.985) return null
  const fill = size / qa // how rectangular the region is (1 = perfect quadrilateral)
  if (fill < 0.8) return null
  return { quad: q, score: Math.min(fill, 1 / fill) * 0.6 + (qa / area) * 0.4 }
}

/** Finds the page's 4 corners in a picture. Returns null when nothing page-like is found. */
export function detectQuad(src: HTMLCanvasElement): Quad | null {
  const W = src.width
  const H = src.height
  const s = Math.min(1, 300 / Math.max(W, H))
  const w = Math.max(8, Math.round(W * s))
  const h = Math.max(8, Math.round(H * s))
  const [c, g] = makeCanvas(w, h)
  g.drawImage(src, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h).data
  const gray = boxBlur(boxBlur(grayOf(d, w * h), w, h, 1), w, h, 1)
  c.width = c.height = 1
  const candidates: { quad: Pt[]; score: number }[] = []

  // 1) the page is usually brighter than what it lies on
  const t = otsu(gray)
  let bright = new Uint8Array(w * h)
  for (let i = 0; i < bright.length; i++) bright[i] = gray[i] > t ? 1 : 0
  bright = morph(morph(bright, w, h, 2, false), w, h, 2, true) // open: cut thin bridges to the background
  bright = morph(morph(bright, w, h, 3, true), w, h, 3, false) // close: fill text holes
  {
    const { comp, size } = largestComponent(bright, w, h)
    const r = quadFromMask(comp, w, h, size)
    if (r) candidates.push(r)
  }

  // 2) strong edges that enclose a region
  const mag = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
      mag[i] = Math.hypot(gx, gy)
    }
  const sortedMag = Float32Array.from(mag).sort()
  const thr = Math.max(40, sortedMag[Math.floor(sortedMag.length * 0.9)])
  let edges = new Uint8Array(w * h)
  for (let i = 0; i < edges.length; i++) edges[i] = mag[i] > thr ? 1 : 0
  edges = morph(edges, w, h, 1, true)
  // flood the outside from the border through non-edge pixels
  const outside = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  const seed = (i: number) => { if (!edges[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (head < tail) {
    const p = queue[head++]
    const x = p % w
    if (x > 0) seed(p - 1)
    if (x < w - 1) seed(p + 1)
    if (p >= w) seed(p - w)
    if (p < w * (h - 1)) seed(p + w)
  }
  const inside = new Uint8Array(w * h)
  for (let i = 0; i < inside.length; i++) inside[i] = outside[i] ? 0 : 1
  {
    const { comp, size } = largestComponent(inside, w, h)
    const r = quadFromMask(comp, w, h, size)
    if (r) candidates.push({ ...r, score: r.score * 0.97 })
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  // pull each corner ~1.5 px (of the small picture) inwards so no sliver of background is kept
  const best = candidates[0].quad
  const cx = best.reduce((a, p) => a + p.x, 0) / 4
  const cy = best.reduce((a, p) => a + p.y, 0) / 4
  const q = best.map((p) => {
    const d = Math.hypot(cx - p.x, cy - p.y) || 1
    const x = p.x + ((cx - p.x) / d) * 1.5
    const y = p.y + ((cy - p.y) / d) * 1.5
    return { x: Math.min(W, Math.max(0, x / s)), y: Math.min(H, Math.max(0, y / s)) }
  })
  return orderQuad(q)
}

/* ------------------------------------------------------------------ perspective warp */

/** 3x3 homography (h33 = 1) mapping each `from` point to the matching `to` point. */
function homography(from: Pt[], to: Pt[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]
    const { x: u, y: v } = to[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gauss-Jordan with partial pivoting
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    const d = A[col][col] || 1e-12
    for (let k = col; k < 9; k++) A[col][k] /= d
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = A[r][col]
      if (!f) continue
      for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k]
    }
  }
  return [...A.map((r) => r[8]), 1]
}

export function warpSize(q: Quad, maxSide: number): { w: number; h: number } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]))
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]))
  const s = Math.min(1, maxSide / Math.max(w, h))
  w = Math.max(8, Math.round(w * s))
  h = Math.max(8, Math.round(h * s))
  return { w, h }
}

/** Straightens the quadrilateral `q` of `src` into a rectangle (bilinear sampling). */
export function warp(src: HTMLCanvasElement, q: Quad, maxSide: number): HTMLCanvasElement {
  const SW = src.width
  const SH = src.height
  if (isFullQuad(q, SW, SH)) return toCanvas(src, SW, SH, maxSide)
  const { w, h } = warpSize(q, maxSide)
  // Sample from a source copy that is not much larger than needed (speed, memory).
  const k = Math.min(1, (Math.max(w, h) * 1.25) / Math.max(SW, SH))
  const s = k < 1 ? toCanvas(src, SW, SH, Math.max(SW, SH) * k) : src
  const sw = s.width
  const sh = s.height
  const sx = sw / SW
  const sy = sh / SH
  const sd = s.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, sw, sh).data
  const H = homography(fullQuad(w, h), q.map((p) => ({ x: p.x * sx, y: p.y * sy })))
  const [out, og] = makeCanvas(w, h)
  const img = og.createImageData(w, h)
  const o = img.data
  for (let y = 0; y < h; y++) {
    const yy = y + 0.5
    for (let x = 0; x < w; x++) {
      const xx = x + 0.5
      const z = H[6] * xx + H[7] * yy + 1
      let u = (H[0] * xx + H[1] * yy + H[2]) / z - 0.5
      let v = (H[3] * xx + H[4] * yy + H[5]) / z - 0.5
      if (u < 0) u = 0
      if (v < 0) v = 0
      if (u > sw - 1) u = sw - 1
      if (v > sh - 1) v = sh - 1
      const x0 = u | 0
      const y0 = v | 0
      const x1 = Math.min(sw - 1, x0 + 1)
      const y1 = Math.min(sh - 1, y0 + 1)
      const fx = u - x0
      const fy = v - y0
      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const j = (y * w + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx
        o[j + ch] = top + (bot - top) * fy
      }
      o[j + 3] = 255
    }
  }
  og.putImageData(img, 0, 0)
  return out
}

/** Rotates by a multiple of 90° clockwise. */
export function rotate(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const r = ((deg % 360) + 360) % 360
  if (!r) return src
  const swap = r === 90 || r === 270
  const [c, g] = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height)
  g.translate(c.width / 2, c.height / 2)
  g.rotate((r * Math.PI) / 180)
  g.drawImage(src, -src.width / 2, -src.height / 2)
  return c
}

/* ------------------------------------------------------------------ filters */

export type FilterId = 'original' | 'auto' | 'lighten' | 'magic' | 'noshadow' | 'gray' | 'bw' | 'bw2'
export const FILTERS: FilterId[] = ['original', 'auto', 'magic', 'noshadow', 'lighten', 'gray', 'bw', 'bw2']

/**
 * Paper colour estimate at every pixel: shrink the picture, take a local maximum (text is darker than
 * paper, so it disappears), smooth, and scale back up. Used to remove shadows and uneven light.
 */
function background(c: HTMLCanvasElement): Uint8ClampedArray {
  const w = c.width
  const h = c.height
  const s = Math.min(1, 160 / Math.max(w, h))
  const sw = Math.max(4, Math.round(w * s))
  const sh = Math.max(4, Math.round(h * s))
  const [sc, sg] = makeCanvas(sw, sh)
  sg.drawImage(c, 0, 0, sw, sh)
  const img = sg.getImageData(0, 0, sw, sh)
  const d = img.data
  for (let ch = 0; ch < 3; ch++) {
    let a = new Float32Array(sw * sh)
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + ch]
    for (let it = 0; it < 3; it++) {
      const b = new Float32Array(a.length)
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          let m = 0
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.min(sw - 1, Math.max(0, x + dx))
              const yy = Math.min(sh - 1, Math.max(0, y + dy))
              const v = a[yy * sw + xx]
              if (v > m) m = v
            }
          b[y * sw + x] = m
        }
      a = b
    }
    boxBlur(a, sw, sh, 2)
    for (let i = 0; i < a.length; i++) d[i * 4 + ch] = a[i]
  }
  sg.putImageData(img, 0, 0)
  const [bc, bg] = makeCanvas(w, h)
  bg.drawImage(sc, 0, 0, w, h)
  const out = bg.getImageData(0, 0, w, h).data
  sc.width = sc.height = bc.width = bc.height = 1
  return out
}

function percentiles(lum: Float32Array | Uint8ClampedArray, lo: number, hi: number, stride = 1): [number, number] {
  const hist = new Array(256).fill(0)
  let n = 0
  for (let i = 0; i < lum.length; i += stride) { hist[Math.max(0, Math.min(255, lum[i] | 0))]++; n++ }
  let a = 0
  let b = 255
  let acc = 0
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * lo) { a = i; break } }
  acc = 0
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * (1 - hi)) { b = i; break } }
  if (b - a < 20) return [0, 255]
  return [a, b]
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

function saturate(d: Uint8ClampedArray, k: number) {
  for (let j = 0; j < d.length; j += 4) {
    const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
    d[j] = clamp(l + (d[j] - l) * k)
    d[j + 1] = clamp(l + (d[j + 1] - l) * k)
    d[j + 2] = clamp(l + (d[j + 2] - l) * k)
  }
}

function normalise(d: Uint8ClampedArray, bg: Uint8ClampedArray, target = 250) {
  for (let j = 0; j < d.length; j += 4)
    for (let ch = 0; ch < 3; ch++) d[j + ch] = clamp((d[j + ch] / Math.max(24, bg[j + ch])) * target)
}

export type Adjust = { bright: number; contrast: number; detail: number } // -100..100, -100..100, 0..100

/** Returns a new canvas with the scan filter and the brightness / contrast / detail adjustments applied. */
export function applyFilter(src: HTMLCanvasElement, f: FilterId, adj: Adjust): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const [c, g] = makeCanvas(w, h)
  g.drawImage(src, 0, 0)
  if (f === 'original' && !adj.bright && !adj.contrast && !adj.detail) return c
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  const n = w * h
  const lumOf = () => {
    const l = new Float32Array(n)
    for (let i = 0, j = 0; i < n; i++, j += 4) l[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
    return l
  }
  const stretch = (lo: number, hi: number, gamma = 1) => {
    const [a, b] = percentiles(lumOf(), lo, hi, 3)
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++) lut[i] = clamp(255 * Math.pow(Math.max(0, Math.min(1, (i - a) / (b - a))), gamma))
    for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]] }
  }
  switch (f) {
    case 'auto':
      stretch(0.01, 0.99)
      saturate(d, 1.15)
      break
    case 'lighten': {
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) lut[i] = clamp(255 * Math.pow(i / 255, 0.72) + 6)
      for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]] }
      stretch(0.005, 0.995)
      break
    }
    case 'noshadow':
      normalise(d, background(src), 248)
      break
    case 'magic': {
      normalise(d, background(src), 255)
      // gentle S-curve that keeps paper white and deepens ink
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) {
        const x = i / 255
        lut[i] = clamp(255 * (x < 0.5 ? 0.5 * Math.pow(2 * x, 1.6) : 1 - 0.5 * Math.pow(2 - 2 * x, 1.6)))
      }
      for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]] }
      saturate(d, 1.4)
      break
    }
    case 'gray': {
      for (let j = 0; j < d.length; j += 4) {
        const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
        d[j] = d[j + 1] = d[j + 2] = l
      }
      stretch(0.01, 0.99)
      break
    }
    case 'bw':
    case 'bw2': {
      const bg = background(src)
      const L = new Float32Array(n)
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
        const b = 0.299 * bg[j] + 0.587 * bg[j + 1] + 0.114 * bg[j + 2]
        L[i] = Math.min(255, (l / Math.max(24, b)) * 255)
      }
      if (f === 'bw') {
        // adaptive threshold against the local mean (integral image)
        const r = Math.max(6, Math.round(Math.max(w, h) / 40))
        const I = new Float64Array((w + 1) * (h + 1))
        for (let y = 0; y < h; y++) {
          let row = 0
          for (let x = 0; x < w; x++) {
            row += L[y * w + x]
            I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row
          }
        }
        for (let y = 0; y < h; y++) {
          const y0 = Math.max(0, y - r)
          const y1 = Math.min(h, y + r + 1)
          for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - r)
            const x1 = Math.min(w, x + r + 1)
            const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]
            const mean = sum / ((x1 - x0) * (y1 - y0))
            const v = L[y * w + x]
            const ink = v < mean - 12 || v < 105
            const j = (y * w + x) * 4
            d[j] = d[j + 1] = d[j + 2] = ink ? 0 : 255
          }
        }
      } else {
        // softer black & white: keeps anti-aliased edges and pencil lines
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const v = clamp(((L[i] - 120) / (225 - 120)) * 255)
          d[j] = d[j + 1] = d[j + 2] = v
        }
      }
      break
    }
  }
  if (adj.bright || adj.contrast) {
    const c2 = adj.contrast * 1.28
    const cf = (259 * (c2 + 255)) / (255 * (259 - c2))
    const b = adj.bright * 1.1
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++) lut[i] = clamp((i - 128) * cf + 128 + b)
    for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]] }
  }
  if (adj.detail > 0) {
    // unsharp mask with a 3x3 box
    const k = adj.detail / 60
    const copy = new Uint8ClampedArray(d)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const j = (y * w + x) * 4
        for (let ch = 0; ch < 3; ch++) {
          let s = 0
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += copy[j + (dy * w + dx) * 4 + ch]
          d[j + ch] = clamp(copy[j + ch] + (copy[j + ch] - s / 9) * k)
        }
      }
  }
  g.putImageData(img, 0, 0)
  return c
}

/* ------------------------------------------------------------------ inpainting */

/** Fills masked pixels from their surroundings: coarse-to-fine diffusion (smooth, seamless on paper). */
function diffuse(px: Float32Array, mask: Uint8Array, w: number, h: number) {
  const n = w * h
  let known = 0
  for (let i = 0; i < n; i++) if (!mask[i]) known++
  if (!known) { px.fill(255); return }
  if (w > 24 && h > 24) {
    const sw = Math.ceil(w / 2)
    const sh = Math.ceil(h / 2)
    const spx = new Float32Array(sw * sh * 3)
    const smask = new Uint8Array(sw * sh)
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let cnt = 0
        let r = 0, g = 0, b = 0
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx
            const yy = y * 2 + dy
            if (xx >= w || yy >= h) continue
            const i = yy * w + xx
            if (mask[i]) continue
            r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2]; cnt++
          }
        const si = y * sw + x
        if (cnt) { spx[si * 3] = r / cnt; spx[si * 3 + 1] = g / cnt; spx[si * 3 + 2] = b / cnt } else smask[si] = 1
      }
    diffuse(spx, smask, sw, sh)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!mask[i]) continue
        const si = (y >> 1) * sw + (x >> 1)
        px[i * 3] = spx[si * 3]; px[i * 3 + 1] = spx[si * 3 + 1]; px[i * 3 + 2] = spx[si * 3 + 2]
      }
  } else {
    let r = 0, g = 0, b = 0
    for (let i = 0; i < n; i++) if (!mask[i]) { r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2] }
    for (let i = 0; i < n; i++) if (mask[i]) { px[i * 3] = r / known; px[i * 3 + 1] = g / known; px[i * 3 + 2] = b / known }
  }
  const idx: number[] = []
  for (let i = 0; i < n; i++) if (mask[i]) idx.push(i)
  const iters = n < 4000 ? 120 : 30
  for (let it = 0; it < iters; it++)
    for (const i of idx) {
      const x = i % w
      const up = i >= w ? i - w : i
      const dn = i < n - w ? i + w : i
      const lf = x > 0 ? i - 1 : i
      const rt = x < w - 1 ? i + 1 : i
      for (let ch = 0; ch < 3; ch++)
        px[i * 3 + ch] = (px[up * 3 + ch] + px[dn * 3 + ch] + px[lf * 3 + ch] + px[rt * 3 + ch]) / 4
    }
}

/** Erases the masked pixels of the canvas (in place). mask has one byte per pixel (1 = erase). */
export function inpaint(c: HTMLCanvasElement, mask: Uint8Array) {
  const W = c.width
  const H = c.height
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  if (x1 < 0) return
  const pad = 6
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad)
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad)
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const g = c.getContext('2d', { willReadFrequently: true })!
  const img = g.getImageData(x0, y0, w, h)
  const d = img.data
  const px = new Float32Array(w * h * 3)
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      m[i] = mask[(y + y0) * W + x + x0]
      px[i * 3] = d[i * 4]; px[i * 3 + 1] = d[i * 4 + 1]; px[i * 3 + 2] = d[i * 4 + 2]
    }
  diffuse(px, m, w, h)
  for (let i = 0; i < w * h; i++) {
    if (!m[i]) continue
    // a little grain so the patch does not look plastic on photos
    const noise = (Math.random() - 0.5) * 3
    d[i * 4] = clamp(px[i * 3] + noise); d[i * 4 + 1] = clamp(px[i * 3 + 1] + noise); d[i * 4 + 2] = clamp(px[i * 3 + 2] + noise)
  }
  g.putImageData(img, x0, y0)
}

/* ------------------------------------------------------------------ colour + text helpers */

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** Median colour of a thin ring just outside the rectangle (the paper around a word). */
export function sampleBackground(c: HTMLCanvasElement, r: Rect): string {
  const g = c.getContext('2d', { willReadFrequently: true })!
  const x0 = Math.max(0, Math.floor(r.x) - 3)
  const y0 = Math.max(0, Math.floor(r.y) - 3)
  const x1 = Math.min(c.width - 1, Math.ceil(r.x + r.w) + 3)
  const y1 = Math.min(c.height - 1, Math.ceil(r.y + r.h) + 3)
  const d = g.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const R: number[] = [], G: number[] = [], B: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x > 2 && y > 2 && x < w - 3 && y < h - 3) continue
      const j = (y * w + x) * 4
      R.push(d[j]); G.push(d[j + 1]); B.push(d[j + 2])
    }
  const med = (a: number[]) => (a.sort((p, q) => p - q), a[a.length >> 1] ?? 255)
  return hex(med(R), med(G), med(B))
}

/** Average of the darkest pixels inside the rectangle (the ink colour). */
export function sampleInk(c: HTMLCanvasElement, r: Rect): string {
  const g = c.getContext('2d', { willReadFrequently: true })!
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const w = Math.max(1, Math.min(c.width - x, Math.round(r.w)))
  const h = Math.max(1, Math.min(c.height - y, Math.round(r.h)))
  const d = g.getImageData(x, y, w, h).data
  const px: [number, number, number, number][] = []
  for (let j = 0; j < d.length; j += 4) px.push([0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2], d[j], d[j + 1], d[j + 2]])
  px.sort((a, b) => a[0] - b[0])
  const k = Math.max(1, Math.floor(px.length * 0.08))
  let rr = 0, gg = 0, bb = 0
  for (let i = 0; i < k; i++) { rr += px[i][1]; gg += px[i][2]; bb += px[i][3] }
  return hex(rr / k, gg / k, bb / k)
}

export const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Devanagari', sans-serif"

/** Draws text lines fitted inside the rectangle (largest size that fits), left aligned, vertically centred. */
export function drawFittedText(g: CanvasRenderingContext2D, text: string, r: Rect, color: string, bold: boolean) {
  const lines = text.replace(/\r/g, '').split('\n')
  let size = Math.max(4, r.h / (lines.length * 1.18))
  const font = (s: number) => `${bold ? 700 : 400} ${s}px ${FONT}`
  for (let i = 0; i < 40; i++) {
    g.font = font(size)
    const widest = Math.max(...lines.map((l) => g.measureText(l).width))
    if (widest <= r.w * 0.98 || size < 5) break
    size *= Math.max(0.6, (r.w * 0.98) / widest)
  }
  g.font = font(size)
  g.fillStyle = color
  g.textBaseline = 'middle'
  const lh = size * 1.18
  const top = r.y + (r.h - lh * lines.length) / 2 + lh / 2
  lines.forEach((l, i) => g.fillText(l, r.x + r.w * 0.01, top + i * lh))
}
