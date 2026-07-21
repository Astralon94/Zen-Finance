// Test dell'abbinamento in fase di import estratto conto (funzioni pure di domain/importmatch.js).
// Si lancia con `node tests/importmatch.test.mjs`.

import { matchBankRow, planBankImport } from '../src/domain/importmatch.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

let seq = 0;
const tx = o => Object.assign({ id: 't' + (++seq), accountId: 'A', type: 'expense', amount: 100, date: '2026-03-01' }, o);

// 1) match 1:1 con slittamento data entro finestra (banca 4 giorni dopo)
{
  const t = tx({ id: 'x1', amount: 100, date: '2026-03-01', sepaFileId: 'F1', sepaBooking: 'single' });
  const m = matchBankRow({ date: '2026-03-05', amount: -100, desc: 'BONIFICO' }, 'A', [t]);
  ok('1:1 entro finestra (data slittata)', m && m.kind === 'single' && m.tx.id === 'x1');
}

// 2) nessun match fuori finestra (>7 giorni)
{
  const t = tx({ id: 'x2', amount: 100, date: '2026-03-01' });
  ok('nessun match fuori finestra', matchBankRow({ date: '2026-03-20', amount: -100, desc: 'X' }, 'A', [t]) === null);
}

// 3) nessun match con importo diverso, conto diverso o segno diverso
{
  ok('nessun match importo diverso', matchBankRow({ date: '2026-03-02', amount: -100.5, desc: 'X' }, 'A', [tx({ amount: 100 })]) === null);
  ok('nessun match conto diverso', matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', [tx({ accountId: 'B' })]) === null);
  ok('nessun match segno diverso', matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', [tx({ type: 'income' })]) === null);
}

// 4) match di lotto sulla somma (addebito unico cumulativo)
{
  const g = [
    tx({ id: 'b1', amount: 60, date: '2026-03-01', sepaFileId: 'FB', sepaBooking: 'batch' }),
    tx({ id: 'b2', amount: 40, date: '2026-03-01', sepaFileId: 'FB', sepaBooking: 'batch' }),
  ];
  const m = matchBankRow({ date: '2026-03-03', amount: -100, desc: 'ADDEBITO CUMULATIVO' }, 'A', g);
  ok('lotto: 60+40 assorbe l\'intero gruppo', m && m.kind === 'batch' && m.group.length === 2);
  // un lotto 'single' NON deve essere assorbito come somma
  const gs = [tx({ id: 's1', amount: 60, sepaFileId: 'FS', sepaBooking: 'single' }), tx({ id: 's2', amount: 40, sepaFileId: 'FS', sepaBooking: 'single' })];
  ok('lotto: booking single non somma', matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', gs) === null);
}

// 5) movimenti già importati (impHash) mai matchati
{
  const t = tx({ id: 'x5', amount: 100, date: '2026-03-01', impHash: 'k', imported: true, sepaFileId: 'F', sepaBooking: 'single' });
  ok('impHash mai matchato', matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', [t]) === null);
}

// 6) priorità: preferisce il movimento SEPA/riconciliato a uno libero anche se meno vicino di data
{
  const free = tx({ id: 'free', amount: 100, date: '2026-03-01' });               // dd = 0
  const sepa = tx({ id: 'sepa', amount: 100, date: '2026-03-02', sepaFileId: 'F', sepaBooking: 'single' }); // dd = 1
  const m = matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', [free, sepa]);
  ok('priorità al movimento SEPA', m && m.tx.id === 'sepa');
  // isReconciled promuove un movimento libero
  const r = matchBankRow({ date: '2026-03-01', amount: -100, desc: 'X' }, 'A', [tx({ id: 'plain', date: '2026-03-03' }), tx({ id: 'rec', date: '2026-03-04' })], { isReconciled: id => id === 'rec' });
  ok('priorità al movimento riconciliato', r && r.tx.id === 'rec');
}

// 7) chiave di gruppo condivisa → re-import scartato come duplicato
{
  const g = [
    tx({ id: 'c1', amount: 60, date: '2026-03-01', sepaFileId: 'FC', sepaBooking: 'batch' }),
    tx({ id: 'c2', amount: 40, date: '2026-03-01', sepaFileId: 'FC', sepaBooking: 'batch' }),
  ];
  const rows = [{ date: '2026-03-03', amount: -100, desc: 'ADDEBITO CUMULATIVO' }];
  const plan1 = planBankImport(rows, 'A', g, {});
  ok('plan: 1 riga abbinata (lotto), 0 nuovi', plan1.matched === 1 && plan1.added === 0);
  const key = plan1.entries[0].key;
  // simula l'assorbimento: i membri del gruppo prendono la STESSA chiave (impHash)
  g.forEach(t => { t.impHash = key; t.imported = true; });
  const plan2 = planBankImport(rows, 'A', g, { existingKeys: new Set([key]) });
  ok('re-import: riga scartata come duplicato', plan2.skipped === 1 && plan2.matched === 0 && plan2.added === 0);
}

// 8) un movimento non è assorbito da due righe diverse (Set used)
{
  const g = [tx({ id: 'u1', amount: 50, date: '2026-03-01' })];
  const rows = [
    { date: '2026-03-01', amount: -50, desc: 'A' },
    { date: '2026-03-02', amount: -50, desc: 'B' },
  ];
  const plan = planBankImport(rows, 'A', g, {});
  ok('un solo movimento assorbito, l\'altra riga è nuova', plan.matched === 1 && plan.added === 1);
}

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
