// ============ Utility di base: denaro, date, id, escaping ============

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
export const fmt = n => eur.format(round2(n));
export const fmtNum = n => round2(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Parsa un importo digitato dall'utente (gestisce virgola/punto, simboli). Ritorna numero >=0 o null.
export function parseAmount(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return isNaN(n) ? null : round2(Math.abs(n));
}

export const pad2 = n => String(n).padStart(2, '0');
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

export const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

// "2026-06-23" -> "23 giu"
export function fmtDate(d) {
  if (!d) return '';
  const [y, m, g] = d.split('-');
  if (!g) return d;
  return `${parseInt(g)} ${MESI[parseInt(m) - 1].slice(0, 3).toLowerCase()}`;
}
// "2026-06-23" -> "23/06/2026"
export function fmtDateFull(d) {
  if (!d) return '';
  const [y, m, g] = d.split('-');
  if (!g) return d;
  return `${g}/${m}/${y}`;
}

// id univoco, monotòno-ish (timestamp + random)
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ---- Aggancio movimento a un elemento (rata/scadenza): nome+categoria, reversibile ----
// Quando un movimento ESISTENTE viene abbinato, prende nome e categoria dell'elemento. I valori
// originali sono conservati in `linkPrev` (solo la prima volta) per poterli ripristinare allo
// scollegamento. Usato da scheduled.js e loans.js (invoices.js ha la sua logica multi-fattura).
export function attachTxMeta(tx, { note, categoryId } = {}) {
  if (!tx) return;
  if (tx.linkPrev === undefined) tx.linkPrev = { note: tx.note ?? null, categoryId: tx.categoryId ?? null };
  if (note != null) tx.note = note;
  if (categoryId != null) tx.categoryId = categoryId;
}
// Ripristina nome+categoria originali. Tollerante alle chiavi legacy (schedPrev/loanPrev) scritte
// da versioni precedenti e dal backfill. Ritorna true se ha agito.
export function detachTxMeta(tx) {
  if (!tx) return false;
  const prev = tx.linkPrev || tx.schedPrev || tx.loanPrev;
  if (!prev) return false;
  tx.note = prev.note;
  if (prev.categoryId !== undefined) tx.categoryId = prev.categoryId;
  delete tx.linkPrev; delete tx.schedPrev; delete tx.loanPrev;
  return true;
}
