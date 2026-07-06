// ============ Vista Movimenti (+ import estratto conto + riconciliazione) ============
import { data, save } from '../../state/store.js';
import { esc, fmt, fmtDate, fmtDateFull, parseAmount, uid, todayStr, round2, MESI } from '../../domain/util.js';
import { activeCompany, acc, cat, co, txLabel } from '../../domain/finance.js';
import { openSheet, closeSheet, toast, confirmDialog } from '../dom.js';
import { exportTable, scopeLabel, nowStamp } from '../pdf.js';
import { companyOptions, accountOptions, categoryOptions, supplierPicker, bindCombos } from '../forms.js';
import { applyRules, suggestKeyword, reapplyAll } from '../../domain/rules.js';
import { readMatrix, detect, buildRows, commitBankRows } from '../../importers/bankxls.js';
import { parseBankXml, looksLikeBankXml } from '../../importers/bankxml.js';
import { candidates, reconcileMany, ignoreRecon, searchInvoices } from '../../domain/reconcile.js';
import { invResiduo, supNameOf, invTotal, isTxReconciled, unlinkTx, txLinkedInvoices, removePayment, mgmtState, txIsLinked, MGMT } from '../../domain/invoices.js';
import { insts, unpayInst } from '../../domain/loans.js';
import { reopenScheduled } from '../../domain/scheduled.js';
import { openRuleEditor } from '../ruleeditor.js';
import { mountPicker } from '../matchpicker.js';
import { openInvoice } from './fatture.js';
import { openLoan } from './finanziamenti.js';
import { openScheduled } from './programmati.js';

let filterType = 'all';
let q = '';
let fAcc = '', fCat = '', fYear = 0, fMonth = 0, fState = '';   // fState: '' | 'todo' | 'review' | 'await' | 'managed'

// stati impostabili a mano dalla lista (pulsanti rapidi). 'todo' = nessun flag (t.mgmt = null).
const STATE_OPTS = [
  { v: 'todo', icon: '⬜', label: 'Da gestire' },
  { v: 'await', icon: '⏳', label: 'In attesa di fattura' },
  { v: 'review', icon: '👁', label: 'Da rivedere' },
  { v: 'managed', icon: '✅', label: 'Gestito' }
];
function setMovState(txId, state) {
  const t = data.transactions.find(x => x.id === txId);
  if (!t) return;
  t.mgmt = state === 'todo' ? null : state;
  save();   // lo store emette → la lista si ridisegna con nuovo colore/pulsante attivo
}

function inScope() {
  const s = activeCompany();
  return (s ? data.transactions.filter(t => t.companyId === s) : data.transactions);
}

export function render() {
  let h = `<div class="pagehead"><h1>Movimenti</h1></div>`;
  h += `<div class="btnrow" style="margin-bottom:12px">
    <button class="btn primary" data-new>+ Nuovo</button>
    <button class="btn" data-importxls>⭳ Importa estratto conto</button>
    ${data.rules.length ? '<button class="btn" data-reapply>↻ Riapplica regole esistenti</button>' : ''}
  </div>`;
  h += listView();
  return h;
}

// ---------- elenco movimenti ----------
function applyFilters() {
  let list = inScope();
  if (filterType !== 'all') list = list.filter(t => t.type === filterType);
  if (fAcc) list = list.filter(t => t.accountId === fAcc || t.toAccountId === fAcc);
  if (fCat === '__none__') list = list.filter(t => t.type !== 'transfer' && !cat(t.categoryId));
  else if (fCat) list = list.filter(t => t.categoryId === fCat);
  if (fYear) list = list.filter(t => (t.date || '').slice(0, 4) === String(fYear));
  if (fMonth) list = list.filter(t => (t.date || '').slice(5, 7) === String(fMonth).padStart(2, '0'));
  if (fState) list = list.filter(t => mgmtState(t) === fState);
  const term = q.trim().toLowerCase();
  if (term) list = list.filter(t => txLabel(t).toLowerCase().includes(term) || (t.desc || '').toLowerCase().includes(term) || (acc(t.accountId)?.name || '').toLowerCase().includes(term));
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

function listView() {
  const scopeList = inScope();
  const list = applyFilters();
  const years = [...new Set(scopeList.map(t => (t.date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const accs = data.accounts.filter(a => !activeCompany() || a.companyId === activeCompany());

  // conteggi per stato di gestione (sull'azienda corrente)
  const sc = { todo: 0, review: 0, await: 0, managed: 0 };
  scopeList.forEach(t => { sc[mgmtState(t)]++; });

  const chip = (v, l) => `<button class="chip ${filterType === v ? 'on' : ''}" data-f="${v}">${l}</button>`;
  const stChip = (v, l) => `<button class="chip ${fState === v ? 'on' : ''}" data-st="${v}">${l}${sc[v] ? ' · ' + sc[v] : ''}</button>`;
  const catOpts = data.categories.map(c => `<option value="${c.id}" ${fCat === c.id ? 'selected' : ''}>${esc((c.emoji || '') + ' ' + c.name)}</option>`).join('');
  const accOpts = accs.map(a => `<option value="${a.id}" ${fAcc === a.id ? 'selected' : ''}>${esc((a.emoji || '') + ' ' + a.name)}</option>`).join('');
  const anyFilter = filterType !== 'all' || fAcc || fCat || fYear || fMonth || fState || q.trim();

  // totali sui risultati filtrati (i trasferimenti non incidono su entrate/uscite)
  const entrate = round2(list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0));
  const uscite = round2(list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0));

  let h = `<div class="field"><input id="movq" placeholder="Cerca per nome, descrizione o conto…" value="${esc(q)}"></div>`;
  h += `<div class="chips">${chip('all', 'Tutti')}${chip('expense', 'Uscite')}${chip('income', 'Entrate')}${chip('transfer', 'Trasferimenti')}</div>`;
  h += `<div class="chips">${stChip('todo', '⬜ Da gestire')}${stChip('review', '👁 Da rivedere')}${stChip('await', '⏳ Attesa fattura')}${stChip('managed', '✅ Gestito')}</div>`;
  h += `<div class="frow" style="gap:8px;margin-bottom:10px">
    <div class="field" style="margin:0"><label>Conto</label><select id="mf_acc"><option value="">Tutti</option>${accOpts}</select></div>
    <div class="field" style="margin:0"><label>Categoria</label><select id="mf_cat"><option value="">Tutte</option><option value="__none__" ${fCat === '__none__' ? 'selected' : ''}>— Senza categoria —</option>${catOpts}</select></div>
  </div>
  <div class="frow" style="gap:8px;margin-bottom:10px">
    <div class="field" style="margin:0;flex:0 0 110px"><label>Anno</label><select id="mf_year"><option value="0">Tutti</option>${years.map(y => `<option value="${y}" ${String(fYear) === y ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    <div class="field" style="margin:0;flex:0 0 130px"><label>Mese</label><select id="mf_month"><option value="0">Tutto l'anno</option>${MESI.map((m, k) => `<option value="${k + 1}" ${fMonth === k + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="field" style="margin:0;display:flex;align-items:flex-end">${anyFilter ? '<button class="btn sm" data-clearf style="width:100%">Azzera filtri</button>' : ''}</div>
  </div>`;

  h += `<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div><b>${list.length}</b> movimenti</div>
    <div><span class="pos tnum">+${fmt(entrate)}</span> &nbsp; <span class="neg tnum">−${fmt(uscite)}</span></div>
  </div>`;

  if (list.length) h += `<div class="btnrow" style="margin-bottom:10px"><button class="btn sm" data-exportmov>⤓ Esporta PDF</button></div>`;
  if (!list.length) h += `<div class="card empty">Nessun movimento con questi filtri.</div>`;
  else h += `<div class="list">${list.map(rowTx).join('')}</div>`;
  return h;
}

function exportMovimenti() {
  const list = applyFilters();
  if (!list.length) return;
  const entrate = round2(list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0));
  const uscite = round2(list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0));
  const filt = [];
  if (filterType !== 'all') filt.push(filterType === 'expense' ? 'uscite' : filterType === 'income' ? 'entrate' : 'trasferimenti');
  if (fAcc) filt.push('conto ' + (acc(fAcc)?.name || ''));
  if (fCat) filt.push('categoria ' + (cat(fCat)?.name || ''));
  if (fYear) filt.push('anno ' + fYear);
  if (fMonth) filt.push(MESI[fMonth - 1]);
  if (fState) filt.push((MGMT[fState]?.label || fState).toLowerCase());
  if (q.trim()) filt.push(`"${q.trim()}"`);
  const rows = list.map(t => {
    const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
    const where = t.type === 'transfer'
      ? `${acc(t.accountId)?.name || '?'} → ${acc(t.toAccountId)?.name || '?'}`
      : `${cat(t.categoryId)?.name || '—'} · ${acc(t.accountId)?.name || '—'}`;
    return [t.date ? fmtDateFull(t.date) : '—', txLabel(t), where, `${sign}${fmt(t.amount)}`];
  });
  exportTable({
    title: 'Movimenti',
    subtitle: `${scopeLabel()} · ${list.length} movimenti${filt.length ? ' · ' + filt.join(', ') : ''} · entrate +${fmt(entrate)} · uscite −${fmt(uscite)} · ${nowStamp()}`,
    sections: [{
      cols: [{ label: 'Data' }, { label: 'Descrizione' }, { label: 'Categoria / Conto' }, { label: 'Importo', right: true }],
      rows, foot: [['', '', 'Entrate − Uscite', fmt(round2(entrate - uscite))]]
    }]
  });
}
function rowTx(t) {
  const a = acc(t.accountId), c = cat(t.categoryId);
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  // icona = emoji della categoria (più informativa); fallback alla direzione
  const icon = t.type === 'transfer' ? '🔁' : (c?.emoji || (t.type === 'income' ? '⬆️' : '⬇️'));
  let sub = fmtDate(t.date);
  if (t.type === 'transfer') { const ta = acc(t.toAccountId); sub += ` · ${esc(a?.name || '?')} → ${esc(ta?.name || '?')}`; }
  else sub += `${c ? ' · ' + esc(c.name) : ' · senza categoria'}${a ? ' · ' + esc(a.name) : ''}`;
  const st = mgmtState(t);
  // auto-gestito (trasferimenti / collegati): stato non modificabile a mano → niente pulsanti.
  const auto = t.type === 'transfer' || txIsLinked(t);
  // badge testuale solo per i collegati ("riconciliato"); per i gestibili lo stato lo danno i pulsanti.
  const stBadge = (auto && st === 'managed' && txIsLinked(t)) ? ' <span class="badge b-paid">riconciliato</span>' : '';
  const tags = `${t.f24 ? ' <span class="badge b-partial">F24</span>' : ''}${t.imported ? ' <span class="badge b-unpaid">banca</span>' : ''}${stBadge}`;
  const stateCtrl = auto ? '' : `<div class="statebtns" data-stbtns>${STATE_OPTS.map(o => `<button class="stbtn ${st === o.v ? 'on' : ''}" data-setstate="${t.id}:${o.v}" title="${esc(o.label)}">${o.icon}</button>`).join('')}</div>`;
  return `<div class="row click ${st}" data-mov="${t.id}">
    <div class="emoji">${icon}</div>
    <div class="mid"><div class="t1">${esc(txLabel(t))}${tags}</div><div class="t2">${sub}</div></div>
    <div class="amt ${cls} tnum">${sign}${fmt(t.amount)}</div>
    ${stateCtrl}
  </div>`;
}

export function bind(root) {
  const rerender = () => { root.innerHTML = render(); bind(root); };
  root.querySelector('[data-new]').onclick = () => openMovimento(null);
  root.querySelector('[data-importxls]').onclick = () => openBankImport();
  root.querySelector('[data-reapply]')?.addEventListener('click', () => { const n = reapplyAll(); toast(n ? `${n} movimenti aggiornati` : 'Nessun movimento da aggiornare'); });
  root.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filterType = b.dataset.f; rerender(); });
  const accSel = root.querySelector('#mf_acc'); if (accSel) accSel.onchange = () => { fAcc = accSel.value; rerender(); };
  const catSel = root.querySelector('#mf_cat'); if (catSel) catSel.onchange = () => { fCat = catSel.value; rerender(); };
  const ySel = root.querySelector('#mf_year'); if (ySel) ySel.onchange = () => { fYear = +ySel.value; rerender(); };
  const mSel = root.querySelector('#mf_month'); if (mSel) mSel.onchange = () => { fMonth = +mSel.value; rerender(); };
  root.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { fState = (fState === b.dataset.st) ? '' : b.dataset.st; rerender(); });
  root.querySelector('[data-exportmov]')?.addEventListener('click', exportMovimenti);
  root.querySelector('[data-clearf]')?.addEventListener('click', () => { filterType = 'all'; fAcc = ''; fCat = ''; fYear = 0; fMonth = 0; fState = ''; q = ''; rerender(); });
  root.querySelectorAll('[data-mov]').forEach(el => el.onclick = () => openMovimento(el.dataset.mov));
  // pulsanti rapidi di stato nella riga (non devono aprire la scheda → stopPropagation)
  root.querySelectorAll('[data-setstate]').forEach(b => b.onclick = e => { e.stopPropagation(); const [id, st] = b.dataset.setstate.split(':'); setMovState(id, st); });
  const qi = root.querySelector('#movq');
  if (qi) qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; rerender(); const n = root.querySelector('#movq'); n.focus(); n.setSelectionRange(pos, pos); };
}

// ---------- riconciliazione: scelta fattura (anche multipla), con ricerca estesa ----------
function openMatch(txId) {
  const t = data.transactions.find(x => x.id === txId); if (!t) return;
  openSheet(`
    <h2>Abbina a fattura</h2>
    <div class="sheetsub">${esc(txLabel(t))} · ${fmtDateFull(t.date)} · ${fmt(t.amount)}</div>
    <div class="muted" style="font-size:12.5px;margin-bottom:8px">Seleziona una o più fatture (es. un bonifico unico che salda più fatture).</div>
    <div id="rm_picker"></div>
    <div id="rm_sum"></div>
    <div class="actions">
      <button class="btn" data-cancel>Chiudi</button>
      <button class="btn danger" data-ign>Ignora</button>
      <button class="btn primary" data-ok disabled>Riconcilia</button>
    </div>`, sheet => {
      const sumEl = sheet.querySelector('#rm_sum'), okBtn = sheet.querySelector('[data-ok]');
      const drawSum = (pick) => {
        const selInvs = [...pick].map(id => data.invoices.find(x => x.id === id)).filter(Boolean);
        const selTot = round2(selInvs.reduce((s, i) => s + invResiduo(i), 0));
        const diffTot = round2(t.amount - selTot);
        sumEl.innerHTML = pick.size ? `<div class="card" style="display:flex;justify-content:space-between;margin-top:10px${Math.abs(diffTot) < 0.02 ? ';border-color:var(--green)' : ''}">
          <span><b>${pick.size}</b> selezionate · ${fmt(selTot)}</span>
          <span class="tnum ${Math.abs(diffTot) < 0.02 ? 'pos' : 'neg'}">${diffTot === 0 ? 'esatto ✓' : (diffTot > 0 ? 'restano ' + fmt(diffTot) : 'eccesso ' + fmt(-diffTot))}</span>
        </div>` : '';
        okBtn.disabled = pick.size === 0; okBtn.textContent = 'Riconcilia' + (pick.size ? ' ' + pick.size : '');
      };
      const pk = mountPicker(sheet.querySelector('#rm_picker'), {
        placeholder: 'Cerca tra tutte le fatture non pagate (nome o numero)…',
        fetch: term => term.trim() ? searchInvoices(t, term) : candidates(t),
        id: ({ inv }) => inv.id,
        row: ({ inv, diff, nameHit }) => `<div class="mid"><div class="t1">${esc(supNameOf(inv))} ${nameHit ? '<span class="badge b-paid">nome ✓</span>' : ''} ${diff < 0.02 ? '<span class="badge b-unpaid">importo ✓</span>' : ''}</div>
            <div class="t2">${inv.number ? 'N. ' + esc(inv.number) + ' · ' : ''}${inv.date ? fmtDate(inv.date) : ''}${inv.due ? ' · scad. ' + fmtDate(inv.due) : ''} · residuo ${fmt(invResiduo(inv))}</div></div>`,
        empty: term => `<div class="muted" style="padding:10px 2px">${term.trim() ? 'Nessuna fattura trovata.' : 'Nessuna fattura compatibile. Cerca per nome o numero, oppure ignora il movimento.'}</div>`,
        onChange: drawSum
      });
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-ign]').onclick = () => { ignoreRecon(t); closeSheet(); toast('Movimento ignorato'); };
      okBtn.onclick = () => {
        const invs = [...pk.picked].map(id => data.invoices.find(x => x.id === id)).filter(Boolean).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
        const r = reconcileMany(t, invs);
        closeSheet();
        toast(`Riconciliato a ${r.linked} fattur${r.linked === 1 ? 'a' : 'e'}${r.leftover > 0.005 ? ' · residuo movimento ' + fmt(r.leftover) : ''}`);
      };
      drawSum(pk.picked);
    });
}

// ---------- import estratto conto ----------
async function openBankImport() {
  // L'input DEVE stare nel DOM, altrimenti il browser può scartarlo (GC) prima
  // della scelta del file e l'evento change non scatta → "non succede nulla".
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.xls,.xlsx,.csv,.tsv,.xml';
  input.multiple = true;                 // più estratti conto insieme (un conto per file)
  input.style.display = 'none';
  document.body.appendChild(input);
  const cleanup = () => { input.remove(); };
  input.onchange = () => {
    const files = [...input.files].filter(f => /\.(xml|xls|xlsx|csv|tsv)$/i.test(f.name));
    cleanup();
    if (files.length) processBankQueue(files, 0);
  };
  // se l'utente annulla il dialog, rimuovi comunque l'input
  window.addEventListener('focus', () => setTimeout(() => { if (!input.files.length) cleanup(); }, 800), { once: true });
  input.click();
}

// Elabora una coda di estratti conto UNO ALLA VOLTA: ogni file ha il suo conto di
// destinazione (l'utente lo sceglie nell'anteprima). Al termine di uno passa al successivo.
async function processBankQueue(files, i) {
  if (i >= files.length) { if (files.length > 1) toast('Import estratti conto completato'); return; }
  const f = files[i];
  const next = () => processBankQueue(files, i + 1);
  const label = files.length > 1 ? ` · ${i + 1}/${files.length}` : '';
  toast('Lettura file…');
  try {
    const text = await f.text();
    const isXml = /\.xml$/i.test(f.name) || looksLikeBankXml(text);
    if (isXml) {
      const parsed = parseBankXml(text);
      if (!parsed || !parsed.rows.length) { toast('XML non riconosciuto: ' + f.name); return next(); }
      openBankPreview(parsed.rows, parsed.iban, f.name, label, next);
    } else {
      const matrix = await readMatrix(f);
      if (!matrix || matrix.length < 2) { toast('File vuoto: ' + f.name); return next(); }
      openMappingSheet(matrix, f.name, label, next);
    }
  } catch (e) { toast('Errore lettura ' + f.name + ': ' + e.message); next(); }
}

// anteprima per XML bancario (nessuna mappatura: dati già strutturati)
// fileName/label/next servono all'import multiplo (coda): "Salta" o "Importa" passano al file successivo.
function openBankPreview(rows, iban, fileName = '', label = '', next = () => {}) {
  const accId = data.accounts.find(a => a.companyId === activeCompany())?.id || data.accounts[0]?.id;
  const queued = label !== '';
  const body = rows.slice(0, 8).map(r => `<tr><td>${fmtDateFull(r.date)}</td><td>${esc(r.desc.slice(0, 44))}</td><td class="r tnum ${r.amount < 0 ? 'neg' : 'pos'}">${fmt(r.amount)}</td></tr>`).join('');
  openSheet(`
    <h2>Importa estratto conto${label}</h2>
    <div class="sheetsub">${fileName ? esc(fileName) + ' · ' : ''}${rows.length} movimenti${iban ? ' · ' + esc(iban) : ''}</div>
    <div class="field"><label>Conto di destinazione</label><select id="bx_acc">${accountOptions(null, accId)}</select></div>
    <div class="section-title">Anteprima</div>
    <div style="max-height:34vh;overflow:auto;border:1px solid var(--line);border-radius:10px">
      <table class="tbl"><thead><tr><th>Data</th><th>Descrizione</th><th class="r">Importo</th></tr></thead><tbody>${body}</tbody></table>
    </div>
    <div class="actions"><button class="btn" data-cancel>${queued ? 'Salta' : 'Annulla'}</button><button class="btn primary" data-import>Importa ${rows.length}</button></div>`,
    sheet => {
      sheet.querySelector('[data-cancel]').onclick = () => { closeSheet(); next(); };
      sheet.querySelector('[data-import]').onclick = () => {
        const accId = sheet.querySelector('#bx_acc').value;
        closeSheet();
        filterType = 'all'; fState = 'todo'; // atterra sul filtro "Da gestire"
        const r = commitBankRows(rows, accId);
        toast(`${r.added} movimenti importati${r.skipped ? ` · ${r.skipped} duplicati` : ''}`);
        next();
      };
    });
}

function colOptions(headers, ncol, sel) {
  let o = '';
  for (let c = 0; c < ncol; c++) o += `<option value="${c}" ${sel === c ? 'selected' : ''}>${esc(headers[c] || 'Colonna ' + (c + 1))}</option>`;
  return o;
}

function openMappingSheet(matrix, fileName = '', label = '', next = () => {}) {
  const det = detect(matrix);
  const accId = data.accounts.find(a => a.companyId === activeCompany())?.id || data.accounts[0]?.id;
  const m = { headerRow: det.headerRow, ...det.suggestion, invert: false };
  const queued = label !== '';

  const optNone = (sel) => `<option value="-1" ${sel == null || sel < 0 ? 'selected' : ''}>—</option>`;
  const html = `
    <h2>Importa estratto conto${label}</h2>
    <div class="sheetsub">${fileName ? esc(fileName) + ' · ' : ''}Verifica la mappatura delle colonne, poi importa.</div>
    <div class="field"><label>Conto di destinazione</label><select id="bk_acc">${accountOptions(null, accId)}</select></div>
    <div class="frow">
      <div class="field"><label>Colonna data</label><select id="bk_date">${colOptions(det.headers, det.ncol, m.dateCol)}</select></div>
      <div class="field"><label>Colonna descrizione</label><select id="bk_desc">${colOptions(det.headers, det.ncol, m.descCol)}</select></div>
    </div>
    <div class="field"><label>Importi</label>
      <div class="chips" id="bk_mode">
        <button class="chip ${m.amountMode === 'single' ? 'on' : ''}" data-m="single">Colonna unica con segno</button>
        <button class="chip ${m.amountMode === 'dual' ? 'on' : ''}" data-m="dual">Dare / Avere</button>
      </div>
    </div>
    <div id="bk_amountfields"></div>
    <div class="field"><label><input type="checkbox" id="bk_inv"> Inverti il segno degli importi</label></div>
    <div class="section-title">Anteprima</div>
    <div id="bk_preview" style="max-height:30vh;overflow:auto;border:1px solid var(--line);border-radius:10px"></div>
    <div class="actions"><button class="btn" data-cancel>${queued ? 'Salta' : 'Annulla'}</button><button class="btn primary" data-import>Importa</button></div>`;

  openSheet(html, sheet => {
    const g = x => sheet.querySelector(x);
    const amountFields = () => {
      if (m.amountMode === 'dual') {
        g('#bk_amountfields').innerHTML = `<div class="frow">
          <div class="field"><label>Colonna uscite (dare)</label><select id="bk_deb">${optNone(m.debitCol)}${colOptions(det.headers, det.ncol, m.debitCol)}</select></div>
          <div class="field"><label>Colonna entrate (avere)</label><select id="bk_cre">${optNone(m.creditCol)}${colOptions(det.headers, det.ncol, m.creditCol)}</select></div>
        </div>`;
        g('#bk_deb').onchange = () => { m.debitCol = +g('#bk_deb').value; preview(); };
        g('#bk_cre').onchange = () => { m.creditCol = +g('#bk_cre').value; preview(); };
      } else {
        g('#bk_amountfields').innerHTML = `<div class="field"><label>Colonna importo</label><select id="bk_amt">${colOptions(det.headers, det.ncol, m.amountCol)}</select></div>`;
        g('#bk_amt').onchange = () => { m.amountCol = +g('#bk_amt').value; preview(); };
      }
    };
    const preview = () => {
      const rows = buildRows(matrix, m);
      const head = `<table class="tbl"><thead><tr><th>Data</th><th>Descrizione</th><th class="r">Importo</th></tr></thead><tbody>`;
      const body = rows.slice(0, 6).map(r => `<tr><td>${fmtDateFull(r.date)}</td><td>${esc(r.desc.slice(0, 40))}</td><td class="r tnum ${r.amount < 0 ? 'neg' : 'pos'}">${fmt(r.amount)}</td></tr>`).join('');
      g('#bk_preview').innerHTML = head + body + `</tbody></table><div class="muted" style="padding:8px 10px;font-size:12px">${rows.length} righe rilevate</div>`;
      sheet._rows = rows;
    };
    g('#bk_date').onchange = () => { m.dateCol = +g('#bk_date').value; preview(); };
    g('#bk_desc').onchange = () => { m.descCol = +g('#bk_desc').value; preview(); };
    g('#bk_inv').onchange = () => { m.invert = g('#bk_inv').checked; preview(); };
    sheet.querySelectorAll('#bk_mode [data-m]').forEach(b => b.onclick = () => { m.amountMode = b.dataset.m; sheet.querySelectorAll('#bk_mode .chip').forEach(c => c.classList.toggle('on', c.dataset.m === m.amountMode)); amountFields(); preview(); });
    amountFields(); preview();
    g('[data-cancel]').onclick = () => { closeSheet(); next(); };
    g('[data-import]').onclick = () => {
      const rows = sheet._rows || buildRows(matrix, m);
      if (!rows.length) { toast('Nessuna riga da importare'); return; }
      const accId = g('#bk_acc').value;
      closeSheet();
      filterType = 'all'; fState = 'todo'; // atterra sul filtro "Da gestire"
      const r = commitBankRows(rows, accId);
      toast(`${r.added} movimenti importati${r.skipped ? ` · ${r.skipped} duplicati` : ''}`);
      next();
    };
  });
}

// ---------- editor movimento ----------
export function openMovimento(id) {
  const t = id ? data.transactions.find(x => x.id === id) : null;
  const type = t?.type || 'expense';
  const cid = t?.companyId || activeCompany() || data.companies[0]?.id;
  const html = `
    <h2>${id ? 'Modifica movimento' : 'Nuovo movimento'}</h2>
    <div class="chips" id="m_type">
      <button class="chip ${type === 'expense' ? 'on' : ''}" data-t="expense">Uscita</button>
      <button class="chip ${type === 'income' ? 'on' : ''}" data-t="income">Entrata</button>
      <button class="chip ${type === 'transfer' ? 'on' : ''}" data-t="transfer">Trasferimento</button>
    </div>
    <div class="field"><label>Importo</label><input id="m_amt" inputmode="decimal" placeholder="0,00" value="${t ? String(t.amount).replace('.', ',') : ''}" style="font-size:18px;font-weight:700"></div>
    <div class="field"><label>Azienda</label><select id="m_co">${companyOptions(cid)}</select></div>
    <div id="m_dynamic"></div>
    <div class="field"><label>Data</label><input id="m_date" type="date" value="${t?.date || todayStr()}"></div>
    ${t?.desc ? `<div class="field"><label>Descrizione banca (originale)</label><input value="${esc(t.desc)}" disabled style="opacity:.7"></div>` : ''}
    <div class="field"><label>Nome visualizzato</label><input id="m_note" value="${esc(t?.note || '')}" placeholder="${t?.desc ? 'es. nome leggibile per la lista' : 'facoltativo'}"></div>
    ${t && (t.desc || t.note) ? '<div class="btnrow" style="margin-bottom:4px"><button class="btn sm" data-rule>⚙ Crea regola da questo movimento</button></div>' : ''}
    <div class="field" style="margin-top:4px"><label><input type="checkbox" id="m_f24" ${t?.f24 ? 'checked' : ''}> F24 (versamento tributi)</label></div>
    <div class="field" id="m_f24wrap" style="${t?.f24 ? '' : 'display:none'}"><label>Periodo / riferimento F24</label><input id="m_f24ref" value="${esc(t?.f24ref || '')}" placeholder="es. 2026 · IVA 1° trimestre"></div>
    ${stateSelector(t)}
    ${t ? reconSection(t) : ''}
    <div class="actions">
      ${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}
      <button class="btn" data-cancel>Annulla</button>
      <button class="btn primary" data-save>Salva</button>
    </div>`;
  openSheet(html, sheet => {
    let curType = type;
    const coSel = sheet.querySelector('#m_co');
    const dyn = sheet.querySelector('#m_dynamic');
    const renderDyn = () => { dyn.innerHTML = dynFields(curType, coSel.value, t); bindCombos(dyn); };
    renderDyn();
    sheet.querySelectorAll('#m_type [data-t]').forEach(b => b.onclick = () => { curType = b.dataset.t; sheet.querySelectorAll('#m_type .chip').forEach(c => c.classList.toggle('on', c.dataset.t === curType)); renderDyn(); });
    coSel.onchange = renderDyn;
    const f24cb = sheet.querySelector('#m_f24');
    f24cb.onchange = () => { sheet.querySelector('#m_f24wrap').style.display = f24cb.checked ? '' : 'none'; };
    sheet.querySelectorAll('#m_state [data-st]').forEach(b => b.onclick = () => { sheet.querySelectorAll('#m_state .chip').forEach(c => c.classList.toggle('on', c === b)); });
    sheet.querySelector('[data-cancel]').onclick = closeSheet;
    sheet.querySelector('[data-rule]')?.addEventListener('click', () => openRuleEditor(null, {
      keyword: suggestKeyword(t.desc || t.note), categoryId: t.categoryId || null, supplierId: t.supplierId || null, displayName: (t.note || ''),
      appliesTo: t.type === 'income' ? 'income' : 'expense'
    }));
    if (id) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare il movimento?', isTxReconciled(t.id) ? 'È riconciliato a una o più fatture: verrà anche scollegato.' : 'Operazione irreversibile.', 'Elimina', () => {
      unlinkTx(t.id); // rimuove eventuali pagamenti collegati nelle fatture
      data.transactions = data.transactions.filter(x => x.id !== id); save(); closeSheet(); toast('Movimento eliminato');
    }, { danger: true });
    // riconciliazione
    sheet.querySelector('[data-recon]')?.addEventListener('click', () => openMatch(t.id));
    sheet.querySelectorAll('[data-goto]').forEach(el => el.onclick = () => {
      const [k, gid] = el.dataset.goto.split(':');
      if (k === 'inv') openInvoice(gid);
      else if (k === 'loan') { closeSheet(); openLoan(gid); }
      else if (k === 'sched') openScheduled(gid);
    });
    sheet.querySelectorAll('[data-unlink]').forEach(b => b.onclick = () => {
      const [k, gid] = b.dataset.unlink.split(':');
      confirmDialog('Scollegare la riconciliazione?', 'Il movimento resta, ma non sarà più abbinato (riprende il nome che aveva prima).', 'Scollega', () => {
        if (k === 'inv') { const inv = data.invoices.find(x => x.id === gid); const p = inv && (inv.payments || []).find(pp => pp.txId === t.id && (pp.linked || pp.batchId)); if (inv && p) removePayment(inv, p.id); }
        else if (k === 'loan') { const l = data.loans.find(x => x.id === gid); const i = l && insts(l).find(x => x.id === t.instId); if (i) unpayInst(i); }
        else if (k === 'sched') { const s = data.scheduled.find(x => x.id === gid); if (s) reopenScheduled(s); }
        toast('Scollegato'); openMovimento(t.id);
      }, { danger: true });
    });
    sheet.querySelector('[data-save]').onclick = () => saveMov(id, curType, sheet, t);
  });
}
// selettore di stato manuale nell'editor. Per i movimenti già collegati (riconciliati/rate/scadenze)
// lo stato è automatico: mostra solo una nota (il dettaglio è in reconSection).
function stateSelector(t) {
  if (t && txIsLinked(t)) return `<div class="field"><label>Stato</label><div class="muted" style="font-size:12.5px">✅ Gestito automaticamente — riconciliato o collegato (vedi sotto).</div></div>`;
  const mg = t?.mgmt || '';
  const opt = (v, l) => `<button type="button" class="chip ${mg === v ? 'on' : ''}" data-st="${v}">${l}</button>`;
  return `<div class="field"><label>Stato gestione</label>
    <div class="chips" id="m_state">${opt('', 'Da gestire')}${opt('await', 'In attesa di fattura')}${opt('review', 'Da rivedere')}${opt('managed', 'Gestito')}</div>
    <div class="muted" style="font-size:12px;margin-top:4px">I trasferimenti e i movimenti riconciliati/collegati risultano "Gestiti" da soli.</div>
  </div>`;
}
function dynFields(type, cid, t) {
  if (type === 'transfer') {
    return `<div class="frow">
      <div class="field"><label>Dal conto</label><select id="m_acc">${accountOptions(cid, t?.accountId)}</select></div>
      <div class="field"><label>Al conto</label><select id="m_acc2">${accountOptions(cid, t?.toAccountId)}</select></div>
    </div>`;
  }
  return `<div class="frow">
    <div class="field"><label>Categoria</label><select id="m_cat">${categoryOptions(type, t?.categoryId)}</select></div>
    <div class="field"><label>Conto</label><select id="m_acc">${accountOptions(cid, t?.accountId)}</select></div>
  </div>
  <div class="field"><label>${type === 'income' ? 'Cliente' : 'Fornitore'}</label>${supplierPicker('m_sup', t?.supplierId, { placeholder: type === 'income' ? 'Cerca cliente…' : 'Cerca fornitore…', noneLabel: type === 'income' ? '— nessun cliente —' : '— nessun fornitore —' })}</div>`;
}
function saveMov(id, type, sheet, prev) {
  const g = x => sheet.querySelector(x);
  const amount = parseAmount(g('#m_amt').value);
  if (!amount) { toast('Inserisci un importo'); return; }
  const rec = { companyId: g('#m_co').value, type, amount, date: g('#m_date').value || todayStr(), note: g('#m_note').value.trim() };
  const isF24 = g('#m_f24')?.checked || false;
  const stOn = g('#m_state .chip.on');                       // selettore presente solo se non collegato
  const mgmtSel = stOn ? (stOn.dataset.st || null) : (prev?.mgmt ?? null);
  if (type === 'transfer') {
    rec.accountId = g('#m_acc').value; rec.toAccountId = g('#m_acc2').value;
    if (rec.accountId === rec.toAccountId) { toast('Scegli due conti diversi'); return; }
    rec.categoryId = null; rec.supplierId = null;
    rec.f24 = false; rec.f24ref = ''; rec.mgmt = null;  // i trasferimenti sono "Gestiti" da soli
  } else {
    rec.categoryId = g('#m_cat').value; rec.accountId = g('#m_acc').value; rec.supplierId = g('#m_sup').value || null; rec.toAccountId = null;
    rec.f24 = isF24; rec.f24ref = isF24 ? (g('#m_f24ref')?.value.trim() || '') : ''; rec.mgmt = mgmtSel;
  }
  if (id) Object.assign(prev, rec);
  else data.transactions.push({ id: uid(), createdAt: Date.now(), desc: null, ...rec });
  save(); closeSheet(); toast('Movimento salvato ✓');
}

// sezione riconciliazione nel dettaglio movimento: link all'elemento abbinato + scollega,
// oppure (se non riconciliato) il tasto Riconcilia, sempre disponibile anche se ignorato nella lista.
function reconSection(t) {
  if (t.type === 'transfer') return '';
  const linkedInvs = txLinkedInvoices(t.id);
  const loan = t.loanId ? data.loans.find(l => l.id === t.loanId) : null;
  const inst = loan ? insts(loan).find(i => i.id === t.instId) : null;
  const sched = t.scheduledId ? data.scheduled.find(s => s.id === t.scheduledId) : null;
  const items = [];
  // "detach" = movimento staccabile senza eliminarlo (abbinato). I movimenti GENERATI dall'elemento
  // (fromLoan/fromSchedule, o pagamento-fattura creato) non sono staccabili: vanno gestiti dall'origine.
  linkedInvs.forEach(inv => { const p = (inv.payments || []).find(pp => pp.txId === t.id); items.push({ k: 'inv', id: inv.id, label: `🧾 ${esc(supNameOf(inv))}${inv.number ? ' · N. ' + esc(inv.number) : ''}`, detach: !!(p && (p.linked || p.batchId)) }); });
  if (loan && inst) items.push({ k: 'loan', id: loan.id, label: `🏦 ${esc(loan.name)} · rata ${inst.n}`, detach: !t.fromLoan });
  if (sched) items.push({ k: 'sched', id: sched.id, label: `🗓️ ${esc(sched.description || 'Programmato')}`, detach: !t.fromSchedule });
  if (items.length) {
    return `<div class="section-title">Riconciliato con</div><div class="list">${items.map(it => `<div class="row">
      <div class="mid t1" data-goto="${it.k}:${it.id}" style="cursor:pointer;color:var(--accent)">${it.label}</div>
      ${it.detach ? `<button class="btn sm" data-unlink="${it.k}:${it.id}">Scollega</button>` : '<span class="muted" style="font-size:12px">generato da qui</span>'}
    </div>`).join('')}</div>`;
  }
  if (t.type === 'expense') {
    return `<div class="btnrow" style="margin-top:6px"><button class="btn" data-recon>↔ Riconcilia con una fattura</button></div>`;
  }
  return '';
}
