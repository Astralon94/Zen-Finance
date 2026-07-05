// ============ Storico eventi fatture (append-only) ============
// Registro cronologico delle azioni sulle fatture (pagamenti, riconciliazioni, eliminazioni…).
// Append-only con timestamp reale; si conservano solo gli ULTIMI `CAP` eventi (i più vecchi
// vengono scartati). Non chiama save(): lo fa il chiamante, che già persiste l'azione.

import { data } from '../state/store.js';
import { uid } from './util.js';

export const LOG_CAP = 500;

// verbo leggibile per ciascun tipo di evento
export const EVENT_VERB = {
  payment: 'Pagamento registrato',
  reconcile: 'Riconciliata da estratto conto',
  credit_used: 'Nota di credito usata',
  payment_removed: 'Pagamento annullato',
  invoice_deleted: 'Fattura eliminata'
};

// Registra un evento. `amount` e `account` opzionali. Mantiene solo gli ultimi LOG_CAP.
export function logEvent(type, { companyId = null, label = '', amount = null, account = null } = {}) {
  if (!Array.isArray(data.log)) data.log = [];
  data.log.push({ id: uid(), at: Date.now(), companyId, type, label, amount, account });
  if (data.log.length > LOG_CAP) data.log.splice(0, data.log.length - LOG_CAP);
}

// Eventi più recenti (opzionalmente filtrati per azienda), dal più nuovo al più vecchio.
// Il log è append-only e quindi già in ordine cronologico: si usa l'ordine d'inserimento
// (deterministico anche per eventi nello stesso millisecondo, es. un saldo multiplo), non `at`.
export function recentEvents(scope = null, limit = LOG_CAP) {
  const all = Array.isArray(data.log) ? data.log : [];
  const filtered = scope ? all.filter(e => e.companyId === scope) : all.slice();
  return filtered.slice(-limit).reverse();
}
