// Πρώτο γέμισμα της βάσης από το data/seed.json.
// Τρέχει ΜΟΝΟ μία φορά: μετά σημειώνεται στο meta και δεν ξαναγγίζει τίποτα,
// ώστε να μη σβηστεί ή να μη διπλασιαστεί ό,τι έχει καταχωρηθεί.

import { getMeta, transaction } from './db.js';

export const SEED_VERSION = 1;

export function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export async function seedIfNeeded() {
  const seeded = await getMeta('seedVersion');
  if (seeded) return { seeded: false };

  const res = await fetch('data/seed.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Δεν φορτώθηκαν τα αρχικά δεδομένα.');
  const seed = await res.json();

  // Πελάτες: καθάρισμα κενών + αφαίρεση διπλών (το αρχείο έχει 7 διπλά).
  const seen = new Set();
  const clients = [];
  for (const raw of seed.clients || []) {
    const name = cleanName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clients.push(name);
  }

  const now = Date.now();
  await transaction(['categories', 'clients', 'staff', 'meta'], (tx) => {
    const cats = tx.objectStore('categories');
    Object.entries(seed.prices || {}).forEach(([name, prices], order) => {
      const cents = [...new Set(prices.map((p) => Math.round(Number(p) * 100)))].sort((a, b) => a - b);
      cats.put({ name: cleanName(name), prices: cents, order });
    });
    const cl = tx.objectStore('clients');
    clients.forEach((name) => cl.add({ name, source: 'seed', createdAt: now }));
    const st = tx.objectStore('staff');
    (seed.staff || []).forEach((name, order) => st.put({ name: cleanName(name), order, active: true }));
    tx.objectStore('meta').put({ key: 'seedVersion', value: SEED_VERSION });
    tx.objectStore('meta').put({ key: 'seededAt', value: now });
  });

  return { seeded: true, clients: clients.length };
}
