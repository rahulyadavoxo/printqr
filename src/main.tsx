import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { captureAuthHash } from './lib/recovery'
import './styles.css'
import { applyTheme, readTheme } from './lib/theme'
import { startPwa } from './lib/pwa'

// Must run before HashRouter reads the hash (Supabase puts auth tokens there).
captureAuthHash()
// Theme (index.html already set it; this also tints the Android app's system bars).
applyTheme(readTheme())
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(readTheme()))

startPwa()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </I18nProvider>
  </React.StrictMode>
)
