// Αποτελέσματα — πλήρες ριπόρτ. Όλα υπολογίζονται τοπικά από τη βάση.
//
// Ορισμοί:
//   Εργασίες = άθροισμα επισκέψεων · Τζίρος = Εργασίες + Μεταπώληση · Κέρδος = Τζίρος − Έξοδα
//   POS = τρόπος πληρωμής (όχι έσοδο). Κάρτα % = POS / τζίρος, μόνο σε ημέρες με καταχωρημένο POS.
//   Πληρωμές χωρίς κάρτα (εκτίμηση) = επισκέψεις − γραμμές POS, σε ημέρες με γραμμές POS.

import * as db from './db.js';

// ---------------------------------------------------------------- βοηθητικά
const MONTHS = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μάι', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];
const MONTHS_LONG = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
const WD = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'];
const WD_LONG = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur0 = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('el-GR', { maximumFractionDigits: 1 });
const fmt = (c) => eur0.format(Math.round((c || 0) / 100));
const fmtS = (c) => (c < 0 ? '−' + fmt(-c) : fmt(c));
const pctN = (a, b) => (b ? (a / b) * 100 : null);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');

const toD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = toD(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / 86400000);
const today = () => ymd(new Date());
const telLink = (ph) => (ph ? `<a class="tel" href="tel:${esc(ph.replace(/[^\d+]/g, ''))}" onclick="event.stopPropagation()">📞 ${esc(ph)}</a>` : '');
const fDate = (s) => toD(s).toLocaleDateString('el-GR', { day: 'numeric', month: 'short', year: 'numeric' });
const fDateW = (s) => toD(s).toLocaleDateString('el-GR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mode = (a) => { const c = new Map(); a.forEach((x) => c.set(x, (c.get(x) || 0) + 1)); return [...c].sort((x, y) => y[1] - x[1])[0]?.[0]; };

// Ορθόδοξο Πάσχα (αλγόριθμος Meeus για Ιουλιανό + 13 ημέρες, 1900–2099).
function orthodoxEaster(y) {
  const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31), day = ((d + e + 114) % 31) + 1;
  const dt = new Date(y, month - 1, day); dt.setDate(dt.getDate() + 13);
  return ymd(dt);
}
const HOLIDAYS = {
  easter: { label: 'Πάσχα (2 εβδομάδες πριν)', range: (y) => { const e = orthodoxEaster(y); return { from: addDays(e, -14), to: addDays(e, -1) }; } },
  xmas: { label: 'Χριστούγεννα – Φώτα (15/12–6/1)', range: (y) => ({ from: `${y}-12-15`, to: `${y + 1}-01-06` }) },
};

// ---------------------------------------------------------------- «έχουν αργήσει»
// Πελάτισσα με ≥2 επισκέψεις που δεν ήρθε για > 1,5× το συνηθισμένο της διάστημα και ≥ 4 εβδομάδες.
export const isOverdue = (every, visits, since) => every != null && visits >= 2 && since >= 28 && since > every * 1.5;

// Για την καθημερινή οθόνη: όλο το ιστορικό, ως σήμερα. Ταξινόμηση: όσες φέρνουν τα περισσότερα πρώτες.
export async function overdueClients() {
  const visits = await db.getAll('visits');
  const by = new Map();
  for (const v of visits) { if (!by.has(v.client)) by.set(v.client, []); by.get(v.client).push(v); }
  const out = [], now = today();
  for (const [name, vs] of by) {
    const dates = [...new Set(vs.map((v) => v.date))].sort();
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const every = median(gaps), last = dates[dates.length - 1], since = daysBetween(last, now);
    if (!isOverdue(every, dates.length, since)) continue;
    out.push({ name, every, last, since, visits: dates.length, spend: sum(vs.map((v) => v.total)),
      fav: mode(vs.flatMap((v) => v.items.map((i) => i.cat))), staff: mode(vs.map((v) => v.staff)) });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

// ---------------------------------------------------------------- κατάσταση
const R = {
  kind: 'year', year: new Date().getFullYear(), month: new Date().getMonth(), quarter: Math.floor(new Date().getMonth() / 3),
  holiday: 'easter', from: null, to: null, staff: '', compare: 'prev', section: 'summary',
  clientQuery: '', clientSort: 'spend', clientLimit: 40, clientOpen: null, catSort: 'count',
};
let D = null; // δεδομένα

async function load() {
  const [visits, days, expenses, staff, clients] = await Promise.all(['visits', 'days', 'expenses', 'staff', 'clients'].map((s) => db.getAll(s)));
  const phones = new Map(clients.filter((c) => c.phone).map((c) => [c.name, c.phone]));
  const fixed = ((await db.getMeta('fixedCosts')) || { items: [] }).items;
  visits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const all = [...visits.map((v) => v.date), ...days.map((d) => d.date), ...expenses.map((e) => e.date)].sort();
  // Ιστορικό ανά πελάτισσα (όλων των εποχών) για συχνότητα / «έχουν αργήσει».
  const hist = new Map();
  for (const v of visits) {
    if (!hist.has(v.client)) hist.set(v.client, []);
    hist.get(v.client).push(v);
  }
  const years = new Set([new Date().getFullYear()]);
  all.forEach((d) => years.add(+d.slice(0, 4)));
  D = {
    visits, days, expenses, dayMap, hist, phones, fixed,
    staffOrder: staff.sort((a, b) => a.order - b.order).map((s) => s.name),
    first: all[0] || today(), last: all[all.length - 1] || today(),
    years: [...years].sort((a, b) => b - a),
  };
}

// ---------------------------------------------------------------- περίοδοι
function periodFor(P) {
  const y = P.year;
  if (P.kind === 'year') return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` };
  if (P.kind === 'month') {
    const last = new Date(y, P.month + 1, 0).getDate();
    const m = String(P.month + 1).padStart(2, '0');
    return { from: `${y}-${m}-01`, to: `${y}-${m}-${last}`, label: `${MONTHS_LONG[P.month]} ${y}` };
  }
  if (P.kind === 'quarter') {
    const m1 = P.quarter * 3, last = new Date(y, m1 + 3, 0);
    return { from: `${y}-${String(m1 + 1).padStart(2, '0')}-01`, to: ymd(last), label: `${P.quarter + 1}ο τρίμηνο ${y}` };
  }
  if (P.kind === 'holiday') { const h = HOLIDAYS[P.holiday]; return { ...h.range(y), label: `${h.label} ${y}` }; }
  if (P.kind === 'range') {
    const from = P.from || D.first, to = P.to || D.last;
    return { from, to, label: `${fDate(from)} – ${fDate(to)}` };
  }
  return { from: D.first, to: D.last, label: 'Όλα τα δεδομένα' };
}

function compareFor(P, cur) {
  if (R.compare === 'none' || P.kind === 'all') return null;
  if (R.compare === 'lastyear') {
    if (P.kind === 'range') {
      const shift = (s) => `${+s.slice(0, 4) - 1}${s.slice(4)}`.replace('-02-29', '-02-28');
      return { from: shift(cur.from), to: shift(cur.to), label: 'ίδια περίοδο πέρυσι' };
    }
    return { ...periodFor({ ...P, year: P.year - 1 }), label: 'ίδια περίοδο πέρυσι' };
  }
  if (P.kind === 'year') return { ...periodFor({ ...P, year: P.year - 1 }), label: `${P.year - 1}` };
  if (P.kind === 'month') {
    const m = P.month === 0 ? 11 : P.month - 1, y = P.month === 0 ? P.year - 1 : P.year;
    return { ...periodFor({ ...P, month: m, year: y }), label: `${MONTHS_LONG[m]} ${y}` };
  }
  if (P.kind === 'quarter') {
    const q = P.quarter === 0 ? 3 : P.quarter - 1, y = P.quarter === 0 ? P.year - 1 : P.year;
    return { ...periodFor({ ...P, quarter: q, year: y }), label: `${q + 1}ο τρίμηνο ${y}` };
  }
  if (P.kind === 'holiday') return { ...periodFor({ ...P, year: P.year - 1 }), label: `${HOLIDAYS[P.holiday].label} ${P.year - 1}` };
  const n = daysBetween(cur.from, cur.to) + 1;
  return { from: addDays(cur.from, -n), to: addDays(cur.from, -1), label: 'προηγούμενη ίδια διάρκεια' };
}

const inR = (d, r) => d >= r.from && d <= r.to;

// Πάγια: μηνιαίο ισοδύναμο μοιρασμένο στις ημέρες κάθε μήνα. Δεν μετράνε μελλοντικές ημέρες.
const FREQ_M = { month: 1, quarter: 3, year: 12 };
function fixedFor(r) {
  const per = new Map(); let total = 0;
  const end = r.to < today() ? r.to : today();
  if (end < r.from) return { total: 0, per };
  for (const f of D.fixed) {
    const monthly = f.amount / (FREQ_M[f.freq] || 1);
    let y = +r.from.slice(0, 4), m = +r.from.slice(5, 7);
    while (`${y}-${String(m).padStart(2, '0')}` <= end.slice(0, 7)) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      if (ym >= f.from && (!f.to || ym <= f.to)) {
        const dim = new Date(y, m, 0).getDate();
        const ms = `${ym}-01`, me = `${ym}-${String(dim).padStart(2, '0')}`;
        const s = r.from > ms ? r.from : ms, e = end < me ? end : me;
        const v = (monthly * (daysBetween(s, e) + 1)) / dim;
        total += v; per.set(f.name, (per.get(f.name) || 0) + v);
      }
      if (++m > 12) { m = 1; y++; }
    }
  }
  return { total: Math.round(total), per };
}

// ---------------------------------------------------------------- υπολογισμοί
function aggregate(r) {
  const vis = D.visits.filter((v) => inR(v.date, r) && (!R.staff || v.staff === R.staff));
  const days = D.days.filter((d) => inR(d.date, r));
  const exps = D.expenses.filter((e) => inR(e.date, r));
  const a = {
    vis, days, exps,
    services: sum(vis.map((v) => v.total)),
    retail: R.staff ? 0 : sum(days.map((d) => d.retail)),
    varExpenses: R.staff ? 0 : sum(exps.map((e) => e.amount)),
    fixed: R.staff ? { total: 0, per: new Map() } : fixedFor(r),
    visits: vis.length,
    clients: new Set(vis.map((v) => v.client)).size,
    workDays: new Set(vis.map((v) => v.date)).size,
    vat: sum(days.map((d) => d.vat)),
  };
  a.expenses = a.varExpenses + a.fixed.total;
  a.turnover = a.services + a.retail;
  a.profit = a.turnover - a.expenses;
  a.profitAfterVat = a.profit - a.vat;
  a.avgTicket = a.visits ? a.services / a.visits : 0;
  a.perDay = a.workDays ? a.turnover / a.workDays : 0;

  // Πληρωμές (όλο το κατάστημα, ανεξάρτητα από φίλτρο υπαλλήλου)
  const allVis = R.staff ? D.visits.filter((v) => inR(v.date, r)) : vis;
  const byDay = new Map();
  for (const v of allVis) {
    const x = byDay.get(v.date) || { s: 0, n: 0 };
    x.s += v.total; x.n++;
    byDay.set(v.date, x);
  }
  let pos = 0, base = 0, posDays = 0, tx = 0, txAmt = 0, txVisits = 0, partsDays = 0, mismatch = 0, missing = 0;
  const txList = [];
  for (const d of days) {
    const dv = byDay.get(d.date) || { s: 0, n: 0 };
    if (d.posTotal != null) { pos += d.posTotal; base += dv.s + (d.retail || 0); posDays++; } else if (dv.n) missing++;
    const parts = d.posParts || [];
    if (parts.length) { tx += parts.length; txAmt += sum(parts); txVisits += dv.n; partsDays++; txList.push(...parts); }
    if (parts.length && d.posTotal != null && sum(parts) !== d.posTotal) mismatch++;
  }
  a.pay = { pos, base, posDays, cardPct: pctN(pos, base), cash: base - pos, tx, txAmt, txVisits, partsDays, mismatch, missing, txList,
    noCard: Math.max(0, txVisits - tx), cardClientsPct: pctN(tx, txVisits) };
  return a;
}

// Κουβάδες για γραφήματα χρόνου: ημέρα (≤45 ημ.), εβδομάδα (≤200), μήνας.
function buckets(r) {
  const n = daysBetween(r.from, r.to) + 1, out = [];
  if (n <= 45) {
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push({ from: d, to: d, label: `${toD(d).getDate()}/${toD(d).getMonth() + 1}`, long: fDateW(d) });
  } else if (n <= 200) {
    let d = r.from; const wd = toD(d).getDay(); d = addDays(d, -((wd + 6) % 7)); // Δευτέρα
    for (; d <= r.to; d = addDays(d, 7)) out.push({ from: d < r.from ? r.from : d, to: addDays(d, 6) > r.to ? r.to : addDays(d, 6), label: `${toD(d).getDate()}/${toD(d).getMonth() + 1}`, long: `Εβδ. ${fDate(d)}` });
  } else {
    let y = +r.from.slice(0, 4), m = +r.from.slice(5, 7) - 1;
    while (`${y}-${String(m + 1).padStart(2, '0')}` <= r.to.slice(0, 7)) {
      const p = periodFor({ kind: 'month', year: y, month: m });
      out.push({ from: p.from < r.from ? r.from : p.from, to: p.to > r.to ? r.to : p.to, label: n > 400 ? `${MONTHS[m]} ${String(y).slice(2)}` : MONTHS[m], long: p.label, drill: { kind: 'month', year: y, month: m } });
      if (++m === 12) { m = 0; y++; }
    }
  }
  for (const b of out) {
    const v = D.visits.filter((x) => inR(x.date, b) && (!R.staff || x.staff === R.staff));
    b.services = sum(v.map((x) => x.total));
    b.retail = R.staff ? 0 : sum(D.days.filter((x) => inR(x.date, b)).map((x) => x.retail));
    b.turnover = b.services + b.retail;
    b.expenses = R.staff ? 0 : sum(D.expenses.filter((x) => inR(x.date, b)).map((x) => x.amount)) + fixedFor(b).total;
    b.visits = v.length;
    const pd = D.days.filter((x) => inR(x.date, b) && x.posTotal != null);
    const pdSet = new Set(pd.map((x) => x.date));
    const allV = D.visits.filter((x) => pdSet.has(x.date));
    b.cardPct = pctN(sum(pd.map((x) => x.posTotal)), sum(allV.map((x) => x.total)) + sum(pd.map((x) => x.retail)));
  }
  return out;
}

// Πελάτισσες: ιστορικό όλων των εποχών μέχρι το τέλος της περιόδου.
function clientStats(r, a) {
  // Συχνότητα / «έχουν αργήσει»: πάντα με όλο το ιστορικό και ως σήμερα (πρακτική λίστα).
  const ref = today();
  const inPeriod = new Map();
  for (const v of a.vis) {
    const c = inPeriod.get(v.client) || { visits: 0, spend: 0, cats: [], staff: [] };
    c.visits++; c.spend += v.total; v.items.forEach((i) => c.cats.push(i.cat)); c.staff.push(v.staff);
    inPeriod.set(v.client, c);
  }
  const all = [];
  for (const [name, hv] of D.hist) {
    const upto = hv.filter((v) => v.date <= ref);
    if (!upto.length) continue;
    const dates = [...new Set(upto.map((v) => v.date))];
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const med = median(gaps);
    const last = dates[dates.length - 1];
    const since = daysBetween(last, ref);
    const p = inPeriod.get(name);
    all.push({
      name, first: dates[0], last, since, every: med, visitsAll: dates.length, spendAll: sum(upto.map((v) => v.total)),
      visits: p?.visits || 0, spend: p?.spend || 0, avg: p ? p.spend / p.visits : 0,
      fav: p ? mode(p.cats) : mode(upto.flatMap((v) => v.items.map((i) => i.cat))),
      favStaff: p ? mode(p.staff) : mode(upto.map((v) => v.staff)),
      overdue: isOverdue(med, dates.length, since),
    });
  }
  const active = all.filter((c) => c.visits);
  const newcomers = active.filter((c) => inR(c.first, r));
  const returning = active.length - newcomers.length;
  const newReturned = newcomers.filter((c) => D.hist.get(c.name).some((v) => v.date > c.first));
  const buckets = [
    ['Κάθε ≤ 3 εβδομάδες', (e) => e <= 21], ['Κάθε 3–6 εβδομάδες', (e) => e > 21 && e <= 42], ['Κάθε 6–10 εβδομάδες', (e) => e > 42 && e <= 70],
    ['Κάθε 10–16 εβδομάδες', (e) => e > 70 && e <= 112], ['Πιο αραιά από 16 εβδ.', (e) => e > 112],
  ].map(([label, f]) => ({ label, value: active.filter((c) => c.every != null && f(c.every)).length }));
  buckets.push({ label: 'Μία επίσκεψη μόνο', value: active.filter((c) => c.every == null).length });
  return {
    ref, all, active, newcomers, returning, newReturned, buckets,
    overdue: all.filter((c) => c.overdue).sort((x, y) => y.spendAll - x.spendAll),
    oneTimersGone: all.filter((c) => c.visitsAll === 1 && c.since > 90).length,
    medianEvery: median(active.map((c) => c.every).filter((x) => x != null)),
  };
}

function serviceStats(vis) {
  const cats = new Map(), pairs = new Map(), notes = new Map();
  for (const v of vis) {
    for (const it of v.items) {
      const c = cats.get(it.cat) || { name: it.cat, count: 0, amount: 0, prices: [], clients: new Set() };
      c.count++; c.amount += it.amount; c.prices.push(it.amount); c.clients.add(v.client);
      cats.set(it.cat, c);
      if (it.cat === 'Άλλο' && it.note) notes.set(it.note, (notes.get(it.note) || 0) + 1);
    }
    const u = [...new Set(v.items.map((i) => i.cat))].sort((a, b) => a.localeCompare(b, 'el'));
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
      const k = `${u[i]} + ${u[j]}`; pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  return {
    cats: [...cats.values()].map((c) => ({ ...c, avg: c.amount / c.count, common: mode(c.prices), clients: c.clients.size })),
    pairs: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 10),
    notes: [...notes].sort((a, b) => b[1] - a[1]).slice(0, 10),
    multi: vis.filter((v) => new Set(v.items.map((i) => i.cat)).size > 1).length,
  };
}

// ---------------------------------------------------------------- γραφικά
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
let chartSeq = 0;
const tipStore = new Map(); // id → [tooltip html ανά κουβά]

// Στήλες (1 ή 2 σειρές). series: [{key, label, cls}], valFmt για άξονα.
function barChart(bks, series, width, { pctAxis = false, tips = null } = {}) {
  const W = Math.max(300, Math.round(width)), narrow = W < 560;
  const H = narrow ? 210 : 250, L = narrow ? 46 : 64, Rm = 6, T = 12, B = 30;
  const vals = bks.flatMap((b) => series.map((s) => b[s.key] || 0));
  const max = pctAxis ? 100 : niceMax(Math.max(...vals, 0) / 100);
  const pw = W - L - Rm, ph = H - T - B, gw = pw / bks.length;
  const bw = Math.max(2, Math.min(22, (gw - (bks.length > 30 ? 2 : narrow ? 5 : 10)) / series.length - 1));
  const y = (v) => T + ph - ((pctAxis ? v : v / 100) / max) * ph;
  const bar = (x, top, cls) => {
    const h = T + ph - top; if (!(h > 0.5)) return '';
    const r = Math.min(4, h, bw / 2);
    return `<path class="${cls}" d="M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z"/>`;
  };
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = T + ph - (ph / 4) * i;
    const lab = pctAxis ? `${Math.round(v)}%` : narrow && v >= 1000 ? `${num.format(v / 1000)} χιλ.` : eur0.format(v);
    g += `<line class="grid" x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}"/><text class="tick" x="${L - 6}" y="${yy + 4}" text-anchor="end">${lab}</text>`;
  }
  const every = Math.ceil(bks.length / Math.floor(pw / (narrow ? 26 : 40)));
  let bars = '', labels = '', hits = '';
  const id = `c${++chartSeq}`;
  bks.forEach((b, i) => {
    const gx = L + gw * i, cx = gx + gw / 2, totalW = series.length * bw + (series.length - 1) * 2;
    series.forEach((s, k) => { if (b[s.key] != null) bars += bar(cx - totalW / 2 + k * (bw + 2), y(b[s.key]), s.cls); });
    if (i % every === 0) labels += `<text class="tick" x="${cx}" y="${H - 9}" text-anchor="middle">${esc(b.label)}</text>`;
    hits += `<rect class="hit" data-i="${i}" x="${gx}" y="${T}" width="${gw}" height="${ph + B}"/>`;
  });
  tipStore.set(id, { tips: bks.map((b, i) => (tips ? tips(b, i) : '')), drills: bks.map((b) => b.drill || null) });
  return `<div class="chart-wrap" data-chart="${id}">
    <svg viewBox="0 0 ${W} ${H}" role="img">${g}${hits}${bars}<line class="axis" x1="${L}" x2="${W - Rm}" y1="${T + ph}" y2="${T + ph}"/>${labels}</svg>
    <div class="tip" hidden></div></div>`;
}

function hbars(rows, valFmt = fmt, cls = '') {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar${r.onclick ? ' clickable' : ''}" ${r.attrs || ''}>
      <span class="hb-label">${r.labelHtml || esc(r.label)}</span>
      <span class="hb-track"><span class="hb-fill ${cls}" style="width:${Math.max(0.5, (r.value / max) * 100)}%"></span></span>
      <span class="hb-val">${valFmt(r.value)}${r.extra ? ` <small>${r.extra}</small>` : ''}</span>
    </div>`).join('')}</div>`;
}

const legend = (items) => `<div class="legend">${items.map(([cls, l]) => `<span><i class="sw ${cls}"></i>${l}</span>`).join('')}</div>`;

function delta(cur, prev, { invert = false, money = true, cmp } = {}) {
  if (!cmp || prev == null || cur == null) return '';
  if (!prev) return cur ? `<div class="delta">νέο σε σχέση με ${esc(cmp.label)}</div>` : '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(p) < 0.5) return `<div class="delta">≈ ίδιο με ${esc(cmp.label)}</div>`;
  const good = invert ? p < 0 : p > 0;
  return `<div class="delta ${good ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(Math.round(p))}% <span>από ${money ? fmtS(prev) : num.format(prev)} (${esc(cmp.label)})</span></div>`;
}

const stat = (k, v, sub = '', d = '', cls = '') => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${d}</div>`;

// ---------------------------------------------------------------- ενότητες
const SECTIONS = [
  ['summary', 'Σύνοψη'], ['time', 'Πότε έρχονται'], ['clients', 'Πελάτισσες'], ['services', 'Εργασίες'],
  ['staff', 'Υπάλληλοι'], ['payments', 'Πληρωμές'], ['expenses', 'Έξοδα'], ['all', 'Πλήρες ριπόρτ'],
];

function secSummary(ctx) {
  const { a, b, cmp, per, width } = ctx;
  const bks = buckets(per);
  const twoSeries = !R.staff;
  const chart = barChart(bks, twoSeries ? [{ key: 'turnover', cls: 's1' }, { key: 'expenses', cls: 's2' }] : [{ key: 'services', cls: 's1' }], width, {
    tips: (x) => `<b>${esc(x.long)}</b><div><i class="sw s1"></i>${R.staff ? 'Εργασίες' : 'Τζίρος'}<span>${fmt(R.staff ? x.services : x.turnover)}</span></div>
      ${twoSeries ? `<div><i class="sw s2"></i>Έξοδα<span>${fmt(x.expenses)}</span></div><div class="tp">Κέρδος<span>${fmtS(x.turnover - x.expenses)}</span></div>` : ''}
      <div class="tp">Επισκέψεις<span>${x.visits}</span></div>${x.drill ? '<div class="tp">Πάτα ξανά για λεπτομέρειες</div>' : ''}`,
  });
  const rows = bks.filter((x) => x.visits || x.expenses || x.retail);
  const noFixed = !R.staff && !D.fixed.length
    ? '<div class="warn" style="margin-bottom:12px">⚠️ Δεν έχουν οριστεί <b>πάγια έξοδα</b> (ενοίκιο, λογιστής, ΕΦΚΑ…), οπότε το κέρδος φαίνεται μεγαλύτερο από το πραγματικό. Πρόσθεσέ τα στο ⚙︎ → Διορθώσεις → Πάγια έξοδα.</div>' : '';
  return `${noFixed}
  <div class="kpis">
    ${R.staff ? stat(`Εργασίες (${esc(R.staff)})`, fmt(a.services), '', delta(a.services, b?.services, { cmp }))
      : stat('Τζίρος', fmt(a.turnover), `εργασίες ${fmt(a.services)} + μεταπώληση ${fmt(a.retail)}`, delta(a.turnover, b?.turnover, { cmp }))}
    ${R.staff ? '' : stat('Έξοδα', fmt(a.expenses), `καθημερινά ${fmt(a.varExpenses)} + πάγια ${fmt(a.fixed.total)}`, delta(a.expenses, b?.expenses, { cmp, invert: true }))}
    ${R.staff ? '' : stat('Κέρδος', fmtS(a.profit), `περιθώριο ${pct(a.profit, a.turnover)}${a.vat ? ` · μετά ΦΠΑ ${fmtS(a.profitAfterVat)}` : ''}`, delta(a.profit, b?.profit, { cmp }), a.profit < 0 ? 'neg' : '')}
    ${stat('Επισκέψεις', num.format(a.visits), `${num.format(a.clients)} διαφορετικές πελάτισσες`, delta(a.visits, b?.visits, { cmp, money: false }))}
    ${stat('Μέσος λογαριασμός', fmt(a.avgTicket), 'ανά επίσκεψη', delta(a.avgTicket, b?.avgTicket, { cmp }))}
    ${stat('Μέσος τζίρος / μέρα', fmt(a.perDay), `${a.workDays} εργάσιμες μέρες`, delta(a.perDay, b?.perDay, { cmp }))}
    ${R.staff ? '' : stat('Πληρωμή με κάρτα', a.pay.cardPct == null ? '—' : `${Math.round(a.pay.cardPct)}%`, a.pay.cardPct == null ? 'δεν υπάρχει POS' : `${fmt(a.pay.pos)} POS · ${fmt(a.pay.cash)} μετρητά (εκτ.)`)}
    ${R.staff ? '' : stat('ΦΠΑ', fmt(a.vat), 'όπως καταχωρήθηκε', delta(a.vat, b?.vat, { cmp, invert: true }))}
  </div>
  <section class="rcard wide insights"><h3>Αξιοσημείωτα</h3><ul>${insights(ctx).map((s) => `<li>${s}</li>`).join('') || '<li>Χρειάζονται περισσότερα δεδομένα.</li>'}</ul></section>
  <section class="rcard wide"><h3>Πορεία — ${esc(per.label)}</h3>
    ${legend(twoSeries ? [['s1', 'Τζίρος'], ['s2', 'Έξοδα']] : [['s1', `Εργασίες ${esc(R.staff)}`]])}
    ${bks.length ? chart : ''}
    <div class="tscroll"><table class="rtable${bks[0]?.drill ? ' clickable' : ''}">
      <thead><tr><th>Περίοδος</th><th>${R.staff ? 'Εργασίες' : 'Τζίρος'}</th>${R.staff ? '' : '<th>Έξοδα</th><th>Κέρδος</th>'}<th>Επισκέψεις</th><th>Μέσος λογ.</th>${R.staff ? '' : '<th>Κάρτα</th>'}</tr></thead>
      <tbody>${rows.map((x) => `<tr ${x.drill ? `data-drill='${JSON.stringify(x.drill)}'` : ''}><th>${esc(x.long)}</th><td>${fmt(R.staff ? x.services : x.turnover)}</td>
        ${R.staff ? '' : `<td>${fmt(x.expenses)}</td><td class="${x.turnover - x.expenses < 0 ? 'bad' : ''}">${fmtS(x.turnover - x.expenses)}</td>`}
        <td>${x.visits}</td><td>${x.visits ? fmt(x.services / x.visits) : '—'}</td>${R.staff ? '' : `<td>${x.cardPct == null ? '—' : Math.round(x.cardPct) + '%'}</td>`}</tr>`).join('') || '<tr><td colspan="7" class="empty">Καμία κίνηση.</td></tr>'}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><th>Σύνολο</th><td>${fmt(R.staff ? a.services : a.turnover)}</td>${R.staff ? '' : `<td>${fmt(a.expenses)}</td><td>${fmtS(a.profit)}</td>`}<td>${a.visits}</td><td>${fmt(a.avgTicket)}</td>${R.staff ? '' : `<td>${a.pay.cardPct == null ? '—' : Math.round(a.pay.cardPct) + '%'}</td>`}</tr></tfoot>` : ''}
    </table></div>
  </section>
`;
}

function insights(ctx) {
  const { a, b, cmp, cs, ss } = ctx, out = [];
  if (!a.visits) return out;
  if (cmp && b?.turnover) {
    const p = Math.round(((a.turnover - b.turnover) / b.turnover) * 100);
    out.push(`Ο ${R.staff ? 'τζίρος εργασιών' : 'τζίρος'} είναι <b>${p >= 0 ? '+' : ''}${p}%</b> σε σχέση με ${esc(cmp.label)}.`);
  }
  const byDate = new Map(); a.vis.forEach((v) => byDate.set(v.date, (byDate.get(v.date) || 0) + v.total));
  const best = [...byDate].sort((x, y) => y[1] - x[1])[0];
  if (best) out.push(`Καλύτερη μέρα: <b>${fDateW(best[0])}</b> με ${fmt(best[1])} εργασίες.`);
  const wd = weekdayStats(a);
  const topWd = wd.filter((w) => w.days).sort((x, y) => y.avg - x.avg)[0];
  if (topWd) out.push(`Πιο δυνατή μέρα της εβδομάδας: <b>${WD_LONG[topWd.d]}</b> (μέσος όρος ${fmt(topWd.avg)}).`);
  const byCount = [...ss.cats].sort((x, y) => y.count - x.count)[0], byAmt = [...ss.cats].sort((x, y) => y.amount - x.amount)[0];
  if (byCount) out.push(`Πιο δημοφιλής εργασία: <b>${esc(byCount.name)}</b> (${byCount.count} φορές)${byAmt && byAmt.name !== byCount.name ? ` · φέρνει τα περισσότερα: <b>${esc(byAmt.name)}</b> (${fmt(byAmt.amount)})` : ''}.`);
  if (ss.pairs[0]) out.push(`Συχνότερος συνδυασμός: <b>${esc(ss.pairs[0][0])}</b> (${ss.pairs[0][1]} φορές).`);
  const topC = [...cs.active].sort((x, y) => y.visits - x.visits || y.spend - x.spend)[0];
  if (topC) out.push(`Πιο συχνή πελάτισσα: <b>${esc(topC.name)}</b> (${topC.visits} επισκέψεις, ${fmt(topC.spend)}).`);
  if (cs.active.length) out.push(`Νέες πελάτισσες: <b>${cs.newcomers.length}</b> από ${cs.active.length} (${pct(cs.newcomers.length, cs.active.length)}).`);
  if (cs.medianEvery) out.push(`Μια πελάτισσα επιστρέφει συνήθως κάθε <b>${Math.round(cs.medianEvery)} ημέρες</b> (διάμεσος).`);
  if (cs.overdue.length) out.push(`<b>${cs.overdue.length}</b> σταθερές πελάτισσες έχουν αργήσει να έρθουν — δες «Πελάτισσες».`);
  if (!R.staff && a.pay.cardPct != null) out.push(`Με κάρτα πληρώνεται το <b>${Math.round(a.pay.cardPct)}%</b> του τζίρου${a.pay.cardClientsPct != null ? ` · περίπου ${Math.round(a.pay.cardClientsPct)}% των πελατισσών` : ''}.`);
  if (!R.staff) {
    if (a.fixed.total) out.push(`Τα πάγια (${fmt(a.fixed.total)}) είναι το <b>${pct(a.fixed.total, a.turnover)}</b> του τζίρου της περιόδου.`);
    const ex = expenseGroups(a.exps)[0];
    if (ex) out.push(`Μεγαλύτερο έξοδο: <b>${esc(ex.name)}</b> (${fmt(ex.amount)}, ${pct(ex.amount, a.expenses)} των εξόδων).`);
  }
  return out;
}

function weekdayStats(a) {
  const per = new Map();
  for (const v of a.vis) {
    const d = toD(v.date).getDay();
    const w = per.get(d) || { d, dates: new Set(), amount: 0, visits: 0 };
    w.dates.add(v.date); w.amount += v.total; w.visits++;
    per.set(d, w);
  }
  return WD_ORDER.map((d) => {
    const w = per.get(d); if (!w) return { d, days: 0, avg: 0, avgVisits: 0, amount: 0 };
    return { d, days: w.dates.size, amount: w.amount, avg: w.amount / w.dates.size, avgVisits: w.visits / w.dates.size };
  });
}
function secTime(ctx) {
  const { a } = ctx;
  if (!a.visits) return '<p class="empty">Καμία επίσκεψη στην περίοδο.</p>';
  const wd = weekdayStats(a).filter((w) => w.days);
  const byDate = new Map(); a.vis.forEach((v) => { const x = byDate.get(v.date) || { s: 0, n: 0 }; x.s += v.total; x.n++; byDate.set(v.date, x); });
  const topDays = [...byDate].sort((x, y) => y[1].s - x[1].s).slice(0, 10);
  const span = daysBetween(ctx.per.from, ctx.per.to);
  let season = '';
  if (span > 70) {
    const mm = Array.from({ length: 12 }, () => ({ s: 0, n: 0, days: new Set() }));
    a.vis.forEach((v) => { const m = +v.date.slice(5, 7) - 1; mm[m].s += v.total; mm[m].n++; mm[m].days.add(v.date); });
    season = `<section class="rcard"><h3>Εποχικότητα — μέσος τζίρος εργασιών ανά εργάσιμη μέρα</h3>
      ${hbars(mm.map((m, i) => ({ label: MONTHS_LONG[i], value: m.days.size ? m.s / m.days.size : 0, extra: m.days.size ? `${num.format(m.n / m.days.size)} επισκ./μέρα` : '' })).filter((x) => x.value))}</section>`;
  }
  return `
  <section class="rcard"><h3>Ανά ημέρα της εβδομάδας (μέσος όρος ανά εργάσιμη μέρα)</h3>
    ${hbars(wd.map((w) => ({ label: WD_LONG[w.d], value: w.avg, extra: `${num.format(w.avgVisits)} επισκ.` })))}
    <div class="tscroll"><table class="rtable"><thead><tr><th>Ημέρα</th><th>Μέρες</th><th>Μ.ο. εργασιών</th><th>Μ.ο. επισκέψεων</th><th>Σύνολο</th></tr></thead>
    <tbody>${wd.map((w) => `<tr><th>${WD_LONG[w.d]}</th><td>${w.days}</td><td>${fmt(w.avg)}</td><td>${num.format(w.avgVisits)}</td><td>${fmt(w.amount)}</td></tr>`).join('')}</tbody></table></div>
  </section>
  ${season}
  <section class="rcard"><h3>Οι 10 καλύτερες μέρες</h3>
    <div class="tscroll"><table class="rtable"><thead><tr><th>Ημέρα</th><th>Εργασίες</th><th>Επισκέψεις</th></tr></thead>
    <tbody>${topDays.map(([d, x]) => `<tr><th>${fDateW(d)}</th><td>${fmt(x.s)}</td><td>${x.n}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
}

function secClients(ctx) {
  const { cs, a } = ctx;
  if (R.clientOpen) return clientProfile(R.clientOpen, ctx);
  const q = norm(R.clientQuery.trim());
  const sorters = { spend: (x, y) => y.spend - x.spend, visits: (x, y) => y.visits - x.visits || y.spend - x.spend, last: (x, y) => (x.last < y.last ? 1 : -1), name: (x, y) => x.name.localeCompare(y.name, 'el') };
  const list = cs.active.filter((c) => !q || norm(c.name).includes(q)).sort(sorters[R.clientSort]);
  const shown = R.printing ? list : list.slice(0, R.clientLimit);
  const every = (e) => (e == null ? '—' : e < 14 ? `${Math.round(e)} ημ.` : `${num.format(e / 7)} εβδ.`);
  return `
  <div class="kpis">
    ${stat('Πελάτισσες στην περίοδο', num.format(cs.active.length), `${num.format(a.visits)} επισκέψεις · ${num.format(a.visits / (cs.active.length || 1))} ανά πελάτισσα`)}
    ${stat('Νέες', num.format(cs.newcomers.length), `${pct(cs.newcomers.length, cs.active.length)} · ξαναήρθαν ${cs.newReturned.length} (${pct(cs.newReturned.length, cs.newcomers.length)})`)}
    ${stat('Σταθερές (ήρθαν και πριν)', num.format(cs.returning), pct(cs.returning, cs.active.length))}
    ${stat('Συνήθως ξανάρχονται κάθε', cs.medianEvery ? `${Math.round(cs.medianEvery)} ημ.` : '—', 'διάμεσος όλων')}
  </div>
  <div class="rgrid">
  <section class="rcard"><h3>Πόσο συχνά έρχονται</h3>${hbars(cs.buckets, (v) => `${v}`, 'seq')}
    <p class="note">Για τις πελάτισσες της περιόδου, με βάση όλο το ιστορικό τους.</p></section>
  <section class="rcard"><h3>📞 Έχουν αργήσει — σήμερα (${cs.overdue.length})</h3>
    ${cs.overdue.length ? `<div class="tscroll"><table class="rtable clickable"><thead><tr><th>Πελάτισσα</th><th class="txt">Τηλέφωνο</th><th>Συνήθως</th><th>Πριν</th><th>Σύνολο</th></tr></thead>
    <tbody>${cs.overdue.slice(0, 25).map((c) => `<tr data-client="${esc(c.name)}"><th>${esc(c.name)}</th><td class="txt">${telLink(D.phones.get(c.name)) || '—'}</td><td>κάθε ${every(c.every)}</td><td>${c.since} ημ.</td><td>${fmt(c.spendAll)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Καμία — όλες έρχονται στην ώρα τους.</p>'}
    <p class="note">Πελάτισσες με ≥2 επισκέψεις που δεν ήρθαν για πάνω από 1,5× το συνηθισμένο τους διάστημα (και ≥4 εβδομάδες). ${cs.oneTimersGone ? `Επιπλέον ${cs.oneTimersGone} ήρθαν μία φορά και δεν ξαναφάνηκαν για 3+ μήνες.` : ''}</p></section>
  </div>
  <section class="rcard wide"><h3>Όλες οι πελάτισσες της περιόδου (${list.length})</h3>
    <div class="filters no-print" style="margin-bottom:10px">
      <label style="flex:2"><span>Αναζήτηση</span><input class="input" data-r="clientQuery" value="${esc(R.clientQuery)}" placeholder="Όνομα…" autocomplete="off"></label>
      <label><span>Ταξινόμηση</span><select class="input" data-r="clientSort">
        ${[['spend', 'Περισσότερα χρήματα'], ['visits', 'Περισσότερες επισκέψεις'], ['last', 'Πιο πρόσφατες'], ['name', 'Αλφαβητικά']].map(([k, l]) => `<option value="${k}" ${R.clientSort === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    </div>
    <div class="tscroll"><table class="rtable clickable"><thead><tr><th>Πελάτισσα</th><th>Επισκ.</th><th>Σύνολο</th><th>Μέσος</th><th>Συνήθως κάθε</th><th>Τελευταία</th><th class="txt">Τι κάνει</th><th class="txt">Με ποιον</th></tr></thead>
    <tbody>${shown.map((c) => `<tr data-client="${esc(c.name)}"><th>${esc(c.name)}</th><td>${c.visits}</td><td>${fmt(c.spend)}</td><td>${fmt(c.avg)}</td><td>${every(c.every)}</td><td>${fDate(c.last)}</td><td class="txt">${esc(c.fav || '')}</td><td class="txt">${esc(c.favStaff || '')}</td></tr>`).join('')}</tbody></table></div>
    ${list.length > shown.length ? `<button class="btn" data-act="more-clients" style="margin-top:10px">Δείξε κι άλλες (${list.length - shown.length})</button>` : ''}
    <p class="note no-print">Πάτα μια πελάτισσα για την πλήρη καρτέλα της.</p>
  </section>`;
}

function clientProfile(name, ctx) {
  const hv = D.hist.get(name) || [];
  const c = ctx.cs.all.find((x) => x.name === name);
  const cats = new Map(), staff = new Map();
  hv.forEach((v) => { v.items.forEach((i) => cats.set(i.cat, (cats.get(i.cat) || 0) + 1)); staff.set(v.staff, (staff.get(v.staff) || 0) + 1); });
  const nextDue = c?.every ? addDays(c.last, Math.round(c.every)) : null;
  return `
  <button class="btn" data-act="client-back" style="width:auto;margin-bottom:12px">← Πίσω στις πελάτισσες</button>
  <h2 class="rtitle" style="margin-top:0">${esc(name)} ${telLink(D.phones.get(name))}</h2>
  <div class="kpis">
    ${stat('Επισκέψεις (όλες)', hv.length, c ? `από ${fDate(c.first)}` : '')}
    ${stat('Σύνολο', fmt(sum(hv.map((v) => v.total))), `μέσος ${fmt(sum(hv.map((v) => v.total)) / (hv.length || 1))}`)}
    ${stat('Έρχεται συνήθως κάθε', c?.every ? `${Math.round(c.every)} ημ.` : '—', c?.every ? `επόμενη περίπου ${fDate(nextDue)}` : 'μία επίσκεψη μέχρι τώρα')}
    ${stat('Τελευταία φορά', c ? fDate(c.last) : '—', c ? `πριν ${c.since} ημέρες${c.overdue ? ' · <b class="bad">έχει αργήσει</b>' : ''}` : '')}
  </div>
  <div class="rgrid">
    <section class="rcard"><h3>Τι κάνει</h3>${hbars([...cats].sort((x, y) => y[1] - x[1]).map(([l, v]) => ({ label: l, value: v })), (v) => `${v}×`)}</section>
    <section class="rcard"><h3>Με ποιον</h3>${hbars([...staff].sort((x, y) => y[1] - x[1]).map(([l, v]) => ({ label: l, value: v })), (v) => `${v}×`)}</section>
  </div>
  <section class="rcard wide" style="margin-top:14px"><h3>Ιστορικό</h3>
    <div class="tscroll"><table class="rtable"><thead><tr><th>Ημερομηνία</th><th>Υπάλληλος</th><th class="txt">Εργασίες</th><th>Ποσό</th></tr></thead>
    <tbody>${[...hv].reverse().map((v) => `<tr><th>${fDateW(v.date)}</th><td class="txt">${esc(v.staff)}</td><td class="txt">${esc(v.items.map((i) => (i.cat === 'Άλλο' && i.note ? i.note : i.cat)).join(', '))}</td><td>${fmt(v.total)}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
}

function secServices(ctx) {
  const { ss, a, cmp, ssPrev } = ctx;
  if (!ss.cats.length) return '<p class="empty">Καμία εργασία στην περίοδο.</p>';
  const key = R.catSort === 'amount' ? 'amount' : 'count';
  const rows = [...ss.cats].sort((x, y) => y[key] - x[key]);
  const prevMap = new Map((ssPrev?.cats || []).map((c) => [c.name, c]));
  const totalCount = sum(ss.cats.map((c) => c.count));
  return `
  <section class="rcard wide"><h3>Κατάταξη εργασιών — ${esc(ctx.per.label)}</h3>
    <div class="seg" role="group">
      <button class="${key === 'count' ? 'on' : ''}" data-act="cat-sort" data-v="count">Δημοτικότητα (φορές)</button>
      <button class="${key === 'amount' ? 'on' : ''}" data-act="cat-sort" data-v="amount">Τζίρος</button>
    </div>
    ${hbars(rows.map((c, i) => ({ labelHtml: `<b>${i + 1}.</b> ${esc(c.name)}`, label: c.name, value: c[key] })), key === 'amount' ? fmt : (v) => `${v}×`)}
    <div class="tscroll"><table class="rtable"><thead><tr><th>#</th><th class="txt">Εργασία</th><th>Φορές</th><th>% φορών</th><th>Τζίρος</th><th>% τζίρου</th><th>Μέση τιμή</th><th>Συνήθης τιμή</th><th>Πελάτισσες</th>${cmp ? `<th>Φορές vs ${esc(cmp.label)}</th>` : ''}</tr></thead>
    <tbody>${rows.map((c, i) => {
      const p = prevMap.get(c.name); const d = p ? c.count - p.count : null;
      return `<tr><td>${i + 1}</td><th class="txt">${esc(c.name)}</th><td>${c.count}</td><td>${pct(c.count, totalCount)}</td><td>${fmt(c.amount)}</td><td>${pct(c.amount, a.services)}</td><td>${fmt(c.avg)}</td><td>${fmt(c.common)}</td><td>${c.clients}</td>
        ${cmp ? `<td class="${d > 0 ? 'ok' : d < 0 ? 'bad' : ''}">${d == null ? 'νέο' : `${d > 0 ? '+' : ''}${d}`}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>
  </section>
  <div class="rgrid">
    <section class="rcard"><h3>Συχνότεροι συνδυασμοί στην ίδια επίσκεψη</h3>
      ${ss.pairs.length ? hbars(ss.pairs.map(([l, v]) => ({ label: l, value: v })), (v) => `${v}×`) : '<p class="empty">Καμία επίσκεψη με 2+ εργασίες.</p>'}
      <p class="note">${pct(ss.multi, a.visits)} των επισκέψεων έχουν πάνω από μία εργασία.</p></section>
    ${ss.notes.length ? `<section class="rcard"><h3>«Άλλο» — τι γράφτηκε</h3>${hbars(ss.notes.map(([l, v]) => ({ label: l, value: v })), (v) => `${v}×`)}
      <p class="note">Αν κάτι επαναλαμβάνεται συχνά, αξίζει να μπει στον τιμοκατάλογο.</p></section>` : ''}
  </div>`;
}

function secStaff(ctx) {
  const { a, per } = ctx;
  const names = [...new Set([...D.staffOrder, ...a.vis.map((v) => v.staff)])].filter((n) => a.vis.some((v) => v.staff === n));
  if (!names.length) return '<p class="empty">Καμία επίσκεψη στην περίοδο.</p>';
  const st = names.map((n) => {
    const vs = a.vis.filter((v) => v.staff === n);
    const clients = new Set(vs.map((v) => v.client));
    const loyal = [...clients].filter((c) => (D.hist.get(c) || []).filter((v) => v.staff === n && v.date <= per.to).length >= 2).length;
    const cats = new Map(); vs.forEach((v) => v.items.forEach((i) => cats.set(i.cat, (cats.get(i.cat) || 0) + 1)));
    return { n, vs, amount: sum(vs.map((v) => v.total)), visits: vs.length, clients: clients.size, loyal, cats, top: [...cats].sort((x, y) => y[1] - x[1])[0]?.[0] };
  });
  const allCats = [...new Set(a.vis.flatMap((v) => v.items.map((i) => i.cat)))].sort((x, y) => sum(st.map((s) => s.cats.get(y) || 0)) - sum(st.map((s) => s.cats.get(x) || 0)));
  const bks = buckets(per);
  const showTime = bks.length > 1 && bks.length <= 24;
  return `
  <section class="rcard wide"><h3>Υπάλληλοι — ${esc(per.label)}</h3>
    ${hbars(st.map((s) => ({ label: s.n, value: s.amount, extra: pct(s.amount, a.services) })))}
    <div class="tscroll"><table class="rtable"><thead><tr><th>Υπάλληλος</th><th>Εργασίες</th><th>Μερίδιο</th><th>Επισκέψεις</th><th>Μέσος λογ.</th><th>Πελάτισσες</th><th>Σταθερές*</th><th class="txt">Κάνει πιο συχνά</th></tr></thead>
    <tbody>${st.map((s) => `<tr><th>${esc(s.n)}</th><td>${fmt(s.amount)}</td><td>${pct(s.amount, a.services)}</td><td>${s.visits}</td><td>${fmt(s.amount / s.visits)}</td><td>${s.clients}</td><td>${pct(s.loyal, s.clients)}</td><td class="txt">${esc(s.top || '')}</td></tr>`).join('')}</tbody></table></div>
    <p class="note">* Πελάτισσες που έχουν έρθει ≥2 φορές στον ίδιο υπάλληλο. Έξοδα και μεταπώληση είναι κοινά, γι' αυτό δεν υπάρχει κέρδος ανά υπάλληλο.</p>
  </section>
  <section class="rcard wide"><h3>Ποιος κάνει τι (φορές)</h3>
    <div class="tscroll"><table class="rtable matrix"><thead><tr><th class="txt">Εργασία</th>${st.map((s) => `<th>${esc(s.n)}</th>`).join('')}<th>Σύνολο</th></tr></thead>
    <tbody>${allCats.map((c) => `<tr><th class="txt">${esc(c)}</th>${st.map((s) => `<td>${s.cats.get(c) || '—'}</td>`).join('')}<td><b>${sum(st.map((s) => s.cats.get(c) || 0))}</b></td></tr>`).join('')}</tbody></table></div>
  </section>
  ${showTime ? `<section class="rcard wide"><h3>Υπάλληλοι ανά ${bks[0].drill ? 'μήνα' : 'εβδομάδα'} (εργασίες)</h3>
    <div class="tscroll"><table class="rtable matrix"><thead><tr><th></th>${bks.map((b) => `<th>${esc(b.label)}</th>`).join('')}<th>Σύνολο</th></tr></thead>
    <tbody>${st.map((s) => `<tr><th>${esc(s.n)}</th>${bks.map((b) => { const v = sum(s.vs.filter((x) => inR(x.date, b)).map((x) => x.total)); return `<td>${v ? fmt(v) : '—'}</td>`; }).join('')}<td><b>${fmt(s.amount)}</b></td></tr>`).join('')}</tbody></table></div>
  </section>` : ''}`;
}

function secPayments(ctx) {
  const { a, per, width } = ctx; const p = a.pay;
  if (R.staff) return '<p class="empty">Οι πληρωμές αφορούν όλο το κατάστημα — βγάλε το φίλτρο υπαλλήλου.</p>';
  const bks = buckets(per).filter((b) => b.cardPct != null);
  const ranges = [[0, 2000, '< 20 €'], [2000, 4000, '20–40 €'], [4000, 6000, '40–60 €'], [6000, 10000, '60–100 €'], [10000, 1e12, '100 € +']];
  return `
  <div class="kpis">
    ${stat('Με κάρτα (POS)', p.cardPct == null ? '—' : `${Math.round(p.cardPct)}%`, `${fmt(p.pos)} του τζίρου`)}
    ${stat('Μετρητά (εκτίμηση)', p.cardPct == null ? '—' : `${Math.round(100 - p.cardPct)}%`, `${fmt(p.cash)} = τζίρος − POS`)}
    ${stat('Συναλλαγές με κάρτα', num.format(p.tx), p.tx ? `μέση ${fmt(p.txAmt / p.tx)}` : 'δεν γράφτηκαν γραμμές POS')}
    ${stat('Πελάτισσες με κάρτα', p.cardClientsPct == null ? '—' : `${Math.round(p.cardClientsPct)}%`, p.cardClientsPct == null ? '' : `≈ ${num.format(p.noCard)} πλήρωσαν χωρίς κάρτα`)}
    ${stat('ΦΠΑ', fmt(a.vat), `${pct(a.vat, a.turnover)} του τζίρου`)}
  </div>
  ${(p.missing || p.mismatch) ? `<div class="warn" style="margin-top:12px">⚠️ ${p.missing ? `${p.missing} εργάσιμες μέρες χωρίς σύνολο POS (δεν μετράνε στο ποσοστό κάρτας). ` : ''}${p.mismatch ? `${p.mismatch} μέρες όπου οι γραμμές POS δεν βγάζουν το σύνολο.` : ''}</div>` : ''}
  <div class="rgrid">
    <section class="rcard wide"><h3>Ποσοστό κάρτας στον χρόνο</h3>
      ${bks.length ? barChart(bks, [{ key: 'cardPct', cls: 's1' }], width, { pctAxis: true, tips: (x) => `<b>${esc(x.long)}</b><div class="tp">Κάρτα<span>${Math.round(x.cardPct)}%</span></div>` }) : '<p class="empty">Δεν υπάρχει POS.</p>'}
    </section>
    <section class="rcard"><h3>Ύψος συναλλαγών με κάρτα</h3>
      ${p.txList.length ? hbars(ranges.map(([lo, hi, l]) => ({ label: l, value: p.txList.filter((x) => x >= lo && x < hi).length })), (v) => `${v}`) : '<p class="empty">Δεν γράφτηκαν γραμμές POS.</p>'}
    </section>
    <section class="rcard"><h3>Πώς υπολογίζονται</h3><p class="note" style="margin:0">
      Κάρτα % = POS ÷ (εργασίες + μεταπώληση), μόνο σε ${p.posDays} μέρες με καταχωρημένο POS.<br>
      Πελάτισσες με κάρτα ≈ γραμμές POS ÷ επισκέψεις, σε ${p.partsDays} μέρες με γραμμές POS (μία γραμμή = μία πελάτισσα).</p></section>
  </div>`;
}

function expenseGroups(exps) {
  const g = new Map();
  for (const e of exps) {
    const k = (e.desc || 'Χωρίς περιγραφή').trim(); const nk = norm(k);
    const x = g.get(nk) || { name: k, amount: 0, count: 0 };
    x.amount += e.amount; x.count++; g.set(nk, x);
  }
  return [...g.values()].sort((a, b) => b.amount - a.amount);
}

function secExpenses(ctx) {
  const { a, b, cmp } = ctx;
  if (R.staff) return '<p class="empty">Τα έξοδα αφορούν όλο το κατάστημα — βγάλε το φίλτρο υπαλλήλου.</p>';
  if (!a.exps.length && !a.fixed.total) return '<p class="empty">Κανένα έξοδο στην περίοδο. Τα πάγια (ενοίκιο κ.λπ.) μπαίνουν στο ⚙︎ → Διορθώσεις → Πάγια έξοδα.</p>';
  const fixedRows = [...a.fixed.per].sort((x, y) => y[1] - x[1]);
  const groups = expenseGroups(a.exps);
  const prevG = new Map(expenseGroups(b?.exps || []).map((x) => [norm(x.name), x]));
  const big = [...a.exps].sort((x, y) => y.amount - x.amount).slice(0, 10);
  return `
  <div class="kpis">
    ${stat('Έξοδα (σύνολο)', fmt(a.expenses), '', delta(a.expenses, b?.expenses, { cmp, invert: true }))}
    ${stat('Καθημερινά', fmt(a.varExpenses), `${a.exps.length} καταχωρήσεις`)}
    ${stat('Πάγια', fmt(a.fixed.total), D.fixed.length ? 'αναλογία της περιόδου' : 'δεν έχουν οριστεί')}
    ${stat('Ως % του τζίρου', pct(a.expenses, a.turnover))}
    ${stat('Ανά εργάσιμη μέρα', fmt(a.workDays ? a.expenses / a.workDays : 0))}
  </div>
  <div class="rgrid">
    <section class="rcard"><h3>Πάγια — αναλογία της περιόδου</h3>
      ${fixedRows.length ? hbars(fixedRows.map(([l, v]) => ({ label: l, value: v })), fmt, 's2f')
        : '<p class="empty">Δεν έχουν οριστεί πάγια. ⚙︎ → Διορθώσεις → Πάγια έξοδα.</p>'}
      <p class="note">Κάθε πάγιο μοιράζεται στις ημέρες του μήνα (π.χ. ενοίκιο 600 € → 2 εβδομάδες ≈ 280 €). Μελλοντικές ημέρες δεν χρεώνονται.</p></section>
    <section class="rcard"><h3>Καθημερινά — ανά κατηγορία (περιγραφή)</h3>
      ${groups.length ? hbars(groups.map((g) => ({ label: g.name, value: g.amount, extra: pct(g.amount, a.varExpenses) })), fmt, 's2f') : '<p class="empty">Κανένα καθημερινό έξοδο.</p>'}
      <div class="tscroll"><table class="rtable"><thead><tr><th class="txt">Περιγραφή</th><th>Ποσό</th><th>Φορές</th>${cmp ? `<th>vs ${esc(cmp.label)}</th>` : ''}</tr></thead>
      <tbody>${groups.map((g) => { const p = prevG.get(norm(g.name)); return `<tr><th class="txt">${esc(g.name)}</th><td>${fmt(g.amount)}</td><td>${g.count}</td>${cmp ? `<td>${p ? fmtS(g.amount - p.amount) : 'νέο'}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>
      <p class="note">Ομαδοποίηση με βάση την περιγραφή — γράφε ίδιες λέξεις (π.χ. πάντα «Βαφές») για καθαρή εικόνα.</p></section>
    <section class="rcard"><h3>Τα 10 μεγαλύτερα καθημερινά</h3>
      <div class="tscroll"><table class="rtable"><thead><tr><th>Ημέρα</th><th class="txt">Περιγραφή</th><th>Ποσό</th></tr></thead>
      <tbody>${big.map((e) => `<tr><th>${fDate(e.date)}</th><td class="txt">${esc(e.desc || '—')}</td><td>${fmt(e.amount)}</td></tr>`).join('')}</tbody></table></div></section>
  </div>`;
}

// ---------------------------------------------------------------- απόδοση
function chartWidth(el) { return Math.min(el.clientWidth || 360, 1180) - 34; }

function filtersHtml() {
  const yearSel = `<label><span>Έτος</span><select class="input" data-r="year">${D.years.map((y) => `<option ${y === R.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`;
  const extra = {
    year: yearSel,
    month: `${yearSel}<label><span>Μήνας</span><select class="input" data-r="month">${MONTHS_LONG.map((m, i) => `<option value="${i}" ${R.month === i ? 'selected' : ''}>${m}</option>`).join('')}</select></label>`,
    quarter: `${yearSel}<label><span>Τρίμηνο</span><select class="input" data-r="quarter">${[0, 1, 2, 3].map((q) => `<option value="${q}" ${R.quarter === q ? 'selected' : ''}>${q + 1}ο (${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]})</option>`).join('')}</select></label>`,
    holiday: `${yearSel}<label><span>Γιορτή</span><select class="input" data-r="holiday">${Object.entries(HOLIDAYS).map(([k, h]) => `<option value="${k}" ${R.holiday === k ? 'selected' : ''}>${h.label}</option>`).join('')}</select></label>`,
    range: `<label><span>Από</span><input type="date" class="input" data-r="from" value="${R.from || D.first}"></label><label><span>Έως</span><input type="date" class="input" data-r="to" value="${R.to || D.last}"></label>`,
    all: '',
  }[R.kind];
  const staffNames = [...new Set([...D.staffOrder, ...D.visits.map((v) => v.staff)])];
  return `<div class="filters">
    <label><span>Περίοδος</span><select class="input" data-r="kind">
      ${[['year', 'Έτος'], ['month', 'Μήνας'], ['quarter', 'Τρίμηνο'], ['holiday', 'Γιορτές (Πάσχα / Χριστούγεννα)'], ['range', 'Από – έως'], ['all', 'Όλα τα δεδομένα']].map(([k, l]) => `<option value="${k}" ${R.kind === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    ${extra}
    <label><span>Υπάλληλος</span><select class="input" data-r="staff"><option value="">Όλοι</option>${staffNames.map((n) => `<option ${R.staff === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label><span>Σύγκριση με</span><select class="input" data-r="compare">
      ${[['prev', 'Προηγούμενη περίοδο'], ['lastyear', 'Ίδια περίοδο πέρυσι'], ['none', 'Χωρίς σύγκριση']].map(([k, l]) => `<option value="${k}" ${R.compare === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
  </div>`;
}

export async function renderResults(el) {
  await load();
  tipStore.clear();
  const per = periodFor(R);
  const cmp = compareFor(R, per);
  const a = aggregate(per);
  const b = cmp ? aggregate(cmp) : null;
  const ctx = { per, cmp, a, b, width: chartWidth(el) };
  ctx.cs = clientStats(per, a);
  ctx.ss = serviceStats(a.vis);
  ctx.ssPrev = b ? serviceStats(b.vis) : null;

  const render = { summary: secSummary, time: secTime, clients: secClients, services: secServices, staff: secStaff, payments: secPayments, expenses: secExpenses };
  const body = R.section === 'all'
    ? SECTIONS.filter(([k]) => k !== 'all').map(([k, l]) => `<div class="rsec"><h2 class="rsec-title">${l}</h2>${render[k](ctx)}</div>`).join('')
    : render[R.section](ctx);

  el.innerHTML = `
    <div class="no-print">${filtersHtml()}</div>
    <div class="rhead">
      <h2 class="rtitle">${esc(per.label)}${R.staff ? ` · ${esc(R.staff)}` : ''}</h2>
      <span class="rsub">${fDate(per.from)} – ${fDate(per.to)}${cmp ? ` · σύγκριση με ${esc(cmp.label)}` : ''}</span>
      <button class="btn no-print print-btn" data-act="print-menu">🖨 Εκτύπωση / ⬇ PDF</button>
      <span class="print-only print-date">Κομμωτήριο · εκτύπωση ${new Date().toLocaleDateString('el-GR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
    </div>
    <div class="print-menu no-print" hidden>
      <b>Τι να τυπωθεί;</b>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn" data-act="print" data-v="section">Μόνο «${esc(R.clientOpen ? R.clientOpen : SECTIONS.find(([k]) => k === R.section)[1])}»</button>
        <button class="btn primary" data-act="print" data-v="all">Πλήρες ριπόρτ</button>
      </div>
      <p class="note">Θα ανοίξει το παράθυρο εκτύπωσης. Για <b>αρχείο PDF</b> διάλεξε ως εκτυπωτή «Αποθήκευση ως PDF»
        (στο iPhone: Κοινοποίηση ⎋ → «Αποθήκευση στα Αρχεία»). Αλλιώς διάλεξε τον εκτυπωτή σου.</p>
    </div>
    <nav class="rnav no-print">${SECTIONS.map(([k, l]) => `<button class="${R.section === k ? 'on' : ''}" data-sec="${k}">${l}</button>`).join('')}</nav>
    <div class="rbody">${body}</div>
    <p class="note">Τζίρος = εργασίες + μεταπώληση. Κέρδος = τζίρος − έξοδα. Το POS είναι τρόπος πληρωμής και δεν προστίθεται. Τα στοιχεία υπάρχουν μόνο σε αυτή τη συσκευή.</p>`;
  bind(el, ctx);
  lastWidth = el.clientWidth;
}

function bind(el, ctx) {
  const rerender = () => renderResults(el);
  el.querySelectorAll('[data-r]').forEach((s) => {
    const ev = s.dataset.r === 'clientQuery' ? 'input' : 'change';
    s.addEventListener(ev, () => {
      const k = s.dataset.r, v = s.value;
      if (k === 'kind') { R.kind = v; if (v === 'range' && !R.from) { R.from = periodFor({ ...R, kind: 'month' }).from; R.to = today(); } }
      else if (['year', 'month', 'quarter'].includes(k)) R[k] = +v;
      else R[k] = v;
      if (k === 'clientQuery' || k === 'clientSort') R.clientLimit = 40;
      if (k === 'clientQuery') {
        clearTimeout(bind.t); bind.t = setTimeout(() => { rerender().then(() => { const i = el.querySelector('[data-r=clientQuery]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 250);
        return;
      }
      rerender();
    });
  });
  el.querySelector('.rnav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sec]'); if (!b) return;
    R.section = b.dataset.sec; R.clientOpen = null; R.printing = false; rerender();
  });
  el.querySelector('.rbody').addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-client],[data-drill]');
    if (!t) return;
    if (t.dataset.client) { R.clientOpen = t.dataset.client; R.section = 'clients'; rerender().then(() => el.scrollIntoView({ block: 'start' })); return; }
    if (t.dataset.drill) { Object.assign(R, JSON.parse(t.dataset.drill)); rerender(); return; }
    const act = t.dataset.act;
    if (act === 'client-back') { R.clientOpen = null; rerender(); }
    if (act === 'more-clients') { R.clientLimit += 60; rerender(); }
    if (act === 'cat-sort') { R.catSort = t.dataset.v; rerender(); }
  });
  el.querySelector('[data-act=print-menu]').addEventListener('click', () => {
    const m = el.querySelector('.print-menu'); m.hidden = !m.hidden;
  });
  el.querySelectorAll('[data-act=print]').forEach((btn) => btn.addEventListener('click', () => {
    const prev = { section: R.section, clientOpen: R.clientOpen }, title = 'Κομμωτήριο';
    if (btn.dataset.v === 'all') { R.section = 'all'; R.clientOpen = null; }
    R.printing = true;
    // Το όνομα του αρχείου PDF βγαίνει από τον τίτλο της σελίδας.
    const sec = R.clientOpen || SECTIONS.find(([k]) => k === R.section)[1];
    document.title = `Κομμωτήριο - ${ctx.per.label}${R.staff ? ' - ' + R.staff : ''} - ${sec}`;
    rerender().then(() => {
      let done = false;
      const restore = () => {
        if (done) return; done = true;
        window.removeEventListener('afterprint', restore);
        document.title = title; R.printing = false; Object.assign(R, prev); rerender();
      };
      window.addEventListener('afterprint', restore);
      setTimeout(() => window.print(), 150);
    });
  }));

  // Tooltips: hover σε υπολογιστή, άγγιγμα σε κινητό (2ο άγγιγμα σε μήνα = άνοιγμα μήνα).
  el.querySelectorAll('.chart-wrap').forEach((wrap) => {
    const { tips = [], drills = [] } = tipStore.get(wrap.dataset.chart) || {};
    const tip = wrap.querySelector('.tip');
    let shown = null;
    const show = (rect) => {
      const i = +rect.dataset.i; if (!tips[i]) return;
      shown = i; tip.innerHTML = tips[i]; tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), rr = rect.getBoundingClientRect();
      const x = rr.left - wr.left + rr.width / 2;
      tip.style.left = `${Math.min(Math.max(x - tip.offsetWidth / 2, 0), wr.width - tip.offsetWidth)}px`;
      wrap.querySelectorAll('rect.hit').forEach((r) => r.classList.toggle('hov', r === rect));
    };
    wrap.querySelectorAll('rect.hit').forEach((r) => {
      r.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(r); });
      r.addEventListener('click', () => {
        const i = +r.dataset.i;
        // 1ο άγγιγμα: λεπτομέρειες · 2ο στον ίδιο μήνα: άνοιγμα του μήνα.
        if (shown === i && drills[i]) { Object.assign(R, drills[i]); rerender(); return; }
        show(r);
      });
    });
    wrap.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      tip.hidden = true; shown = null;
      wrap.querySelectorAll('rect.hit').forEach((r) => r.classList.remove('hov'));
    });
  });
}

let resizeTimer = null, lastWidth = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const el = document.querySelector('#tab-results');
    if (!el || el.hidden || !el.querySelector('.rbody') || Math.abs(el.clientWidth - lastWidth) < 20) return;
    renderResults(el);
  }, 200);
});
