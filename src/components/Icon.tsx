import { ReactElement } from 'react'

/* Small inline stroke icons (24×24, currentColor). No icon library needed. */
const PATHS: Record<string, ReactElement> = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sidebar: <path d="M4 4h16v16H4zM9 4v16" />,
  sun: <path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
  auto: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18" />,
  inbox: <path d="M4 13h4l1.5 3h5L16 13h4M5.5 5h13L21 13v6H3v-6z" />,
  rupee: <path d="M7 4h10M7 8h10M9 4c5 0 5 8 0 8H7l8 8" />,
  qr: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
  star: <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" />,
  file: <path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  printer: <path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M4 20h16" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" />,
  lock: <path d="M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" />,
  pin: <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
  image: <path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01" />,
  user: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
  idcard: <path d="M3 5h18v14H3zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 16a3 3 0 0 1 6 0M14 9h4M14 13h4" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  copy: <path d="M9 9h11v11H9zM5 15H4V4h11v1" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  note: <path d="M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5" />,
  alert: <path d="M12 3l10 18H2zM12 10v4M12 17.5h.01" />,
  store: <path d="M4 10h16v10H4zM3 10l2-6h14l2 6M9 20v-5h6v5" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5h.01" />,
  wifi: <path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01" />,
  // document editor
  scan: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10" />,
  edit: <path d="M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3" />,
  camera: <path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  crop: <path d="M6 2v14h14M2 6h14v14" />,
  filter: <><circle cx="9" cy="9" r="5" /><circle cx="15" cy="9" r="5" /><circle cx="12" cy="15" r="5" /></>,
  rotate: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  rotl: <path d="M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7" />,
  textedit: <path d="M4 7V4h12v3M10 4v15M7.5 19h5M14 20l.8-3.2L20 11.6l2.4 2.4-5.2 5.2z" />,
  erase: <path d="M15.5 3.5l5 5L10 19H5.5l-2-2zM9 10l5 5M13 21h8" />,
  sign: <path d="M3 17c3-6 5-9 6-7s-2 7 0 7 3-5 5-5 1 4 3 4 2-2 4-2M3 21h18" />,
  watermark: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11zM9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" />,
  brush: <path d="M18 3l3 3-9.5 9.5-3-3zM8.5 12.5L6 15c-2 0-3 1.5-3 3.5V21h2.5c2 0 3.5-1 3.5-3l2.5-2.5" />,
  type: <path d="M5 7V4h14v3M12 4v16M9 20h6" />,
  retake: <path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" />,
  addpage: <path d="M14 3H6v18h12V7zM14 3v4h4M12 11v6M9 14h6" />,
  reorder: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  title: <path d="M3 12V4h8l10 10-8 8zM7.5 7.5h.01" />,
  share: <path d="M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  chevl: <path d="M15 6l-6 6 6 6" />,
  chevr: <path d="M9 6l6 6-6 6" />,
  highlighter: <path d="M9 15l-3 3v3h6l3-3M9 15l7-11 4 3-7 11zM4 21h4" />,
  eraser: <path d="M8 20h12M5.5 15.5L15 6l4 4-9.5 9.5H7z" />,
  rect: <path d="M4 6h16v12H4z" />,
  bold: <path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z" />,
  compare: <path d="M12 3v18M4 5h5v14H4zM15 5h5v14h-5" />,
  full: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  magic: <path d="M15 4V2M15 10V8M11 6h2M17 6h2M3 21l12-12M18 13v2M17 14h2" />
}

export type IconName = keyof typeof PATHS

export default function Icon({ name, size = 20, className = '', stroke = 2 }: { name: IconName | string; size?: number; className?: string; stroke?: number }) {
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
