// ============ Vista Dashboard ============
import { data } from '../../state/store.js';
import { esc, fmt, fmtDate } from '../../domain/util.js';
import { activeCompany, cashOf, liquidityOf, cardDebtOf, pnl, txsInScope, periodTxs, co, acc, txLabel } from '../../domain/finance.js';
import { invoicesInScope, invResiduo, invSignedResiduo, isCreditNote, invOverdue, invDueSoon, supNameOf, statusLabelOf } from '../../domain/invoices.js';
import { go } from '../app.js';
import { openInvoice } from './fatture.js';
import { openMovimento } from './movimenti.js';

export function render() {
  const scope = activeCompany();
  const invs = invoicesInScope(scope);
  const unpaid = invs.filter(i => invResiduo(i) > 0.005);
  // le note di credito riducono il dovuto netto al fornitore
  const daPagare = round(Math.max(0, unpaid.reduce((s, i) => s + invSignedResiduo(i), 0)));
  const scaduto = round(unpaid.filter(invOverdue).reduce((s, i) => s + invResiduo(i), 0));
  const liq = liquidityOf(scope);
  const cardDebt = cardDebtOf(scope);

  const year = new Date().getFullYear();
  const pl = pnl(periodTxs(txsInScope(scope), year));

  const due = unpaid.filter(i => !isCreditNote(i)).slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 6);
  const recent = txsInScope(scope).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);

  const kpi = (lbl, val, cls = '') => `<div class="card kpi"><div class="lbl">${esc(lbl)}</div><div class="val tnum ${cls}">${val}</div></div>`;

  let h = `<div class="pagehead"><h1>Dashboard</h1><span class="sub">${esc(scopeName(scope))}</span></div>`;
  h += `<div class="grid k4">
    ${kpi('Liquidità disponibile', fmt(liq), liq < 0 ? 'neg' : '')}
    ${kpi('Fatture da pagare', fmt(daPagare), daPagare > 0 ? 'neg' : '')}
    ${kpi('Di cui scaduto', fmt(scaduto), scaduto > 0 ? 'neg' : '')}
    ${kpi(`Utile ${year}`, fmt(pl.profit), pl.profit < 0 ? 'neg' : 'pos')}
  </div>`;

  // debito carte di credito (separato dalla liquidità)
  if (cardDebt > 0.005) {
    h += `<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>💳 <b>Debito carte di credito</b> <span class="muted">· da saldare</span></div>
      <div class="tnum neg" style="font-weight:800">${fmt(cardDebt)}</div>
    </div>`;
  }

  // prossime scadenze
  h += `<div class="section-title">Prossime scadenze</div>`;
  if (!due.length) h += `<div class="card empty">Nessuna fattura da pagare 🎉</div>`;
  else h += `<div class="list">${due.map(invRow).join('')}</div>`;

  // movimenti recenti
  h += `<div class="section-title">Movimenti recenti</div>`;
  if (!recent.length) h += `<div class="card empty">Nessun movimento.<br><button class="btn primary sm" data-newmov style="margin-top:10px">Aggiungi movimento</button></div>`;
  else h += `<div class="list">${recent.map(txRow).join('')}</div>`;

  return h;
}

function invRow(i) {
  const od = invOverdue(i);
  return `<div class="row click" data-inv="${i.id}">
    <div class="emoji">🧾</div>
    <div class="mid"><div class="t1">${esc(supNameOf(i))}</div>
      <div class="t2">${i.number ? 'N. ' + esc(i.number) + ' · ' : ''}${i.due ? 'scad. ' + fmtDate(i.due) : 'senza scadenza'} ${od ? '<span class="badge b-overdue">scaduta</span>' : ''}</div></div>
    <div class="amt neg tnum">${fmt(invResiduo(i))}</div>
  </div>`;
}
function txRow(t) {
  const a = acc(t.accountId);
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  return `<div class="row click" data-mov="${t.id}">
    <div class="emoji">${t.type === 'income' ? '⬆️' : t.type === 'transfer' ? '🔁' : '⬇️'}</div>
    <div class="mid"><div class="t1">${esc(txLabel(t))}</div><div class="t2">${fmtDate(t.date)}${a ? ' · ' + esc(a.name) : ''}</div></div>
    <div class="amt ${cls} tnum">${sign}${fmt(t.amount)}</div>
  </div>`;
}

export function bind(root) {
  root.querySelectorAll('[data-inv]').forEach(el => el.onclick = () => openInvoice(el.dataset.inv));
  root.querySelectorAll('[data-mov]').forEach(el => el.onclick = () => openMovimento(el.dataset.mov));
  const nm = root.querySelector('[data-newmov]');
  if (nm) nm.onclick = () => go('mov');
}

function scopeName(scope) { return scope ? (co(scope)?.emoji || '') + ' ' + (co(scope)?.name || '') : 'Tutte le aziende'; }
const round = n => Math.round(n * 100) / 100;
