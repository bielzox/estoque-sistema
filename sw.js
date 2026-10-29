const CACHE_NAME = 'estoque-intacto-car-v11';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './config.js',
  './sync.js',
  './icone.png',
  './icone-192.png',
  './icone-512.png'
];

const LIB_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const redePrimeiro = url => url === LIB_CDN || /\/(vendor\/supabase|config)\.js$/.test(new URL(url).pathname);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method === 'GET' && redePrimeiro(request.url)) {
    // config.js e biblioteca de login: tenta a internet primeiro e guarda cópia para uso offline
    event.respondWith(fetch(request).then(response => {
      if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then(cached => cached || Response.error())));
    return;
  }
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && new URL(request.url).pathname.endsWith('/')) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => request.mode === 'navigate' ? caches.match('./index.html') : Promise.reject(new Error('Recurso indisponível offline'))))
  );
});
