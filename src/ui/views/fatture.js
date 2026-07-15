// ============ Vista Fatture passive ============
import { data, save, addAttachment, readAttachment, deleteAttachment, getInvoiceXml } from '../../state/store.js';
import { can } from '../../state/auth.js';
import { esc, fmt, fmtDate, fmtDateFull, parseAmount, todayStr, round2, uid, MESI } from '../../domain/util.js';
import { activeCompany, co, sup, acc, txLabel } from '../../domain/finance.js';
import {
  invoicesInScope, invTotal, invWithholding, invPayable, invPaid, invResiduo,
  invStatus, invOverdue, invDueSoon, supNameOf, statusLabelOf,
  invPayments, addPayment, removePayment, payFull,
  isToPay, toggleToPay, flagMany, isCreditNote, invSignedResiduo, linkBankTx
} from '../../domain/invoices.js';
import { movementCandidates, searchMovements } from '../../domain/reconcile.js';
import { openSheet, closeSheet, toast, printDocument, confirmDialog } from '../dom.js';
import { recentEvents, EVENT_VERB, LOG_CAP } from '../../domain/auditlog.js';
import { companyOptions, accountOptions, categoryOptions, supplierOptions, supplierPicker, bindCombos } from '../forms.js';
import { importFiles } from '../../importers/index.js';
import { commitDrafts } from '../../importers/commit.js';
import { registerImport } from '../importundo.js';
import { openXmlViewer } from './xmlview.js';
import { renderBody as payBody, bindBody as payBind, countToPay } from './pagamenti.js';
import { mountPicker } from '../matchpicker.js';
import { go } from '../app.js';
import { buildZip } from '../../domain/zip.js';

let mode = 'list';         // 'list' | 'pay' | 'log'
let filter = 'all';        // stato
let q = '';
let supFilter = '';        // fornitore
let yearFilter = 0;        // 0 = tutti (data documento)
let monthFilter = 0;       // 0 = tutto l'anno
let flagOnly = false;      // solo "in pagamento"
let sel = new Set();       // selezione multipla
const LOG_STEP = 100;      // quanti eventi mostrare per volta nello Storico
let logShown = LOG_STEP;   // eventi attualmente visibili nello Storico

function scopeList() { return invoicesInScope(activeCompany()); }

// applica TUTTI i filtri tranne lo stato (per i conteggi delle chip di stato)
function preStatus() {
  let list = scopeList();
  if (supFilter) list = list.filter(i => (i.supplierId || '') === supFilter || (!i.supplierId && supFilter === '__free__'));
  if (yearFilter) list = list.filter(i => (i.date || '').slice(0, 4) === String(yearFilter));
  if (monthFilter) list = list.filter(i => (i.date || '').slice(5, 7) === String(monthFilter).padStart(2, '0'));
  if (flagOnly) list = list.filter(isToPay);
  const term = q.trim().toLowerCase();
  if (term) list = list.filter(i => supNameOf(i).toLowerCase().includes(term) || (i.number || '').toLowerCase().includes(term));
  return list;
}
function passStatus(i) {
  switch (filter) {
    case 'unpaid': return invStatus(i) !== 'paid';
    case 'overdue': return invOverdue(i);
    case 'duesoon': return invDueSoon(i);
    case 'partial': return invStatus(i) === 'partial';
    case 'paid': return invStatus(i) === 'paid';
    default: return true;
  }
}

function yearsAvailable() {
  const ys = new Set(scopeList().map(i => (i.date || '').slice(0, 4)).filter(Boolean));
  return [...ys].sort((a, b) => b.localeCompare(a));
}

function segmented() {
  const n = countToPay(activeCompany());
  // Il tab "In pagamento" registra pagamenti (scrittura): visibile solo con fatture.pagamenti.
  const payTab = can('fatture.pagamenti') ? `<button class="chip ${mode === 'pay' ? 'on' : ''}" data-mode="pay">★ In pagamento${n ? ' · ' + n : ''}</button>` : '';
  return `<div class="chips" style="margin-top:2px">
    <button class="chip ${mode === 'list' ? 'on' : ''}" data-mode="list">Elenco</button>
    ${payTab}
    <button class="chip ${mode === 'log' ? 'on' : ''}" data-mode="log">🕘 Storico</button>
  </div>`;
}

// ---------- Storico eventi ----------
function fmtTs(at) {
  const d = new Date(at), p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EV_ICON = { payment: '💸', reconcile: '🔗', credit_used: '↩️', payment_removed: '✖️', invoice_deleted: '🗑️' };
const EV_AMTCLS = { payment: 'neg', reconcile: 'neg', credit_used: 'pos', payment_removed: 'muted', invoice_deleted: 'muted' };
function evRow(e) {
  const amt = e.amount != null ? (e.type === 'payment_removed' || e.type === 'invoice_deleted' ? '' : (EV_AMTCLS[e.type] === 'pos' ? '+' : '−') + fmt(e.amount).replace(/^-/, '')) : '';
  return `<div class="row">
    <div class="emoji">${EV_ICON[e.type] || '•'}</div>
    <div class="mid"><div class="t1">${esc(EVENT_VERB[e.type] || e.type)}${e.label ? ' <span class="muted">· ' + esc(e.label) + '</span>' : ''}</div>
      <div class="t2">${fmtTs(e.at)}${e.account ? ' · ' + esc(e.account) : ''}${e.amount != null && !amt ? ' · ' + fmt(e.amount) : ''}</div></div>
    <div class="amt tnum ${EV_AMTCLS[e.type] || ''}">${amt}</div>
  </div>`;
}
const EXPORT_OPTS = [10, 50, 100, 250, 0]; // 0 = tutti
function storicoBody() {
  const evs = recentEvents(activeCompany());
  const expSel = `<select id="exp_n" class="selbox" style="flex:0 0 auto">${EXPORT_OPTS.map(n => `<option value="${n}" ${n === 50 ? 'selected' : ''}>${n ? 'ultimi ' + n : 'tutti'}</option>`).join('')}</select>`;
  let h = `<div class="btnrow" style="margin:6px 0 12px;align-items:center;gap:8px">
    <button class="btn" data-export ${evs.length ? '' : 'disabled'}>⤓ Esporta PDF</button>
    ${evs.length ? expSel : ''}
    <span class="muted" style="align-self:center;font-size:12.5px">${evs.length ? evs.length + ' eventi · max ' + LOG_CAP : ''}</span></div>`;
  if (!evs.length) return h + `<div class="card empty">Nessun evento registrato.<br><span class="muted">Pagamenti, riconciliazioni ed eliminazioni delle fatture compaiono qui, dal più recente.</span></div>`;
  const visible = evs.slice(0, logShown);
  h += `<div class="list">${visible.map(evRow).join('')}</div>`;
  if (evs.length > visible.length) {
    h += `<div class="btnrow" style="margin-top:10px;justify-content:center"><button class="btn" data-more>Mostra altri (restano ${evs.length - visible.length})</button></div>`;
  }
  return h;
}
function exportStoricoPdf(limit) {
  const all = recentEvents(activeCompany());
  const evs = limit ? all.slice(0, limit) : all;
  if (!evs.length) return;
  const coName = activeCompany() ? (co(activeCompany())?.name || '') : 'Tutte le aziende';
  const rows = evs.map(e => `<tr><td class="r">${fmtTs(e.at)}</td><td>${esc(EVENT_VERB[e.type] || e.type)}</td><td>${esc(e.label || '')}</td><td>${esc(e.account || '')}</td><td class="r">${e.amount != null ? esc(fmt(e.amount)) : ''}</td></tr>`).join('');
  printDocument('Storico fatture', `<h1>Storico fatture</h1>
    <div class="meta">${esc(coName)} · ultimi ${evs.length} eventi · generato il ${fmtTs(Date.now())}</div>
    <table><thead><tr><th class="r">Data e ora</th><th>Evento</th><th>Fattura</th><th>Conto</th><th class="r">Importo</th></tr></thead><tbody>${rows}</tbody></table>`);
}

export function render() {
  const wCrea = can('fatture.crea'), wImp = can('fatture.importa'), wPay = can('fatture.pagamenti');
  if (mode === 'pay' && !wPay) mode = 'list';   // il tab pagamenti richiede fatture.pagamenti
  if (mode === 'pay') {
    return `<div class="pagehead"><h1>Fatture</h1></div>${segmented()}${payBody()}`;
  }
  if (mode === 'log') {
    return `<div class="pagehead"><h1>Fatture</h1><span class="sub">storico</span></div>${segmented()}${storicoBody()}`;
  }
  const pre = preStatus();
  const shown = pre.filter(passStatus);

  // riepilogo aggregato sui risultati filtrati (residuo "netto": le NDC scalano)
  const aggDoc = round2(shown.reduce((s, i) => s + invTotal(i), 0));
  const aggRes = round2(shown.reduce((s, i) => s + invSignedResiduo(i), 0));

  const cnt = {
    all: pre.length,
    unpaid: pre.filter(i => invStatus(i) !== 'paid').length,
    overdue: pre.filter(invOverdue).length,
    duesoon: pre.filter(invDueSoon).length,
    partial: pre.filter(i => invStatus(i) === 'partial').length,
    paid: pre.filter(i => invStatus(i) === 'paid').length
  };
  const chip = (v, l) => `<button class="chip ${filter === v ? 'on' : ''}" data-f="${v}">${l}${cnt[v] ? ' · ' + cnt[v] : ''}</button>`;

  let h = `<div class="pagehead"><h1>Fatture</h1><span class="sub">passive</span></div>`;
  h += segmented();

  // import fatture (fatture.importa) e creazione manuale (fatture.crea): permessi distinti
  if (wImp) {
    h += `<div class="drop" id="drop">
      <div>Trascina qui i file oppure <b>scegli</b></div>
      <div class="muted" style="font-size:12.5px;margin-top:6px">.xml · .p7m firmati · archivi .zip — singoli o multipli</div>
      <input type="file" id="fileInput" accept=".xml,.p7m,.zip" multiple style="display:none">
      <input type="file" id="dirInput" webkitdirectory style="display:none">
    </div>`;
  }
  const impBtns = [
    wImp ? '<button class="btn" data-impdir>📁 Importa cartella…</button>' : '',
    wCrea ? '<button class="btn primary" data-newinv>+ Fattura manuale</button>' : '',
  ].join('');
  if (impBtns) h += `<div class="btnrow" style="margin:12px 0">${impBtns}</div>`;

  // ---- filtri ----
  const years = yearsAvailable();
  h += `<div class="frow" style="gap:8px;margin-bottom:10px">
    <div class="field" style="margin:0"><label>Fornitore</label><select id="f_sup">
      <option value="">Tutti</option>
      ${data.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${s.id}" ${supFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select></div>
    <div class="field" style="margin:0;flex:0 0 110px"><label>Anno</label><select id="f_year">
      <option value="0">Tutti</option>${years.map(y => `<option value="${y}" ${String(yearFilter) === y ? 'selected' : ''}>${y}</option>`).join('')}
    </select></div>
    <div class="field" style="margin:0;flex:0 0 120px"><label>Mese</label><select id="f_month">
      <option value="0">Tutto l'anno</option>${MESI.map((m, k) => `<option value="${k + 1}" ${monthFilter === k + 1 ? 'selected' : ''}>${m}</option>`).join('')}
    </select></div>
  </div>`;
  h += `<div class="chips">${chip('all', 'Tutte')}${chip('unpaid', 'Da pagare')}${chip('overdue', 'Scadute')}${chip('duesoon', 'In scadenza')}${chip('partial', 'Parziali')}${chip('paid', 'Pagate')}
    <button class="chip ${flagOnly ? 'on' : ''}" data-flagonly>★ In pagamento</button></div>`;
  h += `<div class="field"><input id="fattq" placeholder="Cerca fornitore o numero…" value="${esc(q)}"></div>`;

  // riepilogo
  h += `<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div><b>${shown.length}</b> fattur${shown.length === 1 ? 'a' : 'e'} <span class="muted">· documento ${fmt(aggDoc)}</span></div>
    <div class="tnum" style="font-weight:800">${fmt(aggRes)} <span class="muted" style="font-weight:500;font-size:12px">residuo</span></div>
  </div>`;

  // esporta XML (fatture.esporta): selezione attiva se presente, altrimenti le fatture filtrate.
  if (can('fatture.esporta')) {
    const expBase = sel.size ? [...sel].map(id => data.invoices.find(x => x.id === id)).filter(Boolean) : shown;
    const nXml = expBase.filter(hasXml).length;
    h += `<div class="btnrow" style="margin-bottom:10px;align-items:center;gap:8px">
      <button class="btn sm" data-expxml ${nXml ? '' : 'disabled'}>⤓ Esporta XML${nXml ? ' (' + nXml + ')' : ''}</button>
      <span class="muted" style="font-size:12px">${sel.size ? sel.size + ' selezionate' : shown.length + ' fatture filtrate'}${nXml ? '' : ' · nessun XML'}</span>
    </div>`;
  }

  // seleziona tutte le fatture visibili (coi filtri attivi) — azioni di pagamento: solo con fatture.pagamenti
  const allShownSel = shown.length > 0 && shown.every(i => sel.has(i.id));
  if (wPay && shown.length) h += `<div class="btnrow" style="margin-bottom:10px"><button class="btn sm" data-selall>${allShownSel ? '☐ Deseleziona tutte' : '☑ Seleziona tutte (' + shown.length + ')'}</button></div>`;

  // barra azioni selezione
  if (wPay && sel.size) {
    const selInvs = [...sel].map(id => data.invoices.find(x => x.id === id)).filter(Boolean);
    const selRes = round2(selInvs.reduce((s, i) => s + invSignedResiduo(i), 0));
    h += `<div class="card" style="position:sticky;top:64px;z-index:10;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-color:var(--accent)">
      <b>${sel.size} selezionate</b><span class="muted tnum">· residuo ${fmt(selRes)}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm primary" data-flagsel>★ In pagamento</button>
      <button class="btn sm" data-unflagsel>Togli flag</button>
      <button class="btn sm" data-clearsel>Deseleziona</button>
    </div>`;
  }

  // lista
  const list = shown.sort((a, b) => {
    const ra = invResiduo(a) > 0.005, rb = invResiduo(b) > 0.005;
    if (ra !== rb) return ra ? -1 : 1;
    return (a.date || '0000').localeCompare(b.date || '0000') * -1;
  });
  if (!list.length) h += `<div class="card empty">Nessuna fattura con questi filtri.</div>`;
  else h += `<div class="list">${list.map(rowInv).join('')}</div>`;
  return h;
}

function statusBadge(i) {
  const st = invStatus(i);
  if (isCreditNote(i)) return `<span class="badge b-paid">NDC · ${st === 'paid' ? 'usata' : 'da usare'}</span>`;
  if (st === 'paid') return '<span class="badge b-paid">pagata</span>';
  if (st === 'partial') return '<span class="badge b-partial">parziale</span>';
  if (invOverdue(i)) return '<span class="badge b-overdue">scaduta</span>';
  return '<span class="badge b-unpaid">da pagare</span>';
}
function rowInv(i) {
  const st = invStatus(i);
  const cn = isCreditNote(i);
  const amt = (st === 'paid' ? fmt(invTotal(i)) : fmt(invResiduo(i)));
  const checked = sel.has(i.id) ? 'checked' : '';
  const flag = isToPay(i) ? '<span class="badge" style="background:var(--accent);color:#fff">★</span>' : '';
  // NDC: importo a favore → segno + e colore verde; fatture → uscita
  const amtCls = cn ? 'pos' : (st === 'paid' ? '' : 'neg');
  const amtTxt = cn ? '+' + amt : amt;
  const selBox = can('fatture.pagamenti') ? `<input type="checkbox" class="selbox" data-sel="${i.id}" ${checked} style="width:18px;height:18px;flex-shrink:0">` : '';
  return `<div class="row ${sel.has(i.id) ? 'sel' : ''}">
    ${selBox}
    <div class="emoji" data-inv="${i.id}" style="cursor:pointer">${cn ? '↩️' : (i.source === 'xml' ? '📄' : '🧾')}</div>
    <div class="mid" data-inv="${i.id}" style="cursor:pointer"><div class="t1">${esc(supNameOf(i))} ${statusBadge(i)} ${flag}</div>
      <div class="t2">${i.number ? 'N. ' + esc(i.number) + ' · ' : ''}${i.date ? fmtDate(i.date) : ''}${i.due && !cn ? ' · scad. ' + fmtDate(i.due) : ''}</div></div>
    <div class="amt tnum ${amtCls}" data-inv="${i.id}" style="cursor:pointer">${amtTxt}</div>
  </div>`;
}

export function bind(root) {
  const rerender = () => { root.innerHTML = render(); bind(root); };
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (b.dataset.mode === 'log') logShown = LOG_STEP; mode = b.dataset.mode; rerender(); });
  if (mode === 'pay') { payBind(root, rerender); return; }
  if (mode === 'log') {
    root.querySelector('[data-export]')?.addEventListener('click', () => exportStoricoPdf(+(root.querySelector('#exp_n')?.value || 0)));
    root.querySelector('[data-more]')?.addEventListener('click', () => { logShown += LOG_STEP; rerender(); });
    return;
  }
  root.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; rerender(); });
  root.querySelector('[data-flagonly]').onclick = () => { flagOnly = !flagOnly; rerender(); };
  root.querySelectorAll('[data-inv]').forEach(el => el.onclick = () => openInvoice(el.dataset.inv));
  root.querySelector('[data-newinv]')?.addEventListener('click', () => openInvoiceEditor(null));

  root.querySelector('#f_sup').onchange = e => { supFilter = e.target.value; rerender(); };
  root.querySelector('#f_year').onchange = e => { yearFilter = +e.target.value; rerender(); };
  root.querySelector('#f_month').onchange = e => { monthFilter = +e.target.value; rerender(); };

  const qi = root.querySelector('#fattq');
  qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; rerender(); const n = root.querySelector('#fattq'); n.focus(); n.setSelectionRange(pos, pos); };

  // selezione
  root.querySelector('[data-selall]')?.addEventListener('click', () => {
    const shown = preStatus().filter(passStatus);
    const allSel = shown.length > 0 && shown.every(i => sel.has(i.id));
    shown.forEach(i => allSel ? sel.delete(i.id) : sel.add(i.id));
    rerender();
  });
  root.querySelectorAll('[data-sel]').forEach(cb => cb.onchange = () => { cb.checked ? sel.add(cb.dataset.sel) : sel.delete(cb.dataset.sel); rerender(); });
  root.querySelector('[data-expxml]')?.addEventListener('click', ev => {
    const base = sel.size ? [...sel].map(id => data.invoices.find(x => x.id === id)).filter(Boolean) : preStatus().filter(passStatus);
    exportXmlZip(base, ev.currentTarget);
  });
  root.querySelector('[data-flagsel]')?.addEventListener('click', () => { flagMany([...sel].map(id => data.invoices.find(x => x.id === id)).filter(Boolean), true); toast(`${sel.size} aggiunte a "In pagamento"`); sel.clear(); rerender(); });
  root.querySelector('[data-unflagsel]')?.addEventListener('click', () => { flagMany([...sel].map(id => data.invoices.find(x => x.id === id)).filter(Boolean), false); toast('Flag rimosso'); sel.clear(); rerender(); });
  root.querySelector('[data-clearsel]')?.addEventListener('click', () => { sel.clear(); rerender(); });

  // import (solo con fatture.manage: gli elementi esistono solo se l'utente può scrivere)
  const drop = root.querySelector('#drop');
  if (drop) {
    const input = root.querySelector('#fileInput');
    drop.onclick = () => input.click();
    input.onchange = () => { routeImport([...input.files]); input.value = ''; };
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    // supporta anche il trascinamento di intere CARTELLE (ricorsivo, con i PDF allegati dentro)
    drop.addEventListener('drop', async e => { const all = await filesFromDataTransfer(e.dataTransfer); routeImport(all); });

    // Importa un'intera cartella (es. lo scarico InfoCamere, con sottocartelle per fattura):
    // gli .xml/.p7m/.zip diventano fatture; i PDF nella stessa cartella-fattura ne diventano allegati.
    const dirInput = root.querySelector('#dirInput');
    root.querySelector('[data-impdir]')?.addEventListener('click', () => dirInput.click());
    dirInput.onchange = () => { routeImport([...dirInput.files]); dirInput.value = ''; };
  }
}

// ---- import flow ----
// Smista i file scelti/trascinati: .xml/.p7m/.zip → fatture; .pdf → potenziali allegati.
function routeImport(all) {
  const invoiceFiles = all.filter(f => /\.(xml|p7m|zip)$/i.test(f.name));
  const attachFiles = all.filter(f => /\.pdf$/i.test(f.name));
  if (!invoiceFiles.length) { toast('Nessun file .xml/.p7m/.zip da importare'); return; }
  handleImport(invoiceFiles, attachFiles);
}

// Estrae ricorsivamente i File da un DataTransfer, supportando le cartelle trascinate.
// Annota ogni file con _path (percorso relativo) così da raggruppare gli allegati per cartella.
async function filesFromDataTransfer(dt) {
  if (!dt) return [];
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])]; // browser senza entries API → file piatti
  const out = [];
  const walk = entry => new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => { try { f._path = entry.fullPath.replace(/^\//, ''); } catch (e) {} out.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readMore = () => reader.readEntries(async es => {
        if (!es.length) { resolve(); return; }
        await Promise.all(es.map(walk));
        readMore(); // readEntries pagina: si richiama finché non torna vuoto
      }, () => resolve());
      readMore();
    } else resolve();
  });
  await Promise.all(entries.map(walk));
  return out;
}

async function handleImport(files, attachFiles = []) {
  toast('Lettura file…');
  const { drafts, errors, dupInBatch } = await importFiles(files);
  if (!drafts.length) { openImportResult(errors); return; }
  linkAttachments(drafts, attachFiles);
  openImportPreview(drafts, errors, dupInBatch);
}

// Aggancia ogni PDF alla fattura della SUA cartella: il PDF sta in <cartella-fattura>/…/x.pdf
// e il file fattura in <cartella-fattura>/y.xml → match per prefisso di percorso.
function linkAttachments(drafts, attachFiles) {
  if (!attachFiles || !attachFiles.length) return;
  const dirOf = p => { const i = (p || '').lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  drafts.forEach(d => {
    const dir = dirOf(d.path || d.filename || '');
    if (!dir) return;
    const found = attachFiles.filter(f => (f._path || f.webkitRelativePath || f.name).startsWith(dir + '/'));
    if (found.length) d.attachFiles = found;
  });
}
function openImportPreview(drafts, errors, dupInBatch) {
  const cid = activeCompany() || data.companies[0]?.id;
  const nAtt = drafts.reduce((s, d) => s + ((d.attachFiles || []).length), 0);
  const rows = drafts.map(d => { const na = (d.attachFiles || []).length; return `<tr><td>${esc(d.supplierName || d.piva || '—')}</td><td>${esc(d.number || '—')}</td><td>${d.date ? fmtDateFull(d.date) : '—'}</td><td class="r tnum">${fmt(d.total)}</td><td class="r">${na ? '📎 ' + na : ''}</td></tr>`; }).join('');
  openSheet(`
    <h2>Anteprima import</h2>
    <div class="sheetsub">${drafts.length} fattur${drafts.length === 1 ? 'a' : 'e'} pronte${nAtt ? ` · ${nAtt} allegat${nAtt === 1 ? 'o' : 'i'} PDF` : ''}${dupInBatch ? ` · ${dupInBatch} duplicati nel lotto ignorati` : ''}${errors.length ? ` · ${errors.length} file con errori` : ''}</div>
    <div class="field"><label>Importa nell'azienda</label><select id="imp_co">${companyOptions(cid)}</select></div>
    <div style="max-height:38vh;overflow:auto;border:1px solid var(--line);border-radius:10px">
      <table class="tbl"><thead><tr><th>Fornitore</th><th>Numero</th><th>Data</th><th class="r">Totale</th><th class="r">All.</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    ${errors.length ? `<div class="muted" style="font-size:12px;margin-top:8px">Errori: ${errors.map(e => esc(e.name)).join(', ')}</div>` : ''}
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-import>Importa ${drafts.length}</button></div>`,
    sheet => {
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-import]').onclick = async () => {
        const btn = sheet.querySelector('[data-import]');
        btn.disabled = true; btn.textContent = nAtt ? 'Import e allegati…' : 'Import…';
        const r = await commitDrafts(drafts, sheet.querySelector('#imp_co').value);
        closeSheet();
        if (r.added) { registerImport(r.undo); if (r.attached || r.skipped) toast(`${r.attached ? r.attached + ' allegati' : ''}${r.attached && r.skipped ? ' · ' : ''}${r.skipped ? r.skipped + ' già presenti' : ''}`); }
        else toast(r.skipped ? `${r.skipped} già presenti` : 'Nessuna fattura importata');
      };
    });
}
function openImportResult(errors) {
  openSheet(`<h2>Import non riuscito</h2><div class="sheetsub">Nessuna fattura valida trovata.</div>
    ${errors.length ? `<div class="muted" style="font-size:12.5px">${errors.map(e => `${esc(e.name)}: ${esc(e.msg)}`).join('<br>')}</div>` : ''}
    <div class="actions"><button class="btn primary" data-ok>Ok</button></div>`,
    sheet => sheet.querySelector('[data-ok]').onclick = closeSheet);
}

// ---- allegati (PDF) della fattura ----
const fmtSize = b => { b = b || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };
function attBlock(i) {
  const w = can('fatture.modifica');   // allegati = parte della modifica fattura
  const atts = i.attachments || [];
  let h = atts.length ? `<div class="list">${atts.map(a => `<div class="row">
      <div class="emoji">📎</div>
      <div class="mid" data-att-open="${a.id}" style="cursor:pointer"><div class="t1">${esc(a.name)}</div><div class="t2">${fmtSize(a.size)}${a.addedAt ? ' · ' + new Date(a.addedAt).toLocaleDateString('it-IT') : ''}</div></div>
      ${w ? `<button class="btn sm danger" data-att-del="${a.id}">Elimina</button>` : ''}
    </div>`).join('')}</div>` : `<div class="card empty" style="padding:14px">Nessun allegato.</div>`;
  if (w) h += `<div class="btnrow" style="margin-top:10px"><button class="btn sm" data-att-add>+ Aggiungi allegato</button><input type="file" id="att_input" accept="application/pdf,.pdf" style="display:none"></div>`;
  return h;
}
function bindAttachments(sheet, i, id) {
  const attInput = sheet.querySelector('#att_input');
  sheet.querySelector('[data-att-add]')?.addEventListener('click', () => attInput?.click());
  if (attInput) attInput.onchange = async () => {
    const f = attInput.files[0]; attInput.value = '';
    if (!f) return;
    toast('Caricamento…');
    const r = await addAttachment(f);
    if (!r.ok) { toast('Caricamento allegato non riuscito'); return; }
    i.attachments = (i.attachments || []).concat(r.meta);
    save(); toast('Allegato aggiunto ✓'); openInvoice(id);
  };
  sheet.querySelectorAll('[data-att-open]').forEach(el => el.onclick = async () => {
    const a = (i.attachments || []).find(x => x.id === el.dataset.attOpen);
    if (!a) return;
    const file = await readAttachment(a);
    if (!file) { toast('Allegato non trovato'); return; }
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  sheet.querySelectorAll('[data-att-del]').forEach(b => b.onclick = () => {
    const a = (i.attachments || []).find(x => x.id === b.dataset.attDel);
    if (!a) return;
    confirmDialog('Eliminare l\'allegato?', a.name, 'Elimina', async () => {
      await deleteAttachment(a);
      i.attachments = (i.attachments || []).filter(x => x.id !== a.id);
      save(); toast('Allegato eliminato'); openInvoice(id);
    }, { danger: true });
  });
}

// ---- export XML (singolo file / ZIP) ----
// Solo le fatture elettroniche importate hanno l'XML nel DB (source 'xml').
function hasXml(i) { return i && i.source === 'xml'; }
// Nome file leggibile e sicuro: <fornitore>_<numero>_<data>.xml (niente caratteri illegali).
function sanitizeName(s) {
  return String(s || '').replace(/[\/\\:*?"<>|]+/g, '-')
    .replace(/[\u0000-\u001f]+/g, '-')  // scritti come escape: MAI byte di controllo crudi nel sorgente (rompono l'HTML inline)
    .replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
}
function xmlFileName(i) {
  const parts = [supNameOf(i), i.number, i.date].map(sanitizeName).filter(Boolean);
  return (parts.join('_') || 'fattura') + '.xml';
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadInvoiceXml(i) {
  const xml = await getInvoiceXml(i.id);
  if (!xml) { toast('XML non disponibile per questa fattura'); return; }
  triggerDownload(new Blob([xml], { type: 'application/xml' }), xmlFileName(i));
}
// Export multiplo: recupera gli XML in sequenza, salta chi non ne ha, produce uno ZIP unico.
// NB: NIENTE fflate qui — il suo codice (magic number binari) inietta un byte NUL nel
// bundle single-file inline e la pagina muore a page-load. Si usa il mini-writer locale.
async function exportXmlZip(list, btn) {
  const withXml = list.filter(hasXml);
  if (!withXml.length) { toast('Nessuna fattura con XML da esportare'); return; }
  const enc = new TextEncoder();
  const prevTxt = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Esportazione…'; }
  const files = {}, used = new Set();
  let ok = 0;
  for (const i of withXml) {
    const xml = await getInvoiceXml(i.id);
    if (!xml) continue;
    let name = xmlFileName(i), n = 1;
    while (used.has(name)) name = xmlFileName(i).replace(/\.xml$/, '') + '_' + (++n) + '.xml';
    used.add(name); files[name] = enc.encode(xml); ok++;
  }
  if (btn) { btn.disabled = false; if (prevTxt != null) btn.textContent = prevTxt; }
  if (!ok) { toast('Nessun XML recuperato'); return; }
  triggerDownload(buildZip(files), `fatture-xml-${todayStr()}.zip`);
  const missing = list.length - ok;
  toast(`Esportate ${ok} fattur${ok === 1 ? 'a' : 'e'}${missing ? ` (${missing} senza XML escluse)` : ''}`);
}

// ---- dettaglio fattura ----
export function openInvoice(id) {
  const i = data.invoices.find(x => x.id === id);
  if (!i) return;
  const wPay = can('fatture.pagamenti');   // pagamenti/saldi/flag/rimozione pagamento
  const wMod = can('fatture.modifica');    // modifica dati fattura e allegati
  const w = wPay;                          // sezione pagamenti del dettaglio
  const res = invResiduo(i), pay = invPayable(i), wh = invWithholding(i);
  const payments = invPayments(i);
  const line = (l, v, cls = '') => `<div class="row"><div class="mid t2">${l}</div><div class="amt tnum ${cls}">${v}</div></div>`;
  const paysHtml = payments.length ? payments.map(p => `<div class="row">
      <div class="emoji">💸</div>
      <div class="mid"><div class="t1 tnum">${fmt(p.amount)}</div><div class="t2">${fmtDate(p.date)}${p.accountId ? ' · ' + esc((data.accounts.find(a => a.id === p.accountId)?.name) || '') : ' · senza conto'}</div></div>
      ${w ? `<button class="btn sm danger" data-delpay="${p.id}">Rimuovi</button>` : ''}
    </div>`).join('') : '<div class="muted" style="padding:8px 2px">Nessun pagamento registrato.</div>';

  openSheet(`
    <h2>${esc(supNameOf(i))} ${statusBadge(i)} ${isToPay(i) ? '<span class="badge" style="background:var(--accent);color:#fff">★ in pagamento</span>' : ''}</h2>
    <div class="sheetsub">${i.number ? 'N. ' + esc(i.number) + ' · ' : ''}${i.date ? fmtDateFull(i.date) : ''}${i.due ? ' · scad. ' + fmtDateFull(i.due) : ''} · ${esc(co(i.companyId)?.name || '')}</div>
    <div class="list" style="margin-bottom:8px">
      ${line('Totale documento', fmt(invTotal(i)))}
      ${wh ? line('Ritenuta', '− ' + fmt(wh), 'neg') : ''}
      ${line('Da pagare', fmt(pay))}
      ${line('Pagato', fmt(invPaid(i)), 'pos')}
      ${line('Residuo', fmt(res), res > 0.005 ? 'neg' : 'pos')}
    </div>
    <div class="section-title">Pagamenti</div>
    <div class="list">${paysHtml}</div>
    <div class="section-title" style="margin-top:14px">Allegati</div>
    ${attBlock(i)}
    <div class="btnrow" style="margin-top:12px">
      ${w && res > 0.005 ? `<button class="btn ${isToPay(i) ? '' : 'primary'}" data-flag>${isToPay(i) ? '★ Togli da In pagamento' : '★ Metti In pagamento'}</button>` : ''}
      ${w && res > 0.005 ? '<button class="btn" data-settle>Salda fattura</button>' : ''}
      ${hasXml(i) ? '<button class="btn" data-xml>Vedi XML</button>' : ''}
      ${hasXml(i) && can('fatture.esporta') ? '<button class="btn" data-dlxml>⤓ Scarica XML</button>' : ''}
      ${wMod ? '<button class="btn" data-edit>Modifica</button>' : ''}
    </div>
    ${w ? '<div class="muted" style="font-size:11.5px;margin-top:8px">Per eliminare una fattura: Impostazioni → "Elimina una fattura". (Qui puoi rimuovere i singoli pagamenti senza toccare la fattura.)</div>' : ''}`, sheet => {
    sheet.querySelectorAll('[data-delpay]').forEach(b => b.onclick = () => { removePayment(i, b.dataset.delpay); toast('Pagamento rimosso'); openInvoice(id); });
    sheet.querySelector('[data-flag]')?.addEventListener('click', () => { toggleToPay(i); openInvoice(id); });
    sheet.querySelector('[data-settle]')?.addEventListener('click', () => openSettleInvoice(i));
    sheet.querySelector('[data-xml]')?.addEventListener('click', () => openXmlViewer(i.id, i.xml));
    sheet.querySelector('[data-dlxml]')?.addEventListener('click', ev => downloadInvoiceXml(i));
    sheet.querySelector('[data-edit]')?.addEventListener('click', () => openInvoiceEditor(id));
    bindAttachments(sheet, i, id);
  });
}

// ---- Salda fattura: una sola porta, due modi (crea movimento / abbina esistente) ----
// Per le note di credito resta solo "crea movimento" (l'abbinamento bancario non si applica).
function openSettleInvoice(i) {
  const isNdc = isCreditNote(i);
  const res = invResiduo(i), cid = i.companyId;
  let mode = 'create';
  openSheet(`
    <h2>Salda fattura</h2>
    <div class="sheetsub">${esc(supNameOf(i))}${i.number ? ' · N. ' + esc(i.number) : ''} · residuo ${fmt(res)}</div>
    ${!isNdc ? `<div class="chips" id="sm_mode">
      <button class="chip on" data-m="create">Crea movimento</button>
      <button class="chip" data-m="match">Abbina esistente</button>
    </div>` : ''}
    <div id="sm_body"></div>
    <div class="actions" id="sm_actions"></div>`,
    sheet => {
      const body = sheet.querySelector('#sm_body'), actions = sheet.querySelector('#sm_actions');

      const renderCreate = () => {
        body.innerHTML = `
          <div class="field"><label>Importo</label><input id="p_amt" inputmode="decimal" value="${String(res).replace('.', ',')}" style="font-size:18px;font-weight:700"></div>
          <div class="frow">
            <div class="field"><label>Data</label><input id="p_date" type="date" value="${todayStr()}"></div>
            <div class="field"><label>Conto</label><select id="p_acc">${accountOptions(cid, null, { allowNone: true, noneLabel: '— solo registrazione —' })}</select></div>
          </div>
          <div class="muted" style="font-size:12px">Se scegli un conto, viene creato un movimento di uscita collegato.</div>`;
        actions.innerHTML = `<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-ok>Registra</button>`;
        actions.querySelector('[data-cancel]').onclick = () => openInvoice(i.id);
        actions.querySelector('[data-ok]').onclick = () => {
          const amount = parseAmount(body.querySelector('#p_amt').value);
          if (!amount) { toast('Inserisci un importo'); return; }
          addPayment(i, { amount, date: body.querySelector('#p_date').value || todayStr(), accountId: body.querySelector('#p_acc').value || null });
          toast('Pagamento registrato ✓'); openInvoice(i.id);
        };
      };

      const renderMatch = () => {
        body.innerHTML = `
          <div class="muted" style="font-size:12.5px;margin-bottom:8px">Seleziona uno o più movimenti già presenti (es. pagamento in più tranche).</div>
          <div id="sm_picker"></div>
          <div id="sm_sum"></div>`;
        actions.innerHTML = `<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-ok disabled>Abbina</button>`;
        const sumEl = body.querySelector('#sm_sum'), okBtn = actions.querySelector('[data-ok]');
        const drawSum = (pick) => {
          const r = invResiduo(i);
          const selTxs = [...pick].map(id => data.transactions.find(t => t.id === id)).filter(Boolean);
          const selTot = round2(selTxs.reduce((s, t) => s + t.amount, 0));
          const covered = Math.min(selTot, r);
          sumEl.innerHTML = pick.size ? `<div class="card" style="display:flex;justify-content:space-between;margin-top:10px">
            <span><b>${pick.size}</b> selezionati · ${fmt(selTot)}</span>
            <span class="tnum ${covered >= r - 0.005 ? 'pos' : ''}">${covered >= r - 0.005 ? 'copre il residuo ✓' : 'copre ' + fmt(covered) + ' di ' + fmt(r)}</span>
          </div>` : '';
          okBtn.disabled = pick.size === 0; okBtn.textContent = 'Abbina' + (pick.size ? ' ' + pick.size : '');
        };
        const pk = mountPicker(body.querySelector('#sm_picker'), {
          placeholder: 'Cerca tra tutti i movimenti non riconciliati…',
          fetch: term => term.trim() ? searchMovements(i, term) : movementCandidates(i),
          id: ({ tx }) => tx.id,
          row: ({ tx, diff, nameHit }) => `<div class="mid"><div class="t1">${esc(txLabel(tx))} ${nameHit ? '<span class="badge b-paid">nome ✓</span>' : ''} ${diff < 0.02 ? '<span class="badge b-unpaid">importo ✓</span>' : ''}</div>
              <div class="t2">${tx.date ? fmtDate(tx.date) : ''}${acc(tx.accountId) ? ' · ' + esc(acc(tx.accountId).name) : ''}</div></div>
            <div class="amt tnum">${fmt(tx.amount)}</div>`,
          empty: term => `<div class="muted" style="padding:10px 2px">${term.trim() ? 'Nessun movimento trovato.' : 'Nessun movimento compatibile. Cerca, oppure usa "Crea movimento".'}</div>`,
          onChange: drawSum
        });
        actions.querySelector('[data-cancel]').onclick = () => openInvoice(i.id);
        okBtn.onclick = () => {
          const txs = [...pk.picked].map(id => data.transactions.find(t => t.id === id)).filter(Boolean).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
          let n = 0;
          for (const tx of txs) { if (invResiduo(i) <= 0.005) break; if (linkBankTx(i, tx)) n++; }
          toast(n ? `Abbinati ${n} moviment${n === 1 ? 'o' : 'i'} ✓` : 'Nessun abbinamento');
          openInvoice(i.id);
        };
        drawSum(pk.picked);
      };

      if (!isNdc) sheet.querySelectorAll('#sm_mode [data-m]').forEach(b => b.onclick = () => {
        mode = b.dataset.m;
        sheet.querySelectorAll('#sm_mode .chip').forEach(c => c.classList.toggle('on', c.dataset.m === mode));
        mode === 'create' ? renderCreate() : renderMatch();
      });
      renderCreate();
    });
}

// ---- editor manuale / modifica ----
export function openInvoiceEditor(id) {
  const i = id ? data.invoices.find(x => x.id === id) : null;
  const cid = i?.companyId || activeCompany() || data.companies[0]?.id;
  openSheet(`
    <h2>${id ? 'Modifica fattura' : 'Nuova fattura'}</h2>
    <div class="field"><label>Azienda</label><select id="i_co">${companyOptions(cid)}</select></div>
    <div class="field"><label>Fornitore</label>${supplierPicker('i_sup', i?.supplierId)}</div>
    ${i && !i.supplierId && i.supplierName ? `<div class="field"><label>Nome fornitore (libero)</label><input id="i_supname" value="${esc(i.supplierName)}"></div>` : ''}
    <div class="frow">
      <div class="field"><label>Numero</label><input id="i_num" value="${esc(i?.number || '')}"></div>
      <div class="field"><label>Categoria</label><select id="i_cat">${categoryOptions('expense', i?.categoryId || 'c-for')}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Data</label><input id="i_date" type="date" value="${i?.date || todayStr()}"></div>
      <div class="field"><label>Scadenza</label><input id="i_due" type="date" value="${i?.due || ''}"></div>
    </div>
    <div class="frow">
      <div class="field"><label>Imponibile</label><input id="i_net" inputmode="decimal" value="${i?.net != null ? String(i.net).replace('.', ',') : ''}"></div>
      <div class="field"><label>IVA</label><input id="i_vat" inputmode="decimal" value="${i?.vat != null ? String(i.vat).replace('.', ',') : ''}"></div>
    </div>
    <div class="frow">
      <div class="field"><label>Totale</label><input id="i_tot" inputmode="decimal" value="${i ? String(invTotal(i)).replace('.', ',') : ''}"></div>
      <div class="field"><label>Ritenuta</label><input id="i_wh" inputmode="decimal" value="${i?.withholding ? String(i.withholding).replace('.', ',') : ''}"></div>
    </div>
    <div class="field"><label>Nota</label><input id="i_note" value="${esc(i?.note || '')}"></div>
    <div class="field"><label><input type="checkbox" id="i_ndc" ${i?.creditNote ? 'checked' : ''}> Nota di credito (a tuo favore: scala il dovuto al fornitore)</label></div>
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      const g = x => sheet.querySelector(x);
      bindCombos(sheet);
      const recalc = () => {
        const net = parseAmount(g('#i_net').value) || 0, vat = parseAmount(g('#i_vat').value) || 0;
        if ((net || vat) && document.activeElement !== g('#i_tot')) g('#i_tot').value = String(round2(net + vat)).replace('.', ',');
      };
      g('#i_net').oninput = recalc; g('#i_vat').oninput = recalc;
      g('[data-cancel]').onclick = () => id ? openInvoice(id) : closeSheet();
      g('[data-save]').onclick = () => {
        let total = parseAmount(g('#i_tot').value);
        const net = parseAmount(g('#i_net').value), vat = parseAmount(g('#i_vat').value);
        if (total == null) total = round2((net || 0) + (vat || 0));
        if (!total) { toast('Inserisci almeno il totale'); return; }
        const supId = g('#i_sup').value || null;
        const rec = {
          companyId: g('#i_co').value, supplierId: supId,
          supplierName: supId ? null : (g('#i_supname')?.value?.trim() || i?.supplierName || null),
          number: g('#i_num').value.trim(), date: g('#i_date').value || todayStr(), due: g('#i_due').value || null,
          net, vat, total, withholding: parseAmount(g('#i_wh').value) || 0,
          creditNote: g('#i_ndc').checked,
          categoryId: g('#i_cat').value, note: g('#i_note').value.trim()
        };
        if (id) { Object.assign(i, rec); save(); toast(rec.creditNote ? 'Nota di credito aggiornata ✓' : 'Fattura aggiornata ✓'); openInvoice(id); }
        else { data.invoices.push({ id: uid(), ...rec, payments: [], attachments: [], toPay: false, source: 'manual', xml: null, createdAt: Date.now() }); save(); closeSheet(); toast(rec.creditNote ? 'Nota di credito creata ✓' : 'Fattura creata ✓'); }
      };
    });
}
