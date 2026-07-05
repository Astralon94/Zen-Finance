// ============ Carte di credito: saldo estratto conto con elasticità ============
// Le spese sulla carta (uscite con accountId = carta) accumulano un saldo negativo = debito.
// Saldare l'estratto conto = trasferimento dal conto pagante alla carta, che riporta il saldo
// verso zero. L'addebito reale sul conto può non coincidere col debito registrato:
//   addebito > debito  → la differenza è interessi/commissioni, registrata come COSTO;
//   addebito < debito  → resta il debito residuo sulla carta (saldo rotativo).
// La cassa del conto pagante cala sempre dell'addebito reale; gli interessi finiscono nel P&L.

import { data, save } from '../state/store.js';
import { round2, uid, todayStr } from './util.js';
import { balanceOf } from './finance.js';

// debito corrente della carta (valore positivo)
export const cardDebt = card => Math.max(0, round2(-balanceOf(card.id)));

// Salda l'estratto conto di una carta.
// - amount: importo realmente addebitato sul conto pagante.
// - fromAccountId: conto da cui escono i soldi.
// - interestCategoryId: categoria per l'eventuale costo interessi/commissioni (default 'c-ban').
// - existingTx: movimento di addebito già presente (riconciliazione) → viene convertito nel
//   trasferimento, evitando un doppione. In tal caso amount/fromAccountId derivano dal movimento.
export function settleCard(card, { amount, date, fromAccountId, interestCategoryId = 'c-ban', existingTx = null } = {}) {
  date = date || todayStr();
  const debt = cardDebt(card);
  if (debt <= 0.005) return { ok: false, reason: 'no-debt' };
  amount = round2(amount);
  if (!(amount > 0) || !fromAccountId) return { ok: false, reason: 'invalid' };

  const transfer = round2(Math.min(amount, debt)); // quota che azzera (in parte) il debito
  const interest = round2(amount - transfer);       // >0 solo se addebito > debito

  if (existingTx) {
    // converte il movimento bancario importato nel trasferimento di saldo
    existingTx.type = 'transfer';
    existingTx.accountId = fromAccountId;
    existingTx.toAccountId = card.id;
    existingTx.amount = transfer;
    existingTx.categoryId = null;
    existingTx.supplierId = null;
    existingTx.cardSettle = card.id;
    if (!existingTx.note) existingTx.note = `Saldo ${card.name}`;
  } else if (transfer > 0) {
    data.transactions.push({
      id: uid(), companyId: card.companyId, type: 'transfer', amount: transfer,
      accountId: fromAccountId, toAccountId: card.id, categoryId: null, supplierId: null,
      date, note: `Saldo ${card.name}`, cardSettle: card.id, createdAt: Date.now()
    });
  }
  // interessi/commissioni: costo reale sul conto pagante (entra nel P&L)
  if (interest > 0.005) {
    data.transactions.push({
      id: uid(), companyId: card.companyId, type: 'expense', amount: interest,
      accountId: fromAccountId, toAccountId: null, categoryId: interestCategoryId || 'c-ban', supplierId: null,
      date, note: `Interessi e commissioni · ${card.name}`, cardId: card.id, createdAt: Date.now()
    });
  }
  save();
  return { ok: true, transfer, interest, residual: round2(debt - transfer) };
}
