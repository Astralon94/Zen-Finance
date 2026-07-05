// Test sullo storico eventi fatture (append-only, cap 50) e sull'aggancio alle azioni.
// Si lancia con `node tests/auditlog.test.mjs`.

import { data } from '../src/state/store.js';
import { logEvent, recentEvents, LOG_CAP } from '../src/domain/auditlog.js';
import { addPayment, removePayment, deleteInvoice } from '../src/domain/invoices.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };
const reset = () => { data.invoices.length = 0; data.transactions.length = 0; data.log.length = 0; };

// 1. cap a LOG_CAP: i più vecchi vengono scartati
reset();
for (let k = 0; k < LOG_CAP + 15; k++) logEvent('payment', { companyId: 'co1', label: 'F' + k, amount: k });
ok(`il log non supera ${LOG_CAP} eventi`, data.log.length === LOG_CAP);
ok('vengono conservati i più recenti', recentEvents()[0].label === 'F' + (LOG_CAP + 14));
ok('recentEvents rispetta un limite esplicito (per l\'export)', recentEvents(null, 25).length === 25);

// 2. ordine cronologico decrescente
reset();
logEvent('payment', { companyId: 'co1', label: 'A', amount: 1 });
data.log[data.log.length - 1].at -= 10000; // forza A più vecchio
logEvent('reconcile', { companyId: 'co1', label: 'B', amount: 2 });
ok('recentEvents ordina dal più recente', recentEvents().map(e => e.label).join(',') === 'B,A');

// 3. filtro per azienda
reset();
logEvent('payment', { companyId: 'co1', label: 'X' });
logEvent('payment', { companyId: 'co2', label: 'Y' });
ok('filtro per azienda', recentEvents('co1').length === 1 && recentEvents('co1')[0].label === 'X');
ok('senza scope ritorna tutto', recentEvents(null).length === 2);

// 4. integrazione: un pagamento registra un evento; rimuoverlo ne registra un altro
reset();
const inv = { id: 'i1', companyId: 'co1', supplierId: null, supplierName: 'ACME', number: '7', date: '2026-01-01', due: '2026-02-01', total: 100, withholding: 0, payments: [] };
data.invoices.push(inv);
const p = addPayment(inv, { amount: 40, date: '2026-01-10', accountId: 'acc1' });
ok('addPayment registra un evento payment', data.log.length === 1 && data.log[0].type === 'payment' && data.log[0].label.includes('ACME'));
removePayment(inv, p.id);
ok('removePayment registra un evento payment_removed', data.log.length === 2 && data.log[1].type === 'payment_removed');
deleteInvoice(inv);
ok('deleteInvoice registra un evento invoice_deleted', data.log[data.log.length - 1].type === 'invoice_deleted');

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
