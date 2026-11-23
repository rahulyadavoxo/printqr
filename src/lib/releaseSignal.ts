// Instant update signal. Right after a new website deploy or app release goes live, CI sends a
// Supabase Realtime broadcast on the public channel 'pq-releases' (event 'web' or 'app').
// Listeners only run their normal update check, which still verifies against the service worker /
// GitHub, so a fake broadcast can't do anything. Connects only in the app and on the shop dashboard
// (not on customer upload pages) to keep Realtime connections low. Polling stays as the fallback.
import { IN_APP } from './app'
import { isConfigured, supabase } from './supabase'
import { ROUTE_EVENT, routePath } from './router'

type Kind = 'web' | 'app'
const subs = new Set<(k: Kind) => void>()
let started = false

function want() {
  return IN_APP || /^\/dashboard/.test(routePath())
}

function connect() {
  if (started || !isConfigured || !want()) return
  started = true
  supabase
    .channel('pq-releases')
    .on('broadcast', { event: '*' }, (m: { event: string }) => {
      const k: Kind = m.event === 'app' ? 'app' : 'web'
      // small random delay so every client doesn't hit GitHub/the CDN in the same second
      setTimeout(() => subs.forEach((f) => f(k)), Math.random() * 4000)
    })
    .subscribe()
}

export function onRelease(fn: (k: Kind) => void): () => void {
  subs.add(fn)
  connect()
  if (!started && typeof window !== 'undefined') {
    window.addEventListener('hashchange', connect)
    window.addEventListener('popstate', connect)
    window.addEventListener(ROUTE_EVENT, connect) // BrowserRouter navigation (useRouteMeta)
  }
  return () => { subs.delete(fn) }
}
