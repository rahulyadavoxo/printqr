import { IN_APP } from './app'

/*
 * Real paths (print.receipto.in/s/shop) on the public site, #/ routes everywhere else.
 *
 * BrowserRouter: https://print.receipto.in (website, PWA, Windows app) and localhost (dev / preview).
 * HashRouter:   the Android app (its asset server only serves real files) and any other host.
 *
 * Old links keep working: normalizeRouteUrl() turns print.receipto.in/#/s/shop?c=1 into /s/shop?c=1
 * before the router renders (and the other way round on hash hosts).
 */
const host = typeof window === 'undefined' ? '' : window.location.hostname
export const PATH_ROUTER =
  !IN_APP &&
  typeof window !== 'undefined' &&
  ((window.location.protocol === 'https:' && host === 'print.receipto.in') || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host))

/** Router basename: BASE_URL without the trailing slash ("" on the custom domain). */
export const BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')

/** Public origin used for canonical / og:url. */
export const SITE_ORIGIN = 'https://print.receipto.in'

/** href for an in-app <a> that is not a router <Link> (e.g. target=_blank). */
export function routeHref(path: string): string {
  return PATH_ROUTER ? BASENAME + path : '#' + path
}

/** Replace the current URL with an app route ("/reset", "/login"), keeping the query string. */
export function replaceRoute(route: string): void {
  if (PATH_ROUTER) {
    window.history.replaceState(null, '', BASENAME + route + window.location.search)
  } else {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + route)
  }
}

/** Query string of the current route (?tab=... &s=...), whichever router is used. */
export function routeQuery(): URLSearchParams {
  if (PATH_ROUTER) return new URLSearchParams(window.location.search)
  return new URLSearchParams(window.location.hash.split('?')[1] || '')
}

/** Current route path ("/dashboard"), whichever router is used. */
export function routePath(): string {
  if (PATH_ROUTER) {
    const p = window.location.pathname
    return (BASENAME && p.startsWith(BASENAME) ? p.slice(BASENAME.length) : p) || '/'
  }
  return window.location.hash.startsWith('#/') ? window.location.hash.slice(1).split('?')[0] : '/'
}

/** Merge two query strings; keys in `b` win. Returns "" or "?a=1&b=2". */
function mergeQuery(a: string, b: string): string {
  const q = new URLSearchParams(a)
  new URLSearchParams(b).forEach((v, k) => q.set(k, v))
  const s = q.toString()
  return s ? '?' + s : ''
}

/**
 * Run once in main.tsx, right after captureAuthHash() and before the router renders.
 *  - path hosts: /#/s/shop?c=1  -> /s/shop?c=1   (old QR codes, emails, notifications, bookmarks)
 *  - hash hosts: /s/shop?c=1    -> /#/s/shop?c=1 (a path link opened on a preview / other host)
 * A query already in the URL (e.g. Supabase's ?code=) is kept.
 */
export function normalizeRouteUrl(): void {
  if (typeof window === 'undefined') return
  const { hash, search, pathname } = window.location
  if (PATH_ROUTER) {
    if (!hash.startsWith('#/')) return
    const route = hash.slice(1)
    const i = route.indexOf('?')
    const path = i < 0 ? route : route.slice(0, i)
    const q = i < 0 ? '' : route.slice(i + 1)
    window.history.replaceState(null, '', BASENAME + path + mergeQuery(search, q))
    return
  }
  if (IN_APP || hash.startsWith('#/')) return
  const rest = BASENAME && pathname.startsWith(BASENAME) ? pathname.slice(BASENAME.length) : pathname
  if (!rest || rest === '/' || rest === '/index.html' || rest === '/404.html') return
  if (/\.[a-z0-9]+$/i.test(rest)) return // a real file, not a route
  window.history.replaceState(null, '', BASENAME + '/#' + rest + search)
}

/** Fired on every route change (pushState fires no event of its own). */
export const ROUTE_EVENT = 'pq-route'
