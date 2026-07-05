// ============ Riconciliazione bancaria: movimento ↔ fattura ============
// Un solo motore: scoring e filtri condivisi dai tre finder (lato movimento, lato fattura,
// saldo in blocco). Il legame movimento↔fattura vive solo nei payments[] della fattura:
// `isTxReconciled`/`txLinkedInvoices` lo derivano (nessun campo tx.invoiceId da tenere a mano).
import { data, save } from '../state/store.js';
import { round2, daysBetween } from './util.js';
import { invResiduo, supNameOf, linkBankTxMany, isTxReconciled, isCreditNote } from './invoices.js';

// ---- internals condivisi ----
// Un'uscita è "libera" (abbinabile) se non è impegnata in rate/scadenze/saldi-carta e non è già
// referenziata da un pagamento fattura. (Copre anche i movimenti generati dai pagamenti stessi.)
export const isFreeExpense = t =>
  t.type === 'expense' && !t.loanId && !t.scheduledId && !t.cardSettle && !isTxReconciled(t.id);
// punteggio comune: importo esatto pesa molto, poi vicinanza temporale, bonus se il nome combacia
const rankScore = (diff, dd, nameHit) => (diff < 0.02 ? 0 : 100) + dd + (nameHit ? -50 : 0);
// sovrapposizione di parole significative (>3 lettere) di `src` dentro `hay`
const wordOverlap = (src, hay) => (src || '').toLowerCase().split(/\s+/).some(w => w.length > 3 && (hay || '').toLowerCase().includes(w));
const txText = t => ((t.desc || '') + ' ' + (t.note || ''));
// distanza in giorni del movimento dalla scadenza (o data) della fattura
const dueDist = (inv, date) => inv.due ? Math.abs(daysBetween(inv.due, date)) : (inv.date ? Math.abs(daysBetween(inv.date, date)) : 999);

// ===== lato movimento → fatture =====
// Fatture candidate per un movimento: stessa azienda, con residuo, importo compatibile.
export function candidates(tx) {
  const list = data.invoices.filter(i =>
    i.companyId === tx.companyId && !isCreditNote(i) && invResiduo(i) > 0.005 &&
    tx.amount <= invResiduo(i) + 0.02
  );
  return list.map(i => {
    const diff = Math.abs(invResiduo(i) - tx.amount);
    const dd = dueDist(i, tx.date);
    const nameHit = wordOverlap(supNameOf(i), txText(tx));
    return { inv: i, diff, dd, nameHit, score: rankScore(diff, dd, nameHit) };
  }).sort((a, b) => a.score - b.score).slice(0, 8);
}

// Ricerca ESTESA (lato movimento): tutte le fatture non pagate dell'azienda che matchano il testo
// (per nome fornitore o numero), oltre ai soli candidati "probabili".
export function searchInvoices(tx, term) {
  const t = (term || '').trim().toLowerCase();
  return data.invoices.filter(i =>
    i.companyId === tx.companyId && !isCreditNote(i) && invResiduo(i) > 0.005 &&
    (!t || supNameOf(i).toLowerCase().includes(t) || (i.number || '').toLowerCase().includes(t))
  ).map(i => {
    const diff = Math.abs(invResiduo(i) - tx.amount);
    const nameHit = wordOverlap(supNameOf(i), txText(tx));
    return { inv: i, diff, nameHit };
  }).sort((a, b) => a.diff - b.diff).slice(0, 50);
}

// ===== lato fattura → movimenti =====
// Riconciliazione INVERSA: movimenti candidati per una fattura. Uscite libere della stessa
// azienda, di importo ≤ residuo.
export function movementCandidates(inv) {
  const res = invResiduo(inv);
  if (res <= 0.005) return [];
  const supName = supNameOf(inv);
  return data.transactions.filter(t =>
    isFreeExpense(t) && t.companyId === inv.companyId && t.amount <= res + 0.02
  ).map(t => {
    const diff = Math.abs(t.amount - res);
    const dd = dueDist(inv, t.date);
    const nameHit = wordOverlap(txText(t), supName);
    return { tx: t, diff, nameHit, score: rankScore(diff, dd, nameHit) };
  }).sort((a, b) => a.score - b.score).slice(0, 12);
}

// Ricerca ESTESA tra i movimenti liberi di un'azienda (per testo o importo), ordinati per vicinanza
// a `target`. Base condivisa dal lato fattura e dal saldo in blocco.
export function searchFreeMovements(companyId, term, target = 0) {
  const t = (term || '').trim().toLowerCase();
  return data.transactions.filter(tx =>
    isFreeExpense(tx) && tx.companyId === companyId &&
    (!t || (tx.note || '').toLowerCase().includes(t) || (tx.desc || '').toLowerCase().includes(t) || String(tx.amount).includes(t))
  ).map(tx => ({ tx, diff: Math.abs(round2(tx.amount) - round2(target)), nameHit: false })).sort((a, b) => a.diff - b.diff).slice(0, 50);
}
export function searchMovements(inv, term) { return searchFreeMovements(inv.companyId, term, invResiduo(inv)); }

// ===== saldo in blocco =====
// Movimenti candidati per il saldo IN BLOCCO di più fatture: uscite libere dell'azienda di importo
// vicino al totale netto da pagare (es. un bonifico unico che ha saldato più fatture).
export function batchCandidates(companyId, target) {
  const tg = round2(target);
  return data.transactions.filter(t =>
    isFreeExpense(t) && t.companyId === companyId &&
    Math.abs(round2(t.amount) - tg) <= tg * 0.15 + 2
  ).map(t => ({ tx: t, diff: Math.abs(round2(t.amount) - tg) })).sort((a, b) => a.diff - b.diff).slice(0, 8);
}

// ===== azioni =====
export function reconcileMany(tx, invoices) { return linkBankTxMany(tx, invoices); }
export function ignoreRecon(tx) { tx.reconIgnore = true; save(); }
