// Test di persistenza: i campi dei record sopravvivono al round-trip JSON + migrate()
// (come al boot da /api/data o all'import di un backup), e i backup vecchi senza i
// campi nuovi non causano errori. Si lancia con `node tests/persistence.test.mjs`.
// Nota storica: il vecchio test verificava anche leanData() (strip dell'XML prima del
// salvataggio su localStorage/vault); quel meccanismo non esiste più — oggi lo stato
// "leggero" senza XML lo produce il server (GET /api/data), quindi qui resta solo la
// parte ancora viva: migrate() e la retro-compatibilità dei backup.

import { migrate } from '../src/state/model.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

// stato "ricco" con i campi delle varie generazioni (inclusi quelli per l'export SEPA)
const rich = {
  version: 2, rev: 7, savedAt: Date.now(),
  settings: { theme: 'auto' },
  companies: [{ id: 'co1', name: 'A', cuc: 'ABCD1234' }],
  accounts: [
    { id: 'bank', companyId: 'co1', name: 'Banca', kind: 'standard', initial: 100, fido: 50, iban: 'IT60X0542811101000000123456' },
    { id: 'card', companyId: 'co1', name: 'Carta', kind: 'credit', linkedAccountId: 'bank', initial: 0 },
    { id: 'cash', companyId: 'co1', name: 'Contanti', kind: 'cash', initial: 0 }
  ],
  categories: [{ id: 'c-for', name: 'Forn', type: 'expense' }],
  suppliers: [{ id: 's1', type: 'supplier', name: 'Forn Uno', iban: 'IT60X0542811101000000123456' }],
  rules: [], scheduled: [],
  loans: [{ id: 'l1', companyId: 'co1', paymentMethod: 'Bonifico', installments: [] }],
  invoices: [{ id: 'i1', companyId: 'co1', number: '1', total: 100, payments: [], toPay: true }],
  log: [{ id: 'e1', at: 1234, companyId: 'co1', type: 'payment', label: 'X', amount: 10 }],
  transactions: [
    { id: 't1', companyId: 'co1', type: 'transfer', amount: 30, accountId: 'bank', toAccountId: 'card', cardSettle: 'card' },
    { id: 't2', companyId: 'co1', type: 'expense', amount: 5, accountId: 'bank', loanId: 'l1', instId: 'r1', fromLoan: true }
  ]
};

// --- round-trip JSON + migrate (come al boot da /api/data o import backup) ---
const round = migrate(JSON.parse(JSON.stringify(rich)));
ok('round-trip: log integro', round.log.length === 1 && round.log[0].type === 'payment');
ok('round-trip: tipo conto integro', round.accounts[2].kind === 'cash');
ok('round-trip: rev preservato', round.rev === 7);
ok('round-trip: kind e linkedAccountId dei conti', round.accounts[1].kind === 'credit' && round.accounts[1].linkedAccountId === 'bank');
ok('round-trip: campi transazione', round.transactions[0].cardSettle === 'card' && round.transactions[1].fromLoan === true && round.transactions[1].loanId === 'l1');
ok('round-trip: paymentMethod del finanziamento', round.loans[0].paymentMethod === 'Bonifico');
ok('round-trip: iban del conto (export SEPA)', round.accounts[0].iban === 'IT60X0542811101000000123456');
ok('round-trip: cuc azienda (export SEPA)', round.companies[0].cuc === 'ABCD1234');
ok('round-trip: iban fornitore', round.suppliers[0].iban === 'IT60X0542811101000000123456');
ok('round-trip: flag toPay della fattura', round.invoices[0].toPay === true);
ok('round-trip: attachments normalizzato a [] sui loan senza il campo', Array.isArray(round.loans[0].attachments));

// --- backup VECCHIO senza i nuovi campi: migrate non rompe e applica i default ---
const old = {
  companies: [{ id: 'co1', name: 'A' }],
  accounts: [{ id: 'acc1', companyId: 'co1', name: 'Conto' }], // niente kind
  invoices: [{ id: 'i1', companyId: 'co1', total: 50 }],        // niente payments
  transactions: []
  // niente log, niente loans, niente scheduled, niente suppliers
};
const mig = migrate(JSON.parse(JSON.stringify(old)));
ok('backup vecchio: log assente → diventa []', Array.isArray(mig.log) && mig.log.length === 0);
ok('backup vecchio: loans/scheduled assenti → []', Array.isArray(mig.loans) && Array.isArray(mig.scheduled));
ok('backup vecchio: invoice.payments ripristinato', Array.isArray(mig.invoices[0].payments));
ok('backup vecchio: conto senza kind resta valido', mig.accounts[0].id === 'acc1');

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
