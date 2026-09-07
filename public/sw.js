// Never delete model caches or return HTML as a worker/WASM response.
const CACHE_NAME = 'tinglan-shell-v3';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('tinglan-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if(response.ok && (event.request.mode === 'navigate' || /\.(js|css|wasm|svg|webmanifest)$/.test(url.pathname))) {
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)).catch(()=>{}));
    }
    return response;
  }).catch(async()=> {
    const cached=await caches.match(event.request);
    if(cached)return cached;
    if(event.request.mode==='navigate') return (await caches.match('/')) ?? new Response('听澜本机服务未启动。请运行“启动听澜.cmd”。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    return Response.error();
  }));
});
