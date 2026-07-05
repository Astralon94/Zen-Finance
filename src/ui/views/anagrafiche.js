// ============ Vista Anagrafiche: Aziende, Conti, Fornitori, Categorie ============
import { data, save } from '../../state/store.js';
import { esc, fmt, uid, parseAmount, todayStr } from '../../domain/util.js';
import { balanceOf, co, acc, accountsOf, accKind, isCard, isCash, inLiquidity } from '../../domain/finance.js';
import { settleCard, cardDebt } from '../../domain/cards.js';
import { isTxReconciled } from '../../domain/invoices.js';
import { openSheet, closeSheet, toast, confirmDialog } from '../dom.js';
import { companyOptions, accountOptions, categoryOptions, supplierOptions } from '../forms.js';
import { reapplyAll } from '../../domain/rules.js';
import { openRuleEditor } from '../ruleeditor.js';

// tipi di conto disponibili
const ACCOUNT_KINDS = [
  { v: 'standard', label: 'Conto bancario', emoji: '🏦' },
  { v: 'prepaid', label: 'Carta ricaricabile', emoji: '💳' },
  { v: 'credit', label: 'Carta di credito', emoji: '💳' },
  { v: 'cash', label: 'Contanti', emoji: '💵' }
];
const kindLabel = k => (ACCOUNT_KINDS.find(x => x.v === k) || ACCOUNT_KINDS[0]).label;
const kindEmoji = k => (ACCOUNT_KINDS.find(x => x.v === k) || ACCOUNT_KINDS[0]).emoji;

let tab = 'companies';
let ruleQ = '', ruleScope = 'all';

const ruleScopeOf = r => r.appliesTo || (r.applyIncome ? 'both' : 'expense');
const ruleScopeLabel = r => ({ expense: 'uscite', income: 'entrate', both: 'entrambe' }[ruleScopeOf(r)]);
const ruleScopeIcon = r => ({ expense: '⬇️', income: '⬆️', both: '↕️' }[ruleScopeOf(r)]);

export function render() {
  const chip = (v, l) => `<button class="chip ${tab === v ? 'on' : ''}" data-t="${v}">${l}</button>`;
  let h = `<div class="pagehead"><h1>Anagrafiche</h1></div>`;
  h += `<div class="chips">${chip('companies', 'Aziende')}${chip('accounts', 'Conti')}${chip('suppliers', 'Fornitori')}${chip('categories', 'Categorie')}${chip('rules', 'Regole')}</div>`;
  if (tab === 'companies') h += companies();
  else if (tab === 'accounts') h += accounts();
  else if (tab === 'suppliers') h += suppliers();
  else if (tab === 'categories') h += categories();
  else h += rules();
  return h;
}

function companies() {
  let h = `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-newco>+ Nuova azienda</button></div><div class="list">`;
  data.companies.forEach(c => {
    h += `<div class="row click" data-co="${c.id}"><div class="emoji">${c.emoji || '🏢'}</div><div class="mid"><div class="t1">${esc(c.name)}</div><div class="t2">${c.piva ? 'P.IVA ' + esc(c.piva) : ''}</div></div></div>`;
  });
  return h + `</div>`;
}
function accounts() {
  let h = `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-newacc>+ Nuovo conto</button></div><div class="list">`;
  data.accounts.forEach(a => {
    const k = accKind(a), bal = balanceOf(a.id);
    const sub = `${esc(co(a.companyId)?.name || '')} · ${kindLabel(k)}${a.excluded ? ' · escluso' : ''}`;
    let right;
    if (k === 'cash') right = `<div class="amt muted">—</div>`;
    else if (k === 'credit') right = `<div class="amt tnum ${bal < 0 ? 'neg' : 'pos'}">${fmt(bal)}${cardDebt(a) > 0.005 ? ' <span class="badge b-overdue">debito</span>' : ''}</div>`;
    else right = `<div class="amt tnum ${bal < 0 ? 'neg' : ''}">${fmt(bal)}</div>`;
    h += `<div class="row click" data-acc="${a.id}"><div class="emoji">${a.emoji || kindEmoji(k)}</div><div class="mid"><div class="t1">${esc(a.name)}</div><div class="t2">${sub}</div></div>${right}</div>`;
  });
  return h + `</div>`;
}
function suppliers() {
  const list = data.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name));
  let h = `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-newsup>+ Nuovo fornitore</button></div>`;
  if (!list.length) return h + `<div class="card empty">Nessun fornitore. Vengono creati anche automaticamente importando le fatture.</div>`;
  h += `<div class="list">`;
  list.forEach(s => {
    h += `<div class="row click" data-sup="${s.id}"><div class="emoji">🏷️</div><div class="mid"><div class="t1">${esc(s.name)}</div><div class="t2">${s.piva ? 'P.IVA ' + esc(s.piva) : (s.cf ? 'CF ' + esc(s.cf) : '')}${s.iban ? ' · IBAN ✓' : ''}</div></div></div>`;
  });
  return h + `</div>`;
}
function categories() {
  let h = `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-newcat>+ Nuova categoria</button></div><div class="list">`;
  data.categories.forEach(c => {
    h += `<div class="row click" data-cat="${c.id}"><div class="emoji">${c.emoji || '•'}</div><div class="mid"><div class="t1">${esc(c.name)}</div><div class="t2">${c.type === 'income' ? 'Ricavo' : 'Costo'}${c.neutral ? ' · neutra' : ''}</div></div></div>`;
  });
  return h + `</div>`;
}

function rules() {
  let h = `<div class="btnrow" style="margin-bottom:12px">
    <button class="btn primary" data-newrule>+ Nuova regola</button>
    <button class="btn" data-reapply>↻ Riapplica alle esistenti</button>
  </div>`;
  if (!data.rules.length) return h + `<div class="card empty">Nessuna regola.<br><span class="muted">Le regole assegnano automaticamente categoria, fornitore e nome ai movimenti, leggendo la descrizione della banca.</span></div>`;

  // filtri per ambito/stato + ricerca
  const chip = (v, l) => `<button class="chip ${ruleScope === v ? 'on' : ''}" data-rscope="${v}">${l}</button>`;
  h += `<div class="chips">${chip('all', 'Tutte')}${chip('expense', 'Uscite')}${chip('income', 'Entrate')}${chip('both', 'Entrambe')}${chip('off', 'Disattivate')}</div>`;
  h += `<div class="field"><input id="ruleq" placeholder="Cerca per parola chiave, categoria, fornitore o nome…" value="${esc(ruleQ)}"></div>`;

  const term = ruleQ.trim().toLowerCase();
  const list = data.rules.filter(r => {
    if (ruleScope === 'off') { if (r.enabled !== false) return false; }
    else if (ruleScope !== 'all') { if (ruleScopeOf(r) !== ruleScope) return false; }
    if (term) {
      const c = r.categoryId ? data.categories.find(x => x.id === r.categoryId) : null;
      const s = r.supplierId ? data.suppliers.find(x => x.id === r.supplierId) : null;
      const hay = `${r.keyword || ''} ${r.displayName || ''} ${c ? c.name : ''} ${s ? s.name : ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  }).sort((a, b) => (a.keyword || '').localeCompare(b.keyword || ''));

  h += `<div class="muted" style="font-size:12.5px;margin:2px 2px 8px"><b>${list.length}</b> regol${list.length === 1 ? 'a' : 'e'}${list.length !== data.rules.length ? ` su ${data.rules.length}` : ''}</div>`;
  if (!list.length) return h + `<div class="card empty">Nessuna regola con questi filtri.</div>`;

  h += `<div class="list">`;
  list.forEach(r => {
    const c = r.categoryId ? data.categories.find(x => x.id === r.categoryId) : null;
    const s = r.supplierId ? data.suppliers.find(x => x.id === r.supplierId) : null;
    const sets = [c ? c.name : null, s ? s.name : null, r.displayName ? `"${r.displayName}"` : null].filter(Boolean).join(' · ') || 'nessuna azione';
    const off = r.enabled === false;
    h += `<div class="row click" data-rule="${r.id}"${off ? ' style="opacity:.55"' : ''}>
      <div class="emoji">${ruleScopeIcon(r)}</div>
      <div class="mid"><div class="t1">contiene "${esc(r.keyword)}" <span class="badge b-unpaid">${ruleScopeLabel(r)}</span>${off ? ' <span class="badge" style="background:var(--line);color:var(--sub)">off</span>' : ''}</div><div class="t2">→ ${esc(sets)}</div></div>
    </div>`;
  });
  return h + `</div>`;
}

export function bind(root) {
  root.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; root.innerHTML = render(); bind(root); });
  root.querySelector('[data-newco]')?.addEventListener('click', () => editCompany(null));
  root.querySelector('[data-newacc]')?.addEventListener('click', () => editAccount(null));
  root.querySelector('[data-newsup]')?.addEventListener('click', () => editSupplier(null));
  root.querySelector('[data-newcat]')?.addEventListener('click', () => editCategory(null));
  root.querySelector('[data-newrule]')?.addEventListener('click', () => openRuleEditor(null));
  root.querySelector('[data-reapply]')?.addEventListener('click', () => { const n = reapplyAll(); toast(n ? `${n} movimenti aggiornati` : 'Nessun movimento da aggiornare'); });
  root.querySelectorAll('[data-rscope]').forEach(b => b.onclick = () => { ruleScope = b.dataset.rscope; root.innerHTML = render(); bind(root); });
  const rq = root.querySelector('#ruleq');
  if (rq) rq.oninput = () => { ruleQ = rq.value; const pos = rq.selectionStart; root.innerHTML = render(); bind(root); const n = root.querySelector('#ruleq'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  root.querySelectorAll('[data-co]').forEach(e => e.onclick = () => editCompany(e.dataset.co));
  root.querySelectorAll('[data-acc]').forEach(e => e.onclick = () => editAccount(e.dataset.acc));
  root.querySelectorAll('[data-sup]').forEach(e => e.onclick = () => editSupplier(e.dataset.sup));
  root.querySelectorAll('[data-cat]').forEach(e => e.onclick = () => editCategory(e.dataset.cat));
  root.querySelectorAll('[data-rule]').forEach(e => e.onclick = () => openRuleEditor(e.dataset.rule));
}

// ---- editors ----
function editCompany(id) {
  const c = id ? data.companies.find(x => x.id === id) : null;
  openSheet(`<h2>${id ? 'Modifica azienda' : 'Nuova azienda'}</h2>
    <div class="frow"><div class="field" style="flex:0 0 80px"><label>Emoji</label><input id="c_em" value="${esc(c?.emoji || '🏢')}"></div>
      <div class="field"><label>Nome</label><input id="c_nm" value="${esc(c?.name || '')}"></div></div>
    <div class="field"><label>P.IVA</label><input id="c_pi" value="${esc(c?.piva || '')}"></div>
    <div class="field"><label>Note</label><input id="c_no" value="${esc(c?.note || '')}"></div>
    <div class="actions">${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      const g = x => sheet.querySelector(x).value.trim();
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]').onclick = () => {
        const name = g('#c_nm'); if (!name) { toast('Inserisci il nome'); return; }
        const rec = { name, emoji: g('#c_em') || '🏢', piva: g('#c_pi'), note: g('#c_no') };
        if (id) Object.assign(c, rec); else data.companies.push({ id: uid(), color: '#545ea6', ...rec });
        save(); closeSheet(); toast('Salvato ✓');
      };
      if (id) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare l\'azienda?', 'Conti, movimenti e fatture collegati resteranno ma orfani.', 'Elimina', () => {
        data.companies = data.companies.filter(x => x.id !== id);
        if (data.settings.activeCompany === id) data.settings.activeCompany = null;
        save(); closeSheet(); toast('Eliminata');
      }, { danger: true });
    });
}

function editAccount(id) {
  const a = id ? data.accounts.find(x => x.id === id) : null;
  const cid = a?.companyId || data.companies[0]?.id;
  const curKind = accKind(a);
  const kindOpts = ACCOUNT_KINDS.map(k => `<option value="${k.v}" ${curKind === k.v ? 'selected' : ''}>${k.emoji} ${k.label}</option>`).join('');
  // conti di liquidità della stessa azienda, esclusa la carta stessa (per il collegamento)
  const linkOpts = accountOptions(cid, a?.linkedAccountId, { allowNone: true, noneLabel: '— da definire —', predicate: x => inLiquidity(x) && x.id !== id });
  openSheet(`<h2>${id ? 'Modifica conto' : 'Nuovo conto'}</h2>
    <div class="frow"><div class="field" style="flex:0 0 80px"><label>Emoji</label><input id="a_em" value="${esc(a?.emoji || kindEmoji(curKind))}"></div>
      <div class="field"><label>Nome</label><input id="a_nm" value="${esc(a?.name || '')}"></div></div>
    <div class="frow"><div class="field"><label>Tipo di conto</label><select id="a_kind">${kindOpts}</select></div>
      <div class="field"><label>Azienda</label><select id="a_co">${companyOptions(cid)}</select></div></div>
    <div class="frow" id="row_init"><div class="field"><label>Saldo iniziale</label><input id="a_in" inputmode="decimal" value="${a ? String(a.initial || 0).replace('.', ',') : '0'}"></div>
      <div class="field" id="fld_fido"><label>Fido / scoperto</label><input id="a_fi" inputmode="decimal" value="${a?.fido ? String(a.fido).replace('.', ',') : ''}"></div></div>
    <div class="field" id="row_link"><label>Conto collegato (addebito estratto conto)</label><select id="a_link">${linkOpts}</select></div>
    <div class="field" id="row_excl"><label><input type="checkbox" id="a_ex" ${a?.excluded ? 'checked' : ''}> Escludi da liquidità e conto economico</label></div>
    <div class="muted" id="row_hint" style="font-size:12px;margin:-2px 2px 8px"></div>
    ${id && curKind === 'credit' ? `<div class="btnrow" id="row_settle" style="margin-bottom:6px"><button class="btn" data-settle>💳 Salda estratto conto</button><span class="muted" style="align-self:center;font-size:12.5px">debito ${fmt(cardDebt(a))}</span></div>` : ''}
    <div class="actions">${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      const g = x => sheet.querySelector(x);
      const HINTS = {
        standard: '', prepaid: 'Si comporta come un conto: ha un saldo e va ricaricata con un trasferimento.',
        credit: 'Le spese accumulano debito (saldo negativo), fuori dalla liquidità. Si salda dal conto collegato.',
        cash: 'Senza saldo: serve solo a tracciare i pagamenti in contanti. Le spese contano comunque come costi.'
      };
      const applyKind = () => {
        const k = g('#a_kind').value;
        g('#row_init').style.display = (k === 'cash') ? 'none' : '';
        g('#fld_fido').style.display = (k === 'standard' || k === 'prepaid') ? '' : 'none';
        g('#row_link').style.display = (k === 'credit') ? '' : 'none';
        g('#row_excl').style.display = (k === 'standard' || k === 'prepaid') ? '' : 'none';
        g('#row_hint').textContent = HINTS[k] || '';
      };
      g('#a_kind').onchange = applyKind; applyKind();
      g('[data-settle]')?.addEventListener('click', () => openCardSettle(a));
      g('[data-cancel]').onclick = closeSheet;
      g('[data-save]').onclick = () => {
        const name = g('#a_nm').value.trim(); if (!name) { toast('Inserisci il nome'); return; }
        const kind = g('#a_kind').value;
        const liquidityKind = (kind === 'standard' || kind === 'prepaid');
        const rec = {
          name, emoji: g('#a_em').value.trim() || kindEmoji(kind), companyId: g('#a_co').value, kind,
          initial: kind === 'cash' ? 0 : parseSigned(g('#a_in').value),
          fido: liquidityKind ? (parseAmount(g('#a_fi').value) || 0) : 0,
          excluded: liquidityKind ? g('#a_ex').checked : false,
          linkedAccountId: kind === 'credit' ? (g('#a_link').value || null) : null
        };
        if (id) Object.assign(a, rec); else data.accounts.push({ id: uid(), ...rec });
        save(); closeSheet(); toast('Salvato ✓');
      };
      if (id) g('[data-del]').onclick = () => confirmDialog('Eliminare il conto?', 'I movimenti collegati resteranno ma senza conto.', 'Elimina', () => {
        data.accounts = data.accounts.filter(x => x.id !== id); save(); closeSheet(); toast('Eliminato');
      }, { danger: true });
    });
}

// ---- saldo estratto conto carta di credito ----
function openCardSettle(card) {
  const debt = cardDebt(card);
  if (debt <= 0.005) { toast('Nessun debito da saldare'); return; }
  // candidati: uscite su conti di liquidità della stessa azienda, non già usate, importo vicino al debito
  // esclude movimenti già impegnati (collegati a fatture, finanziamenti o altri saldi carta):
  // convertirli in trasferimento corromperebbe quei collegamenti.
  const cands = data.transactions
    .filter(t => t.type === 'expense' && t.companyId === card.companyId && !t.cardSettle && !t.loanId && !isTxReconciled(t.id) && inLiquidity(acc(t.accountId)) && t.amount >= debt - 0.005)
    .sort((x, y) => Math.abs(x.amount - debt) - Math.abs(y.amount - debt)).slice(0, 6);
  const candHtml = cands.map(t => `<div class="row click" data-pick="${t.id}">
      <div class="emoji">⬇️</div>
      <div class="mid"><div class="t1">${esc(t.note || t.desc || 'Addebito')}</div><div class="t2">${t.date || ''}${acc(t.accountId) ? ' · ' + esc(acc(t.accountId).name) : ''}</div></div>
      <div class="amt tnum">${fmt(t.amount)}</div>
    </div>`).join('');
  openSheet(`<h2>Salda ${esc(card.name)}</h2>
    <div class="sheetsub">Debito attuale: ${fmt(debt)}</div>
    ${cands.length ? `<div class="section-title">Abbina l'addebito già sul conto</div><div class="list">${candHtml}</div><div class="section-title">Oppure registra a mano</div>` : ''}
    <div class="field"><label>Importo addebitato sul conto</label><input id="cs_amt" inputmode="decimal" value="${String(debt).replace('.', ',')}" style="font-size:18px;font-weight:700"></div>
    <div class="frow">
      <div class="field"><label>Dal conto</label><select id="cs_acc">${accountOptions(card.companyId, card.linkedAccountId, { predicate: x => inLiquidity(x) })}</select></div>
      <div class="field"><label>Data</label><input id="cs_date" type="date" value="${todayStr()}"></div>
    </div>
    <div class="field"><label>Categoria interessi/commissioni (se l'addebito supera il debito)</label><select id="cs_cat">${categoryOptions('expense', 'c-ban')}</select></div>
    <div class="muted" style="font-size:12px">Se l'addebito è maggiore del debito, la differenza diventa un costo. Se è minore, resta il debito residuo sulla carta.</div>
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-ok>Registra saldo</button></div>`,
    sheet => {
      const finish = r => {
        if (!r.ok) { toast(r.reason === 'no-debt' ? 'Nessun debito' : 'Dati non validi'); return; }
        closeSheet();
        toast(`Saldata ✓${r.interest > 0.005 ? ' · interessi ' + fmt(r.interest) : ''}${r.residual > 0.005 ? ' · residuo ' + fmt(r.residual) : ''}`);
      };
      sheet.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
        const t = data.transactions.find(x => x.id === el.dataset.pick);
        finish(settleCard(card, { existingTx: t, amount: t.amount, fromAccountId: t.accountId, date: t.date, interestCategoryId: sheet.querySelector('#cs_cat').value }));
      });
      sheet.querySelector('[data-cancel]').onclick = () => editAccount(card.id);
      sheet.querySelector('[data-ok]').onclick = () => {
        const amount = parseAmount(sheet.querySelector('#cs_amt').value);
        const from = sheet.querySelector('#cs_acc').value;
        if (!amount) { toast('Inserisci l\'importo'); return; }
        if (!from) { toast('Scegli il conto pagante'); return; }
        finish(settleCard(card, { amount, fromAccountId: from, date: sheet.querySelector('#cs_date').value || todayStr(), interestCategoryId: sheet.querySelector('#cs_cat').value }));
      };
    });
}

function editSupplier(id) {
  const s = id ? data.suppliers.find(x => x.id === id) : null;
  openSheet(`<h2>${id ? 'Modifica fornitore' : 'Nuovo fornitore'}</h2>
    <div class="field"><label>Nome</label><input id="s_nm" value="${esc(s?.name || '')}"></div>
    <div class="frow"><div class="field"><label>P.IVA</label><input id="s_pi" value="${esc(s?.piva || '')}"></div>
      <div class="field"><label>Codice fiscale</label><input id="s_cf" value="${esc(s?.cf || '')}"></div></div>
    <div class="field"><label>IBAN</label><input id="s_ib" value="${esc(s?.iban || '')}"></div>
    <div class="field"><label>Email</label><input id="s_em" value="${esc(s?.email || '')}"></div>
    <div class="field"><label>Note</label><input id="s_no" value="${esc(s?.note || '')}"></div>
    <div class="actions">${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      const g = x => sheet.querySelector(x).value.trim();
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]').onclick = () => {
        const name = g('#s_nm'); if (!name) { toast('Inserisci il nome'); return; }
        const rec = { name, piva: g('#s_pi'), cf: g('#s_cf'), iban: g('#s_ib'), email: g('#s_em'), note: g('#s_no') };
        if (id) Object.assign(s, rec); else data.suppliers.push({ id: uid(), type: 'supplier', ...rec });
        save(); closeSheet(); toast('Salvato ✓');
      };
      if (id) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare il fornitore?', 'Le fatture collegate manterranno il nome.', 'Elimina', () => {
        const name = s.name;
        data.invoices.forEach(inv => { if (inv.supplierId === id) { inv.supplierId = null; inv.supplierName = name; } });
        data.suppliers = data.suppliers.filter(x => x.id !== id); save(); closeSheet(); toast('Eliminato');
      }, { danger: true });
    });
}

function editCategory(id) {
  const c = id ? data.categories.find(x => x.id === id) : null;
  openSheet(`<h2>${id ? 'Modifica categoria' : 'Nuova categoria'}</h2>
    <div class="frow"><div class="field" style="flex:0 0 80px"><label>Emoji</label><input id="k_em" value="${esc(c?.emoji || '📌')}"></div>
      <div class="field"><label>Nome</label><input id="k_nm" value="${esc(c?.name || '')}"></div></div>
    <div class="field"><label>Tipo</label><select id="k_ty"><option value="expense" ${c?.type !== 'income' ? 'selected' : ''}>Costo</option><option value="income" ${c?.type === 'income' ? 'selected' : ''}>Ricavo</option></select></div>
    <div class="field"><label><input type="checkbox" id="k_ne" ${c?.neutral ? 'checked' : ''}> Neutra (partita di giro, fuori dal conto economico)</label></div>
    <div class="actions">${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]').onclick = () => {
        const name = sheet.querySelector('#k_nm').value.trim(); if (!name) { toast('Inserisci il nome'); return; }
        const rec = { name, emoji: sheet.querySelector('#k_em').value.trim() || '📌', type: sheet.querySelector('#k_ty').value, neutral: sheet.querySelector('#k_ne').checked };
        if (id) Object.assign(c, rec); else data.categories.push({ id: uid(), ...rec });
        save(); closeSheet(); toast('Salvato ✓');
      };
      if (id) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare la categoria?', 'I movimenti collegati resteranno senza categoria.', 'Elimina', () => {
        data.categories = data.categories.filter(x => x.id !== id); save(); closeSheet(); toast('Eliminata');
      }, { danger: true });
    });
}

function parseSigned(v) { const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')); return isNaN(n) ? 0 : Math.round(n * 100) / 100; }
