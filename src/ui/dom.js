// ============ Helper UI: toast, sheet/modal, conferme ============
import { esc } from '../domain/util.js';

let toastTimer;
export function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// scrim + sheet condivisi
function ensureSheet() {
  let scrim = document.getElementById('scrim');
  if (!scrim) {
    scrim = document.createElement('div'); scrim.id = 'scrim'; scrim.className = 'scrim';
    const sheet = document.createElement('div'); sheet.id = 'sheet'; sheet.className = 'sheet';
    document.body.append(scrim, sheet);
    scrim.addEventListener('click', closeSheet);
  }
  return { scrim: document.getElementById('scrim'), sheet: document.getElementById('sheet') };
}

export function openSheet(html, onMount) {
  const { scrim, sheet } = ensureSheet();
  sheet.innerHTML = html;
  scrim.classList.add('show'); sheet.classList.add('show');
  if (onMount) onMount(sheet);
  return sheet;
}
export function closeSheet() {
  const scrim = document.getElementById('scrim'), sheet = document.getElementById('sheet');
  if (scrim) scrim.classList.remove('show');
  if (sheet) sheet.classList.remove('show');
}

// conferma a due pulsanti
export function confirmDialog(title, body, okLabel, onOk, { danger = false } = {}) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <div class="sheetsub">${esc(body)}</div>
    <div class="actions">
      <button class="btn" data-x="cancel">Annulla</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(okLabel)}</button>
    </div>`, sheet => {
    sheet.querySelector('[data-x="cancel"]').onclick = closeSheet;
    sheet.querySelector('[data-x="ok"]').onclick = () => { closeSheet(); onOk(); };
  });
}

// Stampa un documento isolato (per export PDF via "Salva come PDF" del browser).
// Usa un iframe nascosto: non disturba il DOM dell'app e funziona offline.
export function printDocument(title, bodyHtml) {
  const css = `
    *{box-sizing:border-box} body{font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;margin:24px}
    h1{font-size:18px;margin:0 0 2px} .meta{color:#666;font-size:12px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #ddd;vertical-align:top}
    th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1.5px solid #999}
    td.r,th.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    @media print{body{margin:0}}`;
  const ifr = document.createElement('iframe');
  ifr.setAttribute('aria-hidden', 'true');
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(ifr);
  const doc = ifr.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${bodyHtml}</body></html>`);
  doc.close();
  const fire = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => ifr.remove(), 1000); };
  if (ifr.contentWindow.document.readyState === 'complete') setTimeout(fire, 150);
  else ifr.onload = () => setTimeout(fire, 150);
}

// chiude i menù a tendina aperti quando si clicca fuori
document.addEventListener('click', e => {
  document.querySelectorAll('.navmenu.open').forEach(m => {
    if (!m.parentElement.contains(e.target)) m.classList.remove('open');
  });
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
