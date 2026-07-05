// ============ Movimenti programmati (scadenziario) ============
// Un programmato è un movimento futuro previsto: addebito (debit) o accredito (credit),
// con una data. Può essere "manuale" (lo devi eseguire tu, es. affitto) o automatico (RID/accredito).
// Si completa creando il movimento reale, oppure abbinandolo a un movimento già presente
// (stile riconciliazione bancaria), oppure segnandolo solo come fatto.
import { data, save } from '../state/store.js';
import { round2, uid, todayStr, daysBetween, pad2, attachTxMeta, detachTxMeta } from './util.js';

export const schedInScope = scope => data.scheduled.filter(s => !scope || s.companyId === scope);
export const isPending = s => s.status !== 'done';
export const isOverdue = s => isPending(s) && !!s.date && s.date < todayStr();
export const txTypeFor = kind => (kind === 'credit' ? 'income' : 'expense');
// un programmato può non avere ancora un importo definito (promemoria): amount === null.
export const hasAmount = s => s.amount != null;

// ---- Ricorrenza (auto-avanza al completamento, indefinita) ----
export const RECURRENCES = {
  weekly:     { unit: 'week',  every: 1,  label: 'Ogni settimana' },
  biweekly:   { unit: 'week',  every: 2,  label: 'Ogni 2 settimane' },
  monthly:    { unit: 'month', every: 1,  label: 'Ogni mese' },
  bimonthly:  { unit: 'month', every: 2,  label: 'Ogni 2 mesi' },
  quarterly:  { unit: 'month', every: 3,  label: 'Ogni 3 mesi' },
  semiannual: { unit: 'month', every: 6,  label: 'Ogni 6 mesi' },
  annual:     { unit: 'month', every: 12, label: 'Ogni anno' }
};
export const recurLabel = key => RECURRENCES[key]?.label || '';
const isoDate = x => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
// data della prossima occorrenza. Per i mesi clampa al fine mese (es. 31 gen +1 mese → 28/29 feb).
export function advanceDate(date, key) {
  const r = RECURRENCES[key];
  if (!r || !date) return date;
  const [y, m, d] = date.split('-').map(Number);
  if (r.unit === 'week') return isoDate(new Date(y, m - 1, d + 7 * r.every));
  const first = new Date(y, (m - 1) + r.every, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, lastDay)));
}

// Genera la prossima occorrenza di una serie ricorrente (clone pulito alla data successiva).
// Registra il figlio in s.nextId così la riapertura può annullarlo. No-op se non ricorrente o senza data.
function spawnNext(s) {
  if (!s.recurrence || !RECURRENCES[s.recurrence] || !s.date) return null;
  const next = {
    id: uid(), status: 'pending', doneDate: null, txId: null, createdAt: Date.now(),
    companyId: s.companyId, kind: s.kind, amount: s.amount ?? null,
    date: advanceDate(s.date, s.recurrence), description: s.description || '',
    categoryId: s.categoryId || null, accountId: s.accountId || null, supplierId: s.supplierId || null,
    manual: !!s.manual, recurrence: s.recurrence, seriesId: s.seriesId || s.id
  };
  data.scheduled.push(next);
  s.nextId = next.id;
  return next;
}

export function addScheduled(rec) {
  const s = { id: uid(), status: 'pending', doneDate: null, txId: null, createdAt: Date.now(), ...rec };
  data.scheduled.push(s); save(); return s;
}
export function updateScheduled(s, rec) { Object.assign(s, rec); save(); }
export function deleteScheduled(s) { data.scheduled = data.scheduled.filter(x => x.id !== s.id); save(); }

// completa creando un movimento reale (per i manuali, o quando vuoi registrarlo).
// `amount` (opzionale) sovrascrive l'importo della scadenza: serve per le voci senza importo definito.
export function completeWithMovement(s, { date, accountId, amount } = {}) {
  date = date || s.date || todayStr();
  const amt = round2(amount != null ? amount : s.amount);
  const tx = {
    id: uid(), companyId: s.companyId, type: txTypeFor(s.kind), amount: amt,
    categoryId: s.categoryId || null, accountId: accountId || s.accountId || null, toAccountId: null,
    supplierId: s.supplierId || null, date, desc: null, note: s.description || '',
    scheduledId: s.id, fromSchedule: true, createdAt: Date.now()
  };
  data.transactions.push(tx);
  s.status = 'done'; s.doneDate = date; s.txId = tx.id;
  spawnNext(s);
  save(); return tx;
}

// completa abbinando un movimento già esistente (es. RID arrivato da estratto conto).
// Il movimento acquisisce nome e categoria della scadenza (schedPrev conserva gli originali
// per ripristinarli alla riapertura). La descrizione bancaria grezza resta intatta.
export function completeWithTx(s, tx) {
  attachTxMeta(tx, { note: s.description || undefined, categoryId: s.categoryId || undefined });
  s.status = 'done'; s.doneDate = tx.date || todayStr(); s.txId = tx.id;
  tx.scheduledId = s.id;
  spawnNext(s);
  save();
}

// segna completato senza alcun movimento (solo tracciamento)
export function completeMarkOnly(s) { s.status = 'done'; s.doneDate = todayStr(); s.txId = null; spawnNext(s); save(); }

// riapre un programmato; se aveva creato un movimento, lo rimuove; se aveva generato la prossima
// occorrenza ricorrente e questa è ancora intatta (in attesa, non toccata), la rimuove pure.
export function reopenScheduled(s) {
  if (s.txId) {
    const tx = data.transactions.find(t => t.id === s.txId);
    if (tx && tx.fromSchedule) data.transactions = data.transactions.filter(t => t.id !== s.txId);
    else if (tx) { delete tx.scheduledId; detachTxMeta(tx); } // abbinamento: scollega e ripristina nome/categoria
  }
  if (s.nextId) {
    const child = data.scheduled.find(x => x.id === s.nextId);
    if (child && child.status !== 'done' && !child.txId) data.scheduled = data.scheduled.filter(x => x.id !== s.nextId);
    delete s.nextId;
  }
  s.status = 'pending'; s.doneDate = null; s.txId = null; save();
}

// movimenti già presenti compatibili per l'abbinamento. Se la scadenza non ha importo definito
// si match solo per tipo/azienda/finestra temporale (l'importo lo darà il movimento abbinato).
export function candidates(s) {
  const type = txTypeFor(s.kind);
  const byAmount = t => !hasAmount(s) || Math.abs(round2(t.amount) - round2(s.amount)) < 0.02;
  return data.transactions.filter(t =>
    t.type === type && t.companyId === s.companyId && !t.scheduledId && byAmount(t) &&
    (!s.date || !t.date || Math.abs(daysBetween(s.date, t.date)) <= 20)
  ).sort((a, b) => Math.abs(daysBetween(s.date || a.date, a.date)) - Math.abs(daysBetween(s.date || b.date, b.date))).slice(0, 8);
}
