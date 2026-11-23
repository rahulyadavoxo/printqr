import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { captureAuthHash } from './lib/recovery'
import { BASENAME, PATH_ROUTER, normalizeRouteUrl } from './lib/router'
import './styles.css'
import { applyTheme, readTheme } from './lib/theme'
import { startPwa } from './lib/pwa'
import { IN_APP } from './lib/app'
import { startErrorReports } from './lib/errorReport'

// Must run before the router reads the URL (Supabase puts auth tokens in the hash).
captureAuthHash()
// Old #/x?y links -> /x?y on print.receipto.in (and /x -> #/x on hash hosts). See lib/router.ts.
normalizeRouteUrl()
// Theme (index.html already set it; this also tints the Android app's system bars).
applyTheme(readTheme())
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(readTheme()))

startPwa()
// v38: crashes on the website / apps show up in the Admin bell
startErrorReports()
// In the app, text isn't selectable/copyable by long-press (inputs still are) - see .in-app in styles.css
if (IN_APP) {
  document.documentElement.classList.add('in-app')
  // The app screen must never zoom (pinch, double-tap or focusing a field) - lock the viewport scale too
  document.querySelector('meta[name="viewport"]')?.setAttribute('content',
    'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {PATH_ROUTER ? (
        <BrowserRouter basename={BASENAME || undefined}>
          <App />
        </BrowserRouter>
      ) : (
        <HashRouter>
          <App />
        </HashRouter>
      )}
    </I18nProvider>
  </React.StrictMode>
)
