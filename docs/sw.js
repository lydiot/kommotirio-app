// Service worker: κρατά αντίγραφο της εφαρμογής στη συσκευή για χρήση offline.
// Σε κάθε αλλαγή αρχείων ανεβάζουμε το VERSION, ώστε να κατέβει η νέα έκδοση.
const VERSION = 'v1.5.0';
const CACHE = `salon-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/seed.js',
  'data/seed.json',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('salon-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Η εφαρμογή ζητά ενεργοποίηση της νέας έκδοσης όταν ο χρήστης πατήσει «Ανανέωση».
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Πλοήγηση: πάντα η αποθηκευμένη σελίδα (δουλεύει χωρίς internet).
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  // Υπόλοιπα: πρώτα από τη συσκευή, αλλιώς από το δίκτυο.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
