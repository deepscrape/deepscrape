/*
 * Cloud Messaging background handler.
 *
 * Deliberately does NOT use the Firebase SDK or `importScripts` of a config object:
 * FCM web push payloads arrive already decrypted in the `push` event, so parsing
 * them here handles both `notification` and data-only messages without duplicating
 * Firebase project values into a publicly served, cacheable file.
 *
 * Registered by NotificationService with an explicit sub-scope
 * ('/firebase-cloud-messaging-push-scope') because the Angular service worker
 * (ngsw-worker.js) already owns scope '/'.
 */
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  // FCM nests the display content under `notification`; a data-only push has none.
  const notification = payload.notification || {}
  const data = payload.data || {}
  const title = notification.title || data.title || 'deepscrape'
  const link = (payload.fcmOptions && payload.fcmOptions.link) || data.link || '/'

  event.waitUntil(self.registration.showNotification(title, {
    body: notification.body || data.body || '',
    icon: notification.icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    tag: data.tag || undefined,
    data: { link },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/'

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windowClients) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) {
          try {
            await client.navigate(link)
          } catch {
            // Cross-origin or detached client: focusing is still the useful half.
          }
        }
        return
      }
    }
    await self.clients.openWindow(link)
  })())
})
