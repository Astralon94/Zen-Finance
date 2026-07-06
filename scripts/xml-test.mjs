// Test lazy-load XML: l'xml non è nel boot, si recupera on-demand, sopravvive agli edit,
// si cancella con la fattura. Gira su DB in memoria.
process.env.ZEN_DB = ':memory:';
import assert from 'node:assert/strict';
const { importData, exportData, applyChanges, getInvoiceXml } = await import('../server/serialize.js');

const XML = '<FatturaElettronica>contenuto pesante</FatturaElettronica>';
importData({
  version: 2, rev: 1, settings: {},
  companies: [{ id: 'co1', name: 'ACME' }],
  accounts: [], categories: [], suppliers: [], rules: [],
  transactions: [{ id: 't1', companyId: 'co1', type: 'expense', amount: 10 }],
  invoices: [{ id: 'i1', companyId: 'co1', number: '5', total: 122, source: 'xml', xml: XML, payments: [{ id: 'p1', amount: 50 }] }],
  scheduled: [], loans: [], log: [],
});

// 1) Il BOOT (exportData light) NON contiene l'xml.
const light = exportData();
assert.equal(light.invoices[0].xml, undefined, 'boot: la fattura NON deve contenere xml');
assert.equal(light.invoices[0].number, '5', 'ma i campi normali ci sono');
assert.equal(light.invoices[0].payments.length, 1, 'e i figli (payments) pure');
console.log('✓ boot leggero: nessun xml nel payload');

// 2) L'export completo (?full) e il lazy-get riportano l'xml.
assert.equal(exportData({ includeXml: true }).invoices[0].xml, XML, 'export full: xml presente');
assert.equal(getInvoiceXml('i1'), XML, 'lazy-get: xml corretto');
assert.equal(getInvoiceXml('inesistente'), null, 'lazy-get inesistente → null');
console.log('✓ export completo + lazy-get dell\'xml');

// 3) Un edit della fattura SENZA xml (come farebbe il client dopo il boot) NON cancella l'xml.
applyChanges({ collections: { invoices: { upsert: [{ id: 'i1', companyId: 'co1', number: '5', total: 200, source: 'xml', payments: [] }] } } });
assert.equal(getInvoiceXml('i1'), XML, 'edit senza xml: l\'xml resta');
assert.equal(exportData().invoices[0].total, 200, 'ma la modifica (total) è applicata');
console.log('✓ edit senza xml preserva l\'xml');

// 4) Un edit CON nuovo xml lo aggiorna.
applyChanges({ collections: { invoices: { upsert: [{ id: 'i1', companyId: 'co1', number: '5', source: 'xml', xml: '<nuovo/>', payments: [] }] } } });
assert.equal(getInvoiceXml('i1'), '<nuovo/>', 'edit con xml: aggiornato');
console.log('✓ edit con nuovo xml aggiorna');

// 5) Rimuovere la fattura cancella anche l'xml (niente orfani).
applyChanges({ collections: { invoices: { remove: ['i1'] } } });
assert.equal(getInvoiceXml('i1'), null, 'rimozione: xml cancellato');
console.log('✓ rimozione fattura → xml cancellato');

console.log('\nLAZY-XML — TUTTI I TEST PASSATI ✅');
