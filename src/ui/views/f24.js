// ============ Vista F24 (versamenti tributi) ============
// Elenca i movimenti segnati come F24, con riferimento/periodo, totali e filtro per anno.
// Il flag e i dati si impostano dall'editor del movimento.
import { data } from '../../state/store.js';
import { esc, fmt, fmtDate, fmtDateFull, round2 } from '../../domain/util.js';
import { activeCompany, acc, co, txLabel } from '../../domain/finance.js';
import { exportTable, scopeLabel, nowStamp } from '../pdf.js';
import { openMovimento } from './movimenti.js';

let fy = 0; // filtro anno

function inScope() {
  const s = activeCompany();
  return data.transactions.filter(t => t.f24 && (!s || t.companyId === s));
}
export function countF24(scope) { return data.transactions.filter(t => t.f24 && (!scope || t.companyId === scope)).length; }

export function render() {
  const all = inScope();
  const years = [...new Set(all.map(t => (t.date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  let list = fy ? all.filter(t => (t.date || '').slice(0, 4) === String(fy)) : all;
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const tot = round2(list.reduce((s, t) => s + t.amount, 0));

  let h = `<div class="pagehead"><h1>F24</h1><span class="sub">versamenti tributi</span></div>`;
  h += `<div class="muted" style="margin:2px 2px 12px;font-size:13px">${list.length} F24 · totale versato ${fmt(tot)}</div>`;
  if (years.length > 1 || fy) {
    h += `<div class="chips"><button class="chip ${!fy ? 'on' : ''}" data-fy="0">Tutti</button>${years.map(y => `<button class="chip ${String(fy) === y ? 'on' : ''}" data-fy="${y}">${y}</button>`).join('')}</div>`;
  }
  if (!list.length) {
    h += `<div class="card empty">Nessun F24.<br><span class="muted">Apri un movimento (in Movimenti) e spunta <b>F24</b> nell'editor per vederlo qui.</span></div>`;
    return h;
  }
  h += `<div class="btnrow" style="margin-bottom:10px"><button class="btn sm" data-export>⤓ Esporta PDF</button></div>`;
  h += `<div class="list">${list.map(row).join('')}</div>`;
  return h;
}

function exportF24() {
  const all = inScope();
  let list = fy ? all.filter(t => (t.date || '').slice(0, 4) === String(fy)) : all;
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!list.length) return;
  const tot = round2(list.reduce((s, t) => s + t.amount, 0));
  exportTable({
    title: 'F24 — versamenti tributi',
    subtitle: `${scopeLabel()}${fy ? ' · anno ' + fy : ''} · ${list.length} F24 · totale versato ${fmt(tot)} · ${nowStamp()}`,
    sections: [{
      cols: [{ label: 'Data' }, { label: 'Riferimento' }, { label: 'Descrizione' }, { label: 'Conto' }, { label: 'Importo', right: true }],
      rows: list.map(t => [t.date ? fmtDateFull(t.date) : '—', t.f24ref || '—', txLabel(t), acc(t.accountId)?.name || '—', fmt(t.amount)]),
      foot: [['', '', '', 'Totale', fmt(tot)]]
    }]
  });
}

function row(t) {
  const a = acc(t.accountId);
  const showCo = !activeCompany();
  const sub = `${fmtDate(t.date)}${t.f24ref ? ' · ' + esc(t.f24ref) : ''}${a ? ' · ' + esc(a.name) : ''}${showCo && co(t.companyId) ? ' · ' + esc(co(t.companyId).name) : ''}`;
  return `<div class="row click" data-open="${t.id}">
    <div class="emoji">🏛️</div>
    <div class="mid"><div class="t1">${esc(txLabel(t))}</div><div class="t2">${sub}</div></div>
    <div class="amt neg tnum">−${fmt(t.amount)}</div>
  </div>`;
}

export function bind(root) {
  const rerender = () => { root.innerHTML = render(); bind(root); };
  root.querySelectorAll('[data-fy]').forEach(b => b.onclick = () => { fy = +b.dataset.fy; rerender(); });
  root.querySelector('[data-export]')?.addEventListener('click', exportF24);
  root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openMovimento(el.dataset.open));
}
