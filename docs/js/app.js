import * as db from './db.js';
import { seedIfNeeded, cleanName } from './seed.js';

const APP_VERSION = '1.5.0';
const OTHER = 'Άλλο'; // ad-hoc εργασία με δική της περιγραφή και ποσό

// ---------------------------------------------------------------- βοηθητικά
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const eur0 = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
const fmt = (cents) => (cents % 100 === 0 ? eur0 : eur2).format((cents || 0) / 100);

// "35", "35,5", "35.50" → λεπτά. Κενό → null. Μη έγκυρο → NaN.
function parseMoney(str) {
  const s = String(str ?? '').trim().replace(/\s|€/g, '').replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
const toInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(cents % 100 ? 2 : 0).replace('.', ','));
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

// Αναζήτηση χωρίς τόνους / πεζά-κεφαλαία / τελικό σίγμα.
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = () => ymd(new Date());
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
function dayTitle(date) {
  const [y, m, d] = date.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('el-GR', { weekday: 'short', day: 'numeric', month: 'short' });
  return label;
}
const timeStr = (ts) => new Date(ts).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------------------------------------------------------------- κατάσταση
const S = {
  date: todayStr(),
  tab: 'visits',
  day: null,
  visits: [],
  expenses: [],
  categories: [],
  staff: [],
  clients: [],
  persisted: null,
};

const blankDay = (date) => ({
  date, posTotal: null, posCards: { visa: null, mastercard: null, other: null },
  retail: null, vat: null, locked: false, lockedAt: null, updatedAt: null,
});

async function loadStatic() {
  S.categories = (await db.getAll('categories')).sort((a, b) => a.order - b.order);
  S.staff = (await db.getAll('staff')).filter((s) => s.active).sort((a, b) => a.order - b.order);
  S.clients = (await db.getAll('clients')).map((c) => c.name).sort((a, b) => a.localeCompare(b, 'el'));
}

// Φορτώνει την ημέρα S.date. Αν στο μεταξύ άλλαξε ημέρα (γρήγορα πατήματα ‹ ›),
// τα παλιά αποτελέσματα πετιούνται, ώστε να μην ανακατευτούν δύο ημέρες.
async function loadDay() {
  const date = S.date;
  const byTime = (a, b) => a.createdAt - b.createdAt;
  const [day, visits, expenses] = await Promise.all([
    db.get('days', date),
    db.getByIndex('visits', 'date', date),
    db.getByIndex('expenses', 'date', date),
  ]);
  if (date !== S.date) return false;
  S.day = day || blankDay(date);
  S.visits = visits.sort(byTime);
  S.expenses = expenses.sort(byTime);
  return true;
}

async function saveDay(patch) {
  S.day = { ...S.day, ...patch, updatedAt: Date.now() };
  await db.put('days', S.day);
}

function totals() {
  const services = sum(S.visits.map((v) => v.total));
  const retail = S.day.retail || 0;
  const expenses = sum(S.expenses.map((e) => e.amount));
  const byStaff = {};
  for (const v of S.visits) byStaff[v.staff] = (byStaff[v.staff] || 0) + v.total;
  return { services, retail, income: services + retail, expenses, net: services + retail - expenses, byStaff };
}

function lockedGuard() {
  if (!S.day.locked) return false;
  toast('Η ημέρα είναι κλειστή. Ξεκλείδωμα από το Ταμείο.');
  return true;
}

// ---------------------------------------------------------------- μόνιμη αποθήκευση
async function ensurePersistent() {
  try {
    if (!navigator.storage?.persist) { S.persisted = null; return; }
    let p = await navigator.storage.persisted();
    if (!p) p = await navigator.storage.persist();
    S.persisted = p;
  } catch { S.persisted = null; }
}

// ---------------------------------------------------------------- απόδοση οθονών
function renderHeader() {
  $('#day-label').textContent = dayTitle(S.date);
  $('#day-picker').value = S.date;
  const sub = [S.date === todayStr() && 'Σήμερα', S.day.locked && '🔒 Κλειστή'].filter(Boolean).join(' · ');
  $('#day-lock').textContent = sub;
  $('#day-lock').hidden = !sub;
  $('#go-today').hidden = S.date === todayStr();
}

function renderTabs() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.querySelectorAll('main .tab').forEach((s) => (s.hidden = s.dataset.tab !== S.tab));
}

function itemsLine(items) {
  return items.map((it) => `${it.cat === OTHER && it.note ? it.note : it.cat} ${fmt(it.amount)}`).join(' · ');
}

function renderVisits() {
  const t = totals();
  const staffChips = S.staff
    .filter((s) => t.byStaff[s.name])
    .map((s) => `<span>${esc(s.name)} ${fmt(t.byStaff[s.name])}</span>`).join('');
  const rows = S.visits.map((v, i) => `
    <button class="row" data-act="edit-visit" data-id="${v.id}">
      <span class="num">${i + 1}</span>
      <span class="main">
        <div class="title">${esc(v.client)}</div>
        <div class="sub">${esc(v.staff)} · ${esc(itemsLine(v.items))}</div>
      </span>
      <span class="amt">${fmt(v.total)}</span>
    </button>`).join('');

  $('#tab-visits').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Εργασίες</div><div class="v">${fmt(t.services)}</div></div>
      <div class="stat"><div class="k">Πελάτες</div><div class="v">${S.visits.length}</div></div>
      ${staffChips ? `<div class="stat wide"><div class="k">Ανά υπάλληλο</div><div class="staff-chips">${staffChips}</div></div>` : ''}
    </div>
    <div style="margin-top:14px">
      <button class="btn primary big" data-act="new-visit" ${S.day.locked ? 'disabled' : ''}>＋ Νέος πελάτης</button>
    </div>
    <h2>Καταχωρήσεις</h2>
    <div class="list">${rows || '<div class="empty">Καμία καταχώρηση ακόμα.</div>'}</div>`;
}

function renderExpenses() {
  const total = sum(S.expenses.map((e) => e.amount));
  const rows = S.expenses.map((e) => `
    <button class="row" data-act="edit-expense" data-id="${e.id}">
      <span class="main"><div class="title">${esc(e.desc || 'Έξοδο')}</div><div class="sub">${timeStr(e.createdAt)}</div></span>
      <span class="amt">${fmt(e.amount)}</span>
    </button>`).join('');
  $('#tab-expenses').innerHTML = `
    <div class="stats">
      <div class="stat wide"><div class="k">Έξοδα ημέρας</div><div class="v">${fmt(total)}</div></div>
    </div>
    <div style="margin-top:14px">
      <button class="btn primary big" data-act="new-expense" ${S.day.locked ? 'disabled' : ''}>＋ Νέο έξοδο</button>
    </div>
    <h2>Καταχωρήσεις</h2>
    <div class="list">${rows || '<div class="empty">Κανένα έξοδο σήμερα.</div>'}</div>`;
}

function moneyField(label, key, value, disabled) {
  return `<label class="field"><span class="lbl">${label}</span>
    <span class="money"><input class="input" inputmode="decimal" enterkeyhint="next" data-day="${key}"
      value="${toInput(value)}" placeholder="0" ${disabled ? 'disabled' : ''}><span class="cur">€</span></span></label>`;
}

function renderTill() {
  const d = S.day, L = d.locked;
  $('#tab-till').innerHTML = `
    <h2>POS</h2>
    <div class="card">
      ${moneyField('Σύνολο POS', 'posTotal', d.posTotal, L)}
      <div class="grid2">
        ${moneyField('Visa', 'visa', d.posCards.visa, L)}
        ${moneyField('Mastercard', 'mastercard', d.posCards.mastercard, L)}
      </div>
      <div style="margin-top:14px">${moneyField('Άλλες κάρτες', 'other', d.posCards.other, L)}</div>
      <div id="pos-check"></div>
    </div>
    <h2>Μεταπώληση & ΦΠΑ</h2>
    <div class="card">
      ${moneyField('Μεταπώληση / προϊόντα', 'retail', d.retail, L)}
      ${moneyField('ΦΠΑ ημέρας', 'vat', d.vat, L)}
    </div>
    <h2>Σύνοψη ημέρας</h2>
    <div class="card" id="till-summary"></div>
    <div style="margin-top:16px" id="till-lock"></div>`;
  renderTillSummary();
}

// Ξεχωριστά από τη φόρμα, ώστε η ανανέωση να μη χαλάει το πεδίο που γράφεις.
function renderTillSummary() {
  const d = S.day, t = totals();
  const cards = [d.posCards.visa, d.posCards.mastercard, d.posCards.other];
  const cardsEntered = cards.some((c) => c != null);
  const cardsSum = sum(cards);
  $('#pos-check').innerHTML = cardsEntered && d.posTotal != null && cardsSum !== d.posTotal
    ? `<div class="warn">Οι κάρτες κάνουν ${fmt(cardsSum)}, το σύνολο POS είναι ${fmt(d.posTotal)}.</div>` : '';

  $('#till-summary').innerHTML = `
    <div class="kv"><span>Εργασίες (${S.visits.length})</span><span>${fmt(t.services)}</span></div>
    <div class="kv"><span>Μεταπώληση</span><span>${fmt(t.retail)}</span></div>
    <div class="kv"><span>Έσοδα</span><span>${fmt(t.income)}</span></div>
    <div class="kv"><span>Έξοδα (${S.expenses.length})</span><span>− ${fmt(t.expenses)}</span></div>
    <div class="kv total"><span>Έσοδα − Έξοδα</span><span>${fmt(t.net)}</span></div>
    <div class="kv"><span>POS</span><span>${d.posTotal == null ? '—' : fmt(d.posTotal)}</span></div>
    <div class="kv"><span>ΦΠΑ</span><span>${d.vat == null ? '—' : fmt(d.vat)}</span></div>`;

  $('#till-lock').innerHTML = d.locked
    ? `<div class="note" style="text-align:center;margin-bottom:10px">🔒 Η ημέρα έκλεισε στις ${timeStr(d.lockedAt)}.</div>
       <button class="btn danger" data-act="unlock">Ξεκλείδωμα ημέρας</button>`
    : `<button class="btn primary big" data-act="lock">Κλείσιμο ημέρας</button>
       <p class="note" style="text-align:center">Μετά το κλείσιμο δεν αλλάζει τίποτα χωρίς ξεκλείδωμα.</p>`;
}

function render() {
  renderHeader();
  renderTabs();
  renderVisits();
  renderExpenses();
  renderTill();
}

// ---------------------------------------------------------------- φύλλο (sheet)
let sheetHandlers = null;

function openSheet({ title, body, foot, onAction, onInput }) {
  const panel = $('#sheet .sheet-panel');
  panel.innerHTML = `
    <div class="sheet-head"><h3>${esc(title)}</h3><button data-act="close">Κλείσιμο</button></div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  sheetHandlers = { onAction, onInput };
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet .sheet-panel').innerHTML = '';
  sheetHandlers = null;
  document.body.style.overflow = '';
}

// ---------------------------------------------------------------- επίσκεψη πελάτη
function openVisit(existing) {
  if (lockedGuard()) return;
  const V = existing ? structuredClone(existing) : { client: '', staff: '', items: [] };
  const catPrices = Object.fromEntries(S.categories.map((c) => [c.name, c.prices]));

  const total = () => sum(V.items.map((it) => (Number.isFinite(it.amount) ? it.amount : 0)));

  const staffBtns = () => S.staff.map((s) =>
    `<button class="choice ${V.staff === s.name ? 'on' : ''}" data-act="staff" data-v="${esc(s.name)}">${esc(s.name)}</button>`).join('');

  const itemHtml = (it, i) => {
    if (it.cat === OTHER) {
      return `<div class="item" data-i="${i}">
        <div class="item-head"><b>${OTHER}</b><button class="item-x" data-act="rm" data-i="${i}">Αφαίρεση</button></div>
        <input class="input" data-field="note" data-i="${i}" placeholder="Περιγραφή (προαιρετικά)" value="${esc(it.note || '')}">
        <span class="money"><input class="input" inputmode="decimal" data-field="amount" data-i="${i}" placeholder="Ποσό" value="${toInput(it.amount)}"><span class="cur">€</span></span>
      </div>`;
    }
    const prices = catPrices[it.cat] || [];
    const custom = it.amount != null && !prices.includes(it.amount);
    return `<div class="item" data-i="${i}">
      <div class="item-head"><b>${esc(it.cat)}</b><button class="item-x" data-act="rm" data-i="${i}">Αφαίρεση</button></div>
      <div class="chips">${prices.map((p) =>
        `<button class="chip ${it.amount === p ? 'on' : ''}" data-act="price" data-i="${i}" data-v="${p}">${fmt(p)}</button>`).join('')}</div>
      <span class="money"><input class="input" inputmode="decimal" data-field="amount" data-i="${i}" placeholder="Άλλο ποσό" value="${custom ? toInput(it.amount) : ''}"><span class="cur">€</span></span>
    </div>`;
  };

  const renderItems = () => {
    $('#v-items').innerHTML = V.items.map(itemHtml).join('') ||
      '<p class="note" style="margin:0 4px 10px">Διάλεξε εργασία από κάτω.</p>';
    renderTotal();
  };
  const renderTotal = () => { $('#v-total').textContent = fmt(total()); };

  const renderSuggest = () => {
    const q = norm(V.client.trim());
    const ul = $('#v-suggest');
    if (!q) { ul.innerHTML = ''; return; }
    const starts = [], contains = [];
    for (const name of S.clients) {
      const n = norm(name);
      if (n === q) continue;
      if (n.split(' ').some((w) => w.startsWith(q)) || n.startsWith(q)) starts.push(name);
      else if (n.includes(q)) contains.push(name);
    }
    const hits = [...starts, ...contains].slice(0, 6);
    const exact = S.clients.some((n) => norm(n) === q);
    ul.innerHTML = hits.map((n) => `<li><button data-act="pick-client" data-v="${esc(n)}">${esc(n)}</button></li>`).join('') +
      (!exact ? `<li><button class="new" data-act="new-client">＋ Νέος πελάτης: «${esc(cleanName(V.client))}»</button></li>` : '');
  };

  const body = `
    <div class="field">
      <span class="lbl">Πελάτης</span>
      <input class="input" id="v-client" data-field="client" autocomplete="off" autocorrect="off" autocapitalize="words"
        spellcheck="false" enterkeyhint="done" placeholder="Όνομα πελάτη" value="${esc(V.client)}">
      <ul class="suggest" id="v-suggest"></ul>
    </div>
    <div class="field">
      <span class="lbl">Υπάλληλος</span>
      <div class="choices" id="v-staff">${staffBtns()}</div>
    </div>
    <div class="field">
      <span class="lbl">Εργασίες</span>
      <div id="v-items"></div>
      <div class="choices cats">
        ${S.categories.map((c) => `<button class="choice" data-act="add" data-v="${esc(c.name)}">${esc(c.name)}</button>`).join('')}
        <button class="choice" data-act="add" data-v="${OTHER}">＋ ${OTHER}</button>
      </div>
    </div>`;

  const foot = `
    <div class="total-line"><span>Σύνολο</span><b id="v-total">${fmt(0)}</b></div>
    <div class="btn-row">
      ${existing ? '<button class="btn danger" data-act="delete">Διαγραφή</button>' : ''}
      <button class="btn primary" data-act="save">Αποθήκευση</button>
    </div>`;

  openSheet({
    title: existing ? 'Επεξεργασία' : 'Νέος πελάτης',
    body, foot,
    onInput(el) {
      const f = el.dataset.field;
      if (f === 'client') { V.client = el.value; renderSuggest(); return; }
      const it = V.items[+el.dataset.i];
      if (!it) return;
      if (f === 'note') it.note = el.value;
      if (f === 'amount') {
        it.amount = parseMoney(el.value);
        el.closest('.item').querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
        renderTotal();
      }
    },
    async onAction(act, el) {
      if (act === 'pick-client' || act === 'new-client') {
        if (act === 'pick-client') V.client = el.dataset.v;
        else V.client = cleanName(V.client);
        $('#v-client').value = V.client;
        $('#v-suggest').innerHTML = '';
        $('#v-client').blur();
      } else if (act === 'staff') {
        V.staff = el.dataset.v;
        $('#v-staff').innerHTML = staffBtns();
      } else if (act === 'add') {
        const cat = el.dataset.v;
        const prices = catPrices[cat] || [];
        V.items.push({ cat, amount: prices.length === 1 ? prices[0] : null, note: '' });
        renderItems();
        $(`#v-items .item[data-i="${V.items.length - 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (act === 'rm') {
        V.items.splice(+el.dataset.i, 1);
        renderItems();
      } else if (act === 'price') {
        V.items[+el.dataset.i].amount = +el.dataset.v;
        renderItems();
      } else if (act === 'save') {
        await saveVisit(V, existing);
      } else if (act === 'delete') {
        if (!confirm(`Διαγραφή της καταχώρησης «${existing.client}»;`)) return;
        await db.del('visits', existing.id);
        closeSheet();
        await refreshDay();
        toast('Διαγράφηκε');
      }
    },
  });
  renderItems();
  if (!existing) setTimeout(() => $('#v-client')?.focus(), 250);
}

async function saveVisit(V, existing) {
  const client = cleanName(V.client);
  if (!client) return toast('Γράψε όνομα πελάτη');
  if (!V.staff) return toast('Διάλεξε υπάλληλο');
  if (!V.items.length) return toast('Πρόσθεσε τουλάχιστον μία εργασία');
  const bad = V.items.find((it) => !Number.isFinite(it.amount));
  if (bad) return toast(`Λείπει ή είναι λάθος το ποσό: ${bad.cat}`);

  const now = Date.now();
  const items = V.items.map((it) => (it.cat === OTHER
    ? { cat: OTHER, amount: it.amount, note: cleanName(it.note) }
    : { cat: it.cat, amount: it.amount }));
  const rec = {
    ...(existing ? { id: existing.id, createdAt: existing.createdAt } : { createdAt: now }),
    date: S.date, client, staff: V.staff, items, total: sum(items.map((i) => i.amount)), updatedAt: now,
  };
  await db.put('visits', rec);

  // Νέο όνομα → μπαίνει στο πελατολόγιο για το autocomplete.
  if (!S.clients.some((n) => norm(n) === norm(client))) {
    try {
      await db.put('clients', { name: client, source: 'app', createdAt: now });
      S.clients.push(client);
      S.clients.sort((a, b) => a.localeCompare(b, 'el'));
    } catch { /* υπάρχει ήδη με άλλη γραφή — δεν πειράζει */ }
  }
  closeSheet();
  await refreshDay();
  toast(existing ? 'Αποθηκεύτηκε' : `Καταχωρήθηκε: ${client}`);
  if (!S.persisted) ensurePersistent();
}

// ---------------------------------------------------------------- έξοδο
function openExpense(existing) {
  if (lockedGuard()) return;
  const E = existing ? { ...existing } : { desc: '', amount: null };
  openSheet({
    title: existing ? 'Επεξεργασία εξόδου' : 'Νέο έξοδο',
    body: `
      <label class="field"><span class="lbl">Περιγραφή</span>
        <input class="input" id="e-desc" data-field="desc" autocapitalize="sentences" placeholder="π.χ. Καφέδες, Βαφές" value="${esc(E.desc)}"></label>
      <label class="field"><span class="lbl">Ποσό</span>
        <span class="money"><input class="input" id="e-amount" data-field="amount" inputmode="decimal" placeholder="0" value="${toInput(E.amount)}"><span class="cur">€</span></span></label>`,
    foot: `<div class="btn-row">
      ${existing ? '<button class="btn danger" data-act="delete">Διαγραφή</button>' : ''}
      <button class="btn primary" data-act="save">Αποθήκευση</button></div>`,
    onInput(el) {
      if (el.dataset.field === 'desc') E.desc = el.value;
      if (el.dataset.field === 'amount') E.amount = parseMoney(el.value);
    },
    async onAction(act) {
      if (act === 'save') {
        if (!Number.isFinite(E.amount) || E.amount <= 0) return toast('Γράψε σωστό ποσό');
        const now = Date.now();
        await db.put('expenses', {
          ...(existing ? { id: existing.id, createdAt: existing.createdAt } : { createdAt: now }),
          date: S.date, desc: cleanName(E.desc), amount: E.amount, updatedAt: now,
        });
        closeSheet();
        await refreshDay();
        toast('Αποθηκεύτηκε');
        if (!S.persisted) ensurePersistent();
      } else if (act === 'delete') {
        if (!confirm('Διαγραφή εξόδου;')) return;
        await db.del('expenses', existing.id);
        closeSheet();
        await refreshDay();
        toast('Διαγράφηκε');
      }
    },
  });
  if (!existing) setTimeout(() => $('#e-desc')?.focus(), 250);
}

// ---------------------------------------------------------------- ρυθμίσεις / πληροφορίες
async function openSettings() {
  await ensurePersistent();
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = `${(est.usage / 1024).toFixed(0)} KB`;
  } catch { /* */ }
  const [visits, expenses, days] = await Promise.all([db.count('visits'), db.count('expenses'), db.count('days')]);
  const standalone = isStandalone();
  const persistTxt = S.persisted === true ? '<span class="ok">Ναι</span>'
    : S.persisted === false ? '<span class="bad">Όχι</span>' : 'Άγνωστο';
  openSheet({
    title: 'Πληροφορίες',
    body: `
      <h2 style="margin-top:4px">Αποθήκευση</h2>
      <div class="card">
        <div class="kv"><span>Τα δεδομένα μένουν</span><span>μόνο σε αυτή τη συσκευή</span></div>
        <div class="kv"><span>Μόνιμη αποθήκευση</span><span>${persistTxt}</span></div>
        <div class="kv"><span>Στην αρχική οθόνη</span><span>${standalone ? '<span class="ok">Ναι</span>' : '<span class="bad">Όχι</span>'}</span></div>
        ${usage ? `<div class="kv"><span>Χώρος</span><span>${usage}</span></div>` : ''}
      </div>
      ${!standalone ? `<p class="warn" style="margin-top:10px">Πρόσθεσε την εφαρμογή στην αρχική οθόνη: έτσι το iPhone δεν σβήνει τα δεδομένα της.</p>` : ''}
      <h2>Καταχωρήσεις</h2>
      <div class="card">
        <div class="kv"><span>Πελάτες (επισκέψεις)</span><span>${visits}</span></div>
        <div class="kv"><span>Έξοδα</span><span>${expenses}</span></div>
        <div class="kv"><span>Ημέρες με ταμείο</span><span>${days}</span></div>
        <div class="kv"><span>Πελατολόγιο</span><span>${S.clients.length}</span></div>
      </div>
      <h2>Αντίγραφο ασφαλείας</h2>
      <div class="card"><p class="note" style="margin:0">Η εξαγωγή (CSV για Excel) έρχεται στην επόμενη έκδοση και θα είναι και το backup.</p></div>
      <p class="note" style="text-align:center;margin-top:18px">Έκδοση ${APP_VERSION}</p>`,
    onAction() {},
  });
}

// ---------------------------------------------------------------- αρχική οθόνη (install)
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let deferredInstall = null;

const SHARE_ICON = `<svg class="share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>`;

function renderInstallBanner() {
  const el = $('#install-banner');
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('installDismissed') === '1'; } catch { /* */ }
  if (isStandalone() || dismissed) { el.hidden = true; return; }
  let how;
  if (isIOS()) {
    how = `Πάτα ${SHARE_ICON} <b style="display:inline;font-size:inherit;padding:0">Κοινοποίηση</b> κάτω στο Safari και μετά
      «<b style="display:inline;font-size:inherit;padding:0">Προσθήκη στην οθόνη Αφετηρίας</b>».`;
  } else if (deferredInstall) {
    how = `<button class="btn primary" data-act="install">Εγκατάσταση</button>`;
  } else {
    how = `Άνοιξε τη σελίδα από το Safari του iPhone και πρόσθεσέ την στην αρχική οθόνη.`;
  }
  el.innerHTML = `<button class="close" data-act="dismiss-install" aria-label="Κλείσιμο">✕</button>
    <b>Βάλε την εφαρμογή στην αρχική οθόνη</b>
    Έτσι ανοίγει χωρίς internet και το iPhone δεν σβήνει τα δεδομένα. ${how}`;
  el.hidden = false;
}

// ---------------------------------------------------------------- ενημερώσεις εφαρμογής
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('Νέα έκδοση διαθέσιμη', { label: 'Ανανέωση', run: () => w.postMessage('skipWaiting') });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(() => { /* χωρίς SW η εφαρμογή δουλεύει, απλώς όχι offline */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

// ---------------------------------------------------------------- συμβάντα
async function refreshDay() {
  if (await loadDay()) render();
}

async function goTo(date) {
  if (!date) return;
  S.date = date;
  await refreshDay();
  window.scrollTo(0, 0);
}

const DAY_FIELDS = { posTotal: 'posTotal', retail: 'retail', vat: 'vat' };
const CARD_FIELDS = ['visa', 'mastercard', 'other'];

async function onTillChange(el) {
  if (S.day.locked) return;
  const key = el.dataset.day;
  const v = parseMoney(el.value);
  if (Number.isNaN(v)) { toast('Μη έγκυρο ποσό'); el.focus(); return; }
  if (CARD_FIELDS.includes(key)) await saveDay({ posCards: { ...S.day.posCards, [key]: v } });
  else if (DAY_FIELDS[key]) await saveDay({ [key]: v });
  el.value = toInput(v);
  renderTillSummary();
  if (!S.persisted) ensurePersistent();
}

function bind() {
  $('#day-prev').onclick = () => goTo(addDays(S.date, -1));
  $('#day-next').onclick = () => goTo(addDays(S.date, 1));
  $('#go-today').onclick = () => goTo(todayStr());
  $('#day-picker').onchange = (e) => goTo(e.target.value);
  $('#open-settings').onclick = openSettings;

  $('#tabbar').onclick = (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    renderTabs();
    window.scrollTo(0, 0);
  };

  $('#main').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'new-visit') openVisit();
    if (act === 'edit-visit') openVisit(S.visits.find((v) => v.id === +el.dataset.id));
    if (act === 'new-expense') openExpense();
    if (act === 'edit-expense') openExpense(S.expenses.find((x) => x.id === +el.dataset.id));
    if (act === 'lock') {
      if (!confirm(`Κλείσιμο της ημέρας ${dayTitle(S.date)};`)) return;
      // Πρώτα αποθηκεύουμε ό,τι γράφεται εκείνη τη στιγμή σε πεδίο.
      const active = document.activeElement;
      if (active?.dataset?.day) await onTillChange(active);
      await saveDay({ locked: true, lockedAt: Date.now() });
      render();
      toast('Η ημέρα έκλεισε 🔒');
    }
    if (act === 'unlock') {
      if (!confirm('Ξεκλείδωμα ημέρας; Θα μπορούν να γίνουν αλλαγές.')) return;
      await saveDay({ locked: false, lockedAt: null });
      render();
    }
  });
  $('#main').addEventListener('change', (e) => { if (e.target.dataset.day) onTillChange(e.target); });
  $('#main').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.day) e.target.blur();
  });

  const sheet = $('#sheet');
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return closeSheet();
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'close') return closeSheet();
    sheetHandlers?.onAction?.(el.dataset.act, el, e);
  });
  sheet.addEventListener('input', (e) => sheetHandlers?.onInput?.(e.target, e));
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });

  $('#install-banner').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'dismiss-install') {
      try { sessionStorage.setItem('installDismissed', '1'); } catch { /* */ }
      $('#install-banner').hidden = true;
    }
    if (act === 'install' && deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      renderInstallBanner();
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; renderInstallBanner(); });
  window.addEventListener('appinstalled', () => { $('#install-banner').hidden = true; });

  // Αν η εφαρμογή μείνει ανοιχτή και αλλάξει η μέρα, όταν ξαναγυρίσεις
  // πας στο σήμερα (μόνο αν έβλεπες το «χθες» που ήταν τότε σήμερα).
  let lastToday = todayStr();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = todayStr();
    if (now !== lastToday && S.date === lastToday && $('#sheet').hidden) goTo(now);
    lastToday = now;
  });
}

// ---------------------------------------------------------------- εκκίνηση
async function start() {
  try {
    bind();
    registerSW();
    await seedIfNeeded();
    await loadStatic();
    await loadDay();
    render();
    renderInstallBanner();
    ensurePersistent();
  } catch (err) {
    console.error(err);
    $('#main').innerHTML = `<div class="card"><b>Κάτι πήγε στραβά στο άνοιγμα.</b>
      <p class="note">${esc(err.message || err)}</p>
      <button class="btn primary" onclick="location.reload()">Ξαναδοκίμασε</button></div>`;
  }
}

start();
