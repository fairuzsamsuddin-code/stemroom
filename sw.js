// Stemroom service worker: keeps the app and the model available offline.
const APP = 'stemroom-app-v2';
const MODEL = 'stemroom-model'; // never deleted, so the 170 MB model is only downloaded once
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/engine.js', 'js/db.js', 'js/compat.js', 'js/mixer.worklet.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-180.png', 'vendor/separate.worker.js', 'vendor/ort/ort.wasm.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('stemroom-app-') && k !== APP) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/model/') || url.pathname.includes('/model-split/')) {
    e.respondWith((async () => {
      const c = await caches.open(MODEL);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok && /\.part|\.onnx/.test(url.pathname)) c.put(req, r.clone());
      return r;
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(APP);
    try {
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
