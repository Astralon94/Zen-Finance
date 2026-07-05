// ============ Finanziamenti (mutui, prestiti, leasing) ============
import { data, save, deleteAttachment } from '../state/store.js';
import { round2, uid, todayStr, daysBetween, pad2, attachTxMeta, detachTxMeta } from './util.js';

// Metodi di pagamento di un finanziamento. I "manuali" richiedono un'azione (bonifico,
// bollettino...), gli "automatici" partono da soli (RID, carta...). La distinzione manual/auto
// è la sola fonte di verità per l'evidenziazione; l'etichetta è solo descrittiva.
export const PAYMENT_METHODS = {
  'Bonifico': { manual: true },
  'Bollettino': { manual: true },
  'MAV/RAV': { manual: true },
  'F24': { manual: true },
  'Contanti': { manual: true },
  'RID': { manual: false },
  'Carta': { manual: false },
  'Trattenuta in busta paga': { manual: false }
};
// ordine nel menù: prima i manuali, poi gli automatici
export const PAYMENT_METHOD_LIST = ['Bonifico', 'Bollettino', 'MAV/RAV', 'F24', 'Contanti', 'RID', 'Carta', 'Trattenuta in busta paga'];
// un finanziamento è "manuale" solo se ha un metodo impostato e quel metodo è manuale.
// Senza metodo (es. vecchi finanziamenti) → non evidenziato.
export const isManualLoan = l => !!(l && l.paymentMethod && PAYMENT_METHODS[l.paymentMethod]?.manual);

export const loansInScope = scope => data.loans.filter(l => !scope || l.companyId === scope);
export const insts = l => (Array.isArray(l.installments) ? l.installments : []);
// Importo EFFETTIVO di una rata: se pagata con importo reale diverso dal piano (tasso variabile)
// usa quello ereditato dal movimento (paidAmount); altrimenti l'importo del piano.
export const instAmount = i => round2((i.status === 'paid' && i.paidAmount != null) ? i.paidAmount : (i.amount || 0));
// Pagato = somma degli importi effettivi delle rate pagate. Residuo = somma del piano delle rate non pagate.
export const loanPaid = l => round2(insts(l).filter(i => i.status === 'paid').reduce((s, i) => s + instAmount(i), 0));
export const loanResiduo = l => round2(insts(l).filter(i => i.status !== 'paid').reduce((s, i) => s + (i.amount || 0), 0));
export const paidCount = l => insts(l).filter(i => i.status === 'paid').length;
export const isInstOverdue = i => i.status !== 'paid' && !!i.date && i.date < todayStr();
export function nextDue(l) {
  return insts(l).filter(i => i.status !== 'paid').sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0] || null;
}
export function overdueInstCount(scope) {
  return loansInScope(scope).reduce((n, l) => n + insts(l).filter(isInstOverdue).length, 0);
}

export function addMonths(dateStr, n) {
  const [y, m, d] = (dateStr || todayStr()).split('-').map(Number);
  const dt = new Date(y, (m - 1) + n, d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// genera un piano rate mensile (o ogni freqMonths mesi)
export function generatePlan({ count, firstDate, amount, freqMonths = 1 }) {
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push({ id: uid(), n: k + 1, date: addMonths(firstDate, k * freqMonths), amount: round2(amount), status: 'pending', paidDate: null, txId: null });
  }
  return out;
}

export function addLoan(rec) { const l = { id: uid(), installments: [], attachments: [], createdAt: Date.now(), ...rec }; data.loans.push(l); save(); return l; }
export function updateLoan(l, rec) { Object.assign(l, rec); save(); }
export function deleteLoan(l) {
  insts(l).forEach(i => { if (i.txId) { const tx = data.transactions.find(t => t.id === i.txId); if (tx && tx.fromLoan) data.transactions = data.transactions.filter(t => t.id !== i.txId); else if (tx) { delete tx.loanId; delete tx.instId; } } });
  (l.attachments || []).forEach(a => { deleteAttachment(a).catch(() => {}); }); // rimuove i file dal vault (best-effort)
  data.loans = data.loans.filter(x => x.id !== l.id); save();
}

// paga una rata creando un movimento reale. `amount` (opzionale) sovrascrive l'importo del piano
// (tasso variabile: importo realmente addebitato). La rata registra l'importo effettivo pagato.
export function payInstWithMovement(l, i, { date, accountId, amount } = {}) {
  date = date || i.date || todayStr();
  const amt = round2(amount != null ? amount : i.amount);
  const tx = {
    id: uid(), companyId: l.companyId, type: 'expense', amount: amt,
    categoryId: l.categoryId || 'c-ban', accountId: accountId || l.accountId || null, toAccountId: null,
    supplierId: null, date, desc: null, note: `${l.name} · rata ${i.n}`,
    loanId: l.id, instId: i.id, fromLoan: true, createdAt: Date.now()
  };
  data.transactions.push(tx);
  i.status = 'paid'; i.paidDate = date; i.txId = tx.id; i.paidAmount = amt; save(); return tx;
}
// paga abbinando un movimento esistente (RID già arrivato). La rata EREDITA l'importo del movimento
// (tasso variabile: la rata effettivamente pagata può differire dal piano). Il movimento acquisisce
// nome e categoria della rata; i valori precedenti sono salvati per ripristinarli alla riapertura.
export function payInstWithTx(l, i, tx) {
  attachTxMeta(tx, { note: `${l.name} · rata ${i.n}`, categoryId: l.categoryId || 'c-ban' });
  i.status = 'paid'; i.paidDate = tx.date || todayStr(); i.txId = tx.id; i.paidAmount = round2(tx.amount); tx.loanId = l.id; tx.instId = i.id; save();
}
// segna pagata senza movimento (all'importo del piano)
export function payInstMarkOnly(i) { i.status = 'paid'; i.paidDate = todayStr(); i.txId = null; delete i.paidAmount; save(); }
// annulla pagamento (rimuove il movimento se creato dal finanziamento; azzera l'importo effettivo)
export function unpayInst(i) {
  if (i.txId) {
    const tx = data.transactions.find(t => t.id === i.txId);
    if (tx && tx.fromLoan) data.transactions = data.transactions.filter(t => t.id !== i.txId);
    else if (tx) {
      delete tx.loanId; delete tx.instId;
      detachTxMeta(tx); // ripristina nome e categoria originali del movimento abbinato
    }
  }
  i.status = 'pending'; i.paidDate = null; i.txId = null; delete i.paidAmount; save();
}

// segna pagate (solo storico, senza movimento) tutte le rate cronologicamente precedenti a `inst`
export function markPreviousPaid(loan, inst) {
  const ordered = insts(loan).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.n - b.n));
  const idx = ordered.findIndex(x => x.id === inst.id);
  let n = 0;
  ordered.slice(0, Math.max(0, idx)).forEach(x => { if (x.status !== 'paid') { x.status = 'paid'; x.paidDate = x.date || todayStr(); x.txId = null; n++; } });
  if (n) save();
  return n;
}

// Movimenti candidati per l'abbinamento di una rata. Per i finanziamenti a TASSO VARIABILE non si
// filtra per importo (la rata pagata può differire dal piano): si cerca per tipo/azienda/finestra data.
export function candidates(l, i) {
  const byAmount = t => l.variableRate ? true : Math.abs(round2(t.amount) - round2(i.amount)) < 0.02;
  return data.transactions.filter(t =>
    t.type === 'expense' && t.companyId === l.companyId && !t.loanId && byAmount(t) &&
    (!i.date || !t.date || Math.abs(daysBetween(i.date, t.date)) <= 20)
  ).sort((a, b) => Math.abs(daysBetween(i.date || a.date, a.date)) - Math.abs(daysBetween(i.date || b.date, b.date))).slice(0, 8);
}
