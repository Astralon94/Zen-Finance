// ============ Backfill una tantum: nomi dei movimenti già abbinati ============
// Riapplica retroattivamente ai movimenti già collegati (rate, scadenze, fatture) il nome e la
// categoria dell'elemento collegato — come avviene ora al momento dell'abbinamento.
// Cattura il valore precedente (loanPrev/schedPrev/invPrev) così l'operazione è reversibile
// (riaprendo l'elemento il movimento torna al nome di prima) e idempotente (rieseguendolo non
// conta nulla se non c'è più niente da cambiare). Sovrascrive eventuali nomi personalizzati a mano.

import { data, save } from '../state/store.js';
import { fmtDateFull } from './util.js';
import { supNameOf } from './invoices.js';

const txById = id => data.transactions.find(t => t.id === id);
const invMoveLabel = i => `${supNameOf(i)}${i.number ? ' · Fatt. ' + i.number : ''}${i.date ? ' · ' + fmtDateFull(i.date) : ''}`;

export function backfillMatchNames() {
  let n = 0;

  // Rateizzazioni: rate pagate abbinate a un movimento ESISTENTE (non creato dalla rata)
  data.loans.forEach(l => {
    (l.installments || []).forEach(i => {
      if (i.status !== 'paid' || !i.txId) return;
      const tx = txById(i.txId);
      if (!tx || tx.fromLoan) return;
      const wantNote = `${l.name} · rata ${i.n}`, wantCat = l.categoryId || 'c-ban';
      if (tx.note === wantNote && tx.categoryId === wantCat) return;
      if (tx.loanPrev === undefined) tx.loanPrev = { note: tx.note ?? null, categoryId: tx.categoryId ?? null };
      tx.note = wantNote; tx.categoryId = wantCat; n++;
    });
  });

  // Programmati: scadenze completate abbinate a un movimento esistente
  data.scheduled.forEach(s => {
    if (s.status !== 'done' || !s.txId) return;
    const tx = txById(s.txId);
    if (!tx || tx.fromSchedule) return;
    const noteDiff = s.description && tx.note !== s.description;
    const catDiff = s.categoryId && tx.categoryId !== s.categoryId;
    if (!noteDiff && !catDiff) return;
    if (tx.schedPrev === undefined) tx.schedPrev = { note: tx.note ?? null, categoryId: tx.categoryId ?? null };
    if (noteDiff) tx.note = s.description;
    if (catDiff) tx.categoryId = s.categoryId;
    n++;
  });

  // Fatture: movimenti abbinati (pagamenti linked). Raggruppa per movimento → fatture collegate.
  const byTx = new Map();
  data.invoices.forEach(inv => (inv.payments || []).forEach(p => {
    if (p.linked && p.txId) { if (!byTx.has(p.txId)) byTx.set(p.txId, []); byTx.get(p.txId).push(inv); }
  }));
  byTx.forEach((invs, txId) => {
    const tx = txById(txId);
    if (!tx) return;
    const want = invs.length === 1 ? invMoveLabel(invs[0]) : `Saldo ${invs.length} fatture`;
    if (tx.note === want) return;
    if (tx.invPrev === undefined) tx.invPrev = { note: tx.note ?? null };
    tx.note = want; n++;
  });

  if (n) save();
  return n;
}
