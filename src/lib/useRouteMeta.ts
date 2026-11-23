import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { ROUTE_EVENT, SITE_ORIGIN } from './router'

/*
 * Per-route <title>, canonical URL, og:url and robots for the public site (index.html has the defaults).
 * Titles stay English on purpose: they are what search engines and link previews show.
 * Upload.tsx may still set a Plus shop's own name as the title after its data loads.
 */
const BRAND = 'Print by Receipto'
export const DEFAULT_TITLE = 'Print by Receipto – Scan, upload, print'

const TITLES: Record<string, string> = {
  '/login': 'Log in or sign up – ' + BRAND,
  '/legal/privacy': 'Privacy Policy – ' + BRAND,
  '/legal/terms': 'Terms of Service – ' + BRAND,
  '/legal/refund': 'Refund and Cancellation Policy – ' + BRAND,
  '/legal/contact': 'Contact – ' + BRAND
}

// Private or per-person pages: never indexed.
const NOINDEX = /^\/(o|q|reset|setup|dashboard|admin)(\/|$)/

function setMeta(sel: string, attr: 'content' | 'href', value: string) {
  const el = document.head.querySelector(sel)
  if (el) el.setAttribute(attr, value)
}

export function useRouteMeta(): void {
  const { pathname } = useLocation()
  useEffect(() => {
    const path = pathname.replace(/\/+$/, '') || '/'
    const known = path in TITLES
    document.title = known ? TITLES[path] : DEFAULT_TITLE
    const url = SITE_ORIGIN + (path === '/' ? '/' : path)
    setMeta('link[rel="canonical"]', 'href', url)
    setMeta('meta[property="og:url"]', 'content', url)
    setMeta('meta[property="og:title"]', 'content', document.title)
    let robots = document.head.querySelector('meta[name="robots"]')
    if (NOINDEX.test(path)) {
      if (!robots) {
        robots = document.createElement('meta')
        robots.setAttribute('name', 'robots')
        document.head.appendChild(robots)
      }
      robots.setAttribute('content', 'noindex')
    } else if (robots) {
      robots.remove()
    }
    window.dispatchEvent(new Event(ROUTE_EVENT))
  }, [pathname])
}
