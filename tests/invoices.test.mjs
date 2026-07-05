// Test di regressione sulla logica fatture/pagamenti (funzioni pure di domain/).
// Nessun framework: si lancia con `node tests/invoices.test.mjs`.
// Non entra nel build (vite bundle solo da src/ via index.html).

import { data } from '../src/state/store.js';
import {
  applyBatch, batchSettle, deleteInvoice, addPayment, removePayment,
  invResiduo, invStatus, linkBankTx, unlinkTx, mgmtState, txIsLinked
} from '../src/domain/invoices.js';
import { movementCandidates, searchInvoices, searchMovements, batchCandidates, reconcileMany } from '../src/domain/reconcile.js';
import { migrate } from '../src/state/model.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };
const reset = () => { data.invoices.length = 0; data.transactions.length = 0; };
const mkInv = (o) => ({ id: o.id, companyId: 'co1', supplierId: null, number: o.id, date: '2026-01-01', due: '2026-02-01', total: o.total, withholding: 0, payments: [], creditNote: !!o.cn });

// 1. Saldo multiplo con NDC: il movimento di cassa è il netto e viene ripulito eliminando la fattura.
reset();
const a = mkInv({ id: 'A', total: 100 });
const nc = mkInv({ id: 'NC', total: 30, cn: true });
data.invoices.push(a, nc);
applyBatch([a, nc], { date: '2026-01-15', accountId: 'acc1', mode: 'cumulative' });
ok('applyBatch(NDC): crea un solo movimento di cassa pari al netto (70)',
  data.transactions.length === 1 && data.transactions[0].amount === 70);
ok('applyBatch(NDC): fattura e nota di credito risultano saldate',
  invStatus(a) === 'paid' && invStatus(nc) === 'paid');
deleteInvoice(a);
ok('applyBatch(NDC): eliminando la fattura il movimento di cassa NON resta orfano',
  data.transactions.length === 0);

// 2. Controllo di non-regressione: saldo multiplo senza NDC resta coerente.
reset();
const b = mkInv({ id: 'B', total: 60 });
const c = mkInv({ id: 'C', total: 40 });
data.invoices.push(b, c);
batchSettle([b, c], { date: '2026-01-15', accountId: 'acc1', mode: 'cumulative' });
ok('batchSettle: un movimento cumulativo pari alla somma (100)',
  data.transactions.length === 1 && data.transactions[0].amount === 100);
ok('batchSettle: il movimento cumulativo porta il nome del fornitore (ricercabile)',
  /Fornitore · saldo 2 fatture/.test(data.transactions[0].note));
deleteInvoice(b); deleteInvoice(c);
ok('batchSettle: eliminando entrambe le fatture il movimento sparisce',
  data.transactions.length === 0);

// 3. Pagamento singolo con conto: rimuoverlo elimina il movimento collegato.
reset();
const d = mkInv({ id: 'D', total: 50 });
data.invoices.push(d);
const p = addPayment(d, { amount: 50, date: '2026-01-15', accountId: 'acc1' });
ok('addPayment(conto): crea il movimento collegato', data.transactions.length === 1);
removePayment(d, p.id);
ok('removePayment: elimina il movimento collegato', data.transactions.length === 0 && invResiduo(d) === 50);

// 4. Abbinamento fattura ↔ movimento: il movimento prende il nome della fattura (fornitore · Fatt · data)
reset();
const e = mkInv({ id: 'E', total: 200 });
e.supplierName = 'ACME Srl'; e.number = '77'; e.date = '2026-04-10';
data.invoices.push(e);
const bankTx = { id: 'BK', companyId: 'co1', type: 'expense', amount: 200, accountId: 'acc1', date: '2026-04-12', desc: 'BONIFICO SEPA', note: 'Bonifico vario', categoryId: 'c-ban' };
data.transactions.push(bankTx);
linkBankTx(e, bankTx);
ok('abbinamento fattura: il movimento prende nome fornitore · Fatt · data', bankTx.note === 'ACME Srl · Fatt. 77 · 10/04/2026');
ok('abbinamento fattura: la descrizione bancaria grezza resta', bankTx.desc === 'BONIFICO SEPA');
ok('abbinamento fattura: la fattura risulta pagata', invStatus(e) === 'paid');
unlinkTx('BK');
ok('scollegamento fattura: ripristina il nome originale del movimento', bankTx.note === 'Bonifico vario');
ok('scollegamento fattura: la fattura torna da pagare', invStatus(e) !== 'paid');

// 5. NDC: il credito non viene sovra-consumato quando supera il lordo
reset();
const f1 = mkInv({ id: 'F1', total: 50 });
const cnBig = mkInv({ id: 'CNB', total: 80, cn: true });
data.invoices.push(f1, cnBig);
applyBatch([f1, cnBig], { date: '2026-02-01', accountId: 'acc1', mode: 'cumulative' });
ok('NDC>lordo: fattura saldata', invStatus(f1) === 'paid');
ok('NDC>lordo: la NDC conserva il credito non usato (residuo 30)', Math.abs(invResiduo(cnBig) - 30) < 0.005);

// 6. NDC: smontando il saldo, le NDC si riaprono e la cassa torna a zero
reset();
const g1 = mkInv({ id: 'G1', total: 50 });
const g2 = mkInv({ id: 'G2', total: 50 });
const cn2 = mkInv({ id: 'CN2', total: 40, cn: true });
data.invoices.push(g1, g2, cn2);
applyBatch([g1, g2, cn2], { date: '2026-02-01', accountId: 'acc1', mode: 'cumulative' });
ok('NDC batch: un solo movimento di cassa pari al netto (60)', data.transactions.length === 1 && data.transactions[0].amount === 60);
removePayment(g1, g1.payments[0].id); // rimuovo un pagamento del lotto → smonta tutto
ok('NDC batch: rimuovendo un pagamento si smonta l\'intero lotto (0 movimenti)', data.transactions.length === 0);
ok('NDC batch: le fatture tornano da pagare', invStatus(g1) !== 'paid' && invStatus(g2) !== 'paid');
ok('NDC batch: la nota di credito si riapre (residuo 40)', Math.abs(invResiduo(cn2) - 40) < 0.005);

// 7. Riconciliazione INVERSA: candidati movimento per una fattura + abbinamento, anche in tranche
reset();
const h1 = mkInv({ id: 'H1', total: 100 });
data.invoices.push(h1);
const t100 = { id: 'M100', companyId: 'co1', type: 'expense', amount: 100, date: '2026-01-05' };
const t60 = { id: 'M60', companyId: 'co1', type: 'expense', amount: 60, date: '2026-01-06' };
const t40 = { id: 'M40', companyId: 'co1', type: 'expense', amount: 40, date: '2026-01-07' };
const tBig = { id: 'M200', companyId: 'co1', type: 'expense', amount: 200, date: '2026-01-05' };
const tInc = { id: 'MIN', companyId: 'co1', type: 'income', amount: 100, date: '2026-01-05' };
const tLoan = { id: 'ML', companyId: 'co1', type: 'expense', amount: 100, date: '2026-01-05', loanId: 'X' };
data.transactions.push(t100, t60, t40, tBig, tInc, tLoan);
const cands = movementCandidates(h1).map(c => c.tx.id);
ok('inversa: candidati includono uscite libere compatibili', cands.includes('M100') && cands.includes('M60') && cands.includes('M40'));
ok('inversa: candidati escludono importo eccessivo, entrate e movimenti impegnati', !cands.includes('M200') && !cands.includes('MIN') && !cands.includes('ML'));
linkBankTx(h1, t60);
ok('inversa: prima tranche → residuo 40, parziale', Math.abs(invResiduo(h1) - 40) < 0.005 && invStatus(h1) === 'partial');
linkBankTx(h1, t40);
ok('inversa: seconda tranche → fattura saldata', invStatus(h1) === 'paid');
ok('inversa: i movimenti abbinati prendono il nome della fattura', (t60.note || '').includes('Fatt. H1') && t60.note === t40.note);

// 8. Ricerca estesa: per nome/numero sul lato movimento, per testo/importo sul lato fattura
reset();
const sA = mkInv({ id: 'SA', total: 500 }); sA.supplierName = 'Enel Energia'; sA.number = 'A-1';
const sB = mkInv({ id: 'SB', total: 999 }); sB.supplierName = 'Acme Spa'; sB.number = 'B-2';
const sPaid = mkInv({ id: 'SP', total: 100 }); sPaid.supplierName = 'Enel Energia'; sPaid.payments = [{ id: 'x', amount: 100 }];
data.invoices.push(sA, sB, sPaid);
const txS = { id: 'TS', companyId: 'co1', type: 'expense', amount: 70, date: '2026-01-10', desc: 'BONIFICO' };
data.transactions.push(txS);
const inv0 = searchInvoices(txS, 'enel').map(r => r.inv.id);
ok('ricerca fatture: trova per nome fornitore (non pagate)', inv0.includes('SA'));
ok('ricerca fatture: esclude le pagate e i non-match', !inv0.includes('SP') && !inv0.includes('SB'));
ok('ricerca fatture: trova anche per numero', searchInvoices(txS, 'b-2').map(r => r.inv.id).includes('SB'));

const tFree = { id: 'TF', companyId: 'co1', type: 'expense', amount: 250, date: '2026-01-11', note: 'Affitto gennaio', desc: 'SDD' };
const tBusy = { id: 'TB', companyId: 'co1', type: 'expense', amount: 250, date: '2026-01-11', note: 'Affitto' };
data.transactions.push(tFree, tBusy);
// TB è "impegnato" perché già referenziato da un pagamento (nuovo modello: legame nei payments[]).
sB.payments = (sB.payments || []).concat({ id: 'pb', amount: 250, txId: 'TB', linked: true });
const mv = searchMovements(sA, 'affitto').map(r => r.tx.id);
ok('ricerca movimenti: trova per testo i movimenti liberi', mv.includes('TF'));
ok('ricerca movimenti: esclude quelli già impegnati', !mv.includes('TB'));
ok('ricerca movimenti: trova per importo', searchMovements(sA, '250').map(r => r.tx.id).includes('TF'));

// 9. Saldo in blocco abbinando un movimento ESISTENTE (es. un bonifico unico)
reset();
const k1 = mkInv({ id: 'K1', total: 50 }), k2 = mkInv({ id: 'K2', total: 30 }), k3 = mkInv({ id: 'K3', total: 20 });
data.invoices.push(k1, k2, k3);
const bonifico = { id: 'BON', companyId: 'co1', type: 'expense', amount: 100, date: '2026-02-01', desc: 'BONIFICO UNICO' };
const tiny = { id: 'TY', companyId: 'co1', type: 'expense', amount: 5, date: '2026-02-01' };
data.transactions.push(bonifico, tiny);
const bc = batchCandidates('co1', 100).map(c => c.tx.id);
ok('saldo in blocco: trova il movimento compatibile col totale (100)', bc.includes('BON'));
ok('saldo in blocco: scarta i movimenti lontani dal totale', !bc.includes('TY'));
reconcileMany(bonifico, [k1, k2, k3]);
ok('saldo in blocco: tutte le fatture risultano pagate', invStatus(k1) === 'paid' && invStatus(k2) === 'paid' && invStatus(k3) === 'paid');
ok('saldo in blocco (stesso fornitore): il movimento prende "Fornitore · saldo 3 fatture"', /Fornitore · saldo 3 fatture/.test(bonifico.note));

// fornitori MISTI su un unico movimento → etichetta generica
reset();
const m1 = mkInv({ id: 'X1', total: 40 }); m1.supplierName = 'Alfa';
const m2 = mkInv({ id: 'X2', total: 60 }); m2.supplierName = 'Beta';
data.invoices.push(m1, m2);
const mixTx = { id: 'MX', companyId: 'co1', type: 'expense', amount: 100, date: '2026-02-01', note: 'bonifico' };
data.transactions.push(mixTx);
reconcileMany(mixTx, [m1, m2]);
ok('saldo in blocco (fornitori misti): etichetta generica "Saldo 2 fatture"', mixTx.note === 'Saldo 2 fatture');

// ===== Stato di gestione del movimento (mgmtState) =====
reset();
const inv = { id: 'GST', companyId: 'co1', supplierName: 'X', number: '1', date: '2026-01-01', due: '2026-02-01', total: 100, payments: [] };
data.invoices.push(inv);
const free = { id: 'F1', companyId: 'co1', type: 'expense', amount: 100, date: '2026-01-01' };
data.transactions.push(free);
ok('default: un movimento non toccato è "todo" (da gestire)', mgmtState(free) === 'todo');
free.mgmt = 'review'; ok('flag manuale: "review" → da rivedere', mgmtState(free) === 'review');
free.mgmt = 'await';  ok('flag manuale: "await" → in attesa di fattura', mgmtState(free) === 'await');
free.mgmt = 'managed'; ok('flag manuale: "managed" → gestito', mgmtState(free) === 'managed');
const transf = { id: 'TR', companyId: 'co1', type: 'transfer', amount: 50, date: '2026-01-02' };
ok('trasferimento: gestito in automatico', mgmtState(transf) === 'managed');
const loanTx = { id: 'LX', companyId: 'co1', type: 'expense', amount: 30, loanId: 'L1', instId: 'i1' };
ok('collegato a rata: linked e gestito', txIsLinked(loanTx) && mgmtState(loanTx) === 'managed');
// riconciliato a fattura → managed anche se mgmt non impostato
free.mgmt = undefined;
linkBankTx(inv, free);
ok('riconciliato a fattura: gestito in automatico (deriva dai payments)', mgmtState(free) === 'managed');

// migrazione: vecchio flag awaitingInvoice → mgmt='await'
const migd = migrate({ companies: [{ id: 'co1', name: 'A' }], accounts: [], transactions: [{ id: 'T', type: 'expense', amount: 10, awaitingInvoice: true }] });
ok('migrazione: awaitingInvoice → mgmt "await"', migd.transactions[0].mgmt === 'await' && migd.transactions[0].awaitingInvoice === undefined);

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
