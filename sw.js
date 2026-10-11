/*
 * ドキドキベースボール — service worker（オフライン用の最小構成）
 *
 * - アプリ本体（HTML/CSS/JS/manifest）はネットワーク優先。GitHub Pages に新しい版を
 *   上げればそのまま反映され、オフラインのときだけキャッシュを使う。
 * - 音声・アイコンはキャッシュ優先＋裏で更新（stale-while-revalidate）。
 * - 他オリジン（Google Fonts など）には手を出さない。
 * - 公開物を大きく変えたら CACHE_VERSION を上げる（古いキャッシュは activate で削除）。
 */
const CACHE_VERSION = 'v3-mobile-voice-fielding';
const CACHE = `dokidoki-${CACHE_VERSION}`;

const SHELL = [
  'js/challenge.js', 'js/challenge-model.mjs', 'css/challenge.css',
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css', 'css/background.css', 'css/settings.css', 'css/fielding.css', 'css/subs.css', 'css/teamedit.css', 'css/mobile.css',
  'js/main.js', 'js/touch.js', 'js/data.js', 'js/engine.js', 'js/cost.js', 'js/game.js', 'js/fielding.js', 'js/subs.js',
  'js/screens.js', 'js/teamedit.js', 'js/sound.js', 'js/music.js',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png', 'assets/apple-touch-icon.png',
  ...['ball', 'foul', 'out', 'out2', 'strike', 'strike2', 'strikeout'].flatMap((n) => [`assets/voice/${n}.mp3`, `assets/voice/${n}.ogg`]),
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 1 ファイル失敗してもインストール全体は止めない
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dokidoki-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isShell = (url, req) => req.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // navigate リクエストには init を付けられないので URL から作り直す（HTTP キャッシュも再検証）
    const res = await fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) {
    event.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // 音声の部分取得はブラウザに任せる
  event.respondWith(isShell(url, req) ? networkFirst(req) : staleWhileRevalidate(event, req));
});
