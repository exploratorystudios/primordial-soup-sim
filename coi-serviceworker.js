// Static hosts such as GitHub Pages can't send the COOP/COEP headers that cross-origin isolation needs (and
// with it SharedArrayBuffer, so the simulation's helper threads; see js/pool.js). Loaded from the page this
// registers itself as a service worker and reloads once; as the worker it adds those headers to every response.
// Served with the headers already (server.js, the Fly server), it does nothing.
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    e.respondWith(fetch(r).then((res) => {
      if (res.status === 0) return res;
      const h = new Headers(res.headers);
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }).catch((err) => console.error(err)));
  });
} else if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
  const src = document.currentScript.src;
  navigator.serviceWorker.register(src).then(() => {
    // Reload once so the page itself comes through the worker (a flag stops a loop if isolation still fails).
    if (sessionStorage.getItem('coiReloaded')) return;
    const go = () => { sessionStorage.setItem('coiReloaded', '1'); location.reload(); };
    if (navigator.serviceWorker.controller) go();
    else navigator.serviceWorker.ready.then(go);
  }, (err) => console.warn('coi-serviceworker:', err));
}
