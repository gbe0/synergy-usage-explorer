/*
 * sw.js - the service worker that lets the app work offline.
 *
 * On a visitor's first online visit it saves a copy of every file in FILES on
 * their device, and from then on serves those saved copies, even when the
 * device is online. That is what makes the app work with no connection.
 *
 * !! IMPORTANT WHEN YOU CHANGE THE APP !!
 * Browsers only fetch new copies of the files when THIS file changes. After
 * editing anything in public/, change VERSION below (any new value will do),
 * or run `python3 stamp_version.py` from the project folder, which sets it
 * from the files' contents and keeps FILES up to date too. Otherwise
 * visitors, and you, keep getting the old app. A visitor gets the new
 * version the next time they open the app online: it downloads in the
 * background and waits, and the page offers to reload into it.
 *
 * Offline use only works when the app is served over https (or from
 * http://localhost). Opening index.html straight from disk works without
 * a connection anyway, but doesn't use this file.
 */
const VERSION = '0d61d5b0a289';
const CACHE = `synergy-tool-${VERSION}`;
// FILES-START (kept up to date by stamp_version.py)
const FILES = [
  "./",
  "css/app.css",
  "css/dashboard.css",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/icon.svg",
  "js/app.js",
  "js/dashboard.js",
  "js/default-tariffs.js",
  "js/readers.js",
  "js/runtime.js",
  "js/sample-data.js",
  "manifest.webmanifest",
  "vendor/d3-LICENSE.txt",
  "vendor/d3.v7.9.0.min.js",
];
// FILES-END

// Save every file. {cache: 'reload'} skips the browser's HTTP cache, so a
// new VERSION never saves stale copies.
async function saveFiles() {
  const cache = await caches.open(CACHE);
  await Promise.all(FILES.map(async (file) => {
    let res = await fetch(new Request(file, {cache: 'reload'}));
    // Some hosts don't serve index.html for the folder's own address.
    if (!res.ok && file === './') res = await fetch(new Request('index.html', {cache: 'reload'}));
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    // A response that followed a redirect can't answer a page load, so store a plain copy.
    const copy = res.redirected
      ? new Response(await res.blob(), {status: res.status, statusText: res.statusText, headers: res.headers})
      : res;
    await cache.put(file, copy);
  }));
}

// A new version waits until the page asks for it (app.js's Reload button
// sends SKIP_WAITING), rather than taking over at once: activating deletes
// the old copies, and a page still running the old app.js could then load
// newer files, such as js/sample-data.js, that don't match it. The first
// install, with no older version in use, takes over straight away anyway.
self.addEventListener('install', (event) => {
  event.waitUntil(saveFiles());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('synergy-tool-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(req, {ignoreSearch: true});
    if (!hit && req.mode === 'navigate') {
      // ".../index.html" and "..." are the same page.
      const root = new URL('./', self.registration.scope).pathname;
      const path = new URL(req.url).pathname;
      if (path === root || path === `${root}index.html`) hit = await cache.match('./');
    }
    return hit || fetch(req);
  })());
});
