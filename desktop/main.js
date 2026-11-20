// PrintQR for Windows: opens https://print.receipto.in in its own window.
// The app always shows the live site, so website updates reach it without reinstalling.
const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const START = 'https://print.receipto.in/'
// Pages allowed inside the app (login, payments, opening uploaded files to print).
// Supabase: only this project's own host, not every *.supabase.co site.
const INSIDE = [/^(print\.|www\.)?receipto\.in$/, /^asqgdgzxkdksoikmffmd\.supabase\.co$/, /(^|\.)razorpay\.com$/]
// Links that may leave the app for the browser / mail / phone / UPI apps. Nothing else (no file:, ms-*, etc.).
const EXTERNAL = new Set(['https:', 'http:', 'mailto:', 'tel:', 'upi:'])

function openOutside(url) {
  try {
    if (EXTERNAL.has(new URL(url).protocol)) shell.openExternal(url)
  } catch {
    /* not a valid URL: ignore */
  }
}

function allowedInside(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && INSIDE.some((re) => re.test(u.hostname))
  } catch {
    return url.startsWith('blob:') || url.startsWith('data:')
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 360,
    minHeight: 560,
    title: 'PrintQR',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: !process.argv.includes('--hidden'),
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, plugins: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedInside(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 1000, height: 800 } }
    }
    openOutside(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (e, url) => {
    if (!allowedInside(url)) {
      e.preventDefault()
      openOutside(url)
    }
  })

  // Pop-ups (Razorpay bank pages) get the same rules.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (!allowedInside(url)) {
        ev.preventDefault()
        openOutside(url)
      }
    })
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
  })

  // Closing the window keeps PrintQR running in the tray, so new-order alerts still come.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.loadURL(START)
  return win
}

// ---------------------------------------------------------------------------
// Direct printing: the dashboard sends a short-lived signed link to an order file; the app downloads
// it to a temp file, prints it with SumatraPDF (bundled by pdf-to-printer) and deletes it again.
const FILE_HOST = 'asqgdgzxkdksoikmffmd.supabase.co'
const PRINTABLE = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp'])
const MAX_BYTES = 210 * 1024 * 1024

function trustedSender(e) {
  try {
    const u = new URL(e.senderFrame ? e.senderFrame.url : '')
    return u.protocol === 'https:' && u.hostname === 'print.receipto.in'
  } catch {
    return false
  }
}

function sumatraPath() {
  try {
    const dir = path.dirname(require.resolve('pdf-to-printer')).replace('app.asar', 'app.asar.unpacked')
    for (const d of [dir, path.join(dir, '..'), path.join(dir, 'dist')]) {
      if (!fs.existsSync(d)) continue
      const exe = fs.readdirSync(d).find((f) => /^SumatraPDF.*\.exe$/i.test(f))
      if (exe) return path.join(d, exe)
    }
  } catch {
    /* fall back to the library default */
  }
  return undefined
}

function setupPrinting() {
  ipcMain.handle('pq:printers', async (e) => {
    if (!trustedSender(e)) return []
    try {
      const list = await e.sender.getPrintersAsync()
      return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }))
    } catch {
      return []
    }
  })

  ipcMain.handle('pq:print', async (e, job) => {
    if (!trustedSender(e)) return { ok: false, error: 'untrusted' }
    if (process.platform !== 'win32') return { ok: false, error: 'not_windows' }
    let tmp = null
    try {
      const u = new URL(String(job && job.url))
      if (u.protocol !== 'https:' || u.hostname !== FILE_HOST || !u.pathname.startsWith('/storage/v1/object/sign/uploads/')) {
        return { ok: false, error: 'bad_url' }
      }
      const ext = String((job && job.name) || '').toLowerCase().split('.').pop()
      if (!PRINTABLE.has(ext)) return { ok: false, error: 'unsupported' }

      const res = await fetch(u.toString())
      if (!res.ok) return { ok: false, error: 'download_failed' }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_BYTES) return { ok: false, error: 'download_failed' }
      tmp = path.join(os.tmpdir(), 'printqr-' + crypto.randomBytes(8).toString('hex') + '.' + ext)
      fs.writeFileSync(tmp, buf)

      const opts = {
        copies: Math.min(99, Math.max(1, parseInt(job.copies, 10) || 1)),
        monochrome: !job.color,
        side: job.duplex ? 'duplex' : 'simplex',
        // Passport sheets keep their exact size; other files shrink to fit the page.
        scale: job.kind === 'passport' ? 'noscale' : ext === 'pdf' ? 'shrink' : 'fit'
      }
      if (typeof job.printer === 'string' && job.printer.trim()) opts.printer = job.printer.trim()
      if (ext === 'pdf' && typeof job.pages === 'string' && /^[0-9][0-9,\- ]*$/.test(job.pages.trim())) {
        opts.pages = job.pages.replace(/\s+/g, '')
      }
      const exe = sumatraPath()
      if (exe) opts.sumatraPdfPath = exe

      const { print } = require('pdf-to-printer')
      await print(tmp, opts)
      return { ok: true }
    } catch (err) {
      console.error('print failed', err)
      return { ok: false, error: 'print_failed' }
    } finally {
      // Sumatra has finished spooling when print() resolves; remove the copy a little later.
      if (tmp) setTimeout(() => fs.unlink(tmp, () => {}), 15000)
    }
  })
}

// One window only: opening the app again focuses it.
// ---------------------------------------------------------------------------
// Tray + start with Windows: the dashboard keeps listening for orders in the background.
let quitting = false
let tray = null

function showWindow() {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return createWindow()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function setupTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('PrintQR – new orders will notify you')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open PrintQR', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } }
    ])
  )
  tray.on('click', showWindow)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => { quitting = true })
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('in.receipto.print')
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    }
    setupPrinting()
    createWindow()
    setupTray()
  })
  app.on('window-all-closed', () => { if (quitting) app.quit() })
}
