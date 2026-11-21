import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'
import ZoomPan from './ZoomPan'
import { thumbPath } from '../lib/thumb'

export type ViewImg = { src: string; name: string }

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i
/** Pictures the browser can draw (HEIC etc. stay as plain file names). */
export const isImageName = (name: string) => IMG_EXT.test(name)

/** Full-screen picture preview: pinch / double-tap / wheel to zoom, drag to move; a tap (when not zoomed), the X or Escape closes it. */
export function ImageLightbox({ src, name, onClose }: ViewImg & { onClose: () => void }) {
  const { t } = useI18n()
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev }
  }, [onClose])
  // Portal to <body> so a parent card's transform/overflow can't trap the fixed overlay
  return createPortal(
    <div className="img-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <button type="button" className="img-lightbox-x" aria-label={t('close')} title={t('close')} onClick={onClose}><Icon name="x" size={22} /></button>
      <ZoomPan src={src} alt={name} className="img-lightbox-zoom" onTap={onClose} />
      <span className="img-lightbox-name">{name}</span>
    </div>,
    document.body
  )
}

/** Small tappable picture. While the link is on its way a same-size placeholder holds the space (no layout jump);
 *  `fallback` shows only if the picture can't be drawn. */
function Thumb({ url, name, small, fallback, onOpen, onBroken }: {
  url: string | null; name: string; small?: boolean; fallback: JSX.Element | null
  onOpen: () => void; onBroken?: () => boolean
}) {
  const [broken, setBroken] = useState(false)
  if (broken) return fallback
  const cls = `file-thumb${small ? ' sm' : ''}`
  if (!url) return <span className={`${cls} skel`} aria-hidden="true" />
  return (
    <button type="button" className={cls} aria-label={name} title={name} onClick={onOpen}>
      <img src={url} alt="" loading="lazy" decoding="async" onError={() => { if (!onBroken?.()) setBroken(true) }} />
    </button>
  )
}

/** Thumbnail of a picked (local) image file. */
export function LocalImageThumb({ file, small, fallback = null, onOpen }: { file: File; small?: boolean; fallback?: JSX.Element | null; onOpen: (v: ViewImg) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => { URL.revokeObjectURL(u); setUrl(null) }
  }, [file])
  return <Thumb url={url} name={file.name} small={small} fallback={fallback} onOpen={() => url && onOpen({ src: url, name: file.name })} />
}

/* ---- Owner side: stored pictures in the private 'uploads' bucket ---- */

const LINK_TTL = 3600 // seconds
const links = new Map<string, { url: string; until: number }>()
/** Paths known to have no '.thumb.jpg' (older orders, HEIC, reorders of old orders). */
const noThumb = new Set<string>()

/** One signed link per object, reused until near expiry, so the browser cache serves repeat views
 *  (a fresh link on every re-render would download the same photo again). */
async function signedLink(path: string): Promise<string | null> {
  const hit = links.get(path)
  if (hit && hit.until > Date.now() + 60_000) return hit.url
  const { data } = await supabase.storage.from('uploads').createSignedUrl(path, LINK_TTL)
  if (!data?.signedUrl) return null
  links.set(path, { url: data.signedUrl, until: Date.now() + LINK_TTL * 1000 })
  return data.signedUrl
}

/** Thumbnail of an uploaded photo (owner side): the small '<path>.thumb.jpg' (~10 KB) the customer's phone
 *  made, else (older orders) the full photo. Tapping opens the full photo. */
export function StoredImageThumb({ path, name, fallback = null, onOpen }: { path: string; name: string; fallback?: JSX.Element | null; onOpen: (v: ViewImg) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [small, setSmall] = useState(() => !noThumb.has(path))
  useEffect(() => {
    let live = true
    setUrl(null)
    const want = small ? thumbPath(path) : path
    signedLink(want).then((u) => {
      if (!live) return
      if (u) setUrl(u)
      else if (small) { noThumb.add(path); setSmall(false) } // no thumbnail stored: use the photo
    }, () => {})
    return () => { live = false }
  }, [path, small])
  const broken = () => {
    if (!small) return false
    noThumb.add(path)
    setSmall(false)
    return true
  }
  const open = () => { void signedLink(path).then((u) => { if (u) onOpen({ src: u, name }) }) }
  return <Thumb url={url} name={name} fallback={fallback} onOpen={open} onBroken={broken} />
}
