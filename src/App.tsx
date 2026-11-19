import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { isConfigured, supabase } from './lib/supabase'
import { useI18n } from './lib/i18n'
import { TopBar } from './components/TopBar'
import UpdateGate from './components/UpdateGate'
import Home from './pages/Home'
import Login from './pages/Login'
import Upload from './pages/Upload'
import Status from './pages/Status'

const Setup = lazy(() => import('./pages/Setup'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Legal = lazy(() => import('./pages/Legal'))
const QrRedirect = lazy(() => import('./pages/QrRedirect'))
const Admin = lazy(() => import('./pages/Admin'))

export default function App() {
  const { t } = useI18n()
  const nav = useNavigate()
  // PKCE-style recovery links (?code=...) are exchanged by supabase-js, which then fires PASSWORD_RECOVERY.
  useEffect(() => {
    if (!isConfigured) return
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') nav('/reset', { replace: true })
    })
    return () => data.subscription.unsubscribe()
  }, [nav])
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
    <UpdateGate>
    <Suspense fallback={
      <div className="page skeleton-wrap" aria-busy="true">
        <div className="skel skel-line w40 skel-title" />
        <div className="card skel-card"><div className="skel skel-avatar" /><div className="skel skel-line w60" /><div className="skel skel-block" /></div>
        <div className="card skel-card"><div className="skel skel-line w60" /><div className="skel skel-block" /></div>
      </div>
    }>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/s/:slug" element={<Upload />} />
      <Route path="/q/:code" element={<QrRedirect />} />
      <Route path="/o/:id/:key" element={<Status />} />
      <Route path="/legal/:doc" element={<Legal />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </UpdateGate>
  )
}
