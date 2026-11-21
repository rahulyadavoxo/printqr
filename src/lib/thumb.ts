/** Small JPEG of a photo (longest side 240 px, ~10 KB) for the owner's order list. null if the browser
 *  can't draw it (e.g. HEIC on most phones). */
export async function makeThumb(file: Blob, max = 240): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * k))
    const h = Math.max(1, Math.round(bmp.height * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    if (!g) return null
    g.fillStyle = '#fff' // transparent PNGs: white, not black
    g.fillRect(0, 0, w, h)
    g.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    return await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.7))
  } catch {
    return null
  }
}

export const thumbPath = (path: string) => path + '.thumb.jpg'
