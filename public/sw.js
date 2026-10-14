// שירות קטן שמאפשר התקנה כאפליקציה. הוא לא נוגע בבקשות המשחק עצמן (poll / answer וכו').
var CACHE = "trivia-shell-v1";
var SHELL = ["/index.html", "/manifest.json", "/banner.jpg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var isNav = req.mode === "navigate";
  if (!isNav && SHELL.indexOf(url.pathname) < 0) return; // כל השאר (ה-API) עובר ישר לרשת
  var key = isNav ? "/index.html" : req;
  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(key, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(key).then(function (r) { return r || Response.error(); });
      })
  );
});
