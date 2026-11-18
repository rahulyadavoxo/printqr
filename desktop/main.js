// PrintQR for Windows: opens https://print.receipto.in in its own window.
// The app always shows the live site, so website updates reach it without reinstalling.
const { app, BrowserWindow, shell } = require('electron')

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
    webPreferences: { contextIsolation: true, sandbox: true, plugins: true, spellcheck: false }
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

  win.loadURL(START)
}

// One window only: opening the app again focuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => app.quit())
}
