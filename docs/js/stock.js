// Αποθήκη: προϊόντα, απόθεμα, παραλαβές, χρήσεις, «τελείωσε», λίστα παραγγελίας.
//
// Απόθεμα = υπολογίζεται από την ιστορία:
//   καταμέτρηση (count)  → ορίζει το απόθεμα σε Χ
//   παραλαβή (receive)   → +Χ
//   χρήση (use)          → −Χ   (αναλώσιμα που άνοιξαν / χρησιμοποιήθηκαν)
//   πώληση               → −1   (κάθε γραμμή μεταπώλησης στο Ταμείο με αυτό το προϊόν)
// Μέχρι την πρώτη καταμέτρηση ή παραλαβή, το απόθεμα είναι «άγνωστο» (?).

import * as db from './db.js';

let H = null; // βοηθητικά από το app.js: { $, esc, fmt, parseMoney, toInput, cleanName, todayStr, openSheet, closeSheet, toast, device, onChange }
export function initStock(helpers) { H = helpers; }

export const normKey = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
const KIND = { retail: 'Μεταπώληση', use: 'Αναλώσιμο', both: 'Μεταπώληση & αναλώσιμο' };
const MOVE = { receive: 'Παραλαβή', use: 'Χρήση', count: 'Καταμέτρηση', sale: 'Πώληση' };
const dayTs = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const fDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('el-GR', { day: 'numeric', month: 'short' }); };

// ---------------------------------------------------------------- υπολογισμός
let CACHE = null;
export async function loadStock() {
  const [products0, moves, days] = await Promise.all([db.getAll('products'), db.getAll('moves'), db.getAll('days')]);
  // Ονόματα από μεταπώληση/αναλώσιμα που δεν έγιναν ποτέ προϊόν (π.χ. γράφτηκαν πριν την αποθήκη) → δημιουργούνται τώρα.
  const products = [...products0];
  const known = new Set(products.map((p) => normKey(p.name)));
  const missing = [];
  for (const d of days) {
    for (const [list, kind] of [[d.retailItems, 'retail'], [d.useItems, 'use']]) {
      for (const it of list || []) {
        const k = normKey(it.product);
        if (!k || known.has(k)) continue;
        known.add(k);
        missing.push({ id: db.newUid(), name: it.product, kind, code: '', size: '', cost: null, price: kind === 'retail' ? it.amount : null, min: 1, updatedAt: Date.now() });
      }
    }
  }
  if (missing.length) { await db.transaction(['products'], (tx) => missing.forEach((p) => tx.objectStore('products').put(p))); products.push(...missing); }
  const byId = new Map(products.map((p) => [p.id, { ...p, stock: 0, known: false, events: [] }]));
  const byName = new Map(products.map((p) => [normKey(p.name), p.id]));
  const ev = [];
  for (const m of moves) ev.push({ pid: m.productId, t: m.at || dayTs(m.date), date: m.date, type: m.type, qty: m.qty, uid: m.uid, note: m.note });
  for (const d of days) for (const it of d.retailItems || []) {
    const pid = it.productId && byId.has(it.productId) ? it.productId : byName.get(normKey(it.product));
    // Πωλήσεις χωρίς ώρα (γράφτηκαν πριν την αποθήκη) → αρχή της μέρας, ώστε μια καταμέτρηση της ίδιας μέρας να τις «περιέχει».
    if (pid) ev.push({ pid, t: it.at || dayTs(d.date), date: d.date, type: 'sale', qty: 1, amount: it.amount });
  }
  for (const d of days) for (const it of d.useItems || []) {
    const pid = it.productId && byId.has(it.productId) ? it.productId : byName.get(normKey(it.product));
    if (pid) ev.push({ pid, t: it.at || dayTs(d.date), date: d.date, type: 'use', qty: it.qty || 1, fromDay: true });
  }
  ev.sort((a, b) => a.t - b.t);
  for (const e of ev) {
    const P = byId.get(e.pid); if (!P) continue;
    P.events.push(e);
    if (e.type === 'count') { P.stock = e.qty; P.known = true; }
    else if (e.type === 'receive') { P.stock += e.qty; P.known = true; }
    else if (P.known) P.stock = Math.max(0, P.stock - e.qty); // δεν πέφτει κάτω από 0
  }
  const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'el'));
  CACHE = { list, byId, byName };
  return CACHE;
}
const isLow = (p) => p.known && p.stock <= (p.min ?? 1);
export async function lowStock() { return (CACHE || (await loadStock())).list.filter(isLow); }
export function productNames(kind) {
  return (CACHE?.list || []).filter((p) => !kind || p.kind === kind || p.kind === 'both').map((p) => p.name);
}
export function productByName(name) { const id = CACHE?.byName.get(normKey(name)); return id ? CACHE.byId.get(id) : null; }

// Συνδέει τις γραμμές μεταπώλησης με προϊόντα. Άγνωστο όνομα → νέο προϊόν «μεταπώληση» (απόθεμα άγνωστο).
export async function linkRetail(items) {
  if (!CACHE) await loadStock();
  const now = Date.now(), created = [];
  const out = items.map((it) => {
    if (!it.product) return it;
    let id = CACHE.byName.get(normKey(it.product));
    if (!id) {
      id = db.newUid();
      const p = { id, name: it.product, kind: 'retail', code: '', size: '', cost: null, price: it.amount, min: 1, updatedAt: now };
      created.push(p);
      CACHE.byName.set(normKey(p.name), id);
      CACHE.byId.set(id, { ...p, stock: 0, known: false, events: [] });
    }
    return { ...it, productId: id };
  });
  if (created.length) await db.transaction(['products'], (tx) => created.forEach((p) => tx.objectStore('products').put(p)));
  return out;
}

// Αναλώσιμα ημέρας → σύνδεση με προϊόν (άγνωστο όνομα → νέο προϊόν «αναλώσιμο»).
export async function linkUse(items) {
  if (!CACHE) await loadStock();
  const now = Date.now(), created = [];
  const out = items.map((it) => {
    let id = CACHE.byName.get(normKey(it.product));
    if (!id) {
      id = db.newUid();
      const p = { id, name: it.product, kind: 'use', code: '', size: '', cost: null, price: null, min: 1, updatedAt: now };
      created.push(p);
      CACHE.byName.set(normKey(p.name), id);
      CACHE.byId.set(id, { ...p, stock: 0, known: false, events: [] });
    }
    return { ...it, productId: id };
  });
  if (created.length) await db.transaction(['products'], (tx) => created.forEach((p) => tx.objectStore('products').put(p)));
  return out;
}

async function addMove(productId, type, qty, extra = {}) {
  const now = Date.now();
  await db.put('moves', { uid: db.newUid(), productId, date: H.todayStr(), at: now, type, qty, ...extra, dev: H.device(), updatedAt: now });
}
async function saveProduct(p) { await db.put('products', { ...p, updatedAt: Date.now() }); }

// ---------------------------------------------------------------- οθόνη Αποθήκη
const V = { q: '', filter: 'all' };

export async function renderStockTab(el) {
  const { list } = await loadStock();
  const low = list.filter(isLow);
  const q = normKey(V.q);
  const shown = list.filter((p) => (!q || normKey(`${p.name} ${p.code || ''}`).includes(q))
    && (V.filter === 'all' || (V.filter === 'low' ? isLow(p) : V.filter === 'unknown' ? !p.known : p.kind === V.filter || p.kind === 'both')));
  const { esc } = H;
  el.innerHTML = `
    ${low.length ? `<div class="order-card">
      <div class="oc-head"><b>🛒 Να παραγγελθούν (${low.length})</b><button class="btn" data-act="st-share-order">📋 Στείλε τη λίστα</button></div>
      ${low.map((p) => `<button class="oc-item" data-act="st-open" data-id="${p.id}"><span>${esc(p.name)}${p.size ? ` <small>${esc(p.size)}</small>` : ''}</span><b>${p.stock <= 0 ? 'τελείωσε' : `έμειναν ${p.stock}`}</b></button>`).join('')}
    </div>` : ''}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-act="st-receive">＋ Παραλαβή</button>
      <button class="btn" data-act="st-new">＋ Νέο προϊόν</button>
    </div>
    <input class="input" data-st="q" placeholder="Αναζήτηση προϊόντος…" autocomplete="off" value="${esc(V.q)}" style="margin-top:12px">
    <div class="chips st-filter" style="margin-top:10px">
      ${[['all', 'Όλα'], ['retail', 'Μεταπώληση'], ['use', 'Αναλώσιμα'], ['low', 'Χαμηλό'], ['unknown', 'Χωρίς απόθεμα']].map(([k, l]) => `<button class="chip ${V.filter === k ? 'on' : ''}" data-act="st-filter" data-v="${k}">${l}</button>`).join('')}
    </div>
    <h2>Προϊόντα (${shown.length})</h2>
    <div class="list">${shown.map((p) => `
      <div class="st-row">
        <button class="st-main" data-act="st-open" data-id="${p.id}">
          <div class="title">${esc(p.name)}</div>
          <div class="sub">${KIND[p.kind] || ''}${p.size ? ` · ${esc(p.size)}` : ''}${p.code ? ` · ${esc(p.code)}` : ''}</div>
          ${!p.known && p.events.length ? `<div class="sub st-act">${activity(p)} · χωρίς καταμέτρηση</div>` : ''}
        </button>
        <span class="st-qty ${isLow(p) ? 'low' : ''}" title="Απόθεμα">${p.known ? p.stock : '?'}</span>
      </div>`).join('') || `<div class="empty">${list.length ? 'Κανένα προϊόν με αυτά τα φίλτρα.' : 'Δεν υπάρχουν ακόμα προϊόντα. Πάτα «＋ Νέο προϊόν» ή κάνε εισαγωγή καταλόγου (⚙︎ → Εισαγωγή αρχείου). Τα προϊόντα που γράφονται στη μεταπώληση μπαίνουν αυτόματα.'}</div>`}
    </div>
    <p class="note">Απόθεμα τώρα, για όλες τις μέρες μαζί. Αφαιρούνται αυτόματα η μεταπώληση και τα αναλώσιμα που γράφονται στο Ταμείο κάθε ημέρας.
      «?» = δεν έχει γίνει ακόμα καταμέτρηση ή παραλαβή.</p>`;

  el.onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, P = b.dataset.id && CACHE.byId.get(b.dataset.id);
    if (act === 'st-filter') { V.filter = b.dataset.v; renderStockTab(el); }
    if (act === 'st-open') openProduct(P, el);
    if (act === 'st-new') openProduct(null, el);
    if (act === 'st-receive') openReceive(el);
    if (act === 'st-share-order') shareOrder(low);
    if (act === 'st-use') {
      if (!P.known && !confirm(`Δεν έχει γίνει ακόμα καταμέτρηση για «${P.name}».\nΝα καταγραφεί η χρήση ούτως ή άλλως;`)) return;
      await addMove(P.id, 'use', 1);
      await afterChange(el, P.id, `−1 ${P.name}`);
    }
  };
  el.oninput = (e) => {
    if (e.target.dataset.st === 'q') {
      V.q = e.target.value;
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

async function afterChange(el, pid, msg) {
  await loadStock();
  const P = CACHE.byId.get(pid);
  H.toast(P && isLow(P) ? `${msg} · ⚠️ ${P.stock <= 0 ? 'τελείωσε' : `έμειναν ${P.stock}`} — μπήκε στη λίστα παραγγελίας` : `${msg}${P?.known ? ` · απόθεμα ${P.stock}` : ''}`);
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
  const F = P ? { ...P } : { id: db.newUid(), name: '', kind: 'both', code: '', size: '', cost: null, price: null, min: 1 };
  const since30 = Date.now() - 30 * 86400000;
  const ev = P ? P.events : [];
  const sold30 = ev.filter((e) => e.type === 'sale' && e.t >= since30).length, used30 = ev.filter((e) => e.type === 'use' && e.t >= since30).reduce((a, e) => a + e.qty, 0);
  H.openSheet({
    title: P ? P.name : 'Νέο προϊόν',
    body: `
      ${P ? `<div class="st-stock ${isLow(P) ? 'low' : ''}"><span>Απόθεμα</span><b>${P.known ? P.stock : '?'}</b>
          <small>${P.known ? (isLow(P) ? 'να παραγγελθεί' : '') : 'κάνε καταμέτρηση για να ξεκινήσει'}</small></div>
        <div class="st-actions">
          <button class="btn danger" data-act="p-out">Τελείωσε</button>
          <button class="btn" data-act="p-receive">＋ Παραλαβή</button>
          <button class="btn" data-act="p-count">Καταμέτρηση</button>
        </div>
        <p class="note">Τελευταίες 30 μέρες: ${sold30} πωλήσεις · ${used30} χρήσεις. Χρήσεις γράφονται στο Ταμείο → Αναλώσιμα ημέρας.</p>` : ''}
      <h2>Στοιχεία</h2>
      <label class="field"><span class="lbl">Όνομα</span><input class="input" data-f="name" autocapitalize="sentences" value="${esc(F.name)}"></label>
      <label class="field"><span class="lbl">Είδος</span><select class="input" data-f="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${F.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Κωδικός</span><input class="input" data-f="code" value="${esc(F.code || '')}"></label>
        <label class="field"><span class="lbl">Μέγεθος</span><input class="input" data-f="size" placeholder="π.χ. 250 ml" value="${esc(F.size || '')}"></label>
      </div>
      <div class="grid2" style="margin-top:14px">
        <label class="field"><span class="lbl">Τιμή αγοράς</span><span class="money"><input class="input" data-f="cost" inputmode="decimal" value="${toInput(F.cost)}" placeholder="0"><span class="cur">€</span></span></label>
        <label class="field"><span class="lbl">Τιμή πώλησης</span><span class="money"><input class="input" data-f="price" inputmode="decimal" value="${toInput(F.price)}" placeholder="—"><span class="cur">€</span></span></label>
      </div>
      <label class="field" style="margin-top:14px"><span class="lbl">Ειδοποίηση όταν μείνουν (ή λιγότερα)</span>
        <input class="input" data-f="min" inputmode="numeric" value="${F.min ?? 1}"></label>
      ${P && ev.length ? `<h2>Ιστορικό</h2><div class="list">${[...ev].reverse().slice(0, 25).map((e) => `
        <div class="row st-ev"><span class="main"><div class="title" style="font-weight:500">${MOVE[e.type]}${e.note ? ` · ${esc(e.note)}` : ''}</div><div class="sub">${fDate(e.date)}</div></span>
          <span class="amt">${e.type === 'count' ? `= ${e.qty}` : e.type === 'receive' ? `+${e.qty}` : `−${e.qty}`}</span>
          ${e.uid && e.type !== 'use' ? `<button class="item-x" data-act="p-undo" data-uid="${e.uid}" data-date="${e.date}" aria-label="Αναίρεση">✕</button>` : ''}</div>`).join('')}</div>
        <p class="note">Πωλήσεις και αναλώσιμα διορθώνονται από το Ταμείο της αντίστοιχης ημέρας.</p>` : ''}`,
    foot: `<div class="btn-row">${P ? '<button class="btn danger" data-act="p-delete">Διαγραφή</button>' : ''}<button class="btn primary" data-act="p-save">Αποθήκευση</button></div>`,
    onInput(t) { const f = t.dataset.f; if (f) F[f] = t.value; },
    onChange(t) { const f = t.dataset.f; if (f) F[f] = t.value; },
    async onAction(act, b) {
      const reopen = async (msg) => { await afterChange(el, F.id, msg); const np = CACHE.byId.get(F.id); if (np) openProduct(np, el); };
      if (act === 'p-out') { if (!confirm(`«${F.name}» τελείωσε;\nΤο απόθεμα γίνεται 0 και μπαίνει στη λίστα παραγγελίας.`)) return; await addMove(F.id, 'count', 0, { note: 'τελείωσε' }); return reopen(`${F.name}: τελείωσε`); }
      if (act === 'p-receive' || act === 'p-count') {
        const v = prompt(act === 'p-receive' ? `Πόσα τεμάχια «${F.name}» παραλήφθηκαν;` : `Πόσα τεμάχια «${F.name}» υπάρχουν τώρα;`);
        if (v == null) return;
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return H.toast('Γράψε έναν αριθμό');
        await addMove(F.id, act === 'p-receive' ? 'receive' : 'count', n);
        return reopen(act === 'p-receive' ? `+${n} ${F.name}` : `${F.name}: καταμέτρηση ${n}`);
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
        const { stock, known, events, ...clean } = F;
        await saveProduct({ ...clean, name, cost, price, min: Number.isFinite(min) && min >= 0 ? min : 1 });
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

// ---------------------------------------------------------------- παραλαβή (πολλές γραμμές)
function openReceive(el) {
  const { esc } = H;
  const row = () => `<div class="rcv-row">
    <input class="input" data-r="name" list="st-products" placeholder="Προϊόν" autocomplete="off" autocapitalize="sentences">
    <input class="input" data-r="qty" inputmode="numeric" placeholder="Τεμ.">
    <span class="money"><input class="input" data-r="cost" inputmode="decimal" placeholder="Τιμή/τεμ."><span class="cur">€</span></span>
    <button class="item-x" data-act="rcv-rm" aria-label="Αφαίρεση">✕</button></div>`;
  H.openSheet({
    title: 'Παραλαβή εμπορευμάτων',
    body: `
      <p class="note" style="margin-top:0">Μία γραμμή για κάθε προϊόν. Η τιμή αγοράς είναι προαιρετική (ενημερώνει το κόστος του προϊόντος).
        Νέο όνομα → δημιουργείται νέο προϊόν.</p>
      <label class="field"><span class="lbl">Ημερομηνία παραλαβής</span><input class="input" type="date" id="rcv-date" value="${H.todayStr()}"></label>
      <div id="rcv-rows">${row()}${row()}${row()}</div>
      <button class="btn" data-act="rcv-add">＋ Γραμμή</button>
      <datalist id="st-products">${productNames().map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`,
    foot: '<button class="btn primary big" data-act="rcv-save">Καταχώρηση παραλαβής</button>',
    async onAction(act, b) {
      if (act === 'rcv-add') { document.getElementById('rcv-rows').insertAdjacentHTML('beforeend', row()); return; }
      if (act === 'rcv-rm') { b.closest('.rcv-row').remove(); return; }
      if (act !== 'rcv-save') return;
      const lines = [];
      for (const r of document.querySelectorAll('#rcv-rows .rcv-row')) {
        const name = H.cleanName(r.querySelector('[data-r=name]').value), qtyS = r.querySelector('[data-r=qty]').value.trim();
        if (!name && !qtyS) continue;
        const qty = parseInt(qtyS, 10), cost = H.parseMoney(r.querySelector('[data-r=cost]').value);
        if (!name) return H.toast('Λείπει όνομα προϊόντος');
        if (!Number.isFinite(qty) || qty <= 0) return H.toast(`Λείπουν τα τεμάχια: ${name}`);
        if (Number.isNaN(cost)) return H.toast(`Λάθος τιμή: ${name}`);
        lines.push({ name, qty, cost });
      }
      if (!lines.length) return H.toast('Γράψε τουλάχιστον ένα προϊόν');
      const date = document.getElementById('rcv-date').value || H.todayStr();
      const [yy, mm, dd] = date.split('-').map(Number);
      const now = Date.now(), at = date === H.todayStr() ? now : new Date(yy, mm - 1, dd, 12).getTime(), prodWrites = [], moveWrites = [];
      for (const l of lines) {
        let id = CACHE.byName.get(normKey(l.name));
        const cur = id ? CACHE.byId.get(id) : null;
        if (!id) { id = db.newUid(); CACHE.byName.set(normKey(l.name), id); }
        if (!cur || l.cost != null) {
          const { stock, known, events, ...base } = cur || { id, name: l.name, kind: 'both', code: '', size: '', price: null, min: 1 };
          prodWrites.push({ ...base, cost: l.cost ?? base.cost ?? null, updatedAt: now });
        }
        moveWrites.push({ uid: db.newUid(), productId: id, date, at, type: 'receive', qty: l.qty, cost: l.cost, dev: H.device(), updatedAt: now });
      }
      await db.transaction(['products', 'moves'], (tx) => {
        prodWrites.forEach((p) => tx.objectStore('products').put(p));
        moveWrites.forEach((m) => tx.objectStore('moves').put(m));
      });
      H.closeSheet();
      await afterChange(el, null, `Παραλαβή: ${lines.length} ${lines.length === 1 ? 'προϊόν' : 'προϊόντα'}, ${lines.reduce((a, l) => a + l.qty, 0)} τεμ.`);
    },
  });
}

// Για τα Αποτελέσματα: χρήσεις αναλωσίμων σε διάστημα.
export async function usageBetween(from, to) {
  const { byId } = CACHE || (await loadStock());
  const g = new Map();
  for (const m of await db.getAll('moves')) {
    if (m.type !== 'use' || m.date < from || m.date > to) continue;
    const p = byId.get(m.productId); const name = p?.name || '(διαγραμμένο)';
    const x = g.get(name) || { name, qty: 0, cost: 0 }; x.qty += m.qty; x.cost += (p?.cost || 0) * m.qty; g.set(name, x);
  }
  return [...g.values()].sort((a, b) => b.qty - a.qty);
}
export async function costOf(name, productId) {
  const c = CACHE || (await loadStock());
  const p = (productId && c.byId.get(productId)) || c.byId.get(c.byName.get(normKey(name)));
  return p?.cost ?? null;
}
