import { Navigate, Route, Routes } from 'react-router-dom'
import { isConfigured } from './lib/supabase'
import { useI18n } from './lib/i18n'
import { TopBar } from './components/TopBar'
import Home from './pages/Home'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Status from './pages/Status'

export default function App() {
  const { t } = useI18n()
  if (!isConfigured) {
    return (
      <>
        <TopBar to={null} />
        <div className="page narrow">
          <div className="card">
            <h2>{t('ncTitle')}</h2>
            <p>
              {t('ncBody1')} <code>VITE_SUPABASE_URL</code> {t('ncAnd')} <code>VITE_SUPABASE_ANON_KEY</code>
              {t('ncBody2')}
            </p>
          </div>
        </div>
      </>
    )
  }
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/s/:slug" element={<Upload />} />
      <Route path="/o/:id/:key" element={<Status />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
