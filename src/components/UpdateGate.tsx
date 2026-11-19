// In-app update for the Android app, the same system as Dairy Diary.
// Checked on start, on resume (at most once a minute), every minute while open, and when internet
// returns. When GitHub has a newer app release (tag app-vX.Y.Z with PrintQR-X.Y.Z.apk uploaded),
// the app is covered by an Update screen: the APK downloads inside the app and Android's installer
// opens. An update found while the app is in use shows a banner at once (tap Update), and the full
// Update screen comes on the next resume, so it never jumps over half-done work. The website gets the
// same banner when a new deploy is ready (src/lib/pwa.ts). Offline or GitHub unreachable: keeps working.
import { ReactNode, useEffect, useRef, useState } from 'react'
import { IN_APP, nativeBridge } from '../lib/app'
import { useI18n } from '../lib/i18n'
import { applyWebUpdate, onWebUpdate } from '../lib/pwa'
import Icon from './Icon'

const CHECK_EVERY_MS = 60 * 1000
const POLL_WHILE_OPEN_MS = 60 * 1000
const SKIP_KEY = 'pq_upd_skip'
const SKIP_MS = 12 * 60 * 60 * 1000
const PERMANENT = ['NOT_NEWER', 'WRONG_SIGNER', 'WRONG_APP', 'NOT_APK', 'NO_INSTALLER']
const FAILS_FOR_LATER = 2
const INSTALLS_FOR_LATER = 2

type UpdEvent =
  | { type: 'check'; version?: string; apk?: boolean; error?: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; code: string }
declare global {
  interface Window {
    __pqUpd?: (e: UpdEvent) => void
    __pqResume?: () => void
  }
}

function parseVer(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function newer(a: string, b: string): boolean {
  const x = parseVer(a), y = parseVer(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
function skipped(): string {
  try {
    const s = JSON.parse(localStorage.getItem(SKIP_KEY) || 'null') as { v?: string; at?: number } | null
    return s && s.v && Date.now() - Number(s.at) < SKIP_MS ? s.v : ''
  } catch {
    return ''
  }
}
function skip(v: string) {
  try { localStorage.setItem(SKIP_KEY, JSON.stringify({ v, at: Date.now() })) } catch { /* ignore */ }
}

// One pending native call at a time per kind; native answers through window.__pqUpd.
let checkWaiter: ((e: UpdEvent) => void) | null = null
let dlWaiter: ((e: UpdEvent) => void) | null = null
let onProgress: ((p: number) => void) | null = null
function installListener() {
  window.__pqUpd = (e) => {
    if (e.type === 'check') { const w = checkWaiter; checkWaiter = null; w?.(e) }
    else if (e.type === 'progress') onProgress?.(e.percent)
    else { const w = dlWaiter; dlWaiter = null; w?.(e) }
  }
}
function nativeCheck(): Promise<string | null> {
  const b = nativeBridge()
  if (!b?.checkUpdate) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { checkWaiter = null; resolve(null) }, 20000)
    checkWaiter = (e) => {
      clearTimeout(timer)
      resolve(e.type === 'check' && e.apk && e.version ? e.version : null)
    }
    b.checkUpdate!()
  })
}
function nativeDownload(version: string, progress: (p: number) => void): Promise<void> {
  const b = nativeBridge()
  return new Promise((resolve, reject) => {
    onProgress = progress
    dlWaiter = (e) => {
      onProgress = null
      if (e.type === 'downloaded') resolve()
      else reject(Object.assign(new Error('download'), { code: e.type === 'error' ? e.code : 'DOWNLOAD_FAILED' }))
    }
    b!.downloadUpdate!(version)
  })
}

export default function UpdateGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const bridge = IN_APP ? nativeBridge() : undefined
  const native = !!bridge?.checkUpdate
  const [cur] = useState(() => (bridge?.appVersion ? bridge.appVersion() : ''))
  const [upd, setUpd] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'downloading' | 'installing' | 'perm' | 'error'>('idle')
  const [pct, setPct] = useState(-1)
  const [fails, setFails] = useState(0)
  const [installs, setInstalls] = useState(0)
  const [permBacks, setPermBacks] = useState(0)
  const [rejected, setRejected] = useState(false)
  // update found while the app is open (native: version waiting; web: new deploy installed)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [webReady, setWebReady] = useState(false)
  // "Not now" hides the notice for 30 minutes
  const [snoozed, setSnoozed] = useState(false)
  useEffect(() => {
    if (!snoozed) return
    const id = setTimeout(() => setSnoozed(false), 30 * 60 * 1000)
    return () => clearTimeout(id)
  }, [snoozed])
  useEffect(() => (IN_APP ? undefined : onWebUpdate(setWebReady)), [])
  const lastCheck = useRef(0)
  const queued = useRef<string | null>(null)
  const downloaded = useRef<string | null>(null)
  const notApk = useRef({ v: '', n: 0 })
  const statusRef = useRef(status)
  statusRef.current = status
  const updRef = useRef(upd)
  updRef.current = upd

  const show = (v: string) => {
    if (updRef.current !== v) { setFails(0); setInstalls(0); setPermBacks(0); setStatus('idle') }
    setUpd(v)
  }

  const run = async (force: boolean, defer = false) => {
    if (!force && Date.now() - lastCheck.current < CHECK_EVERY_MS) return
    lastCheck.current = Date.now()
    if (!cur) return
    const latest = await nativeCheck()
    const v = latest && newer(latest, cur) ? latest : defer ? null : queued.current
    if (!v || v === skipped()) return
    if (defer && !updRef.current) { queued.current = v; setWaiting(v); return }
    queued.current = null
    setWaiting(null)
    show(v)
  }

  const giveUpIfPermanent = (code: string | undefined): boolean => {
    const v = updRef.current
    if (!v || !code || !PERMANENT.includes(code)) return false
    if (code === 'NOT_APK') {
      if (notApk.current.v !== v) notApk.current = { v, n: 0 }
      if (++notApk.current.n < 2) return false
    }
    skip(v)
    downloaded.current = null
    setUpd(null)
    setStatus('idle')
    setRejected(true)
    setTimeout(() => setRejected(false), 8000)
    return true
  }

  const install = () => {
    setStatus('installing')
    const r = bridge?.installUpdate ? bridge.installUpdate() : 'error:NO_INSTALLER'
    if (r === 'perm') { setStatus('perm'); return }
    if (r === 'started') { setInstalls((n) => n + 1); return }
    const code = r.startsWith('error:') ? r.slice(6) : 'INSTALL_FAILED'
    if (giveUpIfPermanent(code)) return
    downloaded.current = null
    setFails((n) => n + 1)
    setStatus('error')
  }

  const start = async () => {
    const v = updRef.current
    if (!v || statusRef.current === 'downloading') return
    if (downloaded.current === v) return install()
    setPct(-1)
    setStatus('downloading')
    try {
      await nativeDownload(v, setPct)
      downloaded.current = v
    } catch (e) {
      const code = (e as { code?: string }).code
      if (giveUpIfPermanent(code)) return
      setFails((n) => n + 1)
      setStatus('error')
      return
    }
    install()
  }

  useEffect(() => {
    if (!native) return undefined
    installListener()
    run(true).catch(() => {})
    window.__pqResume = () => {
      if (statusRef.current === 'perm') {
        if (bridge?.canInstall?.() !== false) install()
        else setPermBacks((n) => n + 1)
      } else if (queued.current) run(true).catch(() => {})
      else run(false).catch(() => {})
    }
    const visible = () => document.visibilityState !== 'hidden'
    const tick = setInterval(() => {
      if (visible() && statusRef.current === 'idle') run(true, true).catch(() => {})
    }, POLL_WHILE_OPEN_MS)
    const onOnline = () => { if (visible()) run(true, true).catch(() => {}) }
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(tick)
      window.removeEventListener('online', onOnline)
      window.__pqResume = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native])

  const busy = status === 'downloading'
  const installStuck = status === 'installing' && installs >= INSTALLS_FOR_LATER
  const permStuck = status === 'perm' && permBacks >= 1
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return (
    <>
      <div style={{ display: upd ? 'none' : 'contents' }}>{children}</div>
      {rejected && <div className="update-toast" role="status">{t('updRejected')}</div>}
      {!upd && !snoozed && (waiting || webReady) && (
        <div className="update-note no-print" role="status" aria-live="polite">
          <span className="update-note-icon" aria-hidden="true"><Icon name="info" size={18} /></span>
          <div className="update-note-text">
            <strong>{waiting ? t('updReadyV', { v: waiting }) : t('updReadyWeb')}</strong>
            <span>{waiting ? t('updReadyVSub') : t('updReadyWebSub')}</span>
          </div>
          <div className="update-note-btns">
            <button type="button" className="btn small" onClick={() => setSnoozed(true)}>{t('updNotNow')}</button>
            <button type="button" className="btn primary small" onClick={() => {
              if (waiting) { queued.current = null; setWaiting(null); show(waiting) } else applyWebUpdate()
            }}>{waiting ? t('updNow') : t('updRefresh')}</button>
          </div>
        </div>
      )}
      {upd && (
        <div className="update-gate" role="dialog" aria-modal="true" aria-labelledby="upd-title">
          <div className="update-icon" aria-hidden="true">↑</div>
          <h2 id="upd-title">{t('updTitle')}</h2>
          <p>{t('updBody', { v: upd })}</p>
          {cur && <p className="muted small">{t('updCurrent', { v: cur })}</p>}
          {busy && (
            <div className="upd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(pct, 0)}>
              <div className="upd-bar" style={{ width: Math.max(pct, 0) + '%' }} />
            </div>
          )}
          {busy && <p className="small">{pct < 0 ? t('updConnecting') : `${t('updDownloading')} ${pct}%`}</p>}
          {status === 'installing' && <p className="small">{t(installStuck ? 'updInstallFailedHint' : 'updInstallHint')}</p>}
          {status === 'perm' && <p className="small">{t('updPermHint')}</p>}
          {status === 'error' && <p className="notice error small">{t('updFailed')}</p>}
          <button type="button" className="btn primary lg" onClick={() => void start()} disabled={busy}>
            {busy ? t('updDownloading') : status === 'error' ? t('updRetry') : t('updNow')}
          </button>
          {((status === 'error' && (offline || fails >= FAILS_FOR_LATER)) || installStuck || permStuck) && (
            <button type="button" className="btn lg" onClick={() => { setUpd(null); setStatus('idle') }}>
              {t('updLater')}
            </button>
          )}
        </div>
      )}
    </>
  )
}
