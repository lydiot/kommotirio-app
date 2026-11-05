// Αποθήκη: προϊόντα, απόθεμα, κόστη, λίστα παραγγελίας.
//
// Απόθεμα = υπολογίζεται από την ιστορία κινήσεων:
//   καταμέτρηση (count) → ορίζει το απόθεμα σε Χ     παραλαβή (receive) → +Χ (με κόστος αν υπάρχει τιμολόγιο)
//   χρήση (use) → −Χ   ·   πώληση (γραμμή μεταπώλησης στο Ταμείο) → −1
// Μέχρι την πρώτη καταμέτρηση ή παραλαβή, το απόθεμα είναι «άγνωστο» (?).
//
// Κόστος: σταθμισμένος μέσος όρος (avg) των παραλαβών με τιμή. Κάθε πώληση/χρήση παίρνει το κόστος
// που ίσχυε ΤΗ ΣΤΙΓΜΗ της κίνησης (avg → αλλιώς χειροκίνητο κόστος → αλλιώς τιμή καταλόγου).
// Έτσι, όταν αλλάζουν οι τιμές, το παλιό κέρδος δεν αλλάζει και το νέο υπολογίζεται με τη νέα τιμή.

import * as db from './db.js';

let H = null; // βοηθητικά από το app.js
export function initStock(helpers) { H = helpers; installPicker(); }
export const helpers = () => H;

export const normKey = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
const KIND = { retail: 'Μεταπώληση', use: 'Αναλώσιμο', both: 'Μεταπώληση & αναλώσιμο' };
const MOVE = { receive: 'Παραλαβή', use: 'Χρήση', count: 'Καταμέτρηση', sale: 'Πώληση' };
const dayTs = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const fDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('el-GR', { day: 'numeric', month: 'short', year: '2-digit' }); };
// Αυτόματα προϊόντα (από ελεύθερο κείμενο) παίρνουν id από το όνομα, ώστε δύο συσκευές να καταλήγουν στο ίδιο προϊόν.
export const autoId = (name) => `n:${normKey(name)}`;

// Αν ο χρήστης γράψει με ελληνικό πληκτρολόγιο ενώ ήθελε λατινικά («ινοα» αντί «inoa»), μετράει κι αυτό.
const GR = { α: 'a', β: 'b', ψ: 'c', δ: 'd', ε: 'e', φ: 'f', γ: 'g', η: 'h', ι: 'i', ξ: 'j', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 'w', τ: 't', θ: 'u', ω: 'v', χ: 'x', υ: 'y', ζ: 'z' };
const grToLat = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/./g, (c) => GR[c] || c);

// ---------------------------------------------------------------- υπολογισμός
let CACHE = null;
export const getCache = () => CACHE;

export async function loadStock() {
  const [products0, moves, days] = await Promise.all([db.getAll('products'), db.getAll('moves'), db.getAll('days')]);
  // Ονόματα από μεταπώληση/αναλώσιμα που δεν έγιναν ποτέ προϊόντα → δημιουργούνται τώρα.
  const products = [...products0];
  const known = new Set(products.map((p) => normKey(p.name)));
  const missing = [];
  for (const d of days) {
    for (const [list, kind] of [[d.retailItems, 'retail'], [d.useItems, 'use']]) {
      for (const it of list || []) {
        const k = normKey(it.product);
        if (!k || known.has(k)) continue;
        known.add(k);
        missing.push({ id: autoId(it.product), name: it.product, kind, code: '', size: '', cost: null, price: kind === 'retail' ? it.amount : null, min: 1, updatedAt: Date.now() });
      }
    }
  }
  if (missing.length) { await db.transaction(['products'], (tx) => missing.forEach((p) => tx.objectStore('products').put(p))); products.push(...missing); }

  const byId = new Map(products.map((p) => [p.id, { ...p, stock: 0, known: false, events: [], avg: null, lastCost: null, lastList: null, lastCostDate: null,
    _s: normKey([p.name, p.supplierName, p.code, p.ean, p.group, p.size].filter(Boolean).join(' ')).replace(/,/g, '.') }]));
  const byName = new Map(products.map((p) => [normKey(p.name), p.id]));
  const pidOf = (it) => (it.productId && byId.has(it.productId) ? it.productId : byName.get(normKey(it.product)));

  const ev = [];
  for (const m of moves) ev.push({ pid: m.productId, t: m.at || dayTs(m.date), date: m.date, type: m.type, qty: m.qty, uid: m.uid, note: m.note,
    cost: m.cost ?? null, listPrice: m.listPrice ?? null, disc: m.disc ?? null, inv: m.inv || '', supplier: m.supplier || '', key: `m|${m.uid}` });
  for (const d of days) for (const it of d.retailItems || []) {
    const pid = pidOf(it);
    // Πωλήσεις χωρίς ώρα (γράφτηκαν πριν την αποθήκη) → αρχή της μέρας.
    if (pid) ev.push({ pid, t: it.at || dayTs(d.date), date: d.date, type: 'sale', qty: 1, amount: it.amount, key: `s|${d.date}|${it.at || 0}|${pid}|${it.amount}` });
  }
  for (const d of days) for (const it of d.useItems || []) {
    const pid = pidOf(it);
    if (pid) ev.push({ pid, t: it.at || dayTs(d.date), date: d.date, type: 'use', qty: it.qty || 1, fromDay: true, key: `u|${d.date}|${it.at || 0}|${pid}` });
  }
  ev.sort((a, b) => a.t - b.t);

  const costs = new Map();
  for (const e of ev) {
    const P = byId.get(e.pid); if (!P) continue;
    if (e.type === 'count') { P.stock = e.qty; P.known = true; }
    else if (e.type === 'receive') {
      if (e.cost != null) {
        P.lastCost = e.cost; P.lastCostDate = e.date; if (e.listPrice != null) P.lastList = e.listPrice;
        // Σταθμισμένος μέσος όρος: ό,τι υπάρχει στο ράφι (στο παλιό κόστος) + ό,τι ήρθε (στο νέο).
        P.avg = P.known && P.stock > 0 && P.avg != null ? (P.stock * P.avg + e.qty * e.cost) / (P.stock + e.qty) : e.cost;
      }
      P.stock += e.qty; P.known = true;
    } else {
      e.cost = P.avg ?? P.cost ?? P.listCost ?? null;      // κόστος τη στιγμή της κίνησης (σε λεπτά)
      costs.set(e.key, e.cost);
      if (P.known) P.stock = Math.max(0, P.stock - e.qty); // δεν πέφτει κάτω από 0
    }
    P.events.push(e);
  }
  for (const P of byId.values()) P.unitCost = P.avg ?? P.cost ?? P.listCost ?? null;
  const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'el'));
  CACHE = { list, byId, byName, costs };
  return CACHE;
}

const isLow = (p) => p.known && p.stock <= (p.min ?? 1);
export async function lowStock() { return (CACHE || (await loadStock())).list.filter(isLow); }
export function productNames(kind) { return (CACHE?.list || []).filter((p) => !kind || p.kind === kind || p.kind === 'both').map((p) => p.name); }
export function productByName(name) { const id = CACHE?.byName.get(normKey(name)); return id ? CACHE.byId.get(id) : null; }

// Κόστος μιας πώλησης / χρήσης όπως ίσχυε τη στιγμή της (για τα Αποτελέσματα).
export function saleCost(date, it) {
  if (!CACHE) return null;
  const pid = (it.productId && CACHE.byId.has(it.productId)) ? it.productId : CACHE.byName.get(normKey(it.product));
  return pid ? (CACHE.costs.get(`s|${date}|${it.at || 0}|${pid}|${it.amount}`) ?? null) : null;
}
export function useCost(date, it) {
  if (!CACHE) return null;
  const pid = (it.productId && CACHE.byId.has(it.productId)) ? it.productId : CACHE.byName.get(normKey(it.product));
  return pid ? (CACHE.costs.get(`u|${date}|${it.at || 0}|${pid}`) ?? null) : null;
}
export const moveCost = (uid) => CACHE?.costs.get(`m|${uid}`) ?? null;

// ---------------------------------------------------------------- αναζήτηση προϊόντων
// Όλες οι λέξεις πρέπει να υπάρχουν (σε όποια σειρά) στο όνομα / κωδικό / barcode / ομάδα / μέγεθος.
export function searchProducts(q, { kind = null, limit = 8 } = {}) {
  const list = CACHE?.list || [];
  const nq = normKey(q).replace(/,/g, '.');
  if (!nq) return [];
  const toks = nq.split(' ');
  const alt = toks.map((t) => normKey(grToLat(t)));
  const out = [];
  for (const p of list) {
    const s = p._s;
    let ok = true;
    for (let i = 0; i < toks.length; i++) if (!s.includes(toks[i]) && !s.includes(alt[i])) { ok = false; break; }
    if (!ok) continue;
    const n = normKey(p.name).replace(/,/g, '.');
    // Πρώτα όσα ταιριάζουν στο ΟΝΟΜΑ· λέξεις που βρέθηκαν μόνο σε κωδικό/barcode/ομάδα βαραίνουν το σκορ.
    let score = 0;
    for (let i = 0; i < toks.length; i++) if (!n.includes(toks[i]) && !n.includes(alt[i])) score += 1;
    if (!(n.startsWith(toks[0]) || n.startsWith(alt[0]))) score += 0.4;
    if (kind && kind !== 'any' && p.kind !== kind && p.kind !== 'both') score += 0.5;
    if (p.known || p.events.length) score -= 0.3;
    out.push([score + n.length / 1000, p]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

// Αναδυόμενη λίστα προτάσεων κάτω από κάθε πεδίο με data-pk="retail|use|any". Η επιλογή γράφει το όνομα
// του προϊόντος στο πεδίο, βάζει data-pid και στέλνει τα συμβάντα «change» και «pkpick».
let pkList = null, pkInput = null;
function closePk() { pkList?.remove(); pkList = null; pkInput = null; }
function showPk(input) {
  const kind = input.dataset.pk;
  const q = input.value.trim();
  closePk();
  if (!q) return;
  const res = searchProducts(q, { kind });
  const ul = document.createElement('ul');
  ul.className = 'suggest pk-list';
  const e = (s) => H.esc(s);
  ul.innerHTML = res.map((p) => `<li><button class="pk-item" data-id="${p.id}"><b>${e(p.name)}</b>
      <small>${[KIND[p.kind], p.size, p.code, p.known ? `απόθεμα ${p.stock}` : ''].filter(Boolean).map(e).join(' · ')}</small></button></li>`).join('')
    + (res.length ? '' : '<li class="pk-none">Δεν υπάρχει στον κατάλογο — θα δημιουργηθεί νέο προϊόν με αυτό το όνομα</li>');
  const anchor = input.closest('[data-pk-row]') || input;
  anchor.after(ul);
  pkList = ul; pkInput = input;
}
function installPicker() {
  const onInput = (e) => { if (e.target.matches?.('[data-pk]')) { delete e.target.dataset.pid; showPk(e.target); } };
  document.addEventListener('input', onInput);
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('[data-pk]') && e.target.value.trim()) showPk(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target.matches?.('[data-pk]')) setTimeout(() => { if (pkInput === e.target) closePk(); }, 250); });
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.pk-item'); if (!b || !pkInput) return;
    e.preventDefault();
    const p = CACHE?.byId.get(b.dataset.id); const input = pkInput; if (!p) return;
    input.value = p.name; input.dataset.pid = p.id;
    closePk();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new CustomEvent('pkpick', { bubbles: true, detail: { product: p } }));
  });
}

// ---------------------------------------------------------------- δημιουργία / σύνδεση προϊόντων
async function linkItems(items, kind, learnPrice) {
  if (!CACHE) await loadStock();
  const now = Date.now(), created = [], patched = [];
  const out = items.map((it) => {
    if (!it.product) return it;
    let id = (it.productId && CACHE.byId.has(it.productId) && normKey(CACHE.byId.get(it.productId).name) === normKey(it.product)) ? it.productId : CACHE.byName.get(normKey(it.product));
    if (!id) {
      id = autoId(it.product);
      const p = { id, name: it.product, kind, code: '', size: '', cost: null, price: learnPrice ? it.amount : null, min: 1, updatedAt: now };
      created.push(p);
      CACHE.byName.set(normKey(p.name), id);
      CACHE.byId.set(id, { ...p, stock: 0, known: false, events: [], _s: normKey(p.name) });
    } else if (learnPrice) {
      // Πρώτη πώληση προϊόντος χωρίς τιμή πώλησης → η τιμή μαθαίνεται για την επόμενη φορά.
      const P = CACHE.byId.get(id);
      if (P.price == null && it.amount != null) { P.price = it.amount; const { stock, known, events, avg, lastCost, lastList, lastCostDate, unitCost, _s, ...base } = P; patched.push({ ...base, price: it.amount, updatedAt: now }); }
    }
    return { ...it, productId: id };
  });
  if (created.length || patched.length) await db.transaction(['products'], (tx) => [...created, ...patched].forEach((p) => tx.objectStore('products').put(p)));
  return out;
}
export const linkRetail = (items) => linkItems(items, 'retail', true);
export const linkUse = (items) => linkItems(items, 'use', false);

export async function addMove(productId, type, qty, extra = {}) {
  const now = Date.now();
  await db.put('moves', { uid: db.newUid(), productId, date: H.todayStr(), at: now, type, qty, ...extra, dev: H.device(), updatedAt: now });
}
const stripDerived = (P) => { const { stock, known, events, avg, lastCost, lastList, lastCostDate, unitCost, _s, ...base } = P; return base; };
async function saveProduct(p) { await db.put('products', { ...p, updatedAt: Date.now() }); }

// Ένωση προϊόντος που γράφτηκε ελεύθερα (from) με προϊόν του καταλόγου (to): όλες οι κινήσεις και οι γραμμές
// των ημερών περνούν στο «to», και το «from» διαγράφεται (με ίχνος, ώστε να φύγει και από την άλλη συσκευή).
export async function mergeProducts(fromId, toId) {
  if (!CACHE) await loadStock();
  const from = CACHE.byId.get(fromId), to = CACHE.byId.get(toId);
  if (!from || !to || fromId === toId) return 0;
  const now = Date.now(), fromKey = normKey(from.name);
  const [moves, days] = await Promise.all([db.getAll('moves'), db.getAll('days')]);
  const mv = moves.filter((m) => m.productId === fromId);
  const dd = [];
  for (const d of days) {
    let hit = false;
    const fix = (list) => (list || []).map((it) => {
      if (it.productId === fromId || normKey(it.product) === fromKey) { hit = true; return { ...it, productId: toId, product: to.name }; }
      return it;
    });
    const retailItems = fix(d.retailItems), useItems = fix(d.useItems);
    if (hit) dd.push({ ...d, ...(d.retailItems ? { retailItems } : {}), ...(d.useItems ? { useItems } : {}), updatedAt: now, dev: H.device() });
  }
  const patch = {};
  if (to.price == null && from.price != null) patch.price = from.price;
  await db.transaction(['moves', 'days', 'products', 'deleted'], (tx) => {
    mv.forEach((m) => tx.objectStore('moves').put({ ...m, productId: toId, updatedAt: now }));
    dd.forEach((d) => tx.objectStore('days').put(d));
    if (patch.price != null) tx.objectStore('products').put({ ...stripDerived(to), ...patch, updatedAt: now });
    tx.objectStore('products').delete(fromId);
    tx.objectStore('deleted').put({ uid: `prod:${fromId}`, store: 'products', date: null, deletedAt: now, dev: H.device() });
  });
  return mv.length + dd.length;
}

// ---------------------------------------------------------------- οθόνη Αποθήκη
const V = { q: '', filter: null, limit: 80 };

export async function renderStockTab(el) {
  const { list } = await loadStock();
  const low = list.filter(isLow);
  const big = list.length > 60;
  if (V.filter == null) V.filter = big ? 'active' : 'all';
  const q = normKey(V.q).replace(/,/g, '.');
  const toks = q ? q.split(' ') : [];
  const isActive = (p) => p.known || p.events.length > 0;
  const shown = toks.length ? searchProducts(V.q, { limit: 1000 })      // αναζήτηση: κατάταξη με βάση το όνομα, σε όλο τον κατάλογο
    : list.filter((p) => (V.filter === 'all' ? true
      : V.filter === 'active' ? isActive(p) : V.filter === 'low' ? isLow(p) : V.filter === 'unknown' ? !p.known : V.filter === 'nocode' ? !p.code && !p.ean : p.kind === V.filter || p.kind === 'both'));
  const noCode = list.filter((p) => !p.code && !p.ean).length;
  const { esc } = H;
  const rows = shown.slice(0, V.limit);
  el.innerHTML = `
    ${low.length ? `<div class="order-card">
      <div class="oc-head"><b>🛒 Να παραγγελθούν (${low.length})</b><button class="btn" data-act="st-share-order">📋 Στείλε τη λίστα</button></div>
      ${low.map((p) => `<button class="oc-item" data-act="st-open" data-id="${p.id}"><span>${esc(p.name)}${p.size ? ` <small>${esc(p.size)}</small>` : ''}</span><b>${p.stock <= 0 ? 'τελείωσε' : `έμειναν ${p.stock}`}</b></button>`).join('')}
    </div>` : ''}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-act="st-receive">＋ Τιμολόγιο / Παραλαβή</button>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn" data-act="st-invoices">📄 Τιμολόγια</button>
      <button class="btn" data-act="st-new">＋ Νέο προϊόν</button>
    </div>
    <input class="input" data-st="q" placeholder="Αναζήτηση: όνομα, κωδικός, barcode…" autocomplete="off" value="${esc(V.q)}" style="margin-top:12px">
    <div class="chips st-filter" style="margin-top:10px">
      ${[['active', 'Στο ράφι'], ['all', `Όλα (${list.length})`], ['retail', 'Μεταπώληση'], ['use', 'Αναλώσιμα'], ['low', 'Χαμηλό'], ['unknown', 'Χωρίς απόθεμα'], ...(noCode && big ? [['nocode', `Εκτός καταλόγου (${noCode})`]] : [])]
        .map(([k, l]) => `<button class="chip ${V.filter === k && !toks.length ? 'on' : ''}" data-act="st-filter" data-v="${k}">${l}</button>`).join('')}
    </div>
    <h2>${toks.length ? 'Αποτελέσματα αναζήτησης' : 'Προϊόντα'} (${shown.length})</h2>
    <div class="list">${rows.map((p) => `
      <div class="st-row">
        <button class="st-main" data-act="st-open" data-id="${p.id}">
          <div class="title">${esc(p.name)}</div>
          <div class="sub">${KIND[p.kind] || ''}${p.size ? ` · ${esc(p.size)}` : ''}${p.code ? ` · ${esc(p.code)}` : ''}${p.unitCost != null ? ` · κόστος ${H.fmt(Math.round(p.unitCost))}` : ''}</div>
          ${!p.known && p.events.length ? `<div class="sub st-act">${activity(p)} · χωρίς καταμέτρηση</div>` : ''}
        </button>
        <span class="st-qty ${isLow(p) ? 'low' : ''}" title="Απόθεμα">${p.known ? p.stock : '?'}</span>
      </div>`).join('') || `<div class="empty">${list.length ? (V.filter === 'active' && !toks.length ? 'Δεν υπάρχουν ακόμα κινήσεις. Ψάξε ένα προϊόν από το πεδίο αναζήτησης ή πάτα «Τιμολόγιο / Παραλαβή».' : 'Κανένα προϊόν με αυτά τα φίλτρα.') : 'Δεν υπάρχουν ακόμα προϊόντα. Πάτα «＋ Νέο προϊόν» ή κάνε εισαγωγή καταλόγου (⚙︎ → Εισαγωγή αρχείου). Τα προϊόντα που γράφονται στη μεταπώληση μπαίνουν αυτόματα.'}</div>`}
    </div>
    ${shown.length > rows.length ? `<button class="btn" data-act="st-more" style="margin-top:10px">Δείξε κι άλλα (${shown.length - rows.length})</button>` : ''}
    <p class="note">Απόθεμα τώρα, για όλες τις μέρες μαζί. Αφαιρούνται αυτόματα η μεταπώληση και τα αναλώσιμα που γράφονται στο Ταμείο κάθε ημέρας.
      «?» = δεν έχει γίνει ακόμα καταμέτρηση ή παραλαβή. Το κόστος προκύπτει από τα τιμολόγια παραλαβής.</p>`;

  el.onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, P = b.dataset.id && CACHE.byId.get(b.dataset.id);
    if (act === 'st-filter') { V.filter = b.dataset.v; V.q = ''; V.limit = 80; renderStockTab(el); }
    if (act === 'st-more') { V.limit += 100; renderStockTab(el); }
    if (act === 'st-open') openProduct(P, el);
    if (act === 'st-new') openProduct(null, el);
    if (act === 'st-receive') (await import('./invoice.js')).openInvoice(el);
    if (act === 'st-invoices') (await import('./invoice.js')).openInvoices(el);
    if (act === 'st-share-order') shareOrder(low);
  };
  el.oninput = (e) => {
    if (e.target.dataset.st === 'q') {
      V.q = e.target.value; V.limit = 80;
      clearTimeout(el._t);
      el._t = setTimeout(() => renderStockTab(el).then(() => { const i = el.querySelector('[data-st=q]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 200);
    }
  };
}

// «2 πωλήσεις · 3 χρήσεις» — για προϊόντα χωρίς καταμέτρηση, ώστε να φαίνεται η κίνηση.
function activity(p) {
  const sold = p.events.filter((e) => e.type === 'sale').length, used = p.events.filter((e) => e.type === 'use').reduce((a, e) => a + e.qty, 0);
  return [sold && `${sold} ${sold === 1 ? 'πώληση' : 'πωλήσεις'}`, used && `${used} ${used === 1 ? 'χρήση' : 'χρήσεις'}`].filter(Boolean).join(' · ');
}

export async function afterChange(el, pid, msg) {
  await loadStock();
  const P = pid ? CACHE.byId.get(pid) : null;
  if (msg) H.toast(P && isLow(P) ? `${msg} · ⚠️ ${P.stock <= 0 ? 'τελείωσε' : `έμειναν ${P.stock}`} — μπήκε στη λίστα παραγγελίας` : `${msg}${P?.known ? ` · απόθεμα ${P.stock}` : ''}`);
  if (el) await renderStockTab(el);
  H.onChange?.();
}

async function shareOrder(low) {
  const text = `Παραγγελία:\n${low.map((p) => `• ${p.name}${p.size ? ` (${p.size})` : ''}${p.code ? ` [${p.code}]` : ''}`).join('\n')}`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (err) { if (err?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); H.toast('Η λίστα αντιγράφηκε — επικόλλησέ τη στο Viber'); }
  catch { prompt('Αντίγραψε τη λίστα:', text); }
}

// ---------------------------------------------------------------- καρτέλα προϊόντος
function openProduct(P, el) {
  const { esc, fmt, parseMoney, toInput } = H;
  const F = P ? stripDerived(P) : { id: db.newUid(), name: '', kind: 'both', code: '', size: '', cost: null, price: null, min: 1 };
  const since30 = Date.now() - 30 * 86400000;
  const ev = P ? P.events : [];
  const sold30 = ev.filter((e) => e.type === 'sale' && e.t >= since30).length, used30 = ev.filter((e) => e.type === 'use' && e.t >= since30).reduce((a, e) => a + e.qty, 0);
  const buys = ev.filter((e) => e.type === 'receive' && e.cost != null);
  const c = (v) => (v == null ? '—' : fmt(Math.round(v)));
  H.openSheet({
    title: P ? P.name : 'Νέο προϊόν',
    body: `
      ${P ? `<div class="st-stock ${isLow(P) ? 'low' : ''}"><span>Απόθεμα</span><b>${P.known ? P.stock : '?'}</b>
          <small>${P.known ? (isLow(P) ? 'να παραγγελθεί' : '') : 'κάνε καταμέτρηση για να ξεκινήσει'}</small></div>
        <div class="st-actions">
          <button class="btn danger" data-act="p-out">Τελείωσε</button>
          <button class="btn" data-act="p-receive">＋ Παραλαβή</button>
          <button class="btn" data-act="p-count">Καταμέτρηση</button>
          ${!P.code && !P.ean ? '<button class="btn" data-act="p-merge">🔗 Ένωση με κατάλογο</button>' : ''}
        </div>
        <p class="note">Τελευταίες 30 μέρες: ${sold30} πωλήσεις · ${used30} χρήσεις. Χρήσεις γράφονται στο Ταμείο → Αναλώσιμα ημέρας.</p>
        <div class="card" style="margin-top:8px">
          <div class="kv"><span>Τιμή καταλόγου (χωρίς ΦΠΑ)</span><span>${c(P.listCost)}</span></div>
          <div class="kv"><span>Τελευταία αγορά (καθαρή)</span><span>${c(P.lastCost)}${P.lastCostDate ? ` · ${fDate(P.lastCostDate)}` : ''}</span></div>
          <div class="kv"><span>Μέσο κόστος στο ράφι</span><span>${c(P.avg)}</span></div>
          ${P.price != null ? `<div class="kv"><span>Τιμή πώλησης</span><span>${fmt(P.price)}</span></div>` : ''}
          ${P.price != null && P.unitCost != null ? `<div class="kv"><span>Περιθώριο ανά τεμάχιο</span><span>${fmt(Math.round(P.price - P.unitCost))}</span></div>` : ''}
        </div>` : ''}
      <h2>Στοιχεία</h2>
      <label class="field"><span class="lbl">Όνομα</span><input class="input" data-f="name" autocapitalize="sentences" value="${esc(F.name)}"></label>
      <label class="field"><span class="lbl">Είδος</span><select class="input" data-f="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${F.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Κωδικός</span><input class="input" data-f="code" value="${esc(F.code || '')}"></label>
        <label class="field"><span class="lbl">Μέγεθος</span><input class="input" data-f="size" placeholder="π.χ. 250 ml" value="${esc(F.size || '')}"></label>
      </div>
      <div class="grid2" style="margin-top:14px">
        <label class="field"><span class="lbl">Κόστος (αν δεν υπάρχει τιμολόγιο)</span><span class="money"><input class="input" data-f="cost" inputmode="decimal" value="${toInput(F.cost)}" placeholder="0"><span class="cur">€</span></span></label>
        <label class="field"><span class="lbl">Τιμή πώλησης</span><span class="money"><input class="input" data-f="price" inputmode="decimal" value="${toInput(F.price)}" placeholder="—"><span class="cur">€</span></span></label>
      </div>
      <label class="field" style="margin-top:14px"><span class="lbl">Ειδοποίηση όταν μείνουν (ή λιγότερα)</span>
        <input class="input" data-f="min" inputmode="numeric" value="${F.min ?? 1}"></label>
      ${F.group || F.ean ? `<p class="note">${[F.group, F.ean && `barcode ${F.ean}`].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
      ${buys.length ? `<h2>Ιστορικό τιμών αγοράς</h2><div class="list">${[...buys].reverse().slice(0, 12).map((e, i, a) => {
        const prev = a[i + 1], d = prev ? ((e.cost - prev.cost) / prev.cost) * 100 : null;
        return `<div class="row st-ev"><span class="main"><div class="title" style="font-weight:500">${fDate(e.date)}${e.inv ? ` · ${esc(e.inv)}` : ''}</div><div class="sub">${e.qty} τεμ.${e.disc ? ` · έκπτωση ${String(e.disc).replace('.', ',')}%` : ''}</div></span>
          <span class="amt">${fmt(Math.round(e.cost))}${d != null && Math.abs(d) >= 0.5 ? ` <small class="${d > 0 ? 'bad' : 'ok'}">${d > 0 ? '▲' : '▼'}${Math.abs(Math.round(d))}%</small>` : ''}</span></div>`;
      }).join('')}</div>` : ''}
      ${P && ev.length ? `<h2>Ιστορικό κινήσεων</h2><div class="list">${[...ev].reverse().slice(0, 25).map((e) => `
        <div class="row st-ev"><span class="main"><div class="title" style="font-weight:500">${MOVE[e.type]}${e.note ? ` · ${esc(e.note)}` : ''}${e.inv ? ` · ${esc(e.inv)}` : ''}</div><div class="sub">${fDate(e.date)}</div></span>
          <span class="amt">${e.type === 'count' ? `= ${e.qty}` : e.type === 'receive' ? `+${e.qty}` : `−${e.qty}`}</span>
          ${e.uid && e.type !== 'use' && !e.inv ? `<button class="item-x" data-act="p-undo" data-uid="${e.uid}" data-date="${e.date}" aria-label="Αναίρεση">✕</button>` : ''}</div>`).join('')}</div>
        <p class="note">Πωλήσεις και αναλώσιμα διορθώνονται από το Ταμείο της αντίστοιχης ημέρας. Παραλαβές με τιμολόγιο διορθώνονται από «📄 Τιμολόγια».</p>` : ''}`,
    foot: `<div class="btn-row">${P ? '<button class="btn danger" data-act="p-delete">Διαγραφή</button>' : ''}<button class="btn primary" data-act="p-save">Αποθήκευση</button></div>`,
    onInput(t) { const f = t.dataset.f; if (f) F[f] = t.value; },
    onChange(t) { const f = t.dataset.f; if (f) F[f] = t.value; },
    async onAction(act, b) {
      const reopen = async (msg) => { await afterChange(el, F.id, msg); const np = CACHE.byId.get(F.id); if (np) openProduct(np, el); };
      if (act === 'p-out') { if (!confirm(`«${F.name}» τελείωσε;\nΤο απόθεμα γίνεται 0 και μπαίνει στη λίστα παραγγελίας.`)) return; await addMove(F.id, 'count', 0, { note: 'τελείωσε' }); return reopen(`${F.name}: τελείωσε`); }
      if (act === 'p-receive') { H.closeSheet(); return (await import('./invoice.js')).openInvoice(el, { product: CACHE.byId.get(F.id) }); }
      if (act === 'p-merge') { return openMerge(CACHE.byId.get(F.id), el); }
      if (act === 'p-count') {
        const v = prompt(`Πόσα τεμάχια «${F.name}» υπάρχουν τώρα;`);
        if (v == null) return;
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return H.toast('Γράψε έναν αριθμό');
        await addMove(F.id, 'count', n);
        return reopen(`${F.name}: καταμέτρηση ${n}`);
      }
      if (act === 'p-undo') {
        if (!confirm('Αναίρεση αυτής της κίνησης;')) return;
        await db.transaction(['moves', 'deleted'], (tx) => {
          tx.objectStore('moves').delete(b.dataset.uid);
          tx.objectStore('deleted').put({ uid: b.dataset.uid, store: 'moves', date: b.dataset.date, deletedAt: Date.now(), dev: H.device() });
        });
        return reopen('Αναιρέθηκε');
      }
      if (act === 'p-save') {
        const name = H.cleanName(F.name);
        if (!name) return H.toast('Γράψε όνομα');
        const other = CACHE.byName.get(normKey(name));
        if (other && other !== F.id) return H.toast('Υπάρχει ήδη προϊόν με αυτό το όνομα');
        const cost = typeof F.cost === 'string' ? parseMoney(F.cost) : F.cost, price = typeof F.price === 'string' ? parseMoney(F.price) : F.price;
        if (Number.isNaN(cost) || Number.isNaN(price)) return H.toast('Μη έγκυρο ποσό');
        const min = parseInt(F.min, 10);
        await saveProduct({ ...F, name, cost, price, min: Number.isFinite(min) && min >= 0 ? min : 1 });
        H.closeSheet();
        await afterChange(el, F.id, P ? 'Αποθηκεύτηκε' : `Προστέθηκε: ${name}`);
      }
      if (act === 'p-delete') {
        if (!confirm(`Διαγραφή του «${F.name}» από την αποθήκη;\n\nΟι παλιές πωλήσεις στη μεταπώληση μένουν όπως είναι.`)) return;
        await db.transaction(['products', 'deleted'], (tx) => {
          tx.objectStore('products').delete(F.id);
          tx.objectStore('deleted').put({ uid: `prod:${F.id}`, store: 'products', date: null, deletedAt: Date.now(), dev: H.device() });
        });
        H.closeSheet();
        await afterChange(el, F.id, 'Διαγράφηκε');
      }
    },
  });
}

// Ένωση ελεύθερου προϊόντος με προϊόν του καταλόγου.
function openMerge(P, el) {
  const { esc } = H;
  let target = null;
  H.openSheet({
    title: `Ένωση: ${P.name}`,
    body: `<p class="note" style="margin-top:0">Βρες το σωστό προϊόν του καταλόγου. Όλες οι πωλήσεις, οι χρήσεις και οι παραλαβές του «${esc(P.name)}» θα περάσουν σε αυτό, και το «${esc(P.name)}» θα φύγει.</p>
      <div data-pk-row><input class="input" id="mg-q" data-pk="any" placeholder="Όνομα, κωδικός ή barcode του καταλόγου" autocomplete="off"></div>
      <div id="mg-pick" style="margin-top:12px"></div>`,
    foot: '<button class="btn primary big" data-act="mg-do" id="mg-btn" disabled>Ένωση</button>',
    onInput() { target = null; document.getElementById('mg-btn').disabled = true; document.getElementById('mg-pick').innerHTML = ''; },
    async onAction(act) {
      if (act !== 'mg-do' || !target) return;
      if (!confirm(`Ένωση του «${P.name}» με το «${target.name}»;\nΔεν αναιρείται.`)) return;
      const n = await mergeProducts(P.id, target.id);
      H.closeSheet();
      await afterChange(el, target.id, `Ενώθηκε με «${target.name}» (${n} ${n === 1 ? 'εγγραφή' : 'εγγραφές'})`);
    },
  });
  const onPick = (e) => {
    if (e.target.id !== 'mg-q') return;
    target = e.detail.product;
    document.getElementById('mg-btn').disabled = false;
    document.getElementById('mg-pick').innerHTML = `<div class="card"><b>${esc(target.name)}</b><div class="note" style="margin:4px 0 0">${[target.size, target.code, target.group].filter(Boolean).map(esc).join(' · ')}</div></div>`;
  };
  document.addEventListener('pkpick', onPick, { once: false });
  const obs = new MutationObserver(() => { if (!document.getElementById('mg-q')) { document.removeEventListener('pkpick', onPick); obs.disconnect(); } });
  obs.observe(document.getElementById('sheet'), { childList: true, subtree: true });
}
