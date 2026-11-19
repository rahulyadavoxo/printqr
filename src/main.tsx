import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { captureAuthHash } from './lib/recovery'
import './styles.css'
import { applyTheme, readTheme } from './lib/theme'
import { startPwa } from './lib/pwa'
import { IN_APP } from './lib/app'

// Must run before HashRouter reads the hash (Supabase puts auth tokens there).
captureAuthHash()
// Theme (index.html already set it; this also tints the Android app's system bars).
applyTheme(readTheme())
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(readTheme()))

startPwa()
// In the app, text isn't selectable/copyable by long-press (inputs still are) - see .in-app in styles.css
if (IN_APP) document.documentElement.classList.add('in-app')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </I18nProvider>
  </React.StrictMode>
)
