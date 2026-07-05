// Test sui metodi di pagamento dei finanziamenti (funzione pura isManualLoan).
// Si lancia con `node tests/loans.test.mjs`.

import { data } from '../src/state/store.js';
import { isManualLoan, PAYMENT_METHODS, PAYMENT_METHOD_LIST, payInstWithTx, unpayInst, instAmount, loanPaid, candidates, payInstWithMovement } from '../src/domain/loans.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

ok('Bonifico è manuale', isManualLoan({ paymentMethod: 'Bonifico' }) === true);
ok('Bollettino è manuale', isManualLoan({ paymentMethod: 'Bollettino' }) === true);
ok('MAV/RAV è manuale', isManualLoan({ paymentMethod: 'MAV/RAV' }) === true);
ok('F24 è manuale', isManualLoan({ paymentMethod: 'F24' }) === true);
ok('Contanti è manuale', isManualLoan({ paymentMethod: 'Contanti' }) === true);
ok('RID è automatico', isManualLoan({ paymentMethod: 'RID' }) === false);
ok('Carta è automatica', isManualLoan({ paymentMethod: 'Carta' }) === false);
ok('Trattenuta in busta paga è automatica', isManualLoan({ paymentMethod: 'Trattenuta in busta paga' }) === false);
ok('finanziamento senza metodo NON è evidenziato', isManualLoan({}) === false);
ok('metodo sconosciuto NON è evidenziato', isManualLoan({ paymentMethod: 'Boh' }) === false);
ok('input null gestito', isManualLoan(null) === false);
ok('la lista copre tutti i metodi della mappa', PAYMENT_METHOD_LIST.length === Object.keys(PAYMENT_METHODS).length && PAYMENT_METHOD_LIST.every(m => m in PAYMENT_METHODS));

// abbinamento rata ↔ movimento esistente: il movimento prende nome e categoria della rata
data.loans.length = 0; data.transactions.length = 0;
const loan = { id: 'L', companyId: 'co1', name: 'Mutuo Casa', categoryId: 'c-aff', installments: [{ id: 'r1', n: 3, date: '2026-03-01', amount: 500, status: 'pending', txId: null }] };
data.loans.push(loan);
const tx = { id: 'T', companyId: 'co1', type: 'expense', amount: 500, accountId: 'acc1', date: '2026-03-02', desc: 'RID BANCA XYZ', note: 'Addebito RID', categoryId: 'c-ban' };
data.transactions.push(tx);
payInstWithTx(loan, loan.installments[0], tx);
ok('abbinamento: il movimento prende il nome della rata', tx.note === 'Mutuo Casa · rata 3');
ok('abbinamento: il movimento prende la categoria della rata', tx.categoryId === 'c-aff');
ok('abbinamento: la descrizione bancaria grezza resta intatta', tx.desc === 'RID BANCA XYZ');
ok('abbinamento: rata pagata e collegata al movimento', loan.installments[0].status === 'paid' && tx.loanId === 'L' && tx.instId === 'r1');
unpayInst(loan.installments[0]);
ok('riapertura: ripristina nome e categoria originali', tx.note === 'Addebito RID' && tx.categoryId === 'c-ban');
ok('riapertura: scollega il movimento senza eliminarlo', !tx.loanId && !tx.instId && data.transactions.some(t => t.id === 'T'));

// ===== Tasso variabile: la rata eredita l'importo effettivamente pagato =====
data.loans.length = 0; data.transactions.length = 0;
const vl = { id: 'VL', companyId: 'co1', name: 'Mutuo Var', categoryId: 'c-ban', variableRate: true, installments: [
  { id: 'v1', n: 1, date: '2026-01-01', amount: 500, status: 'pending', txId: null },
  { id: 'v2', n: 2, date: '2026-02-01', amount: 500, status: 'pending', txId: null }
] };
data.loans.push(vl);
const rid = { id: 'RID', companyId: 'co1', type: 'expense', amount: 512.34, date: '2026-01-02' };
data.transactions.push(rid);
ok('candidati (variabile): includono un movimento di importo diverso dal piano', candidates(vl, vl.installments[0]).some(t => t.id === 'RID'));
payInstWithTx(vl, vl.installments[0], rid);
ok('abbinamento (variabile): la rata eredita l\'importo del movimento (512,34)', vl.installments[0].paidAmount === 512.34);
ok('instAmount: rata pagata → importo effettivo', instAmount(vl.installments[0]) === 512.34);
ok('loanPaid: usa gli importi effettivi', loanPaid(vl) === 512.34);
unpayInst(vl.installments[0]);
ok('riapertura: azzera l\'importo effettivo (torna al piano)', vl.installments[0].paidAmount === undefined && instAmount(vl.installments[0]) === 500);
const tx2 = payInstWithMovement(vl, vl.installments[1], { date: '2026-02-02', accountId: 'acc1', amount: 488.9 });
ok('crea movimento (variabile): movimento e rata all\'importo effettivo (488,90)', tx2.amount === 488.9 && vl.installments[1].paidAmount === 488.9);

// ===== Tasso fisso: i candidati restano filtrati per importo =====
data.loans.length = 0; data.transactions.length = 0;
const fl = { id: 'FL', companyId: 'co1', name: 'Prestito Fisso', categoryId: 'c-ban', installments: [{ id: 'f1', n: 1, date: '2026-03-01', amount: 300, status: 'pending', txId: null }] };
data.loans.push(fl);
data.transactions.push({ id: 'X1', companyId: 'co1', type: 'expense', amount: 300, date: '2026-03-02' }, { id: 'X2', companyId: 'co1', type: 'expense', amount: 350, date: '2026-03-02' });
const fc = candidates(fl, fl.installments[0]).map(t => t.id);
ok('candidati (fisso): solo importo compatibile', fc.includes('X1') && !fc.includes('X2'));

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
