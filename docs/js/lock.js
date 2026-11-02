// Κλείδωμα με PIN (4 ψηφία). Ανά συσκευή — ΔΕΝ μπαίνει στο backup.
// Αποθηκεύεται μόνο αποτύπωμα SHA-256 (με τυχαίο «αλάτι»), όχι το ίδιο το PIN.
// Σημείωση: είναι κλείδωμα οθόνης, όχι κρυπτογράφηση της βάσης.

import * as db from './db.js';

const LOCK_AFTER_MS = 2 * 60 * 1000; // ξανά PIN αν η εφαρμογή έλειψε > 2 λεπτά
const MAX_TRIES = 5, WAIT_MS = 30 * 1000;

async function digest(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function hasPin() { return !!(await db.getMeta('pin')); }
async function savePin(pin) { const salt = db.newUid(); await db.setMeta('pin', { salt, hash: await digest(pin, salt) }); }
async function checkPin(pin) { const p = await db.getMeta('pin'); return !!p && (await digest(pin, p.salt)) === p.hash; }
export async function removePin() { await db.setMeta('pin', null); }

const el = () => document.getElementById('lock');
let tries = 0, waitUntil = 0;

// mode: 'unlock' | 'set' | 'verify'
// opts: { title, allowCancel, onDone(ok), onLater }
export function showPad(mode, opts = {}) {
  const box = el();
  let entry = '', first = null;
  const titles = {
    unlock: 'Πληκτρολόγησε τον κωδικό',
    verify: opts.title || 'Πληκτρολόγησε τον τωρινό κωδικό',
    set: opts.title || 'Διάλεξε νέο κωδικό 4 ψηφίων',
  };
  const render = (msg = '', shake = false) => {
    const step = mode === 'set' && first ? 'Ξαναγράψ’ τον για επιβεβαίωση' : titles[mode];
    box.innerHTML = `
      <div class="lock-inner">
        <img src="icons/icon-192.png" alt="" class="lock-logo">
        <div class="lock-name">Συνταγές</div>
        <div class="lock-title">${step}</div>
        <div class="lock-dots ${shake ? 'shake' : ''}">${[0, 1, 2, 3].map((i) => `<i class="${i < entry.length ? 'on' : ''}"></i>`).join('')}</div>
        <div class="lock-msg">${msg}</div>
        <div class="lock-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
          ${mode === 'unlock' ? '<button class="lk-text" data-k="forgot">Ξέχασα</button>' : opts.allowCancel || opts.onLater ? `<button class="lk-text" data-k="cancel">${opts.onLater ? 'Αργότερα' : 'Άκυρο'}</button>` : '<span></span>'}
          <button data-k="0">0</button>
          <button class="lk-text" data-k="del" aria-label="Σβήσιμο">⌫</button>
        </div>
      </div>`;
  };
  const finish = (ok) => { box.hidden = true; box.innerHTML = ''; box.onclick = null; document.removeEventListener('keydown', onKey); opts.onDone?.(ok); };
  const submit = async () => {
    if (mode === 'set') {
      if (!first) { first = entry; entry = ''; return render(); }
      if (entry !== first) { first = null; entry = ''; return render('Δεν ταίριαξαν — ξαναδοκίμασε', true); }
      await savePin(entry); return finish(true);
    }
    if (Date.now() < waitUntil) { entry = ''; return render(`Περίμενε ${Math.ceil((waitUntil - Date.now()) / 1000)}″`, true); }
    if (await checkPin(entry)) { tries = 0; return finish(true); }
    tries++; entry = '';
    if (tries >= MAX_TRIES) { waitUntil = Date.now() + WAIT_MS; tries = 0; return render('Πολλές λάθος προσπάθειες — περίμενε 30″', true); }
    render('Λάθος κωδικός', true);
  };
  const press = (k) => {
    if (k === 'del') { entry = entry.slice(0, -1); return render(); }
    if (k === 'cancel') { if (opts.onLater) { box.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey); return opts.onLater(); } return finish(false); }
    if (k === 'forgot') return forgot(() => render());
    if (entry.length >= 4) return;
    entry += k; render();
    if (entry.length === 4) setTimeout(submit, 120);
  };
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
  };
  box.onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); };
  document.addEventListener('keydown', onKey);
  box.hidden = false;
  render();
}

function forgot(back) {
  const box = el();
  box.innerHTML = `<div class="lock-inner lock-forgot">
    <div class="lock-title">Ξέχασες τον κωδικό;</div>
    <p>Για ασφάλεια ο κωδικός δεν ανακτάται. Η μόνη λύση είναι να σβηστούν τα δεδομένα <b>αυτής της συσκευής</b>
      και να επαναφερθούν από το τελευταίο αρχείο που στάλθηκε (⚙︎ → Εισαγωγή αρχείου).</p>
    <p>Ό,τι γράφτηκε μετά την τελευταία αποστολή θα χαθεί.</p>
    <button class="btn danger" data-k="wipe">Σβήσε τα δεδομένα αυτής της συσκευής</button>
    <button class="btn" data-k="back" style="margin-top:10px">← Πίσω</button></div>`;
  box.onclick = async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k === 'back') { box.onclick = null; return back(); }
    if (k === 'wipe') {
      const typed = prompt('Γράψε ΣΒΗΣΕ για επιβεβαίωση:');
      if ((typed || '').trim().toUpperCase() !== 'ΣΒΗΣΕ') return;
      await db.wipe();
      location.reload();
    }
  };
}

// Κάλυμμα στο παρασκήνιο (για να μη φαίνεται στη λίστα εφαρμογών) + ξανά PIN μετά από 2'.
export function guardBackground(onLocked) {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (!(await hasPin())) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      document.documentElement.classList.add('covered');
    } else {
      if (Date.now() - hiddenAt > LOCK_AFTER_MS && el().hidden) {
        showPad('unlock', { onDone: () => document.documentElement.classList.remove('covered') });
        onLocked?.();
      } else if (el().hidden) {
        document.documentElement.classList.remove('covered');
      }
    }
  });
}
