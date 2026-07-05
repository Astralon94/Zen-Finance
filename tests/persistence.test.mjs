// Test di persistenza: i nuovi campi sopravvivono al round-trip salva/carica (leanData + migrate),
// e i backup vecchi senza i nuovi campi non causano errori. Si lancia con `node tests/persistence.test.mjs`.

import { leanData } from '../src/state/store.js';
import { migrate } from '../src/state/model.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

// stato "ricco" con tutti i campi nuovi
const rich = {
  version: 2, rev: 7, savedAt: Date.now(),
  settings: { theme: 'auto' },
  companies: [{ id: 'co1', name: 'A' }],
  accounts: [
    { id: 'bank', companyId: 'co1', name: 'Banca', kind: 'standard', initial: 100, fido: 50 },
    { id: 'card', companyId: 'co1', name: 'Carta', kind: 'credit', linkedAccountId: 'bank', initial: 0 },
    { id: 'cash', companyId: 'co1', name: 'Contanti', kind: 'cash', initial: 0 }
  ],
  categories: [{ id: 'c-for', name: 'Forn', type: 'expense' }],
  suppliers: [], rules: [], scheduled: [],
  loans: [{ id: 'l1', companyId: 'co1', paymentMethod: 'Bonifico', installments: [] }],
  invoices: [{ id: 'i1', companyId: 'co1', number: '1', total: 100, payments: [], xml: '<FatturaElettronica>...grezzo...</FatturaElettronica>' }],
  log: [{ id: 'e1', at: 1234, companyId: 'co1', type: 'payment', label: 'X', amount: 10 }],
  transactions: [
    { id: 't1', companyId: 'co1', type: 'transfer', amount: 30, accountId: 'bank', toAccountId: 'card', cardSettle: 'card' },
    { id: 't2', companyId: 'co1', type: 'expense', amount: 5, accountId: 'bank', loanId: 'l1', instId: 'r1', fromLoan: true }
  ]
};

// --- leanData: strippa SOLO l'XML, conserva tutto il resto ---
const lean = leanData(rich);
ok('leanData rimuove l\'XML della fattura', lean.invoices[0].xml === undefined);
ok('leanData conserva i meta-fattura', lean.invoices[0].total === 100 && lean.invoices[0].number === '1');
ok('leanData conserva il log', Array.isArray(lean.log) && lean.log.length === 1);
ok('leanData conserva kind e linkedAccountId dei conti', lean.accounts[1].kind === 'credit' && lean.accounts[1].linkedAccountId === 'bank');
ok('leanData conserva i campi transazione nuovi', lean.transactions[0].cardSettle === 'card' && lean.transactions[1].fromLoan === true && lean.transactions[1].loanId === 'l1');
ok('leanData conserva paymentMethod del finanziamento', lean.loans[0].paymentMethod === 'Bonifico');

// --- round-trip JSON + migrate (come al boot da localStorage/vault) ---
const round = migrate(JSON.parse(JSON.stringify(lean)));
ok('round-trip: log integro', round.log.length === 1 && round.log[0].type === 'payment');
ok('round-trip: tipo conto integro', round.accounts[2].kind === 'cash');
ok('round-trip: rev preservato', round.rev === 7);
ok('round-trip: attachments normalizzato a [] sui loan senza il campo', Array.isArray(round.loans[0].attachments));

// --- backup VECCHIO senza i nuovi campi: migrate non rompe e applica i default ---
const old = {
  companies: [{ id: 'co1', name: 'A' }],
  accounts: [{ id: 'acc1', companyId: 'co1', name: 'Conto' }], // niente kind
  invoices: [{ id: 'i1', companyId: 'co1', total: 50 }],        // niente payments
  transactions: []
  // niente log, niente loans, niente scheduled
};
const mig = migrate(JSON.parse(JSON.stringify(old)));
ok('backup vecchio: log assente → diventa []', Array.isArray(mig.log) && mig.log.length === 0);
ok('backup vecchio: loans/scheduled assenti → []', Array.isArray(mig.loans) && Array.isArray(mig.scheduled));
ok('backup vecchio: invoice.payments ripristinato', Array.isArray(mig.invoices[0].payments));
ok('backup vecchio: conto senza kind resta valido', mig.accounts[0].id === 'acc1');

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
