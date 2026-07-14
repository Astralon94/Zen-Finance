// ============ Ricerca globale (command palette, ⌘K) ============
// Overlay di ricerca CLIENT-SIDE sullo stato già in memoria (`data`), nell'ambito
// dell'azienda attiva (stessa semantica delle viste). Rispetta i permessi: un gruppo di
// risultati compare solo se l'utente ha la relativa `.view` (via can()). La selezione
// naviga alla vista giusta e apre il record riusando le funzioni di apertura già esistenti.
import { data } from '../state/store.js';
import { can } from '../state/auth.js';
import { esc, fmt, fmtDate } from '../domain/util.js';
import { activeCompany, txLabel } from '../domain/finance.js';
import { invoicesInScope, supNameOf, invTotal } from '../domain/invoices.js';
import { loansInScope } from '../domain/loans.js';
import { go } from './app.js';
import { openMovimento } from './views/movimenti.js';
import { openInvoice } from './views/fatture.js';
import { openScheduled } from './views/programmati.js';
import { openLoan } from './views/finanziamenti.js';
import { openSupplier } from './views/anagrafiche.js';

const MAX_PER_GROUP = 8;

// Permessi coinvolti: la ricerca ha senso solo se l'utente può vedere almeno un'area.
const SEARCH_PERMS = ['movimenti.view', 'fatture.view', 'anagrafiche.view', 'programmati.view', 'finanziamenti.view'];
export function canSearch() { return SEARCH_PERMS.some(p => can(p)); }

// Apertura del record per tipo: riusa i meccanismi già presenti nelle view.
const OPENERS = {
  mov: id => { go('mov'); openMovimento(id); },
  fatt: id => { go('fatt'); openInvoice(id); },
  sup: id => { openSupplier(id); },        // porta già alla tab Fornitori di Anagrafiche
  prog: id => { go('prog'); openScheduled(id); },
  fin: id => { openLoan(id); },            // porta già alla vista Rateizzazioni
};

// ---- haystack / evidenziazione --------------------------------------------
const hay = (...parts) => parts.filter(v => v != null && v !== '').map(v => String(v)).join('  ').toLowerCase();
function amountHay(n) { if (n == null) return ''; const s = String(n); return s + ' ' + s.replace('.', ','); }
function hl(text, term) {
  const s = String(text == null ? '' : text);
  if (!term) return esc(s);
  const i = s.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + term.length)) + '</mark>' + esc(s.slice(i + term.length));
}

// ---- raccolta risultati ----------------------------------------------------
function collectGroups(term) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const scope = activeCompany();
  const groups = [];
  const add = (key, label, icon, perm, items) => {
    if (!can(perm) || !items.length) return;
    groups.push({ key, label, icon, total: items.length, items: items.slice(0, MAX_PER_GROUP) });
  };

  // Movimenti (descrizione/nome, note, importo)
  const txs = (scope ? data.transactions.filter(x => x.companyId === scope) : data.transactions)
    .filter(x => hay(txLabel(x), x.note, x.desc, amountHay(x.amount)).includes(t))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(x => ({ id: x.id, title: txLabel(x), sub: `${x.date ? fmtDate(x.date) : ''}${x.amount != null ? ' · ' + fmt(x.amount) : ''}` }));
  add('mov', 'Movimenti', '↕', 'movimenti.view', txs);

  // Fatture (numero, nome fornitore, importo)
  const invs = invoicesInScope(scope)
    .filter(i => hay(i.number, supNameOf(i), amountHay(invTotal(i))).includes(t))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(i => ({ id: i.id, title: supNameOf(i), sub: `${i.number ? 'N. ' + i.number + ' · ' : ''}${i.date ? fmtDate(i.date) : ''} · ${fmt(invTotal(i))}` }));
  add('fatt', 'Fatture', '🧾', 'fatture.view', invs);

  // Fornitori / clienti (nome, P.IVA) — non hanno companyId: sempre nell'anagrafica comune
  const sups = data.suppliers
    .filter(s => hay(s.name, s.piva, s.cf).includes(t))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(s => ({ id: s.id, title: s.name, sub: s.piva ? 'P.IVA ' + s.piva : (s.cf ? 'CF ' + s.cf : '') }));
  add('sup', 'Anagrafiche', '🏷️', 'anagrafiche.view', sups);

  // Programmati (descrizione)
  const scheds = (scope ? data.scheduled.filter(x => x.companyId === scope) : data.scheduled)
    .filter(s => hay(s.description, amountHay(s.amount)).includes(t))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(s => ({ id: s.id, title: s.description || 'Programmato', sub: `${s.date ? fmtDate(s.date) : ''}${s.amount != null ? ' · ' + fmt(s.amount) : ''}` }));
  add('prog', 'Programmati', '🗓️', 'programmati.view', scheds);

  // Rateizzazioni (ente / descrizione)
  const loans = loansInScope(scope)
    .filter(l => hay(l.name, l.lender, l.notes, l.type).includes(t))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(l => ({ id: l.id, title: l.name, sub: `${l.type || 'Finanziamento'}${l.lender ? ' · ' + l.lender : ''}` }));
  add('fin', 'Rateizzazioni', '🏦', 'finanziamenti.view', loans);

  return groups;
}

// ---- overlay ---------------------------------------------------------------
let el = null;      // radice dell'overlay
let flat = [];      // elenco piatto {type,id} per la navigazione con le frecce
let selIdx = 0;
let term = '';

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cmdk';
  el.className = 'cmdk-scrim';
  el.innerHTML = `
    <div class="cmdk" role="dialog" aria-label="Ricerca globale">
      <div class="cmdk-inputwrap"><span class="cmdk-ic">🔎</span><input class="cmdk-input" id="cmdk_q" placeholder="Cerca movimenti, fatture, fornitori, programmati, rate…" autocomplete="off" spellcheck="false"></div>
      <div class="cmdk-results" id="cmdk_res"></div>
      <div class="cmdk-foot"><span>↑↓ naviga</span><span>↵ apri</span><span>esc chiudi</span></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('mousedown', e => { if (e.target === el) closeSearch(); });
  const input = el.querySelector('#cmdk_q');
  input.addEventListener('input', () => { term = input.value; selIdx = 0; renderResults(); });
  input.addEventListener('keydown', onKey);
  el.querySelector('#cmdk_res').addEventListener('mousedown', e => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    e.preventDefault();
    selIdx = Number(row.dataset.i);
    activate();
  });
  return el;
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) { selIdx = (selIdx + 1) % flat.length; highlightSel(); } return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) { selIdx = (selIdx - 1 + flat.length) % flat.length; highlightSel(); } return; }
  if (e.key === 'Enter') { e.preventDefault(); activate(); return; }
}

function renderResults() {
  const res = el.querySelector('#cmdk_res');
  const groups = collectGroups(term);
  flat = [];
  if (!term.trim()) { res.innerHTML = `<div class="cmdk-hint">Digita per cercare tra i dati dell'azienda attiva.</div>`; return; }
  if (!groups.length) { res.innerHTML = `<div class="cmdk-hint">Nessun risultato per “${esc(term.trim())}”.</div>`; return; }
  const t = term.trim();
  let h = '';
  for (const g of groups) {
    const extra = g.total > g.items.length ? ` <span class="cmdk-more">+${g.total - g.items.length}</span>` : '';
    h += `<div class="cmdk-ghead">${g.icon} ${esc(g.label)} <span class="cmdk-count">${g.total}</span>${extra}</div>`;
    for (const it of g.items) {
      const i = flat.length;
      flat.push({ type: g.key, id: it.id });
      h += `<div class="cmdk-item" data-i="${i}">
        <div class="cmdk-t1">${hl(it.title, t)}</div>
        ${it.sub ? `<div class="cmdk-t2">${hl(it.sub, t)}</div>` : ''}
      </div>`;
    }
  }
  res.innerHTML = h;
  if (selIdx >= flat.length) selIdx = 0;
  highlightSel();
}

function highlightSel() {
  const items = el.querySelectorAll('.cmdk-item');
  items.forEach((n, i) => n.classList.toggle('sel', i === selIdx));
  const cur = items[selIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function activate() {
  const pick = flat[selIdx];
  if (!pick) return;
  closeSearch();
  const open = OPENERS[pick.type];
  if (open) open(pick.id);
}

export function openSearch() {
  if (!canSearch()) return;
  ensureEl();
  term = ''; selIdx = 0;
  const input = el.querySelector('#cmdk_q');
  input.value = '';
  renderResults();
  el.classList.add('show');
  requestAnimationFrame(() => input.focus());
}

export function closeSearch() {
  if (el) el.classList.remove('show');
}
