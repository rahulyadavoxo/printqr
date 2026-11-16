import { Navigate, Route, Routes } from 'react-router-dom'
import { isConfigured } from './lib/supabase'
import Home from './pages/Home'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Status from './pages/Status'

export default function App() {
  if (!isConfigured) {
    return (
      <div className="page narrow">
        <div className="card">
          <h2>Setup baaki hai</h2>
          <p>
            Supabase keys nahi mili. GitHub repo ke Settings → Secrets and variables → Actions mein
            <code> VITE_SUPABASE_URL</code> aur <code>VITE_SUPABASE_ANON_KEY</code> add karo, phir workflow dobara chalao.
            README mein poore steps hain.
          </p>
        </div>
      </div>
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
