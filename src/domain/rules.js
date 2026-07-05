// ============ Regole di categorizzazione automatica ============
// Una regola: { id, keyword, enabled, applyIncome, categoryId, supplierId, displayName }
// Match: keyword come sottostringa (case-insensitive) sulla descrizione grezza del movimento.
// Imposta categoria / fornitore / nome visualizzato (note). Agisce su uscite e, se applyIncome, anche su entrate.

import { data, save } from '../state/store.js';

const matchBase = t => ((t.desc || '') + ' ' + (t.note || '')).toLowerCase();

// ambito di una regola → tipi di movimento a cui si applica
function ruleMatchesType(r, type) {
  const scope = r.appliesTo || (r.applyIncome ? 'both' : 'expense');
  if (scope === 'both') return type === 'expense' || type === 'income';
  return scope === type;
}

export function rulesFor(t) {
  const base = matchBase(t);
  return data.rules.filter(r => r.enabled !== false && r.keyword && base.includes(r.keyword.toLowerCase())
    && ruleMatchesType(r, t.type));
}

// Applica le regole a un movimento. onlyEmpty=true non sovrascrive campi già valorizzati.
// Ritorna true se qualcosa è cambiato.
export function applyRules(t, { onlyEmpty = true } = {}) {
  let changed = false;
  for (const r of rulesFor(t)) {
    if (r.categoryId && (!onlyEmpty || !t.categoryId)) { if (t.categoryId !== r.categoryId) { t.categoryId = r.categoryId; changed = true; } }
    if (r.supplierId && (!onlyEmpty || !t.supplierId)) { if (t.supplierId !== r.supplierId) { t.supplierId = r.supplierId; changed = true; } }
    if (r.displayName && (!onlyEmpty || !(t.note || '').trim())) { if (t.note !== r.displayName) { t.note = r.displayName; changed = true; } }
  }
  return changed;
}

// Suggerisce una parola chiave da una descrizione bancaria (l'utente la affina).
export function suggestKeyword(desc) {
  if (!desc) return '';
  let s = String(desc);
  const star = s.indexOf('*');                 // nel formato IT spesso il beneficiario è dopo '*'
  if (star >= 0) s = s.slice(star + 1);
  // taglia su rumore tipico (codici, riferimenti, indirizzi)
  s = s.split(/\s{2,}|TS-|ID\.?BON|Fattura|Fatt\.|PERIODO|Per\.?rif|Via |C\/O|n\.?ord/i)[0];
  s = s.replace(/[^\p{L}\s&.\-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').slice(0, 3).join(' ');
}

// Riapplica le regole a tutti i movimenti esistenti (riempie solo i campi vuoti).
export function reapplyAll() {
  let n = 0;
  data.transactions.forEach(t => { if (t.type === 'transfer') return; if (applyRules(t, { onlyEmpty: true })) n++; });
  if (n) save();
  return n;
}
