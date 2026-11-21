import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'

export type ViewImg = { src: string; name: string }

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i
/** Pictures the browser can draw (HEIC etc. stay as plain file names). */
export const isImageName = (name: string) => IMG_EXT.test(name)

/** Full-screen picture preview; tap anywhere, the X or Escape closes it. */
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
      <img src={src} alt={name} />
      <span className="img-lightbox-name">{name}</span>
    </div>,
    document.body
  )
}

/** Small tappable picture; renders `fallback` while loading fails. */
function Thumb({ url, name, small, fallback, onOpen }: { url: string | null; name: string; small?: boolean; fallback: JSX.Element | null; onOpen: (v: ViewImg) => void }) {
  const [broken, setBroken] = useState(false)
  if (!url || broken) return fallback
  return (
    <button type="button" className={`file-thumb${small ? ' sm' : ''}`} aria-label={name} title={name} onClick={() => onOpen({ src: url, name })}>
      <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
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
  return <Thumb url={url} name={file.name} small={small} fallback={fallback} onOpen={onOpen} />
}

/** Thumbnail of an uploaded image in the 'uploads' bucket (owner side), via a short signed link. */
export function StoredImageThumb({ path, name, fallback = null, onOpen }: { path: string; name: string; fallback?: JSX.Element | null; onOpen: (v: ViewImg) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    supabase.storage.from('uploads').createSignedUrl(path, 3600).then(({ data }) => { if (live && data) setUrl(data.signedUrl) })
    return () => { live = false }
  }, [path])
  return <Thumb url={url} name={name} fallback={fallback} onOpen={onOpen} />
}
