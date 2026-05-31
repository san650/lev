const VERSION = 'v17'
const CACHE_NAME = `lev-${VERSION}`

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/stats.html',
  '/lists.html',
  '/lists.json',
  '/manifest.webmanifest',
  '/assets/main.css',
  '/assets/main.js',
  '/assets/stats.js',
  '/assets/lists.js',
  '/assets/register-sw.js',
  '/assets/logo.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable.svg',
  '/assets/space-mono-700.woff2',
  '/assets/dm-serif-display-400.woff2',
  '/assets/work-sans-400.woff2',
  '/assets/work-sans-600.woff2',
  '/assets/jetbrains-mono-700.woff2'
]

// Install: precache app shell. cache: 'reload' bypasses the HTTP cache so a
// version bump within GitHub Pages' max-age=600 window can't pull stale
// shell into the new cache.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(
        SHELL_ASSETS.map(url => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  )
})

// Activate: clean old caches and, when the cause is an UPDATE (any pre-
// existing lev-* cache existed), broadcast a one-shot RELOAD so controlled
// pages refresh into the new shell on the same launch — avoiding the
// classic "deploy lands on second reload" PWA bug. First installs have no
// prior cache, so the message is suppressed and the page just boots.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    const oldKeys = keys.filter(k => k.startsWith('lev-') && k !== CACHE_NAME)
    const wasUpdate = oldKeys.length > 0
    await Promise.all(oldKeys.map(k => caches.delete(k)))
    await self.clients.claim()
    if (wasUpdate) {
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const c of clients) c.postMessage({ type: 'sw-update-reload' })
    }
  })())
})

// Cacheable only when the response is a successful, same-origin, basic
// response — otherwise 404s and opaque redirects poison the cache.
const isCacheable = (res) => res && res.ok && res.type === 'basic'

// Compute a short hex fingerprint of a string. Web Crypto exposes SHA-1
// natively (MD5 is not available in browsers); we keep the first 16 hex
// chars which is plenty for change detection.
async function fingerprint(text) {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-1', buf)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

async function notifyDbUpdated(hash) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) {
    client.postMessage({ type: 'db-updated', hash })
  }
}

// Stale-while-revalidate for db.json. The page receives the cached copy
// instantly (or the network copy on first visit), and we always kick off a
// network fetch in the background. When the new payload differs from the
// cached one, the SW updates the cache and posts a `db-updated` message so
// the page can re-render.
async function handleDbJson(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match('/db.json')

  const networkPromise = fetch(request, { cache: 'no-store' })
    .then(async response => {
      if (!isCacheable(response)) return null
      const text = await response.clone().text()
      const newHash = await fingerprint(text)

      let oldHash = null
      if (cached) oldHash = await fingerprint(await cached.clone().text())

      await cache.put('/db.json', response.clone())

      // Only notify when we already had a cached copy and it differs —
      // first-visit responses are already what the page is rendering.
      if (oldHash !== null && oldHash !== newHash) await notifyDbUpdated(newHash)
      return response
    })
    .catch(() => null)

  return cached || (await networkPromise) || new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // Don't intercept cross-origin requests — they're not in our cache and we
  // don't want to store opaque responses.
  if (url.origin !== self.location.origin) return

  if (url.pathname === '/db.json') {
    e.respondWith(handleDbJson(e.request))
    return
  }

  if (url.pathname.startsWith('/covers/')) {
    // Cache first for cover images (they rarely change)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached
        return fetch(e.request).then(response => {
          if (isCacheable(response)) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)).catch(() => {})
          }
          return response
        })
      })
    )
    return
  }

  // Cache first for everything else (shell assets, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  )
})
