// Τοπική βάση (IndexedDB). Τίποτα δεν φεύγει από τη συσκευή.
// Όλα τα ποσά αποθηκεύονται σε λεπτά (ακέραιοι), για να μην υπάρχουν
// λάθη στρογγυλοποίησης στα σύνολα και στο CSV.

const DB_NAME = 'salon';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('meta', { keyPath: 'key' });
        // Τιμοκατάλογος: { name, prices: [λεπτά], order }
        db.createObjectStore('categories', { keyPath: 'name' });
        // Πελάτες: { id, name, source: 'seed'|'app', createdAt }
        const clients = db.createObjectStore('clients', { keyPath: 'id', autoIncrement: true });
        clients.createIndex('name', 'name', { unique: true });
        // Υπάλληλοι: { name, order, active }
        db.createObjectStore('staff', { keyPath: 'name' });
        // Ημέρες: { date:'YYYY-MM-DD', posTotal, posCards:{visa,mastercard,other},
        //           retail, vat, locked, lockedAt, updatedAt }
        db.createObjectStore('days', { keyPath: 'date' });
        // Επισκέψεις: { id, date, client, staff, items:[{cat, amount, note}], total, createdAt, updatedAt }
        const visits = db.createObjectStore('visits', { keyPath: 'id', autoIncrement: true });
        visits.createIndex('date', 'date');
        // Έξοδα: { id, date, desc, amount, createdAt, updatedAt }
        const expenses = db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
        expenses.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Αν ανοίξει νεότερη έκδοση σε άλλη καρτέλα, κλείνουμε για να μην μπλοκάρει.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Η βάση είναι ανοιχτή σε άλλο παράθυρο.'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Η αποθήκευση ακυρώθηκε.'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(storeName, key) {
  return wrap((await store(storeName)).get(key));
}

export async function getAll(storeName) {
  return wrap((await store(storeName)).getAll());
}

export async function getByIndex(storeName, index, value) {
  return wrap((await store(storeName)).index(index).getAll(value));
}

// Επιστρέφει το κλειδί (π.χ. το νέο id).
export async function put(storeName, value) {
  const s = await store(storeName, 'readwrite');
  const key = await wrap(s.put(value));
  await done(s.transaction);
  return key;
}

export async function del(storeName, key) {
  const s = await store(storeName, 'readwrite');
  s.delete(key);
  await done(s.transaction);
}

// Πολλές εγγραφές σε μία συναλλαγή: ή γράφονται όλες ή καμία.
// fn(tx) παίρνει τη συναλλαγή και καλεί tx.objectStore(...).put(...)
export async function transaction(storeNames, fn) {
  const db = await openDB();
  const tx = db.transaction(storeNames, 'readwrite');
  fn(tx);
  await done(tx);
}

export async function getMeta(key) {
  const row = await get('meta', key);
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

export async function count(storeName) {
  return wrap((await store(storeName)).count());
}
