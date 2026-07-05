// ============ Vista Conto economico ============
import { esc, fmt, MESI, round2 } from '../../domain/util.js';
import { activeCompany, txsInScope, periodTxs, pnl, pnlBreakdown, availableYears, balanceOf, co, isCash } from '../../domain/finance.js';
import { exportTable, scopeLabel, nowStamp } from '../pdf.js';
import { data } from '../../state/store.js';

let year = new Date().getFullYear();
let month = 0; // 0 = anno intero

export function render() {
  const scope = activeCompany();
  const txs = txsInScope(scope);
  const years = availableYears(txs);
  if (!years.includes(year)) year = years[0];

  const period = periodTxs(txs, year, month);
  const pl = pnl(period);
  const breakdown = pnlBreakdown(period);
  const kpi = (l, v, c) => `<div class="card kpi"><div class="lbl">${l}</div><div class="val tnum ${c}">${fmt(v)}</div></div>`;

  let h = `<div class="pagehead"><h1>Conto economico</h1><span class="sub">${month ? MESI[month - 1] + ' ' : ''}${year}</span></div>`;
  h += `<div class="chips">${years.map(y => `<button class="chip ${y === year ? 'on' : ''}" data-y="${y}">${y}</button>`).join('')}</div>`;
  h += `<div class="chips"><button class="chip ${month === 0 ? 'on' : ''}" data-m="0">Anno</button>${MESI.map((m, k) => `<button class="chip ${month === k + 1 ? 'on' : ''}" data-m="${k + 1}">${m.slice(0, 3)}</button>`).join('')}</div>`;
  h += `<div class="btnrow" style="margin-bottom:10px"><button class="btn sm" data-export>⤓ Esporta PDF</button></div>`;

  h += `<div class="grid k3">
    ${kpi('Ricavi', pl.rev, 'pos')}
    ${kpi('Costi', pl.cost, 'neg')}
    ${kpi('Utile', pl.profit, pl.profit < 0 ? 'neg' : 'pos')}
  </div>`;

  const inc = breakdown.filter(b => b.type === 'income');
  const exp = breakdown.filter(b => b.type === 'expense');
  if (inc.length) { h += `<div class="section-title">Ricavi per categoria</div><div class="list">${inc.map(b => catRow(b, pl.rev)).join('')}</div>`; }
  if (exp.length) { h += `<div class="section-title">Costi per categoria</div><div class="list">${exp.map(b => catRow(b, pl.cost)).join('')}</div>`; }
  if (!breakdown.length) h += `<div class="card empty">Nessun dato nel periodo.</div>`;

  // saldi conti
  const accs = data.accounts.filter(a => !scope || a.companyId === scope);
  if (accs.length) {
    h += `<div class="section-title">Saldi conti</div><div class="list">`;
    accs.forEach(a => {
      const b = balanceOf(a.id);
      const right = isCash(a) ? `<div class="amt muted">—</div>` : `<div class="amt tnum ${b < 0 ? 'neg' : ''}">${fmt(b)}</div>`;
      h += `<div class="row"><div class="emoji">${a.emoji || '🏦'}</div><div class="mid"><div class="t1">${esc(a.name)}</div><div class="t2">${esc(co(a.companyId)?.name || '')}${a.excluded ? ' · escluso da P&L' : ''}</div></div>${right}</div>`;
    });
    h += `</div>`;
  }
  return h;
}

function catRow(b, tot) {
  const pct = tot ? Math.round(b.total / tot * 100) : 0;
  return `<div class="row"><div class="emoji">${b.emoji}</div>
    <div class="mid"><div class="t1">${esc(b.name)}</div><div class="bar"><i style="width:${pct}%;background:${b.type === 'income' ? 'var(--green)' : 'var(--accent)'}"></i></div></div>
    <div class="amt tnum">${fmt(b.total)}<div class="t2" style="text-align:right">${pct}%</div></div></div>`;
}

function exportPnl() {
  const scope = activeCompany();
  const period = periodTxs(txsInScope(scope), year, month);
  const pl = pnl(period);
  const breakdown = pnlBreakdown(period);
  const inc = breakdown.filter(b => b.type === 'income');
  const exp = breakdown.filter(b => b.type === 'expense');
  const accs = data.accounts.filter(a => !scope || a.companyId === scope);
  const sections = [{ heading: 'Sintesi', cols: [{ label: 'Voce' }, { label: 'Importo', right: true }], rows: [['Ricavi', fmt(pl.rev)], ['Costi', fmt(pl.cost)], ['Utile', fmt(pl.profit)]] }];
  if (inc.length) sections.push({ heading: 'Ricavi per categoria', cols: [{ label: 'Categoria' }, { label: 'Importo', right: true }], rows: inc.map(b => [b.name, fmt(b.total)]), foot: [['Totale ricavi', fmt(pl.rev)]] });
  if (exp.length) sections.push({ heading: 'Costi per categoria', cols: [{ label: 'Categoria' }, { label: 'Importo', right: true }], rows: exp.map(b => [b.name, fmt(b.total)]), foot: [['Totale costi', fmt(pl.cost)]] });
  if (accs.length) sections.push({ heading: 'Saldi conti', cols: [{ label: 'Conto' }, { label: 'Saldo', right: true }], rows: accs.map(a => [a.name, isCash(a) ? '—' : fmt(balanceOf(a.id))]) });
  exportTable({ title: 'Conto economico', subtitle: `${scopeLabel()} · ${month ? MESI[month - 1] + ' ' : ''}${year} · ${nowStamp()}`, sections });
}

export function bind(root) {
  root.querySelectorAll('[data-y]').forEach(b => b.onclick = () => { year = +b.dataset.y; root.innerHTML = render(); bind(root); });
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = +b.dataset.m; root.innerHTML = render(); bind(root); });
  root.querySelector('[data-export]')?.addEventListener('click', exportPnl);
}
