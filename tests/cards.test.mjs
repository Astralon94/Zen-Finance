// Test su tipi di conto (liquidità/P&L) e saldo carta di credito con elasticità.
// Si lancia con `node tests/cards.test.mjs`.

import { data } from '../src/state/store.js';
import { balanceOf, cashOf, cardDebtOf, pnl, txsInScope } from '../src/domain/finance.js';
import { settleCard, cardDebt } from '../src/domain/cards.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

function reset() {
  data.accounts.length = 0; data.transactions.length = 0;
  data.accounts.push({ id: 'bank', companyId: 'co1', name: 'Banca', kind: 'standard', initial: 1000, fido: 0 });
  data.accounts.push({ id: 'card', companyId: 'co1', name: 'Carta', kind: 'credit', initial: 0, linkedAccountId: 'bank' });
  data.accounts.push({ id: 'cash', companyId: 'co1', name: 'Contanti', kind: 'cash', initial: 0 });
}
const spend = (acctId, amount) => data.transactions.push({ id: 'x' + Math.random(), companyId: 'co1', type: 'expense', amount, accountId: acctId, categoryId: 'c-for', date: '2026-01-10' });

// --- liquidità e P&L per tipo di conto ---
reset();
spend('card', 200);   // spesa su carta
spend('cash', 50);    // spesa in contanti
ok('liquidità = solo conti bancari (carta e contanti esclusi)', near(cashOf('co1'), 1000));
ok('debito carta tracciato a parte', near(cardDebtOf('co1'), 200));
ok('saldo carta negativo', near(balanceOf('card'), -200));
ok('spese carta e contanti contano nel P&L', near(pnl(txsInScope('co1')).cost, 250));

// --- saldo carta: addebito = debito (caso pulito) ---
reset();
spend('card', 300);
let r = settleCard(data.accounts[1], { amount: 300, fromAccountId: 'bank', date: '2026-02-01' });
ok('addebito = debito: nessun interesse, nessun residuo', r.ok && near(r.interest, 0) && near(r.residual, 0));
ok('carta azzerata', near(balanceOf('card'), 0));
ok('banca ridotta dell\'addebito', near(balanceOf('bank'), 700));
ok('liquidità riflette l\'uscita', near(cashOf('co1'), 700));

// --- elasticità: addebito > debito → differenza a interessi (costo) ---
reset();
spend('card', 300);
r = settleCard(data.accounts[1], { amount: 312.50, fromAccountId: 'bank', date: '2026-02-01' });
ok('addebito > debito: differenza registrata come interessi', r.ok && near(r.interest, 12.50));
ok('carta azzerata anche con interessi', near(balanceOf('card'), 0));
ok('banca ridotta dell\'addebito reale', near(balanceOf('bank'), 1000 - 312.50));
ok('interessi entrano nel P&L', near(pnl(txsInScope('co1')).cost, 300 + 12.50));

// --- elasticità: addebito < debito → debito residuo rotativo ---
reset();
spend('card', 300);
r = settleCard(data.accounts[1], { amount: 200, fromAccountId: 'bank', date: '2026-02-01' });
ok('addebito < debito: resta il residuo', r.ok && near(r.residual, 100) && near(r.interest, 0));
ok('carta mantiene il debito residuo', near(balanceOf('card'), -100));
ok('banca ridotta solo del pagato', near(balanceOf('bank'), 800));

// --- abbina movimento esistente (riconciliazione, niente doppione) ---
reset();
spend('card', 300);
spend('bank', 305);                         // addebito già importato sul conto
const bankTx = data.transactions[data.transactions.length - 1];
const before = data.transactions.length;
r = settleCard(data.accounts[1], { existingTx: bankTx, amount: 305, fromAccountId: 'bank' });
ok('abbina: il movimento bancario diventa il trasferimento (no doppione di trasferimento)', bankTx.type === 'transfer' && bankTx.toAccountId === 'card');
ok('abbina: aggiunge solo l\'eventuale costo interessi', data.transactions.length === before + 1);
ok('abbina: carta azzerata', near(balanceOf('card'), 0));
ok('abbina: banca ridotta di 305 totali', near(balanceOf('bank'), 695));

// --- una carta esclusa non conta nel debito carte ---
reset();
spend('card', 100);
data.accounts.find(a => a.id === 'card').excluded = true;
ok('carta esclusa: fuori dal debito carte', near(cardDebtOf('co1'), 0));

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
