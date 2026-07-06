// Test dello step 2: scritture granulari (applyChanges) + allegati BLOB.
// Gira su DB in memoria per non toccare il file reale.
process.env.ZEN_DB = ':memory:';
import assert from 'node:assert/strict';
const { importData, exportData, applyChanges, counts } = await import('../server/serialize.js');
const { putAttachment, getAttachment, deleteAttachment } = await import('../server/attachments.js');

// Base: 2 transazioni + 1 loan.
importData({
  version: 2, rev: 1, settings: { theme: 'auto', activeCompany: 'co1' },
  companies: [{ id: 'co1', name: 'ACME' }],
  accounts: [{ id: 'acc1', companyId: 'co1', name: 'CC', initial: 0 }],
  categories: [], suppliers: [], rules: [],
  transactions: [
    { id: 't1', companyId: 'co1', type: 'expense', amount: 10, date: '2026-01-01' },
    { id: 't2', companyId: 'co1', type: 'expense', amount: 20, date: '2026-01-02' },
  ],
  invoices: [], scheduled: [],
  loans: [{ id: 'l1', companyId: 'co1', name: 'Mutuo', installments: [], attachments: [] }],
  log: [],
});
const rev0 = exportData().rev;

// 1) CHANGESET: modifica t1, aggiunge t3, rimuove t2. t1 aggiornata, t2 sparita, t3 nuova.
applyChanges({
  collections: {
    transactions: {
      upsert: [
        { id: 't1', companyId: 'co1', type: 'expense', amount: 99, date: '2026-01-01', note: 'modificata' },
        { id: 't3', companyId: 'co1', type: 'income', amount: 50, date: '2026-01-03' },
      ],
      remove: ['t2'],
    },
  },
});
const d1 = exportData();
const tx = Object.fromEntries(d1.transactions.map((t) => [t.id, t]));
assert.equal(d1.transactions.length, 2, 't2 rimossa, t3 aggiunta → 2 transazioni');
assert.equal(tx.t1.amount, 99, 't1 aggiornata');
assert.equal(tx.t1.note, 'modificata');
assert.ok(!tx.t2, 't2 rimossa');
assert.equal(tx.t3.amount, 50, 't3 nuova');
assert.equal(d1.rev, rev0 + 1, 'rev incrementato di 1');
assert.equal(d1.loans.length, 1, 'i loan NON toccati dal changeset transactions');
console.log('✓ changeset granulare (upsert/remove) corretto');

// 2) SETTINGS via changeset.
applyChanges({ settings: { theme: 'dark', activeCompany: 'co1' }, collections: {} });
assert.equal(exportData().settings.theme, 'dark', 'settings aggiornate dal changeset');
console.log('✓ changeset settings');

// 3) ALLEGATI BLOB: put → get (byte identici) → sopravvive a un update del loan → delete.
const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x01, 0x02, 0x03, 0xff, 0x00]); // "%PDF-..." + binari
const meta = putAttachment('contratto.pdf', 'application/pdf', bytes);
assert.ok(meta.id, 'id allegato generato');
assert.equal(meta.size, bytes.length, 'size corretta');
const got = getAttachment(meta.id);
assert.deepEqual(Buffer.from(got.bin), bytes, 'byte del BLOB identici');
assert.equal(got.name, 'contratto.pdf');

// aggiorno il loan (referenziando l'allegato nei metadati) → il BINARIO non deve sparire
applyChanges({
  collections: { loans: { upsert: [{ id: 'l1', companyId: 'co1', name: 'Mutuo v2', installments: [], attachments: [meta] }] } },
});
const still = getAttachment(meta.id);
assert.deepEqual(Buffer.from(still.bin), bytes, 'il BLOB sopravvive all\'update del loan');
const loanBack = exportData().loans[0];
assert.equal(loanBack.name, 'Mutuo v2', 'loan aggiornato');
assert.equal(loanBack.attachments[0].id, meta.id, 'metadati allegato nel doc del loan (round-trip)');
console.log('✓ allegato BLOB: put/get, byte identici, sopravvive agli update del loan');

assert.equal(deleteAttachment(meta.id), true, 'delete ok');
assert.equal(getAttachment(meta.id), null, 'dopo delete non esiste più');
console.log('✓ delete allegato');

console.log('\nSTEP 2 — TUTTI I TEST PASSATI ✅  ' + JSON.stringify(counts()));
