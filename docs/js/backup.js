// Εξαγωγή / εισαγωγή. Το αρχείο είναι η μόνη «γέφυρα» ανάμεσα στις συσκευές:
// κανένας server. Ο Νότης εξάγει από το κινητό, η Λυδία κάνει εισαγωγή στο
// λάπτοπ. Το ίδιο αρχείο επαναφέρει τα πάντα σε νέα συσκευή.

import * as db from './db.js';
import { cleanName } from './seed.js';

export const BACKUP_APP = 'kommotirio';
export const BACKUP_FORMAT = 1;

const DATA_STORES = ['categories', 'clients', 'staff', 'days', 'visits', 'expenses', 'deleted'];

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
  return [...out].sort();
}

// ---------------------------------------------------------------- εισαγωγή (συγχώνευση)
// Δεν σβήνει ποτέ ό,τι υπάρχει: συγχωνεύει. Για κάθε εγγραφή κρατά τη
// νεότερη εκδοχή (updatedAt). Οι διαγραφές περνούν μέσω του store «deleted».
export async function importText(text) {
  let obj;
  try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('Το αρχείο δεν είναι αρχείο backup της εφαρμογής.'); }

  // Σκέτο πελατολόγιο (π.χ. το αρχικό seed.json με "clients": [...]).
  if (obj && obj.app !== BACKUP_APP && Array.isArray(obj.clients)) {
    return { kind: 'clients', clientsAdded: await addClients(obj.clients, 'seed') };
  }
  if (!obj || obj.app !== BACKUP_APP || !obj.data) throw new Error('Το αρχείο δεν είναι αρχείο backup της εφαρμογής.');
  if (obj.format > BACKUP_FORMAT) throw new Error('Το αρχείο είναι από νεότερη έκδοση. Ανανέωσε πρώτα την εφαρμογή.');

  const inc = obj.data;
  const local = {};
  for (const s of DATA_STORES) local[s] = await db.getAll(s);

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
    if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) { writes.push(['days', 'put', d]); res.days++; }
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
  const staffNames = new Set(local.staff.map((s) => s.name));
  for (const s of inc.staff || []) if (!staffNames.has(s.name)) writes.push(['staff', 'put', s]);
  for (const t of tombs.values()) writes.push(['deleted', 'put', t]);

  await db.transaction(['visits', 'expenses', 'days', 'categories', 'staff', 'deleted', 'clients'], (tx) => {
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
