// Αποτελέσματα: τζίρος / έξοδα / κέρδος ανά μήνα και υπάλληλο, και ποιες
// εργασίες φέρνουν τα περισσότερα. Υπολογίζεται τοπικά από όλη τη βάση.
//
// Ορισμοί:
//   Εργασίες   = άθροισμα επισκέψεων
//   Τζίρος     = Εργασίες + Μεταπώληση
//   Κέρδος     = Τζίρος − Έξοδα
//   Τα POS είναι τρόπος πληρωμής, όχι έσοδο, και δεν μπαίνουν στα αθροίσματα.
//   Έξοδα και μεταπώληση δεν ανήκουν σε υπάλληλο → ανά υπάλληλο μόνο εργασίες.

import * as db from './db.js';

const MONTHS = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μάι', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];
const MONTHS_LONG = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur0 = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = (c) => eur0.format(Math.round((c || 0) / 100));
const fmtSigned = (c) => (c < 0 ? '−' + fmt(-c) : fmt(c));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const num = new Intl.NumberFormat('el-GR');

const R = { year: null, month: null, data: null, staffOrder: [] }; // month: null = όλο το έτος

const blank = () => ({ services: 0, retail: 0, expenses: 0, visits: 0 });
const turnover = (a) => a.services + a.retail;
const profit = (a) => turnover(a) - a.expenses;

async function load() {
  const [visits, days, expenses, staff] = await Promise.all(['visits', 'days', 'expenses', 'staff'].map((s) => db.getAll(s)));
  R.data = { visits, days, expenses };
  R.staffOrder = staff.sort((a, b) => a.order - b.order).map((s) => s.name);
  const years = new Set([new Date().getFullYear()]);
  for (const r of [...visits, ...days, ...expenses]) years.add(+r.date.slice(0, 4));
  R.years = [...years].sort((a, b) => b - a);
  if (!R.year || !R.years.includes(R.year)) R.year = R.years.find((y) => y === new Date().getFullYear()) ?? R.years[0];
}

function compute() {
  const { visits, days, expenses } = R.data;
  const y = String(R.year);
  const inYear = (d) => d.startsWith(y);
  const monthIdx = (d) => +d.slice(5, 7) - 1;
  const inPeriod = (d) => inYear(d) && (R.month == null || monthIdx(d) === R.month);

  const months = Array.from({ length: 12 }, blank);
  const staffMonth = {}; // υπάλληλος → [12 μήνες εργασίες]
  const period = blank();
  const staff = {};      // υπάλληλος → { services, visits }
  const cats = {};       // εργασία → { count, amount }

  for (const v of visits) {
    if (!inYear(v.date)) continue;
    const m = monthIdx(v.date);
    months[m].services += v.total; months[m].visits++;
    (staffMonth[v.staff] ||= Array(12).fill(0))[m] += v.total;
    if (!inPeriod(v.date)) continue;
    period.services += v.total; period.visits++;
    const s = (staff[v.staff] ||= { services: 0, visits: 0 });
    s.services += v.total; s.visits++;
    for (const it of v.items) {
      const c = (cats[it.cat] ||= { count: 0, amount: 0 });
      c.count++; c.amount += it.amount;
    }
  }
  for (const d of days) {
    if (!inYear(d.date) || !d.retail) continue;
    months[monthIdx(d.date)].retail += d.retail;
    if (inPeriod(d.date)) period.retail += d.retail;
  }
  for (const e of expenses) {
    if (!inYear(e.date)) continue;
    months[monthIdx(e.date)].expenses += e.amount;
    if (inPeriod(e.date)) period.expenses += e.amount;
  }
  const order = (names) => [...names].sort((a, b) => {
    const ia = R.staffOrder.indexOf(a), ib = R.staffOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'el');
  });
  return {
    months, period, staffMonth,
    staffNames: order(new Set([...Object.keys(staffMonth), ...Object.keys(staff)])),
    staff,
    cats: Object.entries(cats).map(([name, c]) => ({ name, ...c })).sort((a, b) => b.amount - a.amount),
  };
}

// ---------------------------------------------------------------- γράφημα ανά μήνα
// Ομαδοποιημένες στήλες Τζίρος / Έξοδα, ένας άξονας, tooltip ανά μήνα.
function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function monthChart(months, width) {
  // Σχεδιάζεται στο πραγματικό πλάτος, ώστε τα γράμματα να μένουν ευανάγνωστα και στο κινητό.
  const W = Math.max(300, Math.round(width || 760)), narrow = W < 560;
  const H = narrow ? 220 : 260, L = narrow ? 46 : 64, Rm = 6, T = 12, B = 28;
  const max = niceMax(Math.max(...months.map((m) => Math.max(turnover(m), m.expenses))) / 100);
  const pw = W - L - Rm, ph = H - T - B, gw = pw / 12;
  const bw = Math.max(3, Math.min(22, (gw - (narrow ? 6 : 10)) / 2));
  const y = (cents) => T + ph - (cents / 100 / max) * ph;
  const bar = (x, top, cls) => {
    const h = T + ph - top;
    if (h <= 0.5) return '';
    const r = Math.min(4, h, bw / 2);
    return `<path class="${cls}" d="M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z"/>`;
  };
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = T + ph - (ph / 4) * i;
    const lab = narrow && v >= 1000 ? `${num.format(v / 1000)} χιλ.` : eur0.format(v);
    grid += `<line class="grid" x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}"/><text class="tick" x="${L - 6}" y="${yy + 4}" text-anchor="end">${lab}</text>`;
  }
  let bars = '', labels = '', hits = '';
  months.forEach((m, i) => {
    const gx = L + gw * i, cx = gx + gw / 2;
    bars += bar(cx - bw - 1, y(turnover(m)), 's1') + bar(cx + 1, y(m.expenses), 's2');
    labels += `<text class="tick${R.month === i ? ' sel' : ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${narrow ? i + 1 : MONTHS[i]}</text>`;
    hits += `<rect class="hit${R.month === i ? ' sel' : ''}" data-m="${i}" x="${gx}" y="${T}" width="${gw}" height="${ph + B}"/>`;
  });
  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Τζίρος και έξοδα ανά μήνα ${R.year}">
      ${grid}${hits}${bars}<line class="axis" x1="${L}" x2="${W - Rm}" y1="${T + ph}" y2="${T + ph}"/>${labels}
    </svg>
    <div class="tip" hidden></div>
  </div>`;
}

function hbars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar" title="${esc(r.label)}: ${fmt(r.value)}">
      <span class="hb-label">${esc(r.label)}</span>
      <span class="hb-track"><span class="hb-fill" style="width:${Math.max(0.5, (r.value / max) * 100)}%"></span></span>
      <span class="hb-val">${fmt(r.value)}</span>
    </div>`).join('')}</div>`;
}

// Πλάτος γραφήματος = πλάτος κάρτας μείον padding.
function chartWidth(el) {
  const w = el.clientWidth || 360;
  return Math.min(w, 1180) - 34;
}

let resizeTimer = null, lastWidth = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const el = document.querySelector('#tab-results');
    if (!el || el.hidden || !el.querySelector('.chart-wrap') || Math.abs(el.clientWidth - lastWidth) < 20) return;
    renderResults(el);
  }, 200);
});

// ---------------------------------------------------------------- απόδοση
export async function renderResults(el) {
  await load();
  const C = compute();
  const P = C.period;
  const periodLabel = R.month == null ? `${R.year}` : `${MONTHS_LONG[R.month]} ${R.year}`;
  const hasData = P.visits || P.retail || P.expenses;
  const yearTotal = C.months.reduce((a, m) => ({ services: a.services + m.services, retail: a.retail + m.retail, expenses: a.expenses + m.expenses, visits: a.visits + m.visits }), blank());

  const filters = `
    <div class="filters">
      <label><span>Έτος</span><select class="input" data-r="year">${R.years.map((y) => `<option ${y === R.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label><span>Περίοδος</span><select class="input" data-r="month">
        <option value="" ${R.month == null ? 'selected' : ''}>Όλο το έτος</option>
        ${MONTHS_LONG.map((m, i) => `<option value="${i}" ${R.month === i ? 'selected' : ''}>${m}</option>`).join('')}
      </select></label>
    </div>`;

  const kpis = `
    <div class="kpis">
      <div class="stat"><div class="k">Τζίρος</div><div class="v">${fmt(turnover(P))}</div>
        <div class="sub">εργασίες ${fmt(P.services)} + μεταπώληση ${fmt(P.retail)}</div></div>
      <div class="stat"><div class="k">Έξοδα</div><div class="v">${fmt(P.expenses)}</div></div>
      <div class="stat"><div class="k">Κέρδος</div><div class="v ${profit(P) < 0 ? 'bad' : ''}">${fmtSigned(profit(P))}</div>
        <div class="sub">${turnover(P) ? `${pct(profit(P), turnover(P))} του τζίρου` : '&nbsp;'}</div></div>
      <div class="stat"><div class="k">Πελάτες</div><div class="v">${num.format(P.visits)}</div>
        <div class="sub">μέσος λογαριασμός ${P.visits ? fmt(P.services / P.visits) : '—'}</div></div>
    </div>`;

  const monthRows = C.months.map((m, i) => {
    const empty = !m.visits && !m.retail && !m.expenses;
    return `<tr class="${R.month === i ? 'sel' : ''}" data-m="${i}">
      <th>${MONTHS_LONG[i]}</th>
      <td>${empty ? '—' : fmt(turnover(m))}</td><td>${empty ? '—' : fmt(m.expenses)}</td>
      <td class="${profit(m) < 0 ? 'bad' : ''}">${empty ? '—' : fmtSigned(profit(m))}</td><td>${empty ? '—' : num.format(m.visits)}</td></tr>`;
  }).join('');

  const monthly = `
    <section class="rcard wide">
      <h3>Ανά μήνα — ${R.year}</h3>
      <div class="legend"><span><i class="sw s1"></i>Τζίρος</span><span><i class="sw s2"></i>Έξοδα</span>
        <span class="hint">Πάτα μήνα για λεπτομέρειες</span></div>
      ${monthChart(C.months, chartWidth(el))}
      <div class="tscroll"><table class="rtable clickable">
        <thead><tr><th>Μήνας</th><th>Τζίρος</th><th>Έξοδα</th><th>Κέρδος</th><th>Πελάτες</th></tr></thead>
        <tbody>${monthRows}</tbody>
        <tfoot><tr><th>Σύνολο ${R.year}</th><td>${fmt(turnover(yearTotal))}</td><td>${fmt(yearTotal.expenses)}</td>
          <td class="${profit(yearTotal) < 0 ? 'bad' : ''}">${fmtSigned(profit(yearTotal))}</td><td>${num.format(yearTotal.visits)}</td></tr></tfoot>
      </table></div>
    </section>`;

  const staffRows = C.staffNames.filter((n) => C.staff[n]).map((n) => ({ name: n, ...C.staff[n] }));
  const staffCard = `
    <section class="rcard">
      <h3>Ανά υπάλληλο — ${periodLabel}</h3>
      ${staffRows.length ? hbars(staffRows.map((s) => ({ label: s.name, value: s.services }))) +
        `<div class="tscroll"><table class="rtable">
          <thead><tr><th>Υπάλληλος</th><th>Εργασίες</th><th>Μερίδιο</th><th>Πελάτες</th><th>Μέσος λογ.</th></tr></thead>
          <tbody>${staffRows.map((s) => `<tr><th>${esc(s.name)}</th><td>${fmt(s.services)}</td><td>${pct(s.services, P.services)}</td>
            <td>${num.format(s.visits)}</td><td>${fmt(s.services / s.visits)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="empty">Καμία εργασία σε αυτή την περίοδο.</p>'}
      <p class="note">Μόνο εργασίες: τα έξοδα και η μεταπώληση είναι κοινά, δεν χρεώνονται σε υπάλληλο.</p>
    </section>`;

  const catCard = `
    <section class="rcard">
      <h3>Εργασίες που φέρνουν τα περισσότερα — ${periodLabel}</h3>
      ${C.cats.length ? hbars(C.cats.map((c) => ({ label: c.name, value: c.amount }))) +
        `<div class="tscroll"><table class="rtable">
          <thead><tr><th>Εργασία</th><th>Τζίρος</th><th>Μερίδιο</th><th>Φορές</th><th>Μέση τιμή</th></tr></thead>
          <tbody>${C.cats.map((c) => `<tr><th>${esc(c.name)}</th><td>${fmt(c.amount)}</td><td>${pct(c.amount, P.services)}</td>
            <td>${num.format(c.count)}</td><td>${fmt(c.amount / c.count)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="empty">Καμία εργασία σε αυτή την περίοδο.</p>'}
    </section>`;

  const staffYear = C.staffNames.length ? `
    <section class="rcard wide">
      <h3>Υπάλληλοι ανά μήνα — εργασίες ${R.year}</h3>
      <div class="tscroll"><table class="rtable matrix">
        <thead><tr><th></th>${MONTHS.map((m, i) => `<th class="${R.month === i ? 'selc' : ''}">${m}</th>`).join('')}<th>Σύνολο</th></tr></thead>
        <tbody>${C.staffNames.map((n) => {
          const arr = C.staffMonth[n] || Array(12).fill(0);
          return `<tr><th>${esc(n)}</th>${arr.map((v, i) => `<td class="${R.month === i ? 'selc' : ''}">${v ? fmt(v) : '—'}</td>`).join('')}<td><b>${fmt(arr.reduce((a, b) => a + b, 0))}</b></td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>` : '';

  el.innerHTML = `${filters}
    <h2 class="rtitle">${periodLabel}</h2>
    ${kpis}
    ${hasData || yearTotal.visits ? '' : '<div class="empty">Δεν υπάρχουν καταχωρήσεις για αυτή την περίοδο.</div>'}
    <div class="rgrid">${monthly}${staffCard}${catCard}${staffYear}</div>
    <p class="note">Τζίρος = εργασίες + μεταπώληση. Κέρδος = τζίρος − έξοδα. Το POS είναι τρόπος πληρωμής και δεν προστίθεται.</p>`;
  bind(el, C);
  lastWidth = el.clientWidth;
}

function bind(el, C) {
  el.querySelectorAll('select[data-r]').forEach((s) => {
    s.onchange = () => {
      if (s.dataset.r === 'year') R.year = +s.value;
      else R.month = s.value === '' ? null : +s.value;
      renderResults(el);
    };
  });
  const pick = (m) => { R.month = R.month === m ? null : m; renderResults(el); };
  el.querySelectorAll('table.clickable tbody tr').forEach((tr) => (tr.onclick = () => pick(+tr.dataset.m)));

  // Tooltip στο γράφημα: hover σε υπολογιστή, άγγιγμα σε κινητό (δεύτερο άγγιγμα = επιλογή μήνα).
  const wrap = el.querySelector('.chart-wrap');
  if (!wrap) return;
  const tip = wrap.querySelector('.tip');
  let shown = null;
  const show = (rect) => {
    const m = +rect.dataset.m, d = C.months[m];
    shown = m;
    tip.innerHTML = `<b>${MONTHS_LONG[m]} ${R.year}</b>
      <div><i class="sw s1"></i>Τζίρος <span>${fmt(turnover(d))}</span></div>
      <div><i class="sw s2"></i>Έξοδα <span>${fmt(d.expenses)}</span></div>
      <div class="tp">Κέρδος <span>${fmtSigned(profit(d))}</span></div>
      <div class="tp">Πελάτες <span>${num.format(d.visits)}</span></div>`;
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect(), rr = rect.getBoundingClientRect();
    const x = rr.left - wr.left + rr.width / 2;
    tip.style.left = `${Math.min(Math.max(x - tip.offsetWidth / 2, 0), wr.width - tip.offsetWidth)}px`;
    wrap.querySelectorAll('rect.hit').forEach((r) => r.classList.toggle('hov', r === rect));
  };
  wrap.querySelectorAll('rect.hit').forEach((r) => {
    r.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(r); });
    r.addEventListener('click', () => { if (shown === +r.dataset.m) pick(shown); else show(r); });
  });
  wrap.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    tip.hidden = true; shown = null;
    wrap.querySelectorAll('rect.hit').forEach((r) => r.classList.remove('hov'));
  });
}
