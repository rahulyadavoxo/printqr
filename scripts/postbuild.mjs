// Runs after `vite build` (npm "postbuild"). GitHub Pages has no SPA rewrites, so:
//  - dist/404.html = the app shell: any path route (/s/shop, /dashboard, /o/..) opens the app.
//    (GitHub Pages sends it with HTTP 404; the app still loads and routes normally.)
//  - dist/login.html, dist/legal/<doc>.html: the public pages in sitemap.xml get a real HTTP 200
//    (GitHub Pages serves /login from login.html), each with its own title, canonical and og:url.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const dist = 'dist'
const html = readFileSync(join(dist, 'index.html'), 'utf8')
writeFileSync(join(dist, '404.html'), html)

const SITE = 'https://print.receipto.in'
const BRAND = 'Print by Receipto'
const DEFAULT_TITLE = 'Print by Receipto – Scan, upload, print'
// Keep in sync with TITLES in src/lib/useRouteMeta.ts and public/sitemap.xml
const PAGES = {
  '/login': 'Log in or sign up – ' + BRAND,
  '/legal/privacy': 'Privacy Policy – ' + BRAND,
  '/legal/terms': 'Terms of Service – ' + BRAND,
  '/legal/refund': 'Refund and Cancellation Policy – ' + BRAND,
  '/legal/contact': 'Contact – ' + BRAND
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
for (const [path, title] of Object.entries(PAGES)) {
  const url = SITE + path
  let out = html
    .replace(`<title>${DEFAULT_TITLE}</title>`, `<title>${esc(title)}</title>`)
    .replace('<link rel="canonical" href="https://print.receipto.in/" />', `<link rel="canonical" href="${url}" />`)
    .replace('<meta property="og:url" content="https://print.receipto.in/" />', `<meta property="og:url" content="${url}" />`)
    .replace(`<meta property="og:title" content="${DEFAULT_TITLE}" />`, `<meta property="og:title" content="${esc(title)}" />`)
  if (!out.includes(`href="${url}"`)) throw new Error('postbuild: canonical not replaced for ' + path)
  const file = join(dist, path.slice(1) + '.html')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, out)
}
console.log('postbuild: 404.html + ' + Object.keys(PAGES).length + ' page copies written')
