import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/printqr/"). Locally it is "/".
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  build: { target: 'es2022' },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new deploy is offered with an Update banner (src/lib/pwa.ts), checked every minute
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'logo.svg', 'favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Print by Receipto – Scan, upload, print',
        short_name: 'Print',
        description: 'QR file upload and print queue for cyber cafes',
        theme_color: '#0b1210',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base + '#/dashboard',
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,mjs}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/rest\//, /^\/storage\//]
      }
    })
  ]
})
