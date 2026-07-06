// Test d'integrità: import → export deve restituire ESATTAMENTE i dati (lossless),
// con `rev` monotòno. Gira su DB in memoria per non toccare il file reale.
process.env.ZEN_DB = ':memory:';
import assert from 'node:assert/strict';
const { importData, exportData } = await import('../server/serialize.js');

// Dataset ricco: copre campi "scomodi" (linkPrev oggetto, xml grezzo, flag booleani,
// figli payments/installments/attachments, numeri decimali, null espliciti).
const sample = {
  version: 2, rev: 5, savedAt: 123,
  settings: { theme: 'dark', currency: 'EUR', activeCompany: 'co1' },
  companies: [{ id: 'co1', name: 'ACME', emoji: '🏢', color: '#545ea6', piva: '123', note: 'n' }],
  accounts: [{ id: 'acc1', companyId: 'co1', name: 'CC', emoji: '🏦', initial: 100.5, kind: 'standard', excluded: false, fido: 0 }],
  categories: [
    { id: 'c-ven', name: 'Vendite', emoji: '🧾', type: 'income' },
    { id: 'c-gou', name: 'Giroconti', emoji: '🔁', type: 'expense', neutral: true },
  ],
  suppliers: [{ id: 's1', name: 'Fornitore', type: 'supplier', piva: '999', cf: '', iban: '', email: '', note: '' }],
  rules: [{ id: 'r1', keyword: 'luce', enabled: true, appliesTo: 'expense', categoryId: 'c-ute', supplierId: null, displayName: 'Enel' }],
  transactions: [{
    id: 't1', companyId: 'co1', type: 'expense', amount: 50, categoryId: 'c-ute', accountId: 'acc1',
    toAccountId: null, supplierId: 's1', date: '2026-01-02', desc: 'RAW BANCA', note: 'Enel',
    mgmt: 'await', imported: true, impHash: 'h', reconIgnore: false, linkPrev: { note: null, categoryId: null },
  }],
  invoices: [{
    id: 'i1', companyId: 'co1', supplierId: 's1', supplierName: 'Fornitore', number: '12', date: '2026-01-01',
    due: '2026-02-01', net: 100, vat: 22, total: 122, withholding: 0, categoryId: 'c-for', source: 'xml',
    xml: '<FatturaElettronica/>', note: '', toPay: true, creditNote: false, createdAt: 111,
    payments: [{ id: 'p1', amount: 50, date: '2026-01-15', accountId: 'acc1', txId: 't1', note: 'acconto' }],
  }],
  scheduled: [{
    id: 'sc1', companyId: 'co1', kind: 'debit', manual: true, amount: 30, date: '2026-03-01', description: 'F24',
    accountId: 'acc1', categoryId: 'c-tax', supplierId: null, status: 'pending', doneDate: null, txId: null, createdAt: 222,
  }],
  loans: [{
    id: 'l1', companyId: 'co1', accountId: 'acc1', name: 'Mutuo', type: 'loan', lender: 'Banca', totalDebt: 1000,
    startDate: '2026-01-01', endDate: '2027-01-01', categoryId: 'c-ban', notes: '', paymentMethod: 'RID',
    variableRate: false, createdAt: 333,
    installments: [{ id: 'in1', n: 1, date: '2026-02-01', amount: 100, status: 'pending', paidDate: null, txId: null }],
    attachments: [{ id: 'a1', name: 'contratto.pdf', size: 1024, type: 'application/pdf', addedAt: 444, file: 'a1__contratto.pdf' }],
  }],
  log: [{ id: 'lg1', at: 555, companyId: 'co1', type: 'invoice', label: 'Fattura pagata', amount: 10, account: 'CC' }],
};

const dropMeta = (o) => { const { rev, savedAt, version, ...rest } = o; return rest; };

importData(structuredClone(sample));
// Il BOOT (export leggero) NON contiene l'xml delle fatture (lazy-load).
assert.equal(exportData().invoices[0].xml, undefined, 'export leggero: nessun xml nel boot');
// La losslessness completa si verifica sull'export full (?full=1), che riaggancia l'xml.
const out1 = exportData({ includeXml: true });
assert.equal(out1.rev, 6, 'rev deve diventare max(5,0)+1 = 6');
assert.deepEqual(dropMeta(out1), dropMeta(sample), 'export full deve coincidere col sample (lossless)');
console.log('✓ round-trip lossless (boot leggero, full completo)');

importData(structuredClone(sample));
assert.equal(exportData().rev, 7, 'secondo import: rev max(5,6)+1 = 7 (monotòno)');
console.log('✓ rev monotòno');

// import di struttura invalida deve essere RIFIUTATO senza toccare i dati.
let rejected = false;
try { importData({ foo: 'bar' }); } catch { rejected = true; }
assert.ok(rejected, 'struttura invalida deve essere rifiutata');
assert.equal(exportData().rev, 7, 'dopo un import rifiutato i dati restano intatti');
console.log('✓ import invalido rifiutato, dati intatti');

console.log('\nTUTTI I TEST PASSATI ✅');
