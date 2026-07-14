// ============ Vista Attività (registro attività / audit log) ============
// Sola lettura del registro server (tabella standalone audit_log), gated da `audit.view`
// (gate di nav in app.js + guardia backend su GET /api/audit). I dati arrivano via authFetch.
import { esc } from '../../domain/util.js';
import { can, authFetch } from '../../state/auth.js';
import { toast } from '../dom.js';

const PAGE = 30;                 // blocco di righe per "Mostra altri" (pattern di famiglia)

let rows = null;                 // null = non ancora caricato
let total = 0;
let facets = { actions: [], users: [] };
let fAction = '', fUser = '', fQ = '';
let limit = PAGE;                // quante righe caricate/mostrate (cresce di PAGE)
let rootEl = null;
let qTimer = null;

const ACTION_LABEL = {
  crea: 'Creazione', modifica: 'Modifica', elimina: 'Eliminazione',
  import: 'Import totale', reset: 'Azzeramento', password: 'Cambio password',
};
const ACTION_BADGE = {
  crea: 'b-paid', modifica: 'b-unpaid', elimina: 'b-overdue',
  import: 'b-partial', reset: 'b-overdue', password: 'b-unpaid',
};
const COLL_LABEL = {
  transactions: 'Movimento', invoices: 'Fattura', suppliers: 'Anagrafica',
  companies: 'Azienda', accounts: 'Conto', categories: 'Categoria', rules: 'Regola',
  scheduled: 'Programmato', loans: 'Rateizzazione', utenti: 'Utente',
};

function fmtTs(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const actionLabel = a => ACTION_LABEL[a] || a || '—';
const collLabel = c => COLL_LABEL[c] || c || '';

export function render() {
  let h = `<div class="pagehead"><h1>Attività</h1><span class="sub">registro delle operazioni</span></div>`;
  // Difesa a valle del gating di nav: senza `audit.view` non si mostra nulla.
  if (!can('audit.view')) return h + `<div class="card empty">Sezione riservata: registro attività.</div>`;

  const actOpts = ['<option value="">Tutte le azioni</option>']
    .concat(facets.actions.map(a => `<option value="${esc(a)}" ${fAction === a ? 'selected' : ''}>${esc(actionLabel(a))}</option>`)).join('');
  const userOpts = ['<option value="">Tutti gli utenti</option>']
    .concat(facets.users.map(u => `<option value="${esc(u)}" ${fUser === u ? 'selected' : ''}>${esc(u)}</option>`)).join('');
  h += `<div class="frow" style="gap:8px;margin-bottom:10px">
    <div class="field" style="margin:0"><label>Azione</label><select id="a_act">${actOpts}</select></div>
    <div class="field" style="margin:0"><label>Utente</label><select id="a_usr">${userOpts}</select></div>
  </div>`;
  h += `<div class="field"><input id="a_q" placeholder="Cerca per oggetto, utente, tipo…" value="${esc(fQ)}"></div>`;

  if (rows === null) return h + `<div class="card empty">Caricamento…</div>`;
  h += `<div class="muted" style="font-size:12.5px;margin:2px 2px 8px"><b>${total}</b> event${total === 1 ? 'o' : 'i'}${fAction || fUser || fQ.trim() ? ' (filtrati)' : ''}</div>`;
  if (!rows.length) return h + `<div class="card empty">Nessuna attività registrata con questi filtri.</div>`;

  h += `<div class="list">${rows.map(rowHtml).join('')}</div>`;
  if (rows.length < total) {
    h += `<div class="btnrow" style="margin-top:10px;justify-content:center"><button class="btn" data-more>Mostra altri (restano ${total - rows.length})</button></div>`;
  }
  return h;
}

function rowHtml(e) {
  const badge = `<span class="badge ${ACTION_BADGE[e.action] || 'b-unpaid'}">${esc(actionLabel(e.action))}</span>`;
  const obj = [collLabel(e.collection), e.label].filter(Boolean).map(esc).join(' · ') || '<span class="muted">—</span>';
  return `<div class="row">
    <div class="mid"><div class="t1">${badge} ${obj}</div>
      <div class="t2">${fmtTs(e.ts)}${e.username ? ' · ' + esc(e.username) : ''}</div></div>
  </div>`;
}

export function bind(root) {
  rootEl = root;
  if (!can('audit.view')) return;
  root.querySelector('#a_act')?.addEventListener('change', e => { fAction = e.target.value; limit = PAGE; refresh(); });
  root.querySelector('#a_usr')?.addEventListener('change', e => { fUser = e.target.value; limit = PAGE; refresh(); });
  root.querySelector('[data-more]')?.addEventListener('click', () => { limit += PAGE; refresh(); });
  const q = root.querySelector('#a_q');
  if (q) q.oninput = () => { fQ = q.value; limit = PAGE; clearTimeout(qTimer); qTimer = setTimeout(refresh, 250); };
  if (rows === null) refresh();
}

async function refresh() {
  try {
    const params = new URLSearchParams({ limit: String(limit), offset: '0' });
    if (fAction) params.set('action', fAction);
    if (fUser) params.set('user', fUser);
    if (fQ.trim()) params.set('q', fQ.trim());
    const [listRes, facetsRes] = await Promise.all([
      authFetch('/api/audit?' + params.toString()),
      facets.actions.length || facets.users.length ? Promise.resolve(null) : authFetch('/api/audit/facets'),
    ]);
    if (listRes.ok) { const j = await listRes.json(); rows = j.rows || []; total = j.total || 0; }
    else { rows = rows || []; }
    if (facetsRes && facetsRes.ok) facets = await facetsRes.json();
  } catch (e) { rows = rows || []; toast('Errore nel caricamento del registro'); }
  redraw();
}

function redraw() {
  if (!rootEl) return;
  // Preserva il focus/cursore del campo di ricerca durante il refresh incrementale.
  const active = document.activeElement;
  const keepQ = active && active.id === 'a_q';
  const pos = keepQ ? active.selectionStart : null;
  rootEl.innerHTML = render();
  bind(rootEl);
  if (keepQ) { const n = rootEl.querySelector('#a_q'); if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); } }
}
