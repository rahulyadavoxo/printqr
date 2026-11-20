/* PrintQR web push: shows the new-order notification when the dashboard tab is closed.
   Plain push handler (no Firebase SDK needed here); the page gets the token with firebase/messaging. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = {} }
  const n = d.notification || {}
  const data = d.data || {}
  const title = n.title || data.title || 'New order'
  const opts = {
    body: n.body || data.body || '',
    icon: n.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: n.tag || (data.order_id ? 'order-' + data.order_id : 'order'),
    renotify: true,
    requireInteraction: false,
    data: { link: (d.fcmOptions && d.fcmOptions.link) || data.link || '/#/dashboard' }
  }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Dashboard open and visible: it rings by itself, skip the system notification.
      if (list.some((c) => c.visibilityState === 'visible' && c.url.includes('#/dashboard'))) return
      return self.registration.showNotification(title, opts)
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const link = (e.notification.data && e.notification.data.link) || '/#/dashboard'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const c = list.find((w) => w.url.includes(self.location.origin))
      if (c) { c.focus(); return c.navigate ? c.navigate(link).catch(() => {}) : undefined }
      return self.clients.openWindow(link)
    })
  )
})
