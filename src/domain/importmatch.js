// ============ Abbinamento in fase di import estratto conto ============
// Logica PURA e testabile: data una riga della banca, cerca fra i movimenti ESISTENTI
// non ancora importati uno (o un gruppo) compatibile, così un bonifico già registrato a
// mano (es. dal wizard "Registra i pagamenti") non rientra duplicato dall'estratto conto.
// Nessuna dipendenza dallo store: transazioni e predicati arrivano dai parametri.
import { round2, daysBetween } from './util.js';

export const MATCH_DAYS = 7;   // ± giorni entro cui una riga banca può abbinare un movimento esistente
const AMOUNT_EPS = 0.005;      // tolleranza sugli importi (mezzo centesimo)

// ---- chiave impronta della riga (dedup) ----
// Se la banca fornisce un riferimento univoco (ref, da XML) → chiave stabile.
// Altrimenti impronta su conto+data+importo+descrizione con contatore progressivo (#0,#1…):
// due righe identiche nello stesso file ricevono chiavi distinte, ma il re-import dello
// stesso file resta riconosciuto come duplicato. `counter` è una Map condivisa dal file.
export function rowKey(row, accountId, counter) {
  if (row.ref) return `ref:${accountId}:${row.ref}`;
  const base = `${accountId}|${row.date}|${row.amount}|${(row.desc || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60)}`;
  const n = counter.get(base) || 0; counter.set(base, n + 1);
  return `${base}#${n}`;
}

// ---- candidati 1:1 ----
// Movimenti compatibili con la riga: stesso conto, NON importati, stesso segno, importo uguale
// entro EPS, data entro la finestra. Priorità a chi è già referenziato da un pagamento fattura o
// porta un sepaFileId; a parità, data più vicina.
function singleCandidates(row, accountId, transactions, isReconciled) {
  const want = row.amount < 0 ? 'expense' : 'income';
  const amt = round2(Math.abs(row.amount));
  return transactions.filter(t =>
    t.accountId === accountId && !t.impHash && t.type === want &&
    Math.abs(round2(t.amount) - amt) <= AMOUNT_EPS &&
    Math.abs(daysBetween(t.date, row.date)) <= MATCH_DAYS
  ).map(t => ({
    tx: t,
    prio: (isReconciled(t.id) || t.sepaFileId) ? 0 : 1,
    dd: Math.abs(daysBetween(t.date, row.date))
  })).sort((a, b) => a.prio - b.prio || a.dd - b.dd);
}

// ---- gruppo di lotto (addebito unico cumulativo) ----
// Quando la banca addebita UNA riga per l'intero file SEPA (batchBooking cumulativo), la riga
// non ha un match 1:1: si cerca un gruppo di movimenti non importati che condividono lo stesso
// sepaFileId (sepaBooking='batch') la cui SOMMA coincide con l'importo della riga.
function batchGroupFor(row, accountId, transactions) {
  const want = row.amount < 0 ? 'expense' : 'income';
  const amt = round2(Math.abs(row.amount));
  const byFile = new Map();
  transactions.forEach(t => {
    if (t.accountId !== accountId || t.impHash || t.type !== want) return;
    if (t.sepaBooking !== 'batch' || !t.sepaFileId) return;
    if (Math.abs(daysBetween(t.date, row.date)) > MATCH_DAYS) return;
    if (!byFile.has(t.sepaFileId)) byFile.set(t.sepaFileId, []);
    byFile.get(t.sepaFileId).push(t);
  });
  for (const grp of byFile.values()) {
    const sum = round2(grp.reduce((s, t) => s + round2(t.amount), 0));
    if (Math.abs(sum - amt) <= AMOUNT_EPS) return grp;
  }
  return null;
}

// Cerca il match per una riga: prima 1:1, poi il gruppo di lotto. Ritorna null se nessuno.
//  { kind:'single', tx } | { kind:'batch', group:[tx…], sepaFileId } | null
export function matchBankRow(row, accountId, transactions, { isReconciled = () => false } = {}) {
  const cands = singleCandidates(row, accountId, transactions, isReconciled);
  if (cands.length) return { kind: 'single', tx: cands[0].tx };
  const grp = batchGroupFor(row, accountId, transactions);
  if (grp && grp.length) return { kind: 'batch', group: grp, sepaFileId: grp[0].sepaFileId };
  return null;
}

// ---- pianificazione dell'import (pura) ----
// Classifica ogni riga in 'new' | 'matched' | 'duplicate' senza scrivere nulla. Un movimento non
// può essere assorbito da due righe diverse (Set `used`). `forceNew` disabilita l'abbinamento per
// gli indici indicati (l'utente ha scelto di importarli come nuovi).
export function planBankImport(rows, accountId, transactions, { isReconciled = () => false, existingKeys = new Set(), forceNew = new Set() } = {}) {
  const counter = new Map();
  const used = new Set();
  const existing = new Set(existingKeys);
  const entries = [];
  let added = 0, matched = 0, skipped = 0;
  rows.forEach((row, i) => {
    const key = rowKey(row, accountId, counter);
    if (existing.has(key)) { entries.push({ i, row, key, status: 'duplicate', match: null }); skipped++; return; }
    const match = forceNew.has(i) ? null : matchBankRow(row, accountId, transactions.filter(t => !used.has(t.id)), { isReconciled });
    if (match) {
      (match.kind === 'single' ? [match.tx] : match.group).forEach(t => used.add(t.id));
      entries.push({ i, row, key, status: 'matched', match });
      matched++;
    } else {
      entries.push({ i, row, key, status: 'new', match: null });
      added++;
    }
    existing.add(key);
  });
  return { entries, added, matched, skipped };
}
