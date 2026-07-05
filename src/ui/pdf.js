// ============ Export PDF condiviso (via stampa del browser) ============
// Costruisce un documento tabellare coerente e lo passa a printDocument (iframe nascosto →
// "Salva come PDF"). Tutte le viste usano exportTable per avere lo stesso stile.

import { printDocument } from './dom.js';
import { esc } from '../domain/util.js';
import { activeCompany, co } from '../domain/finance.js';

// nome dell'ambito corrente (azienda attiva o tutte)
export function scopeLabel() {
  const s = activeCompany();
  return s ? (co(s)?.name || '') : 'Tutte le aziende';
}
// timbro data/ora corrente "gg/mm/aaaa hh:mm"
export function nowStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// sections: [{ heading?, cols:[{label,right?}], rows:[[cell,…]], foot?:[[cell,…]] }]
// I valori delle celle vanno passati come testo: vengono escapati qui.
export function exportTable({ title, subtitle = '', sections = [] }) {
  const cell = (c, col) => `<td class="${col && col.right ? 'r' : ''}">${esc(c == null ? '' : String(c))}</td>`;
  let body = `<h1>${esc(title)}</h1>`;
  if (subtitle) body += `<div class="meta">${esc(subtitle)}</div>`;
  sections.forEach(sec => {
    if (sec.heading) body += `<h2 style="font-size:13.5px;margin:16px 0 4px">${esc(sec.heading)}</h2>`;
    body += `<table><thead><tr>${sec.cols.map(c => `<th class="${c.right ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
    body += (sec.rows || []).map(r => `<tr>${r.map((c, i) => cell(c, sec.cols[i])).join('')}</tr>`).join('');
    (sec.foot || []).forEach(r => { body += `<tr style="font-weight:700;border-top:2px solid #999">${r.map((c, i) => cell(c, sec.cols[i])).join('')}</tr>`; });
    body += `</tbody></table>`;
  });
  printDocument(title, body);
}
