/* «Полка» — service worker: офлайн-оболочка и кэш статики. */
const CACHE = 'polka-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

async function precacheAssets() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  try {
    const response = await fetch('/index.html', { cache: 'no-cache' });
    if (!response.ok) return;
    const html = await response.text();
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => url.startsWith('/') && !url.startsWith('//'))
      .filter((url) => !url.endsWith('manifest.webmanifest'))
      .filter((url) => !url.endsWith('.png'));
    await Promise.allSettled(urls.map((url) => cache.add(url)));
  } catch (error) {
    console.warn('Не удалось предзакэшировать оболочку', error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheAssets().then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Тексты книг не кэшируем автоматически: пользователь скачивает их явно в IndexedDB.
  if (url.pathname.startsWith('/library/')) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          void cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match('/index.html')) ?? (await caches.match('/'));
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          void cache.put(request, response.clone());
        }
        return response;
      } catch {
        return Response.error();
      }
    })(),
  );
});
