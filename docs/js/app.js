import * as db from './db.js';
import { seedIfNeeded, cleanName } from './seed.js';
import * as backup from './backup.js';
import { renderResults, overdueClients } from './results.js';

const APP_VERSION = '2.8.1';
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
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ');

// Ονόματα: πάντα «Επώνυμο Όνομα». Πρώτη λέξη = επώνυμο.
function splitName(name) {
  const parts = cleanName(name).split(' ');
  return { surname: parts[0] || '', first: parts.slice(1).join(' ') };
}
const joinName = (surname, first) => cleanName(`${cleanName(surname)} ${cleanName(first)}`);

// Επώνυμο έντονο, και υπογράμμιση στο κομμάτι που ταιριάζει με την αναζήτηση q (ήδη norm).
function nameHtml(name, q = '') {
  const chars = [...name];
  const n = chars.map((c) => norm(c));
  const joined = n.join('');
  let from = -1;
  if (q) from = joined.startsWith(q) ? 0 : (joined.indexOf(' ' + q) >= 0 ? joined.indexOf(' ' + q) + 1 : joined.indexOf(q));
  // θέση normalized → θέση χαρακτήρα
  const startOf = []; let pos = 0;
  n.forEach((x, i) => { startOf[i] = pos; pos += x.length; });
  const space = name.indexOf(' ');
  const surnameEnd = space < 0 ? chars.length : [...name.slice(0, space)].length;
  let out = '', cur = null, buf = '';
  const flush = () => {
    if (!buf) return;
    let h = esc(buf);
    if (cur.m) h = `<u>${h}</u>`;
    if (cur.b) h = `<b>${h}</b>`;
    out += h; buf = '';
  };
  chars.forEach((c, i) => {
    const f = { b: i < surnameEnd, m: from >= 0 && startOf[i] >= from && startOf[i] < from + q.length };
    if (!cur || f.b !== cur.b || f.m !== cur.m) { flush(); cur = f; }
    buf += c;
  });
  flush();
  return out;
}

// Απόσταση Levenshtein (πόσα γράμματα διαφέρουν), με όριο για ταχύτητα.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const tolerance = (word) => (word.length <= 4 ? 1 : 2);

// «Μήπως εννοείς…;» — υπάρχοντα ονόματα που μοιάζουν με το νέο (ορθογραφία,
// τόνοι, ανάποδη σειρά, ή ίδιο επώνυμο με παρόμοιο όνομα).
function similarClients(surname, first) {
  const s = norm(cleanName(surname)), f = norm(cleanName(first));
  if (s.length < 3) return [];
  const scored = [];
  for (const name of S.clients) {
    const [cs = '', ...rest] = norm(name).split(' ');
    const cf = rest.join(' ');
    const dS = editDistance(s, cs, 2), dF = f ? editDistance(f, cf, 2) : 0;
    const swapped = f && editDistance(s, cf, 1) <= 1 && editDistance(f, cs, 1) <= 1;
    let score = null;
    if (dS <= tolerance(s) && (!f || !cf || dF <= tolerance(f))) score = dS + dF;      // σχεδόν ίδιο
    else if (swapped) score = 1;                                                     // ανάποδα
    else if (dS <= 1 && f && cf && cf[0] === f[0]) score = 3 + dS;                   // ίδιο επώνυμο, όνομα από το ίδιο γράμμα
    if (score != null) scored.push([score, name]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 4).map((x) => x[1]);
}

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
  phones: new Map(), // όνομα → τηλέφωνο (προαιρετικό)
  device: null, // τυχαίο id αυτής της συσκευής (για το «τι δεν έχει σταλεί»)
};

const blankDay = (date) => ({
  date, posTotal: null, posParts: [],
  retail: null, vat: null, locked: false, lockedAt: null, updatedAt: null,
});

async function loadStatic() {
  S.categories = (await db.getAll('categories')).sort((a, b) => a.order - b.order);
  S.staff = (await db.getAll('staff')).filter((s) => s.active).sort((a, b) => a.order - b.order);
  const cl = await db.getAll('clients');
  S.clients = cl.map((c) => c.name).sort((a, b) => a.localeCompare(b, 'el'));
  S.phones = new Map(cl.filter((c) => c.phone).map((c) => [c.name, c.phone]));
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

// Η διαγραφή αφήνει ίχνος, ώστε να σβηστεί και στην άλλη συσκευή κατά την εισαγωγή.
async function deleteRecord(store, rec) {
  await db.transaction([store, 'deleted'], (tx) => {
    tx.objectStore(store).delete(rec.id);
    if (rec.uid) tx.objectStore('deleted').put({ uid: rec.uid, store, date: rec.date, deletedAt: Date.now(), dev: S.device });
  });
}

async function saveDay(patch) {
  S.day = { ...S.day, ...patch, updatedAt: Date.now(), dev: S.device };
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
  document.body.classList.toggle('results-mode', S.tab === 'results');
  if (S.tab === 'results') renderResults($('#tab-results')).catch((err) => toast(`Σφάλμα αποτελεσμάτων: ${err.message || err}`));
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
    <div id="call-card"></div>
    <div style="margin-top:14px">
      <button class="btn primary big" data-act="new-visit" ${S.day.locked ? 'disabled' : ''}>＋ Νέος πελάτης</button>
    </div>
    <h2>Καταχωρήσεις</h2>
    <div class="list">${rows || '<div class="empty">Καμία καταχώρηση ακόμα.</div>'}</div>`;
}

// ---------------------------------------------------------------- 📞 έχουν αργήσει
// Μόνο στη σημερινή μέρα. «Πήρα τηλέφωνο» = κρύβεται 3 εβδομάδες· «Δεν έρχεται πια» = κρύβεται
// μέχρι να ξανάρθει. Κάθε νέα επίσκεψη ακυρώνει αυτόματα την απόκρυψη.
async function callList() {
  const snooze = (await db.getMeta('callSnooze')) || {};
  const now = todayStr();
  return (await overdueClients()).filter((c) => {
    const s = snooze[c.name];
    if (!s || c.last > s.last) return true;
    return s.until !== 'never' && s.until <= now;
  });
}

async function renderCallCard() {
  const box = $('#call-card');
  if (!box) return;
  if (S.date !== todayStr()) { box.innerHTML = ''; return; }
  const list = await callList();
  if (!$('#call-card')) return;
  box.innerHTML = list.length ? `<button class="call-card" data-act="open-calls">
      <span class="cc-icon">📞</span>
      <span class="cc-text"><b>${list.length} ${list.length === 1 ? 'πελάτισσα έχει' : 'πελάτισσες έχουν'} αργήσει</b>
        <span>${esc(list.slice(0, 3).map((c) => c.name).join(', '))}${list.length > 3 ? '…' : ''}</span></span>
      <span class="cc-go">›</span></button>` : '';
}

async function openCalls() {
  const list = await callList();
  const every = (e) => (e < 14 ? `${Math.round(e)} ημέρες` : `${String(Math.round((e / 7) * 10) / 10).replace('.', ',')} εβδομάδες`);
  const fmtD = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('el-GR', { day: 'numeric', month: 'short' }); };
  openSheet({
    title: `📞 Έχουν αργήσει (${list.length})`,
    body: `<p class="note" style="margin-top:0">Σταθερές πελάτισσες που άργησαν πολύ σε σχέση με το συνηθισμένο τους. Πρώτες όσες φέρνουν τα περισσότερα.</p>
      ${list.map((c) => {
        const ph = S.phones.get(c.name);
        return `<div class="call-item">
          <div class="ci-head"><b>${nameHtml(c.name)}</b><span>${fmt(c.spend)}</span></div>
          <div class="ci-sub">Έρχεται κάθε ~${every(c.every)} · τελευταία ${fmtD(c.last)} (πριν ${c.since} ημέρες)<br>Συνήθως: ${esc(c.fav || '')} · ${esc(c.staff || '')}</div>
          <div class="ci-actions">
            ${ph ? `<a class="btn primary" href="${telHref(ph)}">📞 ${esc(ph)}</a>` : `<button class="btn" data-act="add-phone" data-v="${esc(c.name)}">＋ Τηλέφωνο</button>`}
            <button class="btn" data-act="called" data-v="${esc(c.name)}" data-last="${c.last}">✓ Πήρα</button>
            <button class="btn ghost" data-act="gone" data-v="${esc(c.name)}" data-last="${c.last}">Δεν έρχεται πια</button>
          </div></div>`;
      }).join('') || '<div class="empty">Καμία — όλες έρχονται στην ώρα τους 🎉</div>'}`,
    async onAction(act, el) {
      if (act === 'called' || act === 'gone') {
        const snooze = (await db.getMeta('callSnooze')) || {};
        snooze[el.dataset.v] = { last: el.dataset.last, until: act === 'gone' ? 'never' : addDays(todayStr(), 21) };
        await db.setMeta('callSnooze', snooze);
        toast(act === 'gone' ? 'Δεν θα εμφανίζεται (εκτός αν ξανάρθει)' : 'Κρύφτηκε για 3 εβδομάδες');
        await renderCallCard();
        openCalls();
      }
      if (act === 'add-phone') {
        const ph = cleanPhone(prompt(`Τηλέφωνο για «${el.dataset.v}»:`) || '');
        if (!ph) return;
        await setClientPhone(el.dataset.v, ph);
        await loadStatic();
        openCalls();
      }
    },
  });
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

function posRowHtml(value, i, disabled) {
  return `<div class="pos-row">
    <span class="num">${i + 1}.</span>
    <span class="money"><input class="input" inputmode="decimal" data-pos value="${toInput(value)}" placeholder="0" ${disabled ? 'disabled' : ''}><span class="cur">€</span></span>
    ${disabled ? '' : '<button class="item-x" data-act="pos-rm" aria-label="Αφαίρεση γραμμής">✕</button>'}
  </div>`;
}

function renderTill() {
  const d = S.day, L = d.locked;
  const parts = d.posParts || [];
  const rows = (parts.length || L ? parts : [null]).map((p, i) => posRowHtml(p, i, L)).join('');
  $('#tab-till').innerHTML = `
    <h2>POS</h2>
    <div class="card">
      ${moneyField('Σύνολο POS', 'posTotal', d.posTotal, L)}
      <span class="lbl" style="display:block;font-size:15px;font-weight:600;color:var(--muted);margin:0 4px 6px">Συναλλαγές με κάρτα (μία γραμμή ανά πελάτη)</span>
      <div id="pos-parts">${rows || '<p class="note">Καμία γραμμή.</p>'}</div>
      ${L ? '' : '<button class="btn" data-act="pos-add" style="margin-top:4px">＋ Γραμμή</button>'}
      <div id="pos-check" style="margin-top:10px"></div>
    </div>
    <h2>Μεταπώληση & ΦΠΑ</h2>
    <div class="card">
      ${moneyField('Μεταπώληση / προϊόντα', 'retail', d.retail, L)}
      ${moneyField('ΦΠΑ ημέρας', 'vat', d.vat, L)}
    </div>
    <h2>Σύνοψη ημέρας</h2>
    <div class="card" id="till-summary"></div>
    <h2>Αποστολή στη Λυδία / backup</h2>
    <div class="card" id="send-status"></div>
    <div style="margin-top:16px" id="till-lock"></div>`;
  renderTillSummary();
  renderSendStatus();
}

// Ξεχωριστά από τη φόρμα, ώστε η ανανέωση να μη χαλάει το πεδίο που γράφεις.
function renderTillSummary() {
  const d = S.day, t = totals();
  const parts = d.posParts || [];
  const partsSum = sum(parts);
  let check = '';
  if (parts.length) {
    check = `<div class="note" style="margin:0 4px 6px">${parts.length} ${parts.length === 1 ? 'γραμμή' : 'γραμμές'} · άθροισμα ${fmt(partsSum)}</div>`;
    if (d.posTotal != null && partsSum !== d.posTotal) {
      const diff = d.posTotal - partsSum;
      check += `<div class="warn">Οι γραμμές κάνουν ${fmt(partsSum)}, το σύνολο POS είναι ${fmt(d.posTotal)} (${diff > 0 ? 'λείπουν' : 'περισσεύουν'} ${fmt(Math.abs(diff))}).</div>`;
    } else if (d.posTotal == null) {
      check += `<div class="warn">Γράψε και το σύνολο POS για έλεγχο.</div>`;
    } else {
      check += `<div class="note ok" style="margin:0 4px">✓ Συμφωνεί με το σύνολο POS.</div>`;
    }
  }
  $('#pos-check').innerHTML = check;

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
       <p class="note" style="text-align:center">Μετά το κλείσιμο ακολουθεί αποστολή στη Λυδία (backup).</p>`;
}

function render() {
  renderHeader();
  renderTabs();
  renderVisits();
  renderCallCard();
  renderExpenses();
  renderTill();
  renderBackupBanner();
}

// ---------------------------------------------------------------- φύλλο (sheet)
let sheetHandlers = null;

function openSheet({ title, body, foot, onAction, onInput, onChange, noClose = false }) {
  const panel = $('#sheet .sheet-panel');
  panel.innerHTML = `
    <div class="sheet-head"><h3>${esc(title)}</h3>${noClose ? '' : '<button data-act="close">Κλείσιμο</button>'}</div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  sheetHandlers = { onAction, onInput, onChange, noClose };
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet .sheet-panel').innerHTML = '';
  sheetHandlers = null;
  document.body.style.overflow = '';
  document.body.classList.remove('sheet-open');
}

// ---------------------------------------------------------------- επίσκεψη πελάτη
function openVisit(existing) {
  if (lockedGuard()) return;
  const V = existing ? { ...structuredClone(existing), newName: null } : { client: '', staff: '', items: [], newName: null };
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
    const exactHits = [], starts = [], contains = [];
    for (const name of S.clients) {
      const n = norm(name);
      if (n === q) exactHits.push(name);
      else if (n.split(' ').some((w) => w.startsWith(q)) || n.startsWith(q)) starts.push(name);
      else if (n.includes(q)) contains.push(name);
    }
    const hits = [...exactHits, ...starts, ...contains].slice(0, 6);
    const exact = exactHits.length > 0;
    ul.innerHTML = hits.map((n) => `<li><button data-act="pick-client" data-v="${esc(n)}">${nameHtml(n, q)}</button></li>`).join('') +
      (!exact ? `<li><button class="new" data-act="new-client">＋ Νέος πελάτης (Επώνυμο + Όνομα)</button></li>` : '');
  };

  const newNameHtml = () => `
    <div class="grid2">
      <label class="field"><span class="lbl">Επώνυμο</span>
        <input class="input" data-field="surname" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" value="${esc(V.newName.surname)}"></label>
      <label class="field"><span class="lbl">Όνομα</span>
        <input class="input" data-field="first" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" value="${esc(V.newName.first)}"></label>
    </div>
    <label class="field"><span class="lbl">Τηλέφωνο (προαιρετικό)</span>
      <input class="input" data-field="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="69…" value="${esc(V.newName.phone || '')}"></label>
    <div id="v-similar"></div>
    <button class="item-x" style="color:var(--accent)" data-act="search-again">← Αναζήτηση στο πελατολόγιο</button>`;
  const renderSimilar = () => {
    const box = $('#v-similar');
    if (!box || !V.newName) return;
    const sim = similarClients(V.newName.surname, V.newName.first);
    box.innerHTML = sim.length ? `<div class="warn" style="margin-bottom:8px"><b>Μήπως είναι κάποιος από αυτούς;</b> Πάτα το όνομα αν ναι.</div>
      <ul class="suggest" style="margin:0 0 10px">${sim.map((n) => `<li><button data-act="pick-similar" data-v="${esc(n)}">${nameHtml(n)}</button></li>`).join('')}</ul>` : '';
  };
  const searchHtml = () => `
      <input class="input" id="v-client" data-field="client" autocomplete="off" autocorrect="off" autocapitalize="words"
        spellcheck="false" enterkeyhint="done" placeholder="Επώνυμο ή όνομα" value="${esc(V.client)}">
      <ul class="suggest" id="v-suggest"></ul>`;
  const renderClientBox = () => {
    $('#v-client-box').innerHTML = V.newName ? newNameHtml() : searchHtml();
    renderSimilar();
  };

  const body = `
    <div class="field">
      <span class="lbl">Πελάτης</span>
      <div id="v-client-box">${searchHtml()}</div>
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
      if (f === 'surname' || f === 'first') { V.newName[f] = el.value; renderSimilar(); return; }
      if (f === 'phone' && V.newName) { V.newName.phone = el.value; return; }
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
      if (act === 'pick-client') {
        V.client = el.dataset.v;
        $('#v-client').value = V.client;
        $('#v-suggest').innerHTML = '';
        $('#v-client').blur();
      } else if (act === 'new-client') {
        V.newName = splitName(V.client);
        renderClientBox();
        $('#v-client-box [data-field=surname]').focus();
      } else if (act === 'pick-similar') {
        V.newName = null;
        V.client = el.dataset.v;
        renderClientBox();
        toast(`Επιλέχθηκε: ${V.client}`);
      } else if (act === 'search-again') {
        V.newName = null;
        renderClientBox();
        renderSuggest();
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
        await deleteRecord('visits', existing);
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
  let client;
  if (V.newName) {
    if (!cleanName(V.newName.surname) || !cleanName(V.newName.first)) return toast('Γράψε επώνυμο ΚΑΙ όνομα');
    client = joinName(V.newName.surname, V.newName.first);
    const sim = similarClients(V.newName.surname, V.newName.first);
    if (sim.length && !sim.some((n) => norm(n) === norm(client))
      && !confirm(`Υπάρχει ήδη παρόμοιο όνομα:\n${sim.join('\n')}\n\nΣίγουρα είναι ΝΕΟΣ πελάτης;`)) return;
  } else {
    client = cleanName(V.client);
    if (!client) return toast('Γράψε όνομα πελάτη');
    const known = S.clients.some((n) => norm(n) === norm(client)) || (existing && existing.client === client);
    if (!known) return toast('Διάλεξε από τη λίστα ή πάτα «Νέος πελάτης»');
  }
  // Ίδια γραφή με το πελατολόγιο (π.χ. αν γράφτηκε χωρίς τόνους).
  client = S.clients.find((n) => norm(n) === norm(client)) || client;
  if (!V.staff) return toast('Διάλεξε υπάλληλο');
  if (!V.items.length) return toast('Πρόσθεσε τουλάχιστον μία εργασία');
  const bad = V.items.find((it) => !Number.isFinite(it.amount));
  if (bad) return toast(`Λείπει ή είναι λάθος το ποσό: ${bad.cat}`);

  const now = Date.now();
  const items = V.items.map((it) => (it.cat === OTHER
    ? { cat: OTHER, amount: it.amount, note: cleanName(it.note) }
    : { cat: it.cat, amount: it.amount }));
  const rec = {
    ...(existing ? { id: existing.id, uid: existing.uid || db.newUid(), createdAt: existing.createdAt } : { uid: db.newUid(), createdAt: now }),
    date: S.date, client, staff: V.staff, items, total: sum(items.map((i) => i.amount)), updatedAt: now, dev: S.device,
  };
  await db.put('visits', rec);

  // Νέο όνομα → μπαίνει στο πελατολόγιο για το autocomplete.
  if (!S.clients.some((n) => norm(n) === norm(client))) {
    try {
      const phone = cleanPhone(V.newName?.phone);
      await db.put('clients', { name: client, source: 'app', createdAt: now, updatedAt: now, ...(phone ? { phone } : {}) });
      if (phone) S.phones.set(client, phone);
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
          ...(existing ? { id: existing.id, uid: existing.uid || db.newUid(), createdAt: existing.createdAt } : { uid: db.newUid(), createdAt: now }),
          date: S.date, desc: cleanName(E.desc), amount: E.amount, updatedAt: now, dev: S.device,
        });
        closeSheet();
        await refreshDay();
        toast('Αποθηκεύτηκε');
        if (!S.persisted) ensurePersistent();
      } else if (act === 'delete') {
        if (!confirm('Διαγραφή εξόδου;')) return;
        await deleteRecord('expenses', existing);
        closeSheet();
        await refreshDay();
        toast('Διαγράφηκε');
      }
    },
  });
  if (!existing) setTimeout(() => $('#e-desc')?.focus(), 250);
}

// ---------------------------------------------------------------- αποστολή στη Λυδία / backup
const phoneDigits = (s) => String(s || '').replace(/[^\d+]/g, '');
const fmtDateShort = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('el-GR', { weekday: 'short', day: 'numeric', month: 'short' });
};
const fmtWhen = (ts) => (ts ? `${new Date(ts).toLocaleDateString('el-GR', { weekday: 'short', day: 'numeric', month: 'short' })}, ${timeStr(ts)}` : 'ποτέ');

async function sendInfo() {
  const lastSent = (await db.getMeta('lastSentAt')) || 0;
  const pending = await backup.pendingDates(lastSent, S.device);
  return { lastSent, pending };
}

async function renderSendStatus() {
  const box = $('#send-status');
  if (!box) return;
  const { lastSent, pending } = await sendInfo();
  if (!$('#send-status')) return;
  box.innerHTML = `
    <div class="kv"><span>Τελευταία αποστολή</span><span>${fmtWhen(lastSent)}</span></div>
    <div class="kv"><span>Εκκρεμούν</span><span class="${pending.length ? 'bad' : 'ok'}">${pending.length ? pending.map(fmtDateShort).join(', ') : 'τίποτα ✓'}</span></div>
    ${pending.length ? '<button class="btn" data-act="send" style="margin-top:10px">Στείλε στη Λυδία τώρα</button>' : ''}`;
}

// Κόκκινη προειδοποίηση όταν ανοίγει η εφαρμογή: υπάρχουν προηγούμενες ημέρες χωρίς αποστολή.
async function renderBackupBanner() {
  const el = $('#backup-banner');
  const { lastSent, pending } = await sendInfo();
  const old = pending.filter((d) => d < todayStr());
  if (!old.length) { el.hidden = true; return; }
  const daysAgo = lastSent ? Math.floor((Date.now() - lastSent) / 86400000) : null;
  const since = daysAgo == null ? ' ποτέ' : daysAgo >= 1 ? ` εδώ και ${daysAgo} ${daysAgo === 1 ? 'μέρα' : 'μέρες'}` : '';
  el.innerHTML = `<b>⚠️ Δεν έχει σταλεί backup${since}</b>
    Εκκρεμούν: ${old.map(fmtDateShort).join(', ')}. Αν χαθεί ή χαλάσει το κινητό, αυτά χάνονται.
    <button class="btn primary" data-act="send">Στείλε στη Λυδία τώρα</button>`;
  el.hidden = false;
}

// Ετοιμάζει τα αρχεία ΠΡΙΝ το πάτημα: το iPhone επιτρέπει «Κοινοποίηση» μόνο
// αμέσως μετά από άγγιγμα, οπότε το κουμπί πρέπει να έχει τα αρχεία έτοιμα.
async function prepareSend() {
  const { pending } = await sendInfo();
  const builtAt = Date.now();
  const dates = pending.length ? pending : [S.date];
  const stampNow = backup.stamp();
  const range = dates.length === 1 ? dates[0] : `${dates[0]}_${dates[dates.length - 1]}`;
  const json = JSON.stringify(await backup.buildBackup());
  const csv = await backup.buildCSV(new Set(dates));
  // Το backup στέλνεται ως .txt (text/plain): το Chrome στο Android ΔΕΝ επιτρέπει
  // κοινοποίηση .json. Η εισαγωγή αναγνωρίζει το περιεχόμενο, όχι την κατάληξη.
  const backupFile = backup.makeFile(json, `kommotirio-backup-${stampNow}.txt`, 'text/plain');
  const csvFile = backup.makeFile(csv, `kommotirio-${range}.csv`, 'text/csv');
  return { builtAt, pending, dates, backupFile, csvFile };
}

const canShareFiles = (files) => {
  try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
};

async function openSendSheet({ mandatory = false } = {}) {
  let prep;
  try { prep = await prepareSend(); } catch (err) { toast(`Σφάλμα εξαγωγής: ${err.message || err}`); return; }
  const phone = (await db.getMeta('lydiaPhone')) || '';
  const both = [prep.backupFile, prep.csvFile];
  const canBoth = canShareFiles(both), canBackup = canShareFiles([prep.backupFile]);
  const canShare = canBoth || canBackup;
  const ua = navigator.userAgent;
  const device = (ua.match(/iPhone OS [\d_]+|iPad|Android [\d.]+/) || ['άλλη συσκευή'])[0].replace(/_/g, '.');
  const browser = (ua.match(/CriOS\/\d+|FxiOS\/\d+|EdgA?\/\d+|SamsungBrowser\/\d+|Chrome\/\d+|Version\/[\d.]+ (Mobile\/\w+ )?Safari/) || [''])[0];
  const diag = `share:${navigator.share ? 'ναι' : 'όχι'} · 2 αρχεία:${canBoth ? 'ναι' : 'όχι'} · backup:${canBackup ? 'ναι' : 'όχι'} · ${isStandalone() ? 'εφαρμογή' : 'browser'} · ${device} · ${browser}`;

  const body = `
    ${mandatory ? '<div class="warn" style="margin-bottom:12px"><b>Τελευταίο βήμα του κλεισίματος.</b> Η αποστολή είναι και το backup: χωρίς αυτήν, τα δεδομένα υπάρχουν μόνο σε αυτό το κινητό.</div>' : ''}
    <div class="card">
      <div class="kv"><span>Ημέρες</span><span>${prep.dates.map(fmtDateShort).join(', ')}</span></div>
      <div class="kv"><span>Αρχεία</span><span>backup (όλα τα δεδομένα)${canBoth ? '<br>+ CSV για Excel' : ''}</span></div>
    </div>
    <p class="note">${canShare
      ? 'Θα ανοίξει το μενού κοινοποίησης: διάλεξε <b>Viber</b> και μετά τη <b>Λυδία</b> (ή Gmail / Mail).'
      : 'Αυτή η συσκευή δεν επιτρέπει κοινοποίηση αρχείων από την εφαρμογή. Τα αρχεία θα αποθηκευτούν στις Λήψεις — στείλ’ τα μετά από το Viber (συνημμένο → αρχείο).'}</p>
    <div id="send-error"></div>
    <label class="field" style="margin-top:14px"><span class="lbl">Κινητό Λυδίας (Viber) — αποθηκεύεται μόνο σε αυτή τη συσκευή</span>
      <input class="input" data-field="phone" inputmode="tel" autocomplete="off" placeholder="+30 69…" value="${esc(phone)}"></label>
    <div id="viber-wrap"></div>`;

  const renderViber = (ph) => {
    const n = phoneDigits(ph).replace(/^\+/, '');
    const w = $('#viber-wrap');
    if (w) w.innerHTML = n.length >= 10
      ? `<a class="btn" style="text-decoration:none" href="viber://chat?number=%2B${n}">Άνοιγμα συνομιλίας Viber με Λυδία</a>
         <p class="note">Ανοίγει μόνο τη συνομιλία (χωρίς αρχείο). Τα αρχεία στέλνονται με το μωβ κουμπί.</p>` : '';
  };

  const showError = (title, err, extraButtons = '') => {
    $('#send-error').innerHTML = `<div class="err-box">
      <b>${esc(title)}</b>
      ${err ? `<div class="err-detail">${esc(err.name || '')}: ${esc(err.message || String(err))}</div>` : ''}
      <div class="err-detail">${esc(diag)}</div>
      <div class="stack" style="margin-top:10px">${extraButtons}
        <button class="btn" data-act="download">Αποθήκευση αρχείων στη συσκευή</button></div>
      <p class="note">Στείλε μου στιγμιότυπο αυτού του πλαισίου αν δεν βγει άκρη.</p></div>`;
    $('#send-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const markSent = async (how) => {
    await db.setMeta('lastSentAt', prep.builtAt);
    await db.setMeta('lastSentHow', how);
    renderSendStatus();
    renderBackupBanner();
  };

  const share = async (files, label) => {
    try {
      await navigator.share({ files, title: 'Κομμωτήριο — backup' });
      await markSent(label);
      closeSheet();
      toast('Στάλθηκε ✓');
    } catch (err) {
      if (err?.name === 'AbortError') showError('Η αποστολή ακυρώθηκε ή δεν ολοκληρώθηκε. Δοκίμασε ξανά.', null,
        canBoth ? '<button class="btn primary" data-act="share-backup">Δοκίμασε μόνο το backup</button>' : '');
      else showError('Δεν άνοιξε η κοινοποίηση.', err,
        files.length > 1 && canBackup ? '<button class="btn primary" data-act="share-backup">Δοκίμασε μόνο το backup</button>' : '');
    }
  };

  openSheet({
    title: 'Στείλε στη Λυδία',
    noClose: mandatory,
    body,
    foot: `<button class="btn primary big" data-act="share">${canShare ? 'Στείλε στη Λυδία τώρα' : 'Αποθήκευση αρχείων'}</button>
      ${mandatory ? '<button class="btn" data-act="later" style="margin-top:8px;min-height:44px;font-size:16px;background:transparent;color:var(--muted)">Αργότερα</button>' : ''}`,
    onInput(el) {
      if (el.dataset.field === 'phone') { db.setMeta('lydiaPhone', el.value.trim()); renderViber(el.value); }
    },
    async onAction(act) {
      // ΣΗΜΑΝΤΙΚΟ: το navigator.share καλείται χωρίς await πριν από αυτό,
      // αλλιώς το κινητό το απορρίπτει ως «όχι από άγγιγμα».
      if (act === 'share') {
        if (canBoth) return share(both, 'share-2');
        if (canBackup) return share([prep.backupFile], 'share-backup');
        return onDownload();
      }
      if (act === 'share-backup') return share([prep.backupFile], 'share-backup');
      if (act === 'download') return onDownload();
      if (act === 'confirm-sent') { await markSent('download'); closeSheet(); toast('Σημειώθηκε ως σταλμένο ✓'); return; }
      if (act === 'later') {
        if (!confirm('Χωρίς αποστολή ΔΕΝ υπάρχει backup.\nΑν χαθεί το κινητό, χάνονται τα δεδομένα.\n\nΣίγουρα αργότερα;')) return;
        closeSheet();
        toast('Θα σου το θυμίσω στο επόμενο άνοιγμα');
      }
    },
  });
  renderViber(phone);

  async function onDownload() {
    try {
      backup.download(prep.backupFile);
      setTimeout(() => backup.download(prep.csvFile), 500);
      $('#send-error').innerHTML = `<div class="warn"><b>Τα αρχεία αποθηκεύτηκαν στις Λήψεις.</b>
        Άνοιξε το Viber → συνομιλία με Λυδία → 📎 → Αρχείο, και διάλεξε το «${esc(prep.backupFile.name)}».
        <button class="btn primary" data-act="confirm-sent" style="margin-top:10px">Το έστειλα ✓</button></div>`;
    } catch (err) {
      showError('Δεν αποθηκεύτηκαν τα αρχεία.', err);
    }
  }
}

async function importFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const res = await backup.importText(text);
    await loadStatic();
    await refreshDay();
    if (res.kind === 'clients') toast(`Πελατολόγιο: προστέθηκαν ${res.clientsAdded} ονόματα`);
    else toast(`Εισαγωγή: ${res.added} νέα, ${res.updated} ενημερώσεις, ${res.deleted} διαγραφές, ${res.days} ημέρες ταμείου`);
    return true;
  } catch (err) {
    toast(err.message || String(err));
    return false;
  }
}

// ---------------------------------------------------------------- διαχείριση: πελατολόγιο
// Τα ίχνη διαγραφής (store «deleted») περνούν και στην άλλη συσκευή με την εισαγωγή.
const tomb = (store, key) => ({ uid: `${store === 'clients' ? 'client' : 'cat'}:${key}`, store, date: null, deletedAt: Date.now(), dev: S.device });

async function findClient(name) {
  return (await db.getByIndex('clients', 'name', name))[0];
}

// Μετονομασία: αλλάζει και σε όλες τις παλιές επισκέψεις. Αν το νέο όνομα
// υπάρχει ήδη, οι δύο πελάτες ενώνονται σε έναν.
async function renameClient(oldName, newName) {
  const now = Date.now();
  const rec = await findClient(oldName);
  const target = await findClient(newName);
  const visits = (await db.getAll('visits')).filter((v) => v.client === oldName);
  await db.transaction(['clients', 'visits', 'deleted'], (tx) => {
    const cs = tx.objectStore('clients');
    if (target && rec && target.id !== rec.id) {
      cs.delete(rec.id);
      if (rec.phone && !target.phone) cs.put({ ...target, phone: rec.phone, updatedAt: now });
    } else if (rec) cs.put({ ...rec, name: newName, createdAt: now, updatedAt: now });
    else if (!target) cs.add({ name: newName, source: 'app', createdAt: now });
    tx.objectStore('deleted').put(tomb('clients', oldName));
    tx.objectStore('deleted').delete(`client:${newName}`);
    const vs = tx.objectStore('visits');
    visits.forEach((v) => vs.put({ ...v, client: newName, updatedAt: now, dev: S.device }));
  });
  return visits.length;
}

const cleanPhone = (s) => String(s || '').replace(/[^\d+ ]/g, '').replace(/\s+/g, ' ').trim();
const telHref = (ph) => `tel:${ph.replace(/[^\d+]/g, '')}`;

async function setClientPhone(name, phone) {
  const rec = await findClient(name);
  const now = Date.now();
  if (rec) await db.put('clients', { ...rec, phone: phone || undefined, updatedAt: now });
  else await db.put('clients', { name, source: 'app', createdAt: now, updatedAt: now, phone });
}

async function deleteClient(name) {
  const rec = await findClient(name);
  await db.transaction(['clients', 'deleted'], (tx) => {
    if (rec) tx.objectStore('clients').delete(rec.id);
    tx.objectStore('deleted').put(tomb('clients', name));
  });
}

async function addClient(name, phone) {
  await db.transaction(['clients', 'deleted'], (tx) => {
    const now = Date.now();
    tx.objectStore('clients').add({ name, source: 'app', createdAt: now, updatedAt: now, ...(phone ? { phone } : {}) });
    tx.objectStore('deleted').delete(`client:${name}`);
  });
}

function openClients(query = '') {
  let q = query;
  const renderList = () => {
    const nq = norm(q.trim());
    const all = nq ? S.clients.filter((n) => norm(n).includes(nq)) : S.clients;
    const shown = all.slice(0, 80);
    $('#c-list').innerHTML = shown.map((n) =>
      `<button class="row" data-act="edit-client" data-v="${esc(n)}"><span class="main"><div class="title" style="font-weight:400">${nameHtml(n, nq)}</div></span><span class="amt" style="color:var(--muted)">›</span></button>`).join('') +
      (all.length > shown.length ? `<p class="note" style="text-align:center">…και ${all.length - shown.length} ακόμα. Γράψε για αναζήτηση.</p>` : '') +
      (!all.length ? '<div class="empty">Κανένα όνομα.</div>' : '');
  };
  openSheet({
    title: `Πελατολόγιο (${S.clients.length})`,
    body: `
      <input class="input" data-field="q" placeholder="Αναζήτηση…" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(q)}">
      <button class="btn primary" data-act="new-client" style="margin:10px 0 14px">＋ Νέος πελάτης</button>
      <div class="list" id="c-list"></div>`,
    onInput(el) { if (el.dataset.field === 'q') { q = el.value; renderList(); } },
    onAction(act, el) {
      if (act === 'edit-client') openClientEdit(el.dataset.v, q);
      if (act === 'new-client') openClientEdit(null, q);
    },
  });
  renderList();
}

async function openClientEdit(name, backQuery) {
  const N = name ? { ...splitName(name), phone: S.phones.get(name) || '' } : { surname: '', first: '', phone: '' };
  const oldPhone = N.phone;
  const visitCount = name ? (await db.getAll('visits')).filter((v) => v.client === name).length : 0;
  openSheet({
    title: name ? 'Επεξεργασία πελάτη' : 'Νέος πελάτης',
    body: `
      <div class="grid2">
        <label class="field"><span class="lbl">Επώνυμο</span>
          <input class="input" data-field="surname" autocapitalize="words" autocorrect="off" spellcheck="false" value="${esc(N.surname)}"></label>
        <label class="field"><span class="lbl">Όνομα</span>
          <input class="input" data-field="first" autocapitalize="words" autocorrect="off" spellcheck="false" value="${esc(N.first)}"></label>
      </div>
      <label class="field"><span class="lbl">Τηλέφωνο (προαιρετικό)</span>
        <input class="input" data-field="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="69…" value="${esc(N.phone)}"></label>
      ${N.phone ? `<a class="btn" style="text-decoration:none;margin-bottom:12px" href="${telHref(N.phone)}">📞 Κλήση ${esc(N.phone)}</a>` : ''}
      ${name ? `<p class="note">Καταχωρήσεις με αυτό το όνομα: <b>${visitCount}</b>. Αν αλλάξεις το όνομα, αλλάζει και σε αυτές.
        Αν γράψεις όνομα που υπάρχει ήδη, οι δύο πελάτες ενώνονται.</p>` : ''}`,
    foot: `<div class="btn-row">
      ${name ? '<button class="btn danger" data-act="delete">Διαγραφή</button>' : ''}
      <button class="btn primary" data-act="save">Αποθήκευση</button></div>
      <button class="btn" data-act="back" style="margin-top:8px;min-height:44px;font-size:16px;background:transparent;color:var(--muted)">← Πίσω στη λίστα</button>`,
    onInput(el) { if (el.dataset.field in N) N[el.dataset.field] = el.value; },
    async onAction(act) {
      if (act === 'back') return openClients(backQuery);
      if (act === 'save') {
        if (!cleanName(N.surname) || !cleanName(N.first)) return toast('Γράψε επώνυμο ΚΑΙ όνομα');
        const newName = joinName(N.surname, N.first);
        const clash = S.clients.find((n) => norm(n) === norm(newName) && n !== name);
        if (!name) {
          if (clash) return toast(`Υπάρχει ήδη: ${clash}`);
          const sim = similarClients(N.surname, N.first);
          if (sim.length && !confirm(`Υπάρχει ήδη παρόμοιο όνομα:\n${sim.join('\n')}\n\nΣίγουρα είναι ΝΕΟΣ πελάτης;`)) return;
          await addClient(newName, cleanPhone(N.phone));
          toast(`Προστέθηκε: ${newName}`);
        } else {
          let finalName = name;
          if (newName !== name) {
            if (clash && !confirm(`Το «${clash}» υπάρχει ήδη.\nΝα ενωθούν σε έναν πελάτη;`)) return;
            finalName = clash || newName;
            const n = await renameClient(name, finalName);
            toast(`Αποθηκεύτηκε${n ? ` (και σε ${n} ${n === 1 ? 'καταχώρηση' : 'καταχωρήσεις'})` : ''}`);
          } else toast('Αποθηκεύτηκε');
          if (cleanPhone(N.phone) !== cleanPhone(oldPhone)) await setClientPhone(finalName, cleanPhone(N.phone));
        }
        await loadStatic();
        await refreshDay();
        openClients(backQuery);
      }
      if (act === 'delete') {
        if (!confirm(`Διαγραφή «${name}» από το πελατολόγιο;\n\nΟι παλιές καταχωρήσεις μένουν όπως είναι.`)) return;
        await deleteClient(name);
        await loadStatic();
        toast('Διαγράφηκε από το πελατολόγιο');
        openClients(backQuery);
      }
    },
  });
}

// ---------------------------------------------------------------- διαχείριση: πάγια έξοδα
// Ενοίκιο, λογιστής, ΕΦΚΑ κ.λπ. Μπαίνουν ΜΙΑ φορά εδώ (όχι στα καθημερινά έξοδα) και
// μοιράζονται αυτόματα στις ημέρες κάθε μήνα στα Αποτελέσματα.
// Αποθήκευση: meta 'fixedCosts' = { items:[{id,name,amount,freq,from,to}], updatedAt }
const FREQ = { month: ['Κάθε μήνα', 1], quarter: ['Κάθε τρίμηνο', 3], year: ['Μία φορά τον χρόνο', 12] };
async function getFixed() { return (await db.getMeta('fixedCosts')) || { items: [], updatedAt: 0 }; }
async function saveFixed(items) { await db.setMeta('fixedCosts', { items, updatedAt: Date.now() }); }
const monthLabel = (ym) => { if (!ym) return ''; const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('el-GR', { month: 'short', year: 'numeric' }); };

async function openFixed() {
  const { items } = await getFixed();
  const active = (f) => !f.to || f.to >= todayStr().slice(0, 7);
  const perMonth = sum(items.filter(active).map((f) => Math.round(f.amount / FREQ[f.freq][1])));
  openSheet({
    title: 'Πάγια έξοδα',
    body: `
      <p class="note" style="margin-top:0">Ενοίκιο, λογιστής, ΕΦΚΑ, ρεύμα (αν είναι σταθερό)… Γράψ’ τα <b>μία φορά εδώ</b> — όχι στα
        καθημερινά έξοδα — και αφαιρούνται αυτόματα από το κέρδος κάθε μήνα στα Αποτελέσματα.</p>
      <div class="card" style="margin-bottom:12px"><div class="kv total"><span>Σύνολο ανά μήνα (τώρα)</span><span>${fmt(perMonth)}</span></div></div>
      <div class="list">${items.map((f) => `
        <button class="row" data-act="edit-fixed" data-id="${f.id}">
          <span class="main"><div class="title">${esc(f.name)}</div>
            <div class="sub">${FREQ[f.freq][0]} · από ${monthLabel(f.from)}${f.to ? ` έως ${monthLabel(f.to)}` : ''}${active(f) ? '' : ' · έληξε'}</div></span>
          <span class="amt">${fmt(f.amount)}</span></button>`).join('') || '<div class="empty">Κανένα πάγιο ακόμα.</div>'}
      </div>
      <button class="btn primary" data-act="new-fixed" style="margin-top:14px">＋ Νέο πάγιο</button>
      <p class="note">Αν αλλάξει ένα ποσό (π.χ. αύξηση ενοικίου), βάλε «έως» στο παλιό και φτιάξε νέο από τον επόμενο μήνα — έτσι τα παλιά αποτελέσματα μένουν σωστά.</p>`,
    onAction(act, el) {
      if (act === 'new-fixed') openFixedEdit(null);
      if (act === 'edit-fixed') openFixedEdit(items.find((f) => f.id === el.dataset.id));
    },
  });
}

async function openFixedEdit(item) {
  const F = item ? { ...item } : { id: db.newUid(), name: '', amount: null, freq: 'month', from: todayStr().slice(0, 7), to: '' };
  openSheet({
    title: item ? item.name : 'Νέο πάγιο',
    body: `
      <label class="field"><span class="lbl">Τι είναι</span>
        <input class="input" data-field="name" autocapitalize="sentences" placeholder="π.χ. Ενοίκιο" value="${esc(F.name)}"></label>
      <label class="field"><span class="lbl">Ποσό</span>
        <span class="money"><input class="input" data-field="amount" inputmode="decimal" placeholder="0" value="${toInput(F.amount)}"><span class="cur">€</span></span></label>
      <label class="field"><span class="lbl">Πόσο συχνά πληρώνεται</span>
        <select class="input" data-field="freq">${Object.entries(FREQ).map(([k, [l]]) => `<option value="${k}" ${F.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Από μήνα</span><input class="input" type="month" data-field="from" value="${esc(F.from)}"></label>
        <label class="field"><span class="lbl">Έως (προαιρετικό)</span><input class="input" type="month" data-field="to" value="${esc(F.to || '')}"></label>
      </div>
      <p class="note">Τρίμηνα και ετήσια μοιράζονται ισόποσα στους μήνες (π.χ. 600 € τον χρόνο = 50 € τον μήνα).</p>`,
    foot: `<div class="btn-row">${item ? '<button class="btn danger" data-act="delete">Διαγραφή</button>' : ''}
      <button class="btn primary" data-act="save">Αποθήκευση</button></div>
      <button class="btn" data-act="back" style="margin-top:8px;min-height:44px;font-size:16px;background:transparent;color:var(--muted)">← Πίσω</button>`,
    onInput(el) {
      const f = el.dataset.field;
      if (f === 'amount') F.amount = parseMoney(el.value);
      else if (f) F[f] = el.value;
    },
    onChange(el) { const f = el.dataset.field; if (f === 'freq' || f === 'from' || f === 'to') F[f] = el.value; },
    async onAction(act) {
      if (act === 'back') return openFixed();
      const { items } = await getFixed();
      if (act === 'save') {
        F.name = cleanName(F.name);
        if (!F.name) return toast('Γράψε τι είναι');
        if (!Number.isFinite(F.amount) || F.amount <= 0) return toast('Γράψε σωστό ποσό');
        if (!/^\d{4}-\d{2}$/.test(F.from)) return toast('Διάλεξε μήνα έναρξης');
        if (F.to && F.to < F.from) return toast('Το «έως» είναι πριν το «από»');
        F.to = F.to || null;
        await saveFixed([...items.filter((x) => x.id !== F.id), F]);
        toast('Αποθηκεύτηκε');
        openFixed();
      }
      if (act === 'delete') {
        if (!confirm(`Διαγραφή του παγίου «${item.name}»;\n\nΘα φύγει και από τα παλιά αποτελέσματα. Αν απλώς σταμάτησε, βάλε καλύτερα «έως».`)) return;
        await saveFixed(items.filter((x) => x.id !== F.id));
        openFixed();
      }
    },
  });
}

// ---------------------------------------------------------------- διαχείριση: τιμοκατάλογος
// Οι αλλαγές τιμών ισχύουν για νέες καταχωρήσεις· οι παλιές κρατούν το ποσό που γράφτηκε.
function openCatalog() {
  openSheet({
    title: 'Τιμοκατάλογος',
    body: `
      <p class="note" style="margin-top:0">Οι αλλαγές ισχύουν για νέες καταχωρήσεις. Οι παλιές κρατούν το ποσό τους
        (για διόρθωση παλιάς: άνοιξέ τη από τη λίστα της ημέρας).</p>
      <div class="list">${S.categories.map((c) => `
        <button class="row" data-act="edit-cat" data-v="${esc(c.name)}">
          <span class="main"><div class="title">${esc(c.name)}</div><div class="sub">${c.prices.map(fmt).join(' · ') || '—'}</div></span>
          <span class="amt" style="color:var(--muted)">›</span></button>`).join('')}
      </div>
      <button class="btn primary" data-act="new-cat" style="margin-top:14px">＋ Νέα εργασία</button>`,
    onAction(act, el) {
      if (act === 'edit-cat') openCategoryEdit(S.categories.find((c) => c.name === el.dataset.v));
      if (act === 'new-cat') openCategoryEdit(null);
    },
  });
}

function openCategoryEdit(cat) {
  const C = cat ? { ...cat, prices: [...cat.prices] } : { name: '', prices: [], order: Math.max(-1, ...S.categories.map((c) => c.order)) + 1 };
  const renderPrices = () => {
    $('#cat-prices').innerHTML = C.prices.length
      ? C.prices.map((p, i) => `<button class="chip on" data-act="rm-price" data-i="${i}">${fmt(p)} ✕</button>`).join('')
      : '<p class="note" style="margin:0">Καμία τιμή — στην καταχώρηση γράφεται το ποσό με το χέρι.</p>';
  };
  const addPrice = () => {
    const el = $('#sheet [data-field=newprice]');
    const v = parseMoney(el.value);
    if (v == null) return;
    if (Number.isNaN(v)) return toast('Μη έγκυρο ποσό');
    if (!C.prices.includes(v)) C.prices = [...C.prices, v].sort((a, b) => a - b);
    el.value = '';
    renderPrices();
  };
  openSheet({
    title: cat ? cat.name : 'Νέα εργασία',
    body: `
      ${cat ? '' : `<label class="field"><span class="lbl">Όνομα εργασίας</span>
        <input class="input" data-field="name" autocapitalize="sentences" placeholder="π.χ. Κερατίνη"></label>`}
      <span class="lbl" style="display:block;font-size:15px;font-weight:600;color:var(--muted);margin:0 4px 8px">Τιμές (πάτα για αφαίρεση)</span>
      <div class="chips" id="cat-prices"></div>
      <div class="money" style="margin-top:14px">
        <input class="input" data-field="newprice" inputmode="decimal" placeholder="Νέα τιμή">
        <span class="cur">€</span>
        <button class="btn" data-act="add-price" style="width:auto">Προσθήκη</button>
      </div>`,
    foot: `<div class="btn-row">
      ${cat ? '<button class="btn danger" data-act="delete">Διαγραφή</button>' : ''}
      <button class="btn primary" data-act="save">Αποθήκευση</button></div>
      <button class="btn" data-act="back" style="margin-top:8px;min-height:44px;font-size:16px;background:transparent;color:var(--muted)">← Πίσω</button>`,
    onInput(el) { if (el.dataset.field === 'name') C.name = el.value; },
    async onAction(act, el) {
      if (act === 'back') return openCatalog();
      if (act === 'add-price') addPrice();
      if (act === 'rm-price') { C.prices.splice(+el.dataset.i, 1); renderPrices(); }
      if (act === 'save') {
        addPrice(); // ό,τι έμεινε γραμμένο στο πεδίο
        const name = cleanName(C.name);
        if (!name) return toast('Γράψε όνομα εργασίας');
        if (!cat && (name === OTHER || S.categories.some((c) => norm(c.name) === norm(name)))) return toast('Υπάρχει ήδη εργασία με αυτό το όνομα');
        await db.transaction(['categories', 'deleted'], (tx) => {
          tx.objectStore('categories').put({ name, prices: C.prices, order: C.order, updatedAt: Date.now() });
          tx.objectStore('deleted').delete(`cat:${name}`);
        });
        await loadStatic();
        toast('Αποθηκεύτηκε');
        openCatalog();
      }
      if (act === 'delete') {
        if (!confirm(`Διαγραφή της εργασίας «${cat.name}» από τον τιμοκατάλογο;\n\nΟι παλιές καταχωρήσεις μένουν όπως είναι.`)) return;
        await db.transaction(['categories', 'deleted'], (tx) => {
          tx.objectStore('categories').delete(cat.name);
          tx.objectStore('deleted').put(tomb('categories', cat.name));
        });
        await loadStatic();
        toast('Διαγράφηκε');
        openCatalog();
      }
    },
  });
  renderPrices();
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
  const sent = await sendInfo();
  const phone = (await db.getMeta('lydiaPhone')) || '';
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
      <h2>Διορθώσεις</h2>
      <div class="stack">
        <button class="btn" data-act="mgmt-clients">Πελατολόγιο (${S.clients.length})</button>
        <button class="btn" data-act="mgmt-catalog">Τιμοκατάλογος</button>
        <button class="btn" data-act="mgmt-fixed">Πάγια έξοδα (ενοίκιο κ.λπ.)</button>
      </div>
      <p class="note">Λάθος σε ποσό ή εργασία μιας μέρας: πήγαινε στη μέρα (‹ ›) και πάτα την καταχώρηση.</p>
      <h2>Αποστολή στη Λυδία</h2>
      <div class="card">
        <div class="kv"><span>Τελευταία αποστολή</span><span>${fmtWhen(sent.lastSent)}</span></div>
        <div class="kv"><span>Εκκρεμούν</span><span class="${sent.pending.length ? 'bad' : 'ok'}">${sent.pending.length ? sent.pending.map(fmtDateShort).join(', ') : 'τίποτα ✓'}</span></div>
        <label class="field" style="margin:12px 0 0"><span class="lbl">Κινητό Λυδίας (Viber) — μόνο σε αυτή τη συσκευή</span>
          <input class="input" data-field="phone" inputmode="tel" autocomplete="off" placeholder="+30 69…" value="${esc(phone)}"></label>
      </div>
      <div class="stack" style="margin-top:10px">
        <button class="btn primary" data-act="send">Στείλε στη Λυδία τώρα</button>
      </div>
      <h2>Αρχεία</h2>
      <div class="stack">
        <button class="btn" data-act="dl-backup">Λήψη πλήρους backup</button>
        <button class="btn" data-act="dl-csv">Λήψη CSV για Excel (όλες οι ημέρες)</button>
        <label class="btn" style="cursor:pointer">Εισαγωγή αρχείου…
          <input type="file" data-field="import" accept=".json,.txt,application/json,text/plain" hidden></label>
      </div>
      <p class="note">Η εισαγωγή <b>συγχωνεύει</b>: δεν σβήνει ό,τι υπάρχει. Δέχεται αρχείο backup της εφαρμογής
        (από άλλη συσκευή ή για επαναφορά) ή αρχείο πελατολογίου.</p>
      <p class="note" style="text-align:center;margin-top:18px">Έκδοση ${APP_VERSION}</p>`,
    onInput(el) {
      if (el.dataset.field === 'phone') db.setMeta('lydiaPhone', el.value.trim());
    },
    async onChange(el) {
      if (el.dataset.field === 'import' && el.files?.[0]) {
        const ok = await importFromFile(el.files[0]);
        el.value = '';
        if (ok) closeSheet();
      }
    },
    async onAction(act) {
      if (act === 'send') { closeSheet(); openSendSheet(); }
      if (act === 'mgmt-clients') openClients();
      if (act === 'mgmt-catalog') openCatalog();
      if (act === 'mgmt-fixed') openFixed();
      if (act === 'dl-backup') {
        backup.download(backup.makeFile(JSON.stringify(await backup.buildBackup()), `kommotirio-backup-${backup.stamp()}.json`, 'application/json'));
      }
      if (act === 'dl-csv') {
        backup.download(backup.makeFile(await backup.buildCSV(), `kommotirio-ola-${backup.stamp()}.csv`, 'text/csv'));
      }
    },
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

const DAY_FIELDS = ['posTotal', 'retail', 'vat'];

async function onTillChange(el) {
  if (S.day.locked) return;
  if (el.hasAttribute('data-pos')) return onPosChange(el);
  const key = el.dataset.day;
  const v = parseMoney(el.value);
  if (Number.isNaN(v)) { toast('Μη έγκυρο ποσό'); el.focus(); return; }
  if (DAY_FIELDS.includes(key)) await saveDay({ [key]: v });
  el.value = toInput(v);
  renderTillSummary();
  renderSendStatus();
  if (!S.persisted) ensurePersistent();
}

// Οι γραμμές POS αποθηκεύονται όλες μαζί (οι κενές αγνοούνται).
async function onPosChange(el) {
  if (S.day.locked) return;
  const inputs = [...document.querySelectorAll('#pos-parts input[data-pos]')];
  const values = inputs.map((i) => parseMoney(i.value));
  if (values.some(Number.isNaN)) { toast('Μη έγκυρο ποσό'); el?.focus(); return; }
  inputs.forEach((i, k) => { if (values[k] != null) i.value = toInput(values[k]); });
  await saveDay({ posParts: values.filter((v) => v != null) });
  renderTillSummary();
  renderSendStatus();
  if (!S.persisted) ensurePersistent();
}

function renumberPos() {
  document.querySelectorAll('#pos-parts .pos-row .num').forEach((n, i) => (n.textContent = `${i + 1}.`));
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
    if (act === 'open-calls') openCalls();
    if (act === 'edit-visit') openVisit(S.visits.find((v) => v.id === +el.dataset.id));
    if (act === 'new-expense') openExpense();
    if (act === 'pos-add') {
      const box = $('#pos-parts');
      box.querySelector('p.note')?.remove();
      box.insertAdjacentHTML('beforeend', posRowHtml(null, box.children.length, false));
      box.lastElementChild.querySelector('input').focus();
    }
    if (act === 'pos-rm') {
      el.closest('.pos-row').remove();
      renumberPos();
      await onPosChange();
    }
    if (act === 'send') openSendSheet();
    if (act === 'edit-expense') openExpense(S.expenses.find((x) => x.id === +el.dataset.id));
    if (act === 'lock') {
      if (!confirm(`Κλείσιμο της ημέρας ${dayTitle(S.date)};`)) return;
      // Πρώτα αποθηκεύουμε ό,τι γράφεται εκείνη τη στιγμή σε πεδίο.
      const active = document.activeElement;
      if (active?.dataset?.day || active?.hasAttribute?.('data-pos')) await onTillChange(active);
      await saveDay({ locked: true, lockedAt: Date.now() });
      render();
      // Υποχρεωτικό βήμα: αποστολή / backup αμέσως μετά το κλείσιμο.
      openSendSheet({ mandatory: true });
    }
    if (act === 'unlock') {
      if (!confirm('Ξεκλείδωμα ημέρας; Θα μπορούν να γίνουν αλλαγές.')) return;
      await saveDay({ locked: false, lockedAt: null });
      render();
    }
  });
  $('#main').addEventListener('change', (e) => {
    if (e.target.dataset.day || e.target.hasAttribute('data-pos')) onTillChange(e.target);
  });
  $('#main').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.dataset.day || e.target.hasAttribute('data-pos'))) e.target.blur();
  });

  const sheet = $('#sheet');
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return sheetHandlers?.noClose ? undefined : closeSheet();
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'close') return closeSheet();
    sheetHandlers?.onAction?.(el.dataset.act, el, e);
  });
  sheet.addEventListener('input', (e) => sheetHandlers?.onInput?.(e.target, e));
  sheet.addEventListener('change', (e) => sheetHandlers?.onChange?.(e.target, e));
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });

  $('#backup-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-act=send]')) openSendSheet();
  });
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
    renderBackupBanner();
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
    S.device = await db.getMeta('deviceId');
    if (!S.device) { S.device = db.newUid(); await db.setMeta('deviceId', S.device); }
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
