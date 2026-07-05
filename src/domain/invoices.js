// ============ Fatture passive: STATO SEMPRE DERIVATO ============
// Si memorizzano solo fatti: total, withholding, payments[]. Tutto il resto è calcolato.
// Un pagamento può (opzionalmente) generare un movimento collegato su un conto: così
// saldo conti e conto economico restano coerenti. Il collegamento è txId sul pagamento.

import { data, save, deleteXmlFile } from '../state/store.js';
import { round2, uid, todayStr, fmtDateFull } from './util.js';
import { sup, acc } from './finance.js';
import { logEvent } from './auditlog.js';

// etichetta evento storico: "Fornitore · N. 123"
const evLabel = i => supNameOf(i) + (i.number ? ' · N. ' + i.number : '');
const accName = id => (id ? (acc(id)?.name || null) : null);

// ---- nome del movimento per una fattura abbinata: "Fornitore · Fatt. 123 · 23/06/2026" ----
const invMoveLabel = i => `${supNameOf(i)}${i.number ? ' · Fatt. ' + i.number : ''}${i.date ? ' · ' + fmtDateFull(i.date) : ''}`;
// nome del movimento per il saldo cumulativo (più fatture, niente data singola): "Fornitore · saldo 3 fatture"
const settleLabel = (i, n) => `${supNameOf(i)} · saldo ${n} ${n === 1 ? 'fattura' : 'fatture'}`;
// nome per un movimento legato a N fatture: data singola se una sola; nome fornitore se tutte dello stesso
// fornitore; generico "Saldo N fatture" se di fornitori misti (es. un bonifico che paga più fornitori).
const multiInvLabel = invs => invs.length === 1
  ? invMoveLabel(invs[0])
  : (invs.every(i => supNameOf(i) === supNameOf(invs[0])) ? settleLabel(invs[0], invs.length) : `Saldo ${invs.length} fatture`);
// imposta il nome del movimento conservando l'originale (solo la prima volta) in invPrev
function applyInvName(tx, label) { if (tx.invPrev === undefined) tx.invPrev = { note: tx.note ?? null }; tx.note = label; }
// dopo una variazione di abbinamento aggiorna il nome: se è ancora legato a fatture aggiorna
// l'etichetta al numero residuo; se non lo è più, ripristina il nome originale. Ritorna true se ha agito.
function refreshInvName(txId) {
  const tx = data.transactions.find(t => t.id === txId);
  if (!tx || tx.invPrev === undefined) return false;
  const invs = txLinkedInvoices(txId);
  tx.note = invs.length ? multiInvLabel(invs) : tx.invPrev.note;
  if (!invs.length) delete tx.invPrev;
  return true;
}

// ---- derivazioni (pure) ----
export const invTotal = i => round2(i.total != null ? i.total : (i.net || 0) + (i.vat || 0));
export const invWithholding = i => round2(i.withholding || 0);
export const invPayable = i => round2(invTotal(i) - invWithholding(i));
export const invPayments = i => (Array.isArray(i.payments) ? i.payments : []);
export const invPaid = i => round2(invPayments(i).reduce((s, p) => s + (p.amount || 0), 0));
export const invResiduo = i => round2(invPayable(i) - invPaid(i));

// nota di credito a favore: gestita come fattura "in positivo" che scala il totale del fornitore
export const isCreditNote = i => !!i.creditNote;
// residuo "con segno": le NDC riducono il dovuto (negativo)
export const invSignedResiduo = i => isCreditNote(i) ? -invResiduo(i) : invResiduo(i);

export function invStatus(i) {
  const r = invResiduo(i);
  if (r <= 0.005) return 'paid';
  return invPaid(i) > 0.005 ? 'partial' : 'unpaid';
}
// le NDC non sono "da pagare", quindi mai scadute/in scadenza
export const invOverdue = i => !isCreditNote(i) && invResiduo(i) > 0.005 && !!i.due && i.due < todayStr();
export function invDueSoon(i) {
  if (isCreditNote(i) || invResiduo(i) <= 0.005 || !i.due) return false;
  const t = todayStr();
  if (i.due < t) return false;
  return (new Date(i.due) - new Date(t)) / 86400000 <= 30;
}

export const STATUS_LABEL = { unpaid: 'Da pagare', partial: 'Parziale', paid: 'Pagata' };
export function statusLabelOf(i) {
  if (isCreditNote(i)) return invStatus(i) === 'paid' ? 'Usata' : (invStatus(i) === 'partial' ? 'Usata in parte' : 'Da usare');
  if (invStatus(i) === 'paid') return 'Pagata';
  if (invStatus(i) === 'partial') return 'Parziale';
  return invOverdue(i) ? 'Scaduta' : 'Da pagare';
}

export function supNameOf(i) {
  const s = i.supplierId ? sup(i.supplierId) : null;
  return s ? s.name : (i.supplierName || 'Fornitore');
}

export function invoicesInScope(scope) {
  return scope ? data.invoices.filter(i => i.companyId === scope) : data.invoices;
}

// ---- azioni (mutano lo stato e salvano) ----
// Registra un pagamento. Se accountId è valorizzato crea un movimento collegato.
export function addPayment(inv, { amount, date, accountId = null, note = '' }) {
  amount = round2(amount);
  if (amount <= 0) return;
  const res = invResiduo(inv);
  if (amount > res + 0.005) amount = res; // non eccedere il residuo
  const pay = { id: uid(), amount, date: date || todayStr(), accountId: accountId || null, txId: null, note: note || '' };
  if (accountId) {
    const tx = {
      id: uid(), companyId: inv.companyId, type: 'expense', amount,
      categoryId: inv.categoryId || 'c-for', accountId, supplierId: inv.supplierId || null,
      date: pay.date, note: note || invMoveLabel(inv)
    };
    data.transactions.push(tx);
    pay.txId = tx.id;
  }
  inv.payments = invPayments(inv).concat(pay);
  logEvent('payment', { companyId: inv.companyId, label: evLabel(inv), amount, account: accName(accountId) });
  save();
  return pay;
}

// Rilascia il movimento collegato a un pagamento già rimosso dall'array.
// Reference-count: un movimento cumulativo è condiviso da più pagamenti.
// Se altri pagamenti lo referenziano ancora → riduce l'importo; altrimenti → lo elimina.
function releaseTx(p) {
  if (!p || !p.txId) return;
  let refs = 0;
  for (const inv of data.invoices) for (const q of invPayments(inv)) if (q.txId === p.txId) refs++;
  const tx = data.transactions.find(t => t.id === p.txId);
  if (!tx) return;
  if (refs > 0) tx.amount = round2(Math.max(0, tx.amount - p.amount));
  else data.transactions = data.transactions.filter(t => t.id !== p.txId);
}

// Smonta atomicamente un saldo-lotto con note di credito: rimuove i pagamenti del lotto da TUTTE
// le fatture/NDC coinvolte (ripristinando i loro residui) ed elimina il movimento di cassa del lotto.
function stripBatch(batchId) {
  let cashTxId = null, n = 0, ref = null;
  data.invoices.forEach(inv => {
    const ps = invPayments(inv);
    const kept = ps.filter(p => { if (p.batchId === batchId) { if (p.txId) cashTxId = p.txId; if (!ref) ref = inv; n++; return false; } return true; });
    if (kept.length !== ps.length) inv.payments = kept;
  });
  if (cashTxId) data.transactions = data.transactions.filter(t => t.id !== cashTxId);
  return { ref, n };
}
function removeBatch(batchId) {
  const { ref, n } = stripBatch(batchId);
  if (!n) return;
  logEvent('payment_removed', { companyId: ref?.companyId || null, label: ref ? evLabel(ref) : 'Saldo multiplo', amount: null });
  save();
}

export function removePayment(inv, paymentId) {
  const ps = invPayments(inv);
  const idx = ps.findIndex(p => p.id === paymentId);
  if (idx < 0) return;
  if (ps[idx].batchId) return removeBatch(ps[idx].batchId); // pagamento di un saldo-lotto NDC → smonta tutto il lotto
  const [p] = ps.splice(idx, 1);
  inv.payments = ps;
  if (p.linked) { refreshInvName(p.txId); } // movimento bancario: scollega (aggiorna/ripristina il nome), non eliminare
  else releaseTx(p);
  logEvent('payment_removed', { companyId: inv.companyId, label: evLabel(inv), amount: p.amount, account: accName(p.accountId) });
  save();
}

// Collega un movimento bancario ESISTENTE a una fattura come pagamento (riconciliazione).
// Non crea un nuovo movimento: usa quello importato.
export function linkBankTx(inv, tx) {
  const amount = round2(Math.min(invResiduo(inv), tx.amount));
  if (amount <= 0) return null;
  applyInvName(tx, invMoveLabel(inv));
  const pay = { id: uid(), amount, date: tx.date || todayStr(), accountId: tx.accountId || null, txId: tx.id, note: 'Da estratto conto', linked: true };
  inv.payments = invPayments(inv).concat(pay);
  logEvent('reconcile', { companyId: inv.companyId, label: evLabel(inv), amount, account: accName(tx.accountId) });
  save();
  return pay;
}

// Collega UN movimento a PIÙ fatture (es. un bonifico unico che salda più fatture).
// Ripartisce l'importo del movimento sui residui, nell'ordine dato.
export function linkBankTxMany(tx, invoices) {
  let remaining = round2(Math.abs(tx.amount));
  const done = [];
  for (const inv of invoices) {
    if (remaining <= 0.005) break;
    const amount = round2(Math.min(invResiduo(inv), remaining));
    if (amount <= 0) continue;
    inv.payments = invPayments(inv).concat({ id: uid(), amount, date: tx.date || todayStr(), accountId: tx.accountId || null, txId: tx.id, note: 'Da estratto conto', linked: true });
    logEvent('reconcile', { companyId: inv.companyId, label: evLabel(inv), amount, account: accName(tx.accountId) });
    remaining = round2(remaining - amount);
    done.push(inv);
  }
  if (done.length) {
    applyInvName(tx, multiInvLabel(done));
    save();
  }
  return { linked: done.length, leftover: remaining };
}

// Una transazione è riconciliata se almeno una fattura ha un pagamento che la referenzia.
export function isTxReconciled(txId) {
  return data.invoices.some(inv => invPayments(inv).some(p => p.txId === txId));
}
// Fatture collegate a una transazione (per scollegare in blocco).
export function txLinkedInvoices(txId) {
  return data.invoices.filter(inv => invPayments(inv).some(p => p.txId === txId));
}

// ============ Stato di gestione del movimento ============
// Quattro stati: managed (Gestito) · await (In attesa di fattura) · review (Da rivedere) · todo (Da gestire).
// Trasferimenti e movimenti collegati (riconciliati a fattura, rate, scadenze, saldi-carta, o generati
// da essi) sono "managed" in automatico; gli altri seguono il flag manuale t.mgmt, default "todo".
// L'obiettivo del flusso è portare ogni movimento a "managed" (evidenziato in verde).
export const MGMT = {
  managed: { label: 'Gestito', cls: 'managed' },
  await:   { label: 'In attesa di fattura', cls: 'await' },
  review:  { label: 'Da rivedere', cls: 'review' },
  todo:    { label: 'Da gestire', cls: 'todo' }
};
export const txIsLinked = t => isTxReconciled(t.id) || !!t.loanId || !!t.scheduledId || !!t.cardSettle || !!t.fromLoan || !!t.fromSchedule;
export function mgmtState(t) {
  if (!t) return 'todo';
  if (t.type === 'transfer' || txIsLinked(t)) return 'managed';
  return (t.mgmt === 'managed' || t.mgmt === 'await' || t.mgmt === 'review') ? t.mgmt : 'todo';
}
// Scollega un movimento da TUTTE le fatture (rimuove i pagamenti linked, lascia il movimento).
export function unlinkTx(txId) {
  let changed = false;
  data.invoices.forEach(inv => {
    const ps = invPayments(inv);
    const kept = ps.filter(p => p.txId !== txId);
    if (kept.length !== ps.length) { inv.payments = kept; changed = true; }
  });
  const renamed = refreshInvName(txId);
  if (changed || renamed) save();
  return changed;
}

export function payFull(inv, { date, accountId = null } = {}) {
  const res = invResiduo(inv);
  if (res <= 0.005) return;
  return addPayment(inv, { amount: res, date: date || todayStr(), accountId });
}

export function deleteInvoice(inv) {
  // se la fattura fa parte di saldi-lotto NDC, smontali prima (ripristina NDC e cassa del lotto)
  [...new Set(invPayments(inv).filter(p => p.batchId).map(p => p.batchId))].forEach(stripBatch);
  const ps = invPayments(inv).slice();
  inv.payments = [];                 // svuota prima, così il conteggio refs è corretto
  const linkedTxIds = [];
  ps.forEach(p => { if (p.linked) { linkedTxIds.push(p.txId); } else releaseTx(p); });
  logEvent('invoice_deleted', { companyId: inv.companyId, label: evLabel(inv), amount: invTotal(inv) });
  data.invoices = data.invoices.filter(x => x.id !== inv.id);
  linkedTxIds.forEach(refreshInvName); // aggiorna/ripristina il nome dei movimenti non più abbinati
  if (inv.source === 'xml') deleteXmlFile(inv.id); // rimuove l'XML orfano dalla cartella (best-effort)
  save();
}

// ============ Flag "in pagamento" (intenzione di saldo) ============
export const isToPay = i => !!i.toPay && invResiduo(i) > 0.005;
export function setToPay(inv, val) { inv.toPay = !!val; save(); }
export function toggleToPay(inv) { inv.toPay = !inv.toPay; save(); }
export function flagMany(invs, val) { invs.forEach(i => { i.toPay = !!val; }); save(); }

// ============ Saldo multiplo ============
// items: fatture da saldare a residuo intero. mode: 'cumulative' (un solo movimento) | 'separate'.
// Il movimento si crea solo se accountId è valorizzato.
export function batchSettle(invoices, { date, accountId = null, mode = 'separate' } = {}) {
  date = date || todayStr();
  const items = invoices.filter(i => invResiduo(i) > 0.005);
  if (!items.length) return { paid: 0 };

  if (mode === 'cumulative' && accountId) {
    const total = round2(items.reduce((s, i) => s + invResiduo(i), 0));
    const tx = {
      id: uid(), companyId: items[0].companyId, type: 'expense', amount: total,
      categoryId: 'c-for', accountId, supplierId: items[0].supplierId || null,
      date, note: settleLabel(items[0], items.length)
    };
    data.transactions.push(tx);
    items.forEach(i => {
      const amt = invResiduo(i);
      i.payments = invPayments(i).concat({ id: uid(), amount: amt, date, accountId, txId: tx.id, note: 'Saldo multiplo' });
      i.toPay = false;
      logEvent('payment', { companyId: i.companyId, label: evLabel(i), amount: amt, account: accName(accountId) });
    });
  } else {
    items.forEach(i => {
      const amount = invResiduo(i);
      const pay = { id: uid(), amount, date, accountId: accountId || null, txId: null, note: 'Saldo multiplo' };
      if (accountId) {
        const tx = {
          id: uid(), companyId: i.companyId, type: 'expense', amount,
          categoryId: i.categoryId || 'c-for', accountId, supplierId: i.supplierId || null,
          date, note: invMoveLabel(i)
        };
        data.transactions.push(tx); pay.txId = tx.id;
      }
      i.payments = invPayments(i).concat(pay);
      i.toPay = false;
      logEvent('payment', { companyId: i.companyId, label: evLabel(i), amount, account: accName(accountId) });
    });
  }
  save();
  return { paid: items.length };
}

// ============ Saldo multiplo CON note di credito ============
// Salda le fatture del fornitore scalando le NDC selezionate: il movimento di cassa è il NETTO
// (fatture − note di credito). Le fatture vanno a "pagata", le NDC a "usata".
export function applyBatch(items, { date, accountId = null, mode = 'cumulative' } = {}) {
  date = date || todayStr();
  const invs = items.filter(i => !isCreditNote(i) && invResiduo(i) > 0.005);
  const cns = items.filter(i => isCreditNote(i) && invResiduo(i) > 0.005);
  if (!invs.length && !cns.length) return { paid: 0, used: 0, net: 0 };

  // nessuna NDC → comportamento standard (cumulativo o separato)
  if (!cns.length) return { ...batchSettle(invs, { date, accountId, mode }), used: 0, net: round2(invs.reduce((s, i) => s + invResiduo(i), 0)) };

  const gross = round2(invs.reduce((s, i) => s + invResiduo(i), 0));
  const creditAvail = round2(cns.reduce((s, c) => s + invResiduo(c), 0));
  const creditUsed = round2(Math.min(creditAvail, gross)); // non consumare più credito del dovuto
  const net = round2(gross - creditUsed);
  const ref = invs[0] || cns[0];
  const batchId = uid(); // lega fatture + NDC del lotto → annullabile in blocco

  // un solo movimento di cassa per il netto effettivamente pagato
  let cashTxId = null;
  if (accountId && net > 0.005) {
    const tx = {
      id: uid(), companyId: ref.companyId, type: 'expense', amount: net,
      categoryId: 'c-for', accountId, supplierId: ref.supplierId || null,
      date, note: `${settleLabel(ref, invs.length)} (netto NDC)`, batchId
    };
    data.transactions.push(tx);
    cashTxId = tx.id;
  }
  // fatture → pagate per intero (collegate al movimento di cassa del lotto)
  invs.forEach(i => { const amt = invResiduo(i); i.payments = invPayments(i).concat({ id: uid(), amount: amt, date, accountId: accountId || null, txId: cashTxId, note: 'Saldo multiplo', batchId }); i.toPay = false; logEvent('payment', { companyId: i.companyId, label: evLabel(i), amount: amt, account: accName(accountId) }); });
  // NDC → consumate solo fino a creditUsed, in sequenza (il resto del credito resta disponibile)
  let remaining = creditUsed, usedCount = 0;
  cns.forEach(c => {
    if (remaining <= 0.005) return;
    const amt = round2(Math.min(invResiduo(c), remaining));
    c.payments = invPayments(c).concat({ id: uid(), amount: amt, date, accountId: null, txId: null, note: 'Compensata', batchId, compensation: true });
    c.toPay = false; remaining = round2(remaining - amt); usedCount++;
    logEvent('credit_used', { companyId: c.companyId, label: evLabel(c), amount: amt });
  });
  save();
  return { paid: invs.length, used: usedCount, net };
}
