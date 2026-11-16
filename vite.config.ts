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
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'PrintQR – Scan, upload, print',
        short_name: 'PrintQR',
        description: 'QR file upload and print queue for cyber cafes',
        theme_color: '#2348e0',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base + '#/dashboard',
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
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
