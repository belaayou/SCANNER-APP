/* =====================================================================
   SCANNER-APP - Service Worker
   Chemins 100 % relatifs : fonctionne dans /<depot>/ sur GitHub Pages.
   Pour publier une nouvelle version : changer VERSION ci-dessous.
   ===================================================================== */
const VERSION = "v1.2.0";
const CACHE_PREFIX = "scanner-app-";
const CACHE_LOCAL = CACHE_PREFIX + "local-" + VERSION;
const CACHE_CDN = CACHE_PREFIX + "cdn-" + VERSION;

/* Ressources locales (relatives à l'emplacement de ce fichier) */
/* Indispensables : si l'un manque, l'installation du SW échoue (visible dans la console) */
const REQUIRED_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json"
];
/* Facultatifs : mis en cache s'ils existent (copies locales des bibliothèques, icônes) */
const OPTIONAL_ASSETS = [
  "./libs/html5-qrcode.min.js",
  "./libs/supabase.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];
const LOCAL_ASSETS = REQUIRED_ASSETS.concat(OPTIONAL_ASSETS);

/* Dépendances externes réellement utilisées par index.html */
const CDN_SCRIPTS = [
  "https://unpkg.com/html5-qrcode",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];
const CDN_STYLES = [
  "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700&display=swap",
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&display=swap",
  "https://fonts.googleapis.com/icon?family=Material+Icons"
];
const CDN_HOSTS = [
  "unpkg.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
];

const isCacheable = (r) => r && (r.ok || r.type === "opaque");

async function precacheCdn() {
  const cache = await caches.open(CACHE_CDN);

  /* Scripts : réponse opaque acceptée (chargés sans attribut crossorigin) */
  await Promise.all(CDN_SCRIPTS.map(async (url) => {
    try {
      const res = await fetch(new Request(url, { mode: "no-cors" }));
      if (isCacheable(res)) await cache.put(url, res);
    } catch (e) { /* hors ligne à l'installation : repris à l'exécution */ }
  }));

  /* Feuilles de style : lues pour récupérer aussi les fichiers de police */
  await Promise.all(CDN_STYLES.map(async (url) => {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) return;
      const css = await res.clone().text();
      await cache.put(url, res);
      const fontUrls = [...css.matchAll(/url\((['"]?)(https:[^)'"]+)\1\)/g)].map((m) => m[2]);
      await Promise.all(fontUrls.map(async (f) => {
        try {
          const fr = await fetch(f, { mode: "cors" });
          if (fr.ok) await cache.put(f, fr);
        } catch (e) { /* ignoré */ }
      }));
    } catch (e) { /* ignoré */ }
  }));
}

async function precacheLocal(cache) {
  await cache.addAll(REQUIRED_ASSETS.map((u) => new Request(u, { cache: "reload" })));
  await Promise.all(OPTIONAL_ASSETS.map(async (u) => {
    try {
      const res = await fetch(new Request(u, { cache: "reload" }));
      if (res.ok) await cache.put(u, res);
    } catch (e) { /* absent ou hors ligne : ignoré */ }
  }));
}

/* Le CDN n'est utile hors ligne que si aucune copie locale n'existe : on complète à la demande */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "PRECACHE") {
    event.waitUntil((async () => {
      await precacheLocal(await caches.open(CACHE_LOCAL)).catch(() => {});
      await precacheCdn();
    })());
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_LOCAL);
    await precacheLocal(cache);
    await precacheCdn();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [CACHE_LOCAL, CACHE_CDN];
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith(CACHE_PREFIX) && !keep.includes(n))
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* Réseau d'abord, repli sur le cache (pages HTML) */
async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (isCacheable(res)) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const cached = (await cache.match(request, { ignoreSearch: true })) ||
      (fallbackUrl && (await cache.match(fallbackUrl)));
    if (cached) return cached;
    return new Response("Hors ligne", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

/* Cache d'abord + mise à jour en arrière-plan */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (isCacheable(res)) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) { update.catch(() => {}); return cached; }
  const res = await update;
  return res || new Response("", { status: 504, statusText: "Gateway Timeout" });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;               /* POST/PATCH/DELETE : jamais interceptés */

  const url = new URL(request.url);

  /* Supabase (API, authentification, données) et tout autre domaine inconnu :
     jamais mis en cache, laissés au navigateur -> vraies erreurs réseau hors ligne */
  if (url.origin !== self.location.origin && !CDN_HOSTS.includes(url.hostname)) return;

  /* Navigation : réseau d'abord, repli sur index.html en cache */
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, CACHE_LOCAL, "./index.html"));
    return;
  }

  /* Ressources locales */
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, CACHE_LOCAL));
    return;
  }

  /* Bibliothèques et polices (CDN) */
  event.respondWith(staleWhileRevalidate(request, CACHE_CDN));
});
