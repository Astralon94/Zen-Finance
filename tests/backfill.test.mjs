// Test del backfill una tantum: riallinea i movimenti già abbinati (rate/scadenze/fatture),
// è idempotente e reversibile (prev catturato). Si lancia con `node tests/backfill.test.mjs`.

import { data } from '../src/state/store.js';
import { backfillMatchNames } from '../src/domain/backfill.js';
import { unpayInst } from '../src/domain/loans.js';
import { reopenScheduled } from '../src/domain/scheduled.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

// Stato che simula abbinamenti "vecchi" (senza loanPrev/schedPrev/invPrev)
data.loans.length = 0; data.scheduled.length = 0; data.invoices.length = 0; data.transactions.length = 0;

// rata pagata abbinata a un movimento esistente
const loan = { id: 'L', companyId: 'co1', name: 'Mutuo', categoryId: 'c-aff', installments: [{ id: 'r1', n: 2, amount: 500, status: 'paid', txId: 'TL', date: '2026-02-01', paidDate: '2026-02-01' }] };
const txL = { id: 'TL', companyId: 'co1', type: 'expense', amount: 500, accountId: 'acc1', desc: 'RID BANCA', note: 'vecchio nome', categoryId: 'c-ban', loanId: 'L', instId: 'r1' };
// scadenza completata abbinata
const sch = { id: 'S', companyId: 'co1', kind: 'debit', amount: 300, description: 'Affitto', categoryId: 'c-aff', status: 'done', txId: 'TS', doneDate: '2026-02-01' };
const txS = { id: 'TS', companyId: 'co1', type: 'expense', amount: 300, accountId: 'acc1', desc: 'SDD', note: 'altro nome', categoryId: 'c-ban', scheduledId: 'S' };
// fattura abbinata (pagamento linked)
const inv = { id: 'I', companyId: 'co1', supplierName: 'ACME', number: '9', date: '2026-03-03', total: 200, payments: [{ id: 'p1', amount: 200, txId: 'TI', linked: true }] };
const txI = { id: 'TI', companyId: 'co1', type: 'expense', amount: 200, accountId: 'acc1', desc: 'BONIFICO', note: 'mio nome', categoryId: 'c-ban' };
data.loans.push(loan); data.scheduled.push(sch); data.invoices.push(inv);
data.transactions.push(txL, txS, txI);

const n1 = backfillMatchNames();
ok('riallinea 3 movimenti', n1 === 3);
ok('rata: movimento rinominato e ricategorizzato', txL.note === 'Mutuo · rata 2' && txL.categoryId === 'c-aff');
ok('scadenza: movimento rinominato e ricategorizzato', txS.note === 'Affitto' && txS.categoryId === 'c-aff');
ok('fattura: movimento rinominato (solo nome)', txI.note === 'ACME · Fatt. 9 · 03/03/2026' && txI.categoryId === 'c-ban');
ok('descrizioni bancarie grezze intatte', txL.desc === 'RID BANCA' && txS.desc === 'SDD' && txI.desc === 'BONIFICO');

// idempotente: una seconda esecuzione non cambia nulla
ok('idempotente: seconda esecuzione non conta nulla', backfillMatchNames() === 0);

// reversibile: riaprendo l'elemento il nome torna quello pre-backfill
unpayInst(loan.installments[0]);
ok('reversibile (rata): nome ripristinato a quello pre-backfill', txL.note === 'vecchio nome' && txL.categoryId === 'c-ban');
reopenScheduled(sch);
ok('reversibile (scadenza): nome ripristinato', txS.note === 'altro nome' && txS.categoryId === 'c-ban');

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
