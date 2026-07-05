// Test abbinamento programmato ↔ movimento: nome e categoria della scadenza vincono, ripristino alla riapertura.
// Si lancia con `node tests/scheduled.test.mjs`.

import { data } from '../src/state/store.js';
import {
  completeWithTx, reopenScheduled, completeWithMovement, completeMarkOnly,
  advanceDate, candidates, hasAmount
} from '../src/domain/scheduled.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

data.scheduled.length = 0; data.transactions.length = 0;
const s = { id: 'S', companyId: 'co1', kind: 'debit', amount: 300, description: 'Affitto negozio', categoryId: 'c-aff', status: 'pending', txId: null };
data.scheduled.push(s);
const tx = { id: 'TX', companyId: 'co1', type: 'expense', amount: 300, accountId: 'acc1', date: '2026-05-01', desc: 'ADDEBITO SDD', note: 'RID generico', categoryId: 'c-ban' };
data.transactions.push(tx);

completeWithTx(s, tx);
ok('programmato abbinato: il movimento prende il nome della scadenza', tx.note === 'Affitto negozio');
ok('programmato abbinato: prende la categoria della scadenza', tx.categoryId === 'c-aff');
ok('programmato abbinato: la descrizione bancaria grezza resta intatta', tx.desc === 'ADDEBITO SDD');
ok('programmato abbinato: scadenza completata e collegata', s.status === 'done' && tx.scheduledId === 'S');

reopenScheduled(s);
ok('riapertura: ripristina nome e categoria originali del movimento', tx.note === 'RID generico' && tx.categoryId === 'c-ban');
ok('riapertura: movimento scollegato senza eliminarlo', !tx.scheduledId && data.transactions.some(t => t.id === 'TX'));

// ===== Ricorrenza e voci senza importo =====
const resetS = () => { data.scheduled.length = 0; data.transactions.length = 0; };

// advanceDate: settimane, mesi e clamp a fine mese
ok('advanceDate settimanale', advanceDate('2026-01-10', 'weekly') === '2026-01-17');
ok('advanceDate bisettimanale', advanceDate('2026-01-10', 'biweekly') === '2026-01-24');
ok('advanceDate mensile', advanceDate('2026-01-15', 'monthly') === '2026-02-15');
ok('advanceDate mensile clamp fine mese', advanceDate('2026-01-31', 'monthly') === '2026-02-28');
ok('advanceDate trimestrale clamp', advanceDate('2026-11-30', 'quarterly') === '2027-02-28');

// completamento ricorrente → nasce la prossima occorrenza; reopen la rimuove
resetS();
const r = { id: 'R', companyId: 'co1', kind: 'debit', amount: 200, description: 'Affitto', categoryId: 'c-aff', date: '2026-03-10', recurrence: 'monthly', status: 'pending', txId: null };
data.scheduled.push(r);
completeMarkOnly(r);
ok('ricorrente: completando nasce la prossima occorrenza', data.scheduled.length === 2);
const child = data.scheduled.find(x => x.id !== 'R');
ok('prossima occorrenza alla data avanzata e in attesa', child.date === '2026-04-10' && child.status === 'pending');
ok('prossima eredita importo/descrizione/ricorrenza', child.amount === 200 && child.description === 'Affitto' && child.recurrence === 'monthly');
ok('serie collegata via nextId', r.nextId === child.id);
reopenScheduled(r);
ok('riaprendo rimuove la prossima occorrenza non toccata', data.scheduled.length === 1 && data.scheduled[0].id === 'R');
ok('riapertura azzera nextId e stato', !r.nextId && r.status !== 'done');

// voce senza importo: hasAmount, completamento con importo override, prossima resta senza importo
resetS();
const a = { id: 'A', companyId: 'co1', kind: 'debit', amount: null, description: 'Bolletta', categoryId: 'c-ute', date: '2026-05-20', recurrence: 'monthly', status: 'pending', txId: null };
data.scheduled.push(a);
ok('voce senza importo: hasAmount = false', !hasAmount(a));
completeWithMovement(a, { date: '2026-05-21', accountId: 'acc1', amount: 88.5 });
const txA = data.transactions.find(t => t.scheduledId === 'A');
ok('completamento con importo override crea il movimento con quell\'importo', txA && txA.amount === 88.5);
ok('ricorrente senza importo: la prossima resta senza importo', data.scheduled.some(x => x.id !== 'A' && x.amount == null && x.recurrence === 'monthly'));

// candidati per voce senza importo: per tipo/data, senza filtro importo
resetS();
const c = { id: 'C', companyId: 'co1', kind: 'debit', amount: null, date: '2026-06-01', status: 'pending', txId: null };
data.scheduled.push(c);
data.transactions.push(
  { id: 'M1', companyId: 'co1', type: 'expense', amount: 123.45, date: '2026-06-02' },
  { id: 'M2', companyId: 'co1', type: 'income', amount: 50, date: '2026-06-02' }
);
const cc = candidates(c).map(t => t.id);
ok('candidati senza importo: include uscite per tipo/data (no filtro importo)', cc.includes('M1'));
ok('candidati senza importo: esclude il tipo errato', !cc.includes('M2'));

// non ricorrente: nessuna nuova occorrenza
resetS();
const n = { id: 'N', companyId: 'co1', kind: 'debit', amount: 10, date: '2026-07-01', status: 'pending', txId: null };
data.scheduled.push(n);
completeMarkOnly(n);
ok('non ricorrente: nessuna nuova occorrenza', data.scheduled.length === 1);

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
