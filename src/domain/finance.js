// ============ Logica finanziaria: lookup, saldi conti, conto economico ============
import { data } from '../state/store.js';
import { round2 } from './util.js';

// ---- lookup ----
export const cat = id => data.categories.find(c => c.id === id);
export const acc = id => data.accounts.find(a => a.id === id);
export const co = id => data.companies.find(c => c.id === id);
export const sup = id => data.suppliers.find(s => s.id === id);

export const activeCompany = () => data.settings.activeCompany || null;
export const accountsOf = cid => data.accounts.filter(a => a.companyId === cid);
export const catsByType = type => data.categories.filter(c => c.type === type);

// Etichetta in lista: nome visualizzato > descrizione grezza banca > categoria > tipo
export function txLabel(t) {
  const name = (t.note || '').trim();
  if (name) return name;
  const raw = (t.desc || '').trim();
  if (raw) return raw;
  const c = cat(t.categoryId);
  if (c) return c.name;
  return t.type === 'income' ? 'Entrata' : t.type === 'transfer' ? 'Trasferimento' : 'Uscita';
}

export function catNeutral(id) { const c = cat(id); return !!(c && c.neutral); }
export function isNeutral(t) { return (t.type === 'expense' || t.type === 'income') && catNeutral(t.categoryId); }
export function accExcluded(id) { const a = acc(id); return !!(a && a.excluded); }
// fuori dal conto economico: neutre o conti esclusi (carte e contanti NON sono esclusi:
// le loro spese restano costi reali e contano nel P&L).
export function offPL(t) { return (t.type === 'expense' || t.type === 'income') && (catNeutral(t.categoryId) || accExcluded(t.accountId)); }

// ---- tipi di conto ----
// 'standard' (banca), 'prepaid' (carta ricaricabile: identica a banca), 'credit' (carta di
// credito: debito, fuori dalla liquidità), 'cash' (contanti: senza saldo, fuori dalla liquidità).
export const accKind = a => (a && a.kind) || 'standard';
export const isCard = a => accKind(a) === 'credit';
export const isCash = a => accKind(a) === 'cash';
// contribuisce alla liquidità di cassa: solo banca/ricaricabile, non esclusi
export const inLiquidity = a => !!a && !a.excluded && (accKind(a) === 'standard' || accKind(a) === 'prepaid');

// ---- effetto di un movimento su un conto ----
export function txEffect(t, accountId) {
  if (t.type === 'income') return t.accountId === accountId ? t.amount : 0;
  if (t.type === 'expense') return t.accountId === accountId ? -t.amount : 0;
  if (t.type === 'transfer') {
    let s = 0;
    if (t.accountId === accountId) s -= t.amount;
    if (t.toAccountId === accountId) s += t.amount;
    return s;
  }
  return 0;
}

export function balanceOf(accountId) {
  const a = acc(accountId); if (!a) return 0;
  return round2(data.transactions.reduce((s, t) => s + txEffect(t, accountId), a.initial || 0));
}

// saldo (cash) di un'azienda o di tutte (scope=null): solo conti di liquidità (no carte/contanti)
export function cashOf(scope) {
  return round2(data.accounts.filter(a => (!scope || a.companyId === scope) && inLiquidity(a))
    .reduce((s, a) => s + balanceOf(a.id), 0));
}
export function fidoOf(scope) {
  return round2(data.accounts.filter(a => (!scope || a.companyId === scope) && inLiquidity(a))
    .reduce((s, a) => s + (a.fido || 0), 0));
}
export function liquidityOf(scope) { return round2(cashOf(scope) + fidoOf(scope)); }
// debito totale delle carte di credito (valore positivo): saldi negativi delle carte
export function cardDebtOf(scope) {
  return round2(data.accounts.filter(a => (!scope || a.companyId === scope) && isCard(a) && !a.excluded)
    .reduce((s, a) => s + Math.max(0, -balanceOf(a.id)), 0));
}

// ---- conto economico ----
export function pnl(txs) {
  let rev = 0, cost = 0;
  txs.forEach(t => {
    if (offPL(t)) return;
    if (t.type === 'income') rev = round2(rev + t.amount);
    else if (t.type === 'expense') cost = round2(cost + t.amount);
  });
  return { rev, cost, profit: round2(rev - cost) };
}

export function txsInScope(scope) {
  return scope ? data.transactions.filter(t => t.companyId === scope) : data.transactions;
}

export function periodTxs(txs, year, month) {
  return txs.filter(t => {
    if (!t.date) return false;
    if (year && t.date.slice(0, 4) !== String(year)) return false;
    if (month && t.date.slice(5, 7) !== String(month).padStart(2, '0')) return false;
    return true;
  });
}

export function availableYears(txs) {
  const ys = new Set(txs.map(t => (t.date || '').slice(0, 4)).filter(Boolean));
  ys.add(String(new Date().getFullYear()));
  return [...ys].sort((a, b) => b.localeCompare(a)).map(Number);
}

export function pnlBreakdown(txs) {
  const byCat = {};
  txs.forEach(t => {
    if (offPL(t) || (t.type !== 'expense' && t.type !== 'income')) return;
    const c = cat(t.categoryId);
    const key = c ? c.id : 'none';
    const e = byCat[key] || (byCat[key] = { id: key, name: c?.name || 'Senza categoria', emoji: c?.emoji || '•', type: t.type, total: 0 });
    e.total = round2(e.total + t.amount);
  });
  return Object.values(byCat).sort((a, b) => b.total - a.total);
}
