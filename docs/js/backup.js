// Εξαγωγή / εισαγωγή. Το αρχείο είναι η μόνη «γέφυρα» ανάμεσα στις συσκευές:
// κανένας server. Ο Νότης εξάγει από το κινητό, η Λυδία κάνει εισαγωγή στο
// λάπτοπ. Το ίδιο αρχείο επαναφέρει τα πάντα σε νέα συσκευή.

import * as db from './db.js';
import { cleanName } from './seed.js';

export const BACKUP_APP = 'kommotirio';

// «LP Majirel CB 6.23 60ml R25 V522» → «Majirel CB 6.23 60ml» (αφαιρούνται το πρόθεμα LP και οι κωδικοί παρτίδας).
export function cleanSupplierName(n) {
  return String(n || '').replace(/^\s*LP\s+/i, '').replace(/\bV[A-Z]?\d{2,3}\b/g, '').replace(/\bR\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
}
const normKey = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
export const BACKUP_FORMAT = 1;

const DATA_STORES = ['categories', 'clients', 'staff', 'days', 'visits', 'expenses', 'deleted', 'products', 'moves'];

// ---------------------------------------------------------------- πλήρες backup (JSON)
export async function buildBackup() {
  const data = {};
  for (const s of DATA_STORES) data[s] = await db.getAll(s);
  // Τα τοπικά id δεν έχουν νόημα σε άλλη συσκευή — ταυτότητα είναι το uid.
  for (const s of ['visits', 'expenses']) data[s] = data[s].map(({ id, ...rest }) => rest);
  data.clients = data.clients.map(({ id, ...rest }) => rest);
  const settings = { lydiaPhone: (await db.getMeta('lydiaPhone')) || '', fixedCosts: (await db.getMeta('fixedCosts')) || null };
  return { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt: Date.now(), settings, data };
}

// ---------------------------------------------------------------- CSV για Excel
// Ελληνικό Excel: διαχωριστικό «;», δεκαδικά με κόμμα, ημερομηνία ηη/μμ/εεεε,
// και BOM ώστε να διαβάζει σωστά τα ελληνικά.
const CSV_HEAD = ['Ημερομηνία', 'Τύπος', 'Α/Α', 'Πελάτης', 'Υπάλληλος', 'Περιγραφή', 'Ποσό'];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvMoney = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const csvDate = (d) => d.split('-').reverse().join('/');

// dates: Set ημερομηνιών προς εξαγωγή, ή null για όλες.
export async function buildCSV(dates = null) {
  const keep = (d) => !dates || dates.has(d);
  const [days, visits, expenses] = await Promise.all([db.getAll('days'), db.getAll('visits'), db.getAll('expenses')]);
  const byDate = new Map();
  const bucket = (d) => {
    if (!byDate.has(d)) byDate.set(d, { day: null, visits: [], expenses: [] });
    return byDate.get(d);
  };
  days.filter((d) => keep(d.date)).forEach((d) => (bucket(d.date).day = d));
  visits.filter((v) => keep(v.date)).forEach((v) => bucket(v.date).visits.push(v));
  expenses.filter((e) => keep(e.date)).forEach((e) => bucket(e.date).expenses.push(e));

  const rows = [CSV_HEAD];
  for (const date of [...byDate.keys()].sort()) {
    const { day, visits: vs, expenses: es } = byDate.get(date);
    const D = csvDate(date);
    vs.sort((a, b) => a.createdAt - b.createdAt).forEach((v, i) => {
      for (const it of v.items) {
        const desc = it.cat === 'Άλλο' && it.note ? `Άλλο: ${it.note}` : it.cat;
        rows.push([D, 'Εργασία', i + 1, v.client, v.staff, desc, csvMoney(it.amount)]);
      }
    });
    if (day?.retailItems) day.retailItems.forEach((it, i) => rows.push([D, 'Μεταπώληση', i + 1, '', '', it.product || '', csvMoney(it.amount)]));
    else if (day?.retail != null) rows.push([D, 'Μεταπώληση', '', '', '', '', csvMoney(day.retail)]);
    es.sort((a, b) => a.createdAt - b.createdAt).forEach((e) => rows.push([D, 'Έξοδο', '', '', '', e.desc, csvMoney(e.amount)]));
    if (day?.posTotal != null) rows.push([D, 'POS σύνολο', '', '', '', '', csvMoney(day.posTotal)]);
    (day?.posParts || []).forEach((p, i) => rows.push([D, 'POS συναλλαγή', i + 1, '', '', '', csvMoney(p)]));
    (day?.useItems || []).forEach((it, i) => rows.push([D, 'Αναλώσιμο', i + 1, '', '', `${it.product} × ${it.qty || 1}`, '']));
    if (day?.vat != null) rows.push([D, 'ΦΠΑ', '', '', '', '', csvMoney(day.vat)]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- τι δεν έχει σταλεί
// Ημερομηνίες με αλλαγές ΣΕ ΑΥΤΗ ΤΗ ΣΥΣΚΕΥΗ μετά την τελευταία αποστολή.
// Ό,τι ήρθε με εισαγωγή από άλλη συσκευή (άλλο dev) δεν μετράει ως εκκρεμότητα.
export async function pendingDates(since, device) {
  since = since || 0;
  const mine = (r) => !r.dev || !device || r.dev === device;
  const [days, visits, expenses, deleted] = await Promise.all(
    ['days', 'visits', 'expenses', 'deleted'].map((s) => db.getAll(s)));
  const out = new Set();
  for (const d of days) if (mine(d) && (d.updatedAt || 0) > since) out.add(d.date);
  for (const v of [...visits, ...expenses]) if (mine(v) && (v.updatedAt || v.createdAt || 0) > since) out.add(v.date);
  for (const t of deleted) if (mine(t) && t.deletedAt > since && t.date) out.add(t.date);
  for (const m of await db.getAll('moves')) if (mine(m) && (m.updatedAt || 0) > since) out.add(m.date);
  return [...out].sort();
}

// ---------------------------------------------------------------- εισαγωγή (συγχώνευση)
// Δεν σβήνει ποτέ ό,τι υπάρχει: συγχωνεύει. Για κάθε εγγραφή κρατά τη
// νεότερη εκδοχή (updatedAt). Οι διαγραφές περνούν μέσω του store «deleted».
export async function importText(text) {
  let obj;
  try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('Το αρχείο δεν είναι αρχείο backup της εφαρμογής.'); }

  // Τιμολόγιο από αρχείο: { "invoice": { supplier, no, date:"ΕΕΕΕ-ΜΜ-ΗΗ", discount, page?, pageTotal?, lines:[{code, ean, desc, qty, list, disc?}] } }
  // (list = τιμή μονάδας χωρίς ΦΠΑ σε ευρώ, disc = έκπτωση %). Ίδιος υπολογισμός με την οθόνη τιμολογίου: καθαρή τιμή τεμαχίου
  // στρογγυλεύεται στο λεπτό. Ασφαλές για επανάληψη (σταθερά uid ανά τιμολόγιο/σελίδα/προϊόν). Αν δίνεται pageTotal και δεν
  // συμφωνεί με το άθροισμα, ΔΕΝ γίνεται εισαγωγή.
  if (obj && obj.app !== BACKUP_APP && obj.invoice && Array.isArray(obj.invoice.lines)) {
    const inv = obj.invoice;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.date || '')) throw new Error('Το αρχείο τιμολογίου δεν έχει σωστή ημερομηνία.');
    const date = inv.date, no = cleanName(inv.no || ''), supplier = cleanName(inv.supplier || ''), page = inv.page || 1;
    const local = await db.getAll('products');
    const byCode = new Map(local.filter((p) => p.code).map((p) => [String(p.code).toUpperCase(), p]));
    const byEan = new Map(local.filter((p) => p.ean).map((p) => [String(p.ean), p]));
    const byNm = new Map(local.map((p) => [normKey(p.name), p]));
    const toC = (v) => (v == null || v === '' ? null : Math.round(Number(String(v).replace(',', '.')) * 100));
    const eur = (c) => (c / 100).toFixed(2).replace('.', ',') + ' €';
    const [y, mo, d] = date.split('-').map(Number), base = new Date(y, mo - 1, d, 12).getTime(), now = Date.now();
    const dev = await db.getMeta('deviceId');
    const newProds = [], moves = [], seen = new Map();
    let sum = 0, pieces = 0;
    inv.lines.forEach((ln, i) => {
      const q = parseInt(ln.qty, 10); if (!(q > 0)) return;
      const code = String(ln.code || '').trim().toUpperCase(), ean = String(ln.ean || '').trim();
      let P = (code && byCode.get(code)) || (ean && byEan.get(ean)) || byNm.get(normKey(cleanSupplierName(ln.desc)));
      if (!P) {
        P = { id: code ? `lp:${code}` : db.newUid(), name: cleanSupplierName(ln.desc) || code || ean, supplierName: ln.desc || '', code, ean, size: '', group: '', kind: 'both', listCost: null, cost: null, price: null, min: 1, updatedAt: now };
        newProds.push(P); if (code) byCode.set(code, P); if (ean) byEan.set(ean, P); byNm.set(normKey(P.name), P);
      }
      const list = toC(ln.list), disc = Number(ln.disc ?? inv.discount ?? 0) || 0;
      const net = list == null ? null : Math.round(list * (1 - disc / 100));
      const n = (seen.get(P.id) || 0) + 1; seen.set(P.id, n);
      moves.push({ uid: `inv:${normKey(no) || date}:p${page}:${P.id}:${n}`, productId: P.id, date, at: base + i, type: 'receive', qty: q, cost: net, listPrice: list,
        disc: disc || null, inv: no || null, supplier: supplier || null, dev, updatedAt: now });
      if (net != null) sum += q * net;
      pieces += q;
    });
    if (!moves.length) throw new Error('Το αρχείο τιμολογίου δεν έχει γραμμές με ποσότητα.');
    const check = toC(inv.pageTotal);
    if (check != null && Math.abs(sum - check) > 5) throw new Error(`Το άθροισμα των γραμμών (${eur(sum)}) δεν συμφωνεί με το σύνολο του αρχείου (${eur(check)}). Δεν έγινε εισαγωγή.`);
    const have = new Set((await db.getAll('moves')).map((m) => m.uid));
    const fresh = moves.filter((m) => !have.has(m.uid));
    const keep = new Set(fresh.map((m) => m.productId));
    await db.transaction(['products', 'moves', 'deleted'], (tx) => {
      newProds.filter((p) => keep.has(p.id)).forEach((p) => tx.objectStore('products').put(p));
      fresh.forEach((m) => { tx.objectStore('moves').put(m); tx.objectStore('deleted').delete(m.uid); });
    });
    return { kind: 'invoice', no, lines: moves.length, added: fresh.length, pieces, sum, checked: check != null, newProducts: newProds.filter((p) => keep.has(p.id)).length, text: eur(sum) };
  }
  // Κατάλογος προϊόντων προμηθευτή: { "products": [ { name, code, ean, size, group, kind, listCost, price? } ] }.
  // Αντιστοίχιση με υπάρχοντα προϊόντα: κωδικός → barcode → όνομα. Νέα προϊόντα παίρνουν σταθερό id από τον κωδικό
  // (έτσι δύο συσκευές που εισάγουν τον ίδιο κατάλογο δεν δημιουργούν διπλά). Σε ήδη υπάρχοντα ενημερώνεται μόνο η τιμή
  // καταλόγου και συμπληρώνονται στοιχεία που λείπουν· το απόθεμα, το είδος και το όνομα ΔΕΝ πειράζονται.
  if (obj && obj.app !== BACKUP_APP && Array.isArray(obj.products)) {
    const local = await db.getAll('products');
    const byCode = new Map(local.filter((p) => p.code).map((p) => [String(p.code), p]));
    const byEan = new Map(local.filter((p) => p.ean).map((p) => [String(p.ean), p]));
    const byNm = new Map(local.map((p) => [normKey(p.name), p]));
    const toC = (v) => (v == null || v === '' ? null : Math.round(Number(String(v).replace(',', '.')) * 100));
    const now = Date.now(), writes = [], r = { kind: 'products', productsAdded: 0, productsUpdated: 0, priceChanges: 0 };
    for (const it of obj.products) {
      const name = cleanName(it.name); if (!name) continue;
      const code = String(it.code || '').trim(), ean = String(it.ean || '').trim();
      const listCost = toC(it.listCost ?? it.cost);
      const cur = (code && byCode.get(code)) || (ean && byEan.get(ean)) || byNm.get(normKey(name));
      if (!cur) {
        const p = { id: code ? `lp:${code}` : db.newUid(), name, supplierName: it.supplierName || '', code, ean, size: it.size || '', group: it.group || '',
          kind: ['retail', 'use', 'both'].includes(it.kind) ? it.kind : 'both', listCost, cost: null, price: toC(it.price), min: 1, updatedAt: now };
        writes.push(p); r.productsAdded++;
        if (code) byCode.set(code, p); byNm.set(normKey(name), p);
      } else {
        const patch = {};
        for (const k of ['code', 'ean', 'size', 'group', 'supplierName']) { const v = k === 'code' ? code : k === 'ean' ? ean : (it[k] || ''); if (v && !cur[k]) patch[k] = v; }
        if (listCost != null && listCost !== cur.listCost) { patch.listCost = listCost; if (cur.listCost != null) r.priceChanges++; }
        if (Object.keys(patch).length) { writes.push({ ...cur, ...patch, updatedAt: now }); r.productsUpdated++; }
      }
    }
    if (writes.length) await db.transaction(['products'], (tx) => writes.forEach((p) => tx.objectStore('products').put(p)));
    return r;
  }
  // Σκέτο πελατολόγιο (π.χ. το αρχικό seed.json με "clients": [...]).
  if (obj && obj.app !== BACKUP_APP && Array.isArray(obj.clients)) {
    return { kind: 'clients', clientsAdded: await addClients(obj.clients, 'seed') };
  }
  if (!obj || obj.app !== BACKUP_APP || !obj.data) throw new Error('Το αρχείο δεν είναι αρχείο backup της εφαρμογής.');
  if (obj.format > BACKUP_FORMAT) throw new Error('Το αρχείο είναι από νεότερη έκδοση. Ανανέωσε πρώτα την εφαρμογή.');

  const inc = obj.data;
  const local = {};
  for (const s of DATA_STORES) local[s] = await db.getAll(s);

  const localProd = new Map(local.products.map((p) => [p.id, p]));
  const localByName = new Map(local.products.map((p) => [normKey(p.name), p.id]));
  const remap = new Map(); // εισερχόμενο id → τοπικό id, όταν το ίδιο προϊόν υπάρχει ήδη με άλλο id
  for (const p of inc.products || []) {
    const lid = localByName.get(normKey(p.name));
    if (lid && lid !== p.id && !localProd.has(p.id)) remap.set(p.id, lid);
  }
  const rid = (id) => remap.get(id) || id;
  const res = { kind: 'backup', added: 0, updated: 0, deleted: 0, days: 0, clientsAdded: 0 };
  const tombs = new Map(local.deleted.map((t) => [t.uid, t]));
  for (const t of inc.deleted || []) {
    const cur = tombs.get(t.uid);
    if (!cur || t.deletedAt > cur.deletedAt) tombs.set(t.uid, t);
  }

  const writes = []; // [store, 'put'|'delete', value|key]
  for (const store of ['visits', 'expenses']) {
    const byUid = new Map(local[store].map((r) => [r.uid, r]));
    for (const r of inc[store] || []) {
      if (!r.uid || !r.date) continue;
      const t = tombs.get(r.uid);
      const ts = r.updatedAt || r.createdAt || 0;
      if (t && t.deletedAt >= ts) continue;
      const cur = byUid.get(r.uid);
      if (!cur) { writes.push([store, 'put', { ...r }]); res.added++; }
      else if (ts > (cur.updatedAt || cur.createdAt || 0)) { writes.push([store, 'put', { ...r, id: cur.id }]); res.updated++; }
    }
    for (const t of tombs.values()) {
      if (t.store !== store) continue;
      const cur = byUid.get(t.uid);
      if (cur && t.deletedAt >= (cur.updatedAt || cur.createdAt || 0)) { writes.push([store, 'delete', cur.id]); res.deleted++; }
    }
  }
  const localDays = new Map(local.days.map((d) => [d.date, d]));
  for (const d of inc.days || []) {
    const cur = localDays.get(d.date);
    if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) {
      const fix = (l) => (l ? l.map((it) => (it.productId && remap.has(it.productId) ? { ...it, productId: rid(it.productId) } : it)) : l);
      writes.push(['days', 'put', { ...d, ...(d.retailItems ? { retailItems: fix(d.retailItems) } : {}), ...(d.useItems ? { useItems: fix(d.useItems) } : {}) }]); res.days++;
    }
  }
  // Τιμοκατάλογος: κρατιέται η νεότερη εκδοχή· διαγραφές με ίχνος «cat:όνομα».
  const localCats = new Map(local.categories.map((c) => [c.name, c]));
  for (const c of inc.categories || []) {
    const t = tombs.get(`cat:${c.name}`);
    if (t && t.deletedAt >= (c.updatedAt || 0)) continue;
    const cur = localCats.get(c.name);
    if (!cur || (c.updatedAt || 0) > (cur.updatedAt || 0)) writes.push(['categories', 'put', c]);
  }
  // Πελατολόγιο: διαγραφές/μετονομασίες με ίχνος «client:όνομα».
  for (const t of tombs.values()) {
    if (t.store === 'categories') {
      const cur = localCats.get(t.uid.slice(4));
      if (cur && (cur.updatedAt || 0) <= t.deletedAt) writes.push(['categories', 'delete', cur.name]);
    }
    if (t.store === 'clients') {
      const cur = local.clients.find((c) => c.name === t.uid.slice(7));
      if (cur && (cur.createdAt || 0) <= t.deletedAt) { writes.push(['clients', 'delete', cur.id]); res.clientsRemoved = (res.clientsRemoved || 0) + 1; }
    }
  }
  // Αποθήκη: προϊόντα (νεότερη εκδοχή, ίχνος «prod:id») και κινήσεις (ανά uid, ίχνος uid).
  // (η αντιστοίχιση προϊόντων έχει οριστεί νωρίτερα: localProd, remap, rid)
  for (const p of (inc.products || []).filter((x) => !remap.has(x.id))) {
    const t = tombs.get(`prod:${p.id}`);
    if (t && t.deletedAt >= (p.updatedAt || 0)) continue;
    const cur = localProd.get(p.id);
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) { writes.push(['products', 'put', p]); res.products = (res.products || 0) + 1; }
  }
  const localMoves = new Set(local.moves.map((m) => m.uid));
  for (const m of inc.moves || []) {
    if (!m.uid || localMoves.has(m.uid) || tombs.has(m.uid)) continue;
    writes.push(['moves', 'put', { ...m, productId: rid(m.productId) }]); res.moves = (res.moves || 0) + 1;
  }
  for (const t of tombs.values()) {
    if (t.store === 'products' && localProd.has(t.uid.slice(5)) && (localProd.get(t.uid.slice(5)).updatedAt || 0) <= t.deletedAt) writes.push(['products', 'delete', t.uid.slice(5)]);
    if (t.store === 'moves' && localMoves.has(t.uid)) writes.push(['moves', 'delete', t.uid]);
  }
  const staffNames = new Set(local.staff.map((s) => s.name));
  for (const s of inc.staff || []) if (!staffNames.has(s.name)) writes.push(['staff', 'put', s]);
  for (const t of tombs.values()) writes.push(['deleted', 'put', t]);

  await db.transaction(['visits', 'expenses', 'days', 'categories', 'staff', 'deleted', 'clients', 'products', 'moves'], (tx) => {
    for (const [store, op, v] of writes) {
      if (op === 'put') tx.objectStore(store).put(v);
      else tx.objectStore(store).delete(v);
    }
  });

  res.clientsAdded = await addClients(inc.clients || [], 'import');
  // Τηλέφωνα: κρατιέται η νεότερη αλλαγή.
  const localClients = new Map((await db.getAll('clients')).map((c) => [c.name, c]));
  const phoneUpd = (inc.clients || []).filter((c) => {
    const cur = localClients.get(c.name);
    return cur && (c.updatedAt || 0) > (cur.updatedAt || 0) && (c.phone || '') !== (cur.phone || '');
  });
  if (phoneUpd.length) {
    await db.transaction(['clients'], (tx) => {
      phoneUpd.forEach((c) => tx.objectStore('clients').put({ ...localClients.get(c.name), phone: c.phone || undefined, updatedAt: c.updatedAt }));
    });
  }
  if (obj.settings?.lydiaPhone && !(await db.getMeta('lydiaPhone'))) await db.setMeta('lydiaPhone', obj.settings.lydiaPhone);
  // Πάγια: κρατιέται η νεότερη λίστα (όλη μαζί).
  const incFixed = obj.settings?.fixedCosts;
  if (incFixed?.items) {
    const cur = await db.getMeta('fixedCosts');
    if (!cur || (incFixed.updatedAt || 0) > (cur.updatedAt || 0)) { await db.setMeta('fixedCosts', incFixed); res.fixedUpdated = true; }
  }
  return res;
}

// Προσθέτει ονόματα που λείπουν. Δεν ξαναφέρνει ονόματα που σβήστηκαν εδώ
// μετά τη δημιουργία τους (ίχνος «client:όνομα»). Αρχεία πελατολογίου = createdAt 0.
async function addClients(list, source) {
  const have = new Set((await db.getAll('clients')).map((c) => cleanName(c.name)));
  const tombs = new Map((await db.getAll('deleted')).filter((t) => t.store === 'clients').map((t) => [t.uid.slice(7), t]));
  const add = [];
  for (const item of list) {
    const name = cleanName(typeof item === 'string' ? item : item.name);
    const createdAt = typeof item === 'string' ? 0 : (item.createdAt || 0);
    const extra = typeof item === 'string' ? {} : { ...(item.phone ? { phone: item.phone } : {}), ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}) };
    if (!name || have.has(name)) continue;
    const t = tombs.get(name);
    if (t && t.deletedAt >= createdAt) continue;
    have.add(name);
    add.push({ name, source, createdAt, ...extra });
  }
  if (add.length) {
    await db.transaction(['clients'], (tx) => {
      const s = tx.objectStore('clients');
      add.forEach((c) => s.add(c));
    });
  }
  return add.length;
}

// ---------------------------------------------------------------- αρχεία
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function makeFile(text, name, type) {
  return new File([text], name, { type });
}

export function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
