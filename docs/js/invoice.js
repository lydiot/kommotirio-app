// Τιμολόγιο / παραλαβή εμπορευμάτων.
//
// Μία παραλαβή = κεφαλίδα (ημερομηνία, προμηθευτής, αρ. τιμολογίου, σύνολο, έκπτωση) + γραμμές
// (προϊόν, τεμάχια, τιμή καταλόγου/τιμολογίου, έκπτωση %). Κάθε γραμμή γίνεται κίνηση «receive» με:
//   cost = καθαρή τιμή τεμαχίου (χωρίς ΦΠΑ, μετά την έκπτωση), listPrice, disc, inv, supplier.
// Το απόθεμα και το κόστος (σταθμισμένος μέσος όρος) προκύπτουν από τις κινήσεις — τίποτα δεν αντιγράφεται
// στο προϊόν, οπότε η διαγραφή ενός τιμολογίου επαναφέρει αυτόματα τα κόστη.

import * as db from './db.js';
import { helpers, loadStock, getCache, normKey, fDate, afterChange, autoId } from './stock.js';

let S = null; // ενεργή παραλαβή: { el, lineHtml, updateLine, updateTotals }

const parsePct = (s) => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : 0; };

document.addEventListener('pkpick', (e) => {
  const line = e.target.closest?.('.inv-line');
  if (line && S) S.onPick(line, e.detail.product);
});

export async function openInvoice(el, { product = null } = {}) {
  const H = helpers();
  const { esc, fmt, parseMoney, toInput, cleanName } = H;
  await loadStock();
  const cache = getCache();
  const supplier0 = (await db.getMeta('lastSupplier')) || 'L\'Oréal';

  const lineHtml = (P) => `<div class="inv-line" ${P ? `data-pid="${P.id}"` : ''}>
    <div class="inv-top" data-pk-row>
      <input class="input" data-i="name" data-pk="any" placeholder="Προϊόν: όνομα, κωδικός ή barcode" autocomplete="off" autocapitalize="sentences" value="${esc(P?.name || '')}">
      <button class="item-x" data-act="inv-rm" aria-label="Αφαίρεση γραμμής">✕</button>
    </div>
    <div class="inv-nums">
      <label><span>Τεμ.</span><input class="input" data-i="qty" inputmode="numeric" placeholder="1"></label>
      <label><span>Τιμή (χωρίς ΦΠΑ)</span><span class="money"><input class="input" data-i="price" inputmode="decimal" placeholder="0" value="${P ? toInput(P.lastList ?? P.listCost ?? null) : ''}"><span class="cur">€</span></span></label>
      <label><span>Έκπτωση</span><span class="money"><input class="input" data-i="disc" inputmode="decimal" placeholder="0"><span class="cur">%</span></span></label>
    </div>
    <div class="inv-info"></div>
  </div>`;

  const prodOf = (line) => {
    const name = line.querySelector('[data-i=name]').value;
    const pid = line.dataset.pid;
    const P = pid && cache.byId.get(pid);
    if (P && normKey(P.name) === normKey(name)) return P;
    const k = normKey(name);
    const byName = cache.byId.get(cache.byName.get(k));
    if (byName) return byName;
    return cache.list.find((p) => (p.code && normKey(p.code) === k) || (p.ean && p.ean === name.trim())) || null;
  };
  const read = (line) => {
    const q = line.querySelector('[data-i=qty]').value.trim(), pr = line.querySelector('[data-i=price]').value.trim(), d = line.querySelector('[data-i=disc]').value.trim();
    const qty = q === '' ? NaN : parseInt(q, 10), list = pr === '' ? null : parseMoney(pr), disc = parsePct(d);
    const net = list == null || Number.isNaN(list) ? null : Math.round(list * (1 - disc / 100));
    return { qty, list, disc, net, total: Number.isFinite(qty) && qty > 0 && net != null ? qty * net : 0, priceBad: Number.isNaN(list) };
  };

  const updateLine = (line) => {
    const P = prodOf(line), r = read(line), info = line.querySelector('.inv-info');
    const bits = [];
    if (!line.querySelector('[data-i=name]').value.trim()) { info.innerHTML = ''; return; }
    if (!P) bits.push('<span class="note-new">νέο προϊόν — δεν υπάρχει στον κατάλογο</span>');
    if (r.priceBad) bits.push('<span class="bad">λάθος τιμή</span>');
    else if (r.net != null) {
      bits.push(`καθαρή ${fmt(r.net)}${Number.isFinite(r.qty) && r.qty > 0 ? ` × ${r.qty} = <b>${fmt(r.total)}</b>` : ''}`);
      if (P?.lastCost != null) {
        const d = ((r.net - P.lastCost) / P.lastCost) * 100;
        if (Math.abs(d) >= 0.5) bits.push(`<span class="${d > 0 ? 'bad' : 'ok'}">${d > 0 ? '▲' : '▼'} ${d > 0 ? '+' : ''}${Math.round(d)}% από ${fmt(Math.round(P.lastCost))} (προηγούμενη αγορά)</span>`);
        else bits.push('<span class="ok">ίδια τιμή με την προηγούμενη αγορά</span>');
      } else if (P?.listCost != null && r.list != null && r.list !== P.listCost) {
        bits.push(`<span class="warn-t">κατάλογος: ${fmt(P.listCost)}</span>`);
      }
    }
    info.innerHTML = bits.join(' · ');
  };

  const updateTotals = () => {
    let sum = 0, n = 0;
    document.querySelectorAll('#inv-lines .inv-line').forEach((l) => { if (l.querySelector('[data-i=name]').value.trim()) { sum += read(l).total; n++; } });
    const hdr = parseMoney(document.getElementById('inv-total').value);
    let h = `<div class="total-line"><span>Σύνολο γραμμών (${n}) χωρίς ΦΠΑ</span><b>${fmt(sum)}</b></div>`;
    if (hdr != null && !Number.isNaN(hdr)) {
      const diff = sum - hdr;
      h += Math.abs(diff) <= 5 ? '<div class="ok" style="margin-bottom:8px">✓ Συμφωνεί με το σύνολο του τιμολογίου</div>'
        : `<div class="warn" style="margin-bottom:8px">Το τιμολόγιο γράφει ${fmt(hdr)} — διαφορά ${fmt(Math.abs(diff))} (${diff > 0 ? 'οι γραμμές είναι περισσότερες' : 'λείπουν γραμμές ή τιμές'}).</div>`;
    }
    document.getElementById('inv-foot-sum').innerHTML = h;
  };

  S = {
    onPick(line, P) {
      line.dataset.pid = P.id;
      const price = line.querySelector('[data-i=price]');
      price.value = toInput(P.lastList ?? P.listCost ?? null);
      const disc = line.querySelector('[data-i=disc]');
      if (!disc.dataset.manual) disc.value = document.getElementById('inv-disc').value;
      updateLine(line); updateTotals();
      line.querySelector('[data-i=qty]').focus();
    },
  };

  H.openSheet({
    title: product ? `Παραλαβή: ${product.name}` : 'Τιμολόγιο / Παραλαβή',
    body: `
      <p class="note" style="margin-top:0">Γράψε τις γραμμές όπως είναι στο τιμολόγιο. Οι τιμές είναι <b>χωρίς ΦΠΑ</b>.
        Ενημερώνονται το απόθεμα και το κόστος, και σου δείχνω αν μια τιμή άλλαξε από την προηγούμενη φορά.</p>
      <div class="grid2">
        <label class="field"><span class="lbl">Ημερομηνία</span><input class="input" type="date" id="inv-date" value="${H.todayStr()}"></label>
        <label class="field"><span class="lbl">Αρ. τιμολογίου</span><input class="input" id="inv-no" autocomplete="off" placeholder="προαιρετικό"></label>
      </div>
      <label class="field" style="margin-top:12px"><span class="lbl">Προμηθευτής</span><input class="input" id="inv-supplier" autocomplete="off" value="${esc(supplier0)}"></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Σύνολο τιμολογίου (χωρίς ΦΠΑ)</span><span class="money"><input class="input" id="inv-total" inputmode="decimal" placeholder="για έλεγχο"><span class="cur">€</span></span></label>
        <label class="field"><span class="lbl">Έκπτωση σε όλες τις γραμμές</span><span class="money"><input class="input" id="inv-disc" inputmode="decimal" placeholder="0"><span class="cur">%</span></span></label>
      </div>
      <h2>Γραμμές</h2>
      <div id="inv-lines">${lineHtml(product)}${product ? '' : lineHtml() + lineHtml()}</div>
      <button class="btn" data-act="inv-add">＋ Γραμμή</button>`,
    foot: `<div id="inv-foot-sum"></div><button class="btn primary big" data-act="inv-save">Καταχώρηση</button>`,
    onInput(t) {
      const line = t.closest('.inv-line');
      if (line) { if (t.dataset.i === 'disc') t.dataset.manual = '1'; updateLine(line); updateTotals(); }
      else if (t.id === 'inv-total') updateTotals();
      else if (t.id === 'inv-disc') {
        document.querySelectorAll('#inv-lines [data-i=disc]').forEach((d) => { if (!d.dataset.manual) { d.value = t.value; updateLine(d.closest('.inv-line')); } });
        updateTotals();
      }
    },
    async onAction(act, b) {
      if (act === 'inv-add') {
        const box = document.getElementById('inv-lines');
        box.insertAdjacentHTML('beforeend', lineHtml());
        const last = box.lastElementChild;
        last.querySelector('[data-i=disc]').value = document.getElementById('inv-disc').value;
        last.querySelector('[data-i=name]').focus();
        return;
      }
      if (act === 'inv-rm') { b.closest('.inv-line').remove(); updateTotals(); return; }
      if (act !== 'inv-save') return;
      await save();
    },
  });
  if (product) { const l = document.querySelector('#inv-lines .inv-line'); l.querySelector('[data-i=qty]').focus(); }
  updateTotals();

  async function save() {
    const date = document.getElementById('inv-date').value || H.todayStr();
    const supplier = cleanName(document.getElementById('inv-supplier').value);
    const inv = cleanName(document.getElementById('inv-no').value);
    const hdr = parseMoney(document.getElementById('inv-total').value);
    if (Number.isNaN(hdr)) return H.toast('Λάθος σύνολο τιμολογίου');
    const lines = [];
    for (const l of document.querySelectorAll('#inv-lines .inv-line')) {
      const name = cleanName(l.querySelector('[data-i=name]').value), r = read(l);
      if (!name && Number.isNaN(r.qty) && r.list == null) continue;
      if (!name) return H.toast('Λείπει όνομα προϊόντος σε μία γραμμή');
      if (!Number.isFinite(r.qty) || r.qty <= 0) return H.toast(`Λείπουν τα τεμάχια: ${name}`);
      if (r.priceBad) return H.toast(`Λάθος τιμή: ${name}`);
      if (r.disc < 0 || r.disc > 100) return H.toast(`Λάθος έκπτωση: ${name}`);
      lines.push({ name, P: prodOf(l), ...r });
    }
    if (!lines.length) return H.toast('Γράψε τουλάχιστον ένα προϊόν');

    const missingPrice = lines.filter((x) => x.net == null);
    if (missingPrice.length && !confirm(`Χωρίς τιμή: ${missingPrice.map((x) => x.name).join(', ')}.\nΤο απόθεμα θα αυξηθεί αλλά το κόστος δεν θα ενημερωθεί. Συνέχεια;`)) return;
    const unknown = lines.filter((x) => !x.P);
    if (unknown.length && !confirm(`Δεν υπάρχουν στον κατάλογο:\n${unknown.map((x) => x.name).join('\n')}\n\nΝα δημιουργηθούν νέα προϊόντα;`)) return;
    if (inv) {
      const dup = (await db.getAll('moves')).some((m) => m.type === 'receive' && m.inv && normKey(m.inv) === normKey(inv) && normKey(m.supplier || '') === normKey(supplier));
      if (dup && !confirm(`Το τιμολόγιο «${inv}» του προμηθευτή «${supplier}» έχει ήδη καταχωρηθεί.\nΝα προστεθεί ξανά (διπλή αύξηση αποθέματος);`)) return;
    }
    const sum = lines.reduce((a, x) => a + x.total, 0);
    if (hdr != null && Math.abs(sum - hdr) > 5 && !confirm(`Οι γραμμές κάνουν ${fmt(sum)}, το τιμολόγιο γράφει ${fmt(hdr)} (διαφορά ${fmt(Math.abs(sum - hdr))}).\nΝα καταχωρηθεί ούτως ή άλλως;`)) return;

    const now = Date.now(), [yy, mm, dd] = date.split('-').map(Number);
    const base = date === H.todayStr() ? now : new Date(yy, mm - 1, dd, 12).getTime();
    const newProds = [], moves = [], changes = [];
    lines.forEach((x, i) => {
      let P = x.P;
      if (!P) {
        const id = autoId(x.name);
        P = { id, name: x.name, kind: 'both', code: '', size: '', cost: null, price: null, min: 1, updatedAt: now };
        newProds.push(P);
        cache.byName.set(normKey(x.name), id);
      }
      if (x.net != null && x.P?.lastCost != null && Math.abs(x.net - x.P.lastCost) >= 1) changes.push({ name: x.P.name, from: x.P.lastCost, to: x.net, pct: ((x.net - x.P.lastCost) / x.P.lastCost) * 100 });
      moves.push({ uid: db.newUid(), productId: P.id, date, at: base + i, type: 'receive', qty: x.qty, cost: x.net, listPrice: x.list, disc: x.disc || null,
        inv: inv || null, supplier: supplier || null, dev: H.device(), updatedAt: now });
    });
    await db.transaction(['products', 'moves'], (tx) => {
      newProds.forEach((p) => tx.objectStore('products').put(p));
      moves.forEach((m) => tx.objectStore('moves').put(m));
    });
    if (supplier) await db.setMeta('lastSupplier', supplier);
    S = null;
    H.closeSheet();
    await afterChange(el, null, null);
    showSummary({ n: lines.length, qty: lines.reduce((a, x) => a + x.qty, 0), sum, changes, newCount: newProds.length, inv });
  }

  function showSummary({ n, qty, sum, changes, newCount, inv }) {
    H.openSheet({
      title: '✓ Καταχωρήθηκε',
      body: `<div class="card">
          <div class="kv"><span>Γραμμές</span><span>${n}</span></div>
          <div class="kv"><span>Τεμάχια</span><span>${qty}</span></div>
          <div class="kv total"><span>Αξία (χωρίς ΦΠΑ)</span><span>${fmt(sum)}</span></div>
          ${newCount ? `<div class="kv"><span>Νέα προϊόντα</span><span>${newCount}</span></div>` : ''}
        </div>
        ${changes.length ? `<h2>Άλλαξαν οι τιμές (${changes.length})</h2><div class="list">${changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).map((c) => `
          <div class="row st-ev"><span class="main"><div class="title" style="font-weight:500">${esc(c.name)}</div><div class="sub">${fmt(Math.round(c.from))} → ${fmt(c.to)}</div></span>
            <span class="amt ${c.pct > 0 ? 'bad' : 'ok'}">${c.pct > 0 ? '▲ +' : '▼ '}${Math.round(c.pct)}%</span></div>`).join('')}</div>`
        : '<p class="note">Καμία αλλαγή τιμής σε σχέση με την προηγούμενη αγορά.</p>'}`,
      foot: '<button class="btn primary big" data-act="close">Εντάξει</button>',
      onAction() {},
    });
  }
}

// ---------------------------------------------------------------- λίστα τιμολογίων
export async function openInvoices(el) {
  const H = helpers();
  const { esc, fmt } = H;
  await loadStock();
  const cache = getCache();
  const moves = (await db.getAll('moves')).filter((m) => m.type === 'receive');
  const groups = new Map();
  for (const m of moves) {
    const k = `${m.inv || ''}|${normKey(m.supplier || '')}|${m.inv ? '' : m.date}`;
    const g = groups.get(k) || { key: k, inv: m.inv || '', supplier: m.supplier || '', date: m.date, moves: [] };
    g.moves.push(m); if (m.date > g.date) g.date = m.date; g.at = Math.max(g.at || 0, m.at || 0);
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.at || 0) - (a.at || 0)));
  const total = (g) => g.moves.reduce((a, m) => a + (m.cost != null ? m.cost * m.qty : 0), 0);
  H.openSheet({
    title: 'Τιμολόγια / Παραλαβές',
    body: list.length ? `<div class="list">${list.map((g) => `
      <button class="row" data-act="inv-open" data-k="${esc(g.key)}">
        <span class="main"><div class="title">${g.inv ? `Τιμ. ${esc(g.inv)}` : 'Παραλαβή χωρίς τιμολόγιο'}${g.supplier ? ` · ${esc(g.supplier)}` : ''}</div>
          <div class="sub">${fDate(g.date)} · ${g.moves.length} γραμμές · ${g.moves.reduce((a, m) => a + m.qty, 0)} τεμ.</div></span>
        <span class="amt">${fmt(Math.round(total(g)))}</span></button>`).join('')}</div>
      <p class="note">Τα ποσά είναι χωρίς ΦΠΑ. Πάτα ένα τιμολόγιο για τις γραμμές του ή για να το διαγράψεις.</p>`
      : '<div class="empty">Δεν έχει καταχωρηθεί ακόμα κανένα τιμολόγιο.</div>',
    onAction(act, b) {
      if (act !== 'inv-open') return;
      const g = groups.get(b.dataset.k);
      H.openSheet({
        title: g.inv ? `Τιμολόγιο ${g.inv}` : 'Παραλαβή',
        body: `<div class="card"><div class="kv"><span>Ημερομηνία</span><span>${fDate(g.date)}</span></div>
            ${g.supplier ? `<div class="kv"><span>Προμηθευτής</span><span>${esc(g.supplier)}</span></div>` : ''}
            <div class="kv total"><span>Αξία (χωρίς ΦΠΑ)</span><span>${fmt(Math.round(total(g)))}</span></div></div>
          <h2>Γραμμές</h2><div class="list">${g.moves.map((m) => {
            const P = cache.byId.get(m.productId);
            return `<div class="row st-ev"><span class="main"><div class="title" style="font-weight:500">${esc(P?.name || '(διαγραμμένο προϊόν)')}</div>
              <div class="sub">${m.qty} τεμ.${m.cost != null ? ` × ${fmt(Math.round(m.cost))}${m.disc ? ` (έκπτωση ${String(m.disc).replace('.', ',')}%)` : ''}` : ' · χωρίς τιμή'}</div></span>
              <span class="amt">${m.cost != null ? fmt(Math.round(m.cost * m.qty)) : ''}</span></div>`;
          }).join('')}</div>`,
        foot: `<button class="btn danger" data-act="inv-del">Διαγραφή ${g.inv ? 'τιμολογίου' : 'παραλαβής'}</button>
          <button class="btn" data-act="inv-back" style="margin-top:8px">← Πίσω</button>`,
        async onAction(act2) {
          if (act2 === 'inv-back') return openInvoices(el);
          if (act2 !== 'inv-del') return;
          if (!confirm(`Διαγραφή ${g.inv ? `του τιμολογίου ${g.inv}` : 'της παραλαβής'};\nΤα τεμάχια θα φύγουν από το απόθεμα και τα κόστη θα επανέλθουν στα προηγούμενα.`)) return;
          const now = Date.now();
          await db.transaction(['moves', 'deleted'], (tx) => g.moves.forEach((m) => {
            tx.objectStore('moves').delete(m.uid);
            tx.objectStore('deleted').put({ uid: m.uid, store: 'moves', date: m.date, deletedAt: now, dev: H.device() });
          }));
          H.closeSheet();
          await afterChange(el, null, 'Διαγράφηκε');
          openInvoices(el);
        },
      });
    },
  });
}
