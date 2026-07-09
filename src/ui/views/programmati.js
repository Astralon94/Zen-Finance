// ============ Vista Programmati (scadenziario) ============
import { data } from '../../state/store.js';
import { can } from '../../state/auth.js';
import { esc, fmt, fmtDate, fmtDateFull, parseAmount, todayStr, round2, pad2 } from '../../domain/util.js';
import { activeCompany, acc, co, cat, txLabel } from '../../domain/finance.js';
import { openSheet, closeSheet, toast, confirmDialog } from '../dom.js';
import { exportTable, scopeLabel, nowStamp } from '../pdf.js';
import { companyOptions, accountOptions, categoryOptions, supplierPicker, bindCombos } from '../forms.js';
import {
  schedInScope, isPending, isOverdue, txTypeFor, addScheduled, updateScheduled, deleteScheduled,
  completeWithMovement, completeWithTx, completeMarkOnly, reopenScheduled, candidates,
  hasAmount, RECURRENCES, recurLabel
} from '../../domain/scheduled.js';
import { loansInScope, insts, isInstOverdue, unpayInst, isManualLoan } from '../../domain/loans.js';
import { openInstPay } from './finanziamenti.js';

let fKind = 'all';     // all | debit | credit
let manualOnly = false;
let showDone = false;

export function countOverdue(scope) {
  const t = todayStr();
  const sch = schedInScope(scope).filter(s => isPending(s) && s.date && s.date < t).length;
  const ln = loansInScope(scope).reduce((n, l) => n + insts(l).filter(isInstOverdue).length, 0);
  return sch + ln;
}

// entries unificate: scadenze manuali + rate dei finanziamenti
function pendingEntries(scope) {
  const out = [];
  schedInScope(scope).filter(isPending).forEach(s => out.push({
    key: 's:' + s.id, kind: s.kind, date: s.date, amount: s.amount, noAmount: !hasAmount(s), recurrence: s.recurrence || '',
    desc: s.description || (s.kind === 'credit' ? 'Accredito' : 'Addebito'),
    manual: !!s.manual, loan: false, overdue: isOverdue(s)
  }));
  loansInScope(scope).forEach(l => { const lm = isManualLoan(l); insts(l).filter(i => i.status !== 'paid').forEach(i => out.push({
    key: 'l:' + l.id + ':' + i.id, kind: 'debit', date: i.date, amount: i.amount, noAmount: false, recurrence: '',
    desc: `${l.name} · rata ${i.n}`, manual: lm, loan: true, overdue: isInstOverdue(i)
  })); });
  return out.filter(e => (fKind === 'all' || e.kind === fKind) && (!manualOnly || e.manual));
}

// raggruppamento temporale
function addDays(d, n) { const [y, m, g] = d.split('-').map(Number); const x = new Date(y, m - 1, g + n); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; }
function endOfMonth(d) { const [y, m] = d.split('-').map(Number); const x = new Date(y, m, 0); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; }
function bucketOf(date) {
  if (!date) return 'nodate';
  const t = todayStr();
  if (date < t) return 'overdue';
  if (date === t) return 'today';
  const [y, m, g] = t.split('-').map(Number);
  const dow = (new Date(y, m - 1, g).getDay() + 6) % 7;            // lun=0 … dom=6
  const endThis = addDays(t, 6 - dow), endNext = addDays(endThis, 7);
  if (date <= endThis) return 'thisweek';
  if (date <= endNext) return 'nextweek';
  if (date <= endOfMonth(t)) return 'thismonth';
  return 'later';
}
const BUCKETS = [['overdue', '⚠️ Scadute'], ['today', 'Oggi'], ['thisweek', 'Questa settimana'], ['nextweek', 'Settimana prossima'], ['thismonth', 'Questo mese'], ['later', 'Più avanti'], ['nodate', 'Senza data']];

export function render() {
  const entries = pendingEntries(activeCompany());
  const debP = round2(entries.filter(e => e.kind === 'debit').reduce((t, e) => t + (e.amount || 0), 0));
  const creP = round2(entries.filter(e => e.kind === 'credit').reduce((t, e) => t + (e.amount || 0), 0));
  const noAmtN = entries.filter(e => e.noAmount).length;
  const chip = (v, l) => `<button class="chip ${fKind === v ? 'on' : ''}" data-k="${v}">${l}</button>`;
  const kpi = (l, v, c) => `<div class="card kpi"><div class="lbl">${l}</div><div class="val tnum ${c}">${fmt(v)}</div></div>`;

  let h = `<div class="pagehead"><h1>Programmati</h1><span class="sub">scadenziario</span></div>`;
  h += `<div class="btnrow" style="margin-bottom:12px">${can('programmati.crea') ? '<button class="btn primary" data-new>+ Nuovo programmato</button>' : ''}${entries.length ? '<button class="btn" data-export>⤓ Esporta PDF</button>' : ''}</div>`;
  h += `<div class="grid k3">
    ${kpi('Addebiti previsti', debP, debP > 0 ? 'neg' : '')}
    ${kpi('Accrediti previsti', creP, creP > 0 ? 'pos' : '')}
    ${kpi('Saldo previsto', round2(creP - debP), (creP - debP) < 0 ? 'neg' : 'pos')}
  </div>`;
  if (noAmtN) h += `<div class="muted" style="margin:-4px 2px 10px;font-size:12.5px">💶 ${noAmtN} voc${noAmtN === 1 ? 'e' : 'i'} senza importo · non incluse nei totali</div>`;
  h += `<div class="chips">${chip('all', 'Tutti')}${chip('debit', 'Addebiti')}${chip('credit', 'Accrediti')}
    <button class="chip ${manualOnly ? 'on' : ''}" data-manual>✋ Solo manuali</button>
    <button class="chip ${showDone ? 'on' : ''}" data-done>Mostra completati</button></div>`;

  if (!entries.length) h += `<div class="card empty">Nessuna scadenza in attesa.</div>`;
  else {
    const byB = {}; entries.forEach(e => (byB[bucketOf(e.date)] ||= []).push(e));
    BUCKETS.forEach(([b, label]) => {
      const list = byB[b]; if (!list || !list.length) return;
      list.sort((a, z) => (a.date || '9999').localeCompare(z.date || '9999'));
      const sub = round2(list.reduce((t, e) => t + (e.kind === 'credit' ? (e.amount || 0) : -(e.amount || 0)), 0));
      h += `<div class="section-title" style="display:flex;justify-content:space-between"><span>${label} · ${list.length}</span><span class="tnum ${sub < 0 ? 'neg' : 'pos'}" style="text-transform:none">${sub < 0 ? '−' : '+'}${fmt(Math.abs(sub))}</span></div>`;
      h += `<div class="list">${list.map(rowEntry).join('')}</div>`;
    });
  }

  if (showDone) {
    const done = doneEntries(activeCompany());
    if (done.length) h += `<div class="section-title">Completati</div><div class="list">${done.map(rowDone).join('')}</div>`;
  }
  return h;
}

function rowEntry(e) {
  const icon = e.loan ? '🏦' : (e.kind === 'credit' ? '⬆️' : '⬇️');
  const badges = `${e.recurrence ? ` <span class="badge b-paid">🔁 ${esc(recurLabel(e.recurrence).toLowerCase())}</span>` : ''}${e.noAmount ? ' <span class="badge b-partial">💶 importo da definire</span>' : ''}${e.manual ? ' <span class="badge b-partial">✋ manuale</span>' : ''}${e.loan ? ' <span class="badge b-unpaid">rateizz.</span>' : ''}${e.overdue ? ' <span class="badge b-overdue">scaduto</span>' : ''}`;
  const amt = e.noAmount ? '<span class="muted">—</span>' : `${e.kind === 'credit' ? '+' : '−'}${fmt(e.amount)}`;
  return `<div class="row ${e.overdue || e.noAmount ? 'await' : ''}">
    <div class="emoji" data-open="${e.key}" style="cursor:pointer">${icon}</div>
    <div class="mid" data-open="${e.key}" style="cursor:pointer"><div class="t1">${esc(e.desc)}${badges}</div><div class="t2">${e.date ? fmtDate(e.date) : 'senza data'}</div></div>
    <div class="amt tnum ${e.noAmount ? '' : (e.kind === 'credit' ? 'pos' : 'neg')}">${amt}</div>
    ${(e.loan ? can('finanziamenti.rate') : can('programmati.esegui')) ? `<button class="btn sm primary" data-complete="${e.key}">✓</button>` : ''}
  </div>`;
}

function doneEntries(scope) {
  const out = [];
  schedInScope(scope).filter(s => !isPending(s)).forEach(s => out.push({ key: 's:' + s.id, kind: s.kind, amount: s.amount, desc: s.description || (s.kind === 'credit' ? 'Accredito' : 'Addebito'), when: s.doneDate, loan: false }));
  loansInScope(scope).forEach(l => insts(l).filter(i => i.status === 'paid').forEach(i => out.push({ key: 'l:' + l.id + ':' + i.id, kind: 'debit', amount: i.amount, desc: `${l.name} · rata ${i.n}`, when: i.paidDate, loan: true })));
  return out.sort((a, b) => (b.when || '').localeCompare(a.when || '')).slice(0, 60);
}
function rowDone(e) {
  return `<div class="row" style="opacity:.6">
    <div class="emoji">✅</div>
    <div class="mid"><div class="t1">${esc(e.desc)}${e.loan ? ' <span class="badge b-unpaid">rateizz.</span>' : ''}</div><div class="t2">completato ${e.when ? fmtDate(e.when) : ''}</div></div>
    <div class="amt tnum">${e.amount == null ? '<span class="muted">—</span>' : `${e.kind === 'credit' ? '+' : '−'}${fmt(e.amount)}`}</div>
    ${(e.loan ? can('finanziamenti.rate') : can('programmati.esegui')) ? `<button class="btn sm" data-reopen="${e.key}">↩</button>` : ''}
  </div>`;
}

function loanOf(key) { const [, lid, iid] = key.split(':'); const l = data.loans.find(x => x.id === lid); const i = l && insts(l).find(x => x.id === iid); return { l, i }; }

function exportProgrammati() {
  const entries = pendingEntries(activeCompany());
  if (!entries.length) return;
  const byB = {}; entries.forEach(e => (byB[bucketOf(e.date)] ||= []).push(e));
  const sections = [];
  BUCKETS.forEach(([b, label]) => {
    const list = byB[b]; if (!list || !list.length) return;
    list.sort((a, z) => (a.date || '9999').localeCompare(z.date || '9999'));
    const sub = round2(list.reduce((t, e) => t + (e.kind === 'credit' ? (e.amount || 0) : -(e.amount || 0)), 0));
    sections.push({
      heading: `${label.replace('⚠️ ', '')} · ${list.length}`,
      cols: [{ label: 'Descrizione' }, { label: 'Data' }, { label: 'Tipo' }, { label: 'Importo', right: true }],
      rows: list.map(e => [`${e.desc}${e.recurrence ? ' (' + recurLabel(e.recurrence).toLowerCase() + ')' : ''}${e.manual ? ' (manuale)' : ''}${e.loan ? ' (rateizz.)' : ''}`, e.date ? fmtDateFull(e.date) : 'senza data', e.kind === 'credit' ? 'Accredito' : 'Addebito', e.noAmount ? 'da definire' : `${e.kind === 'credit' ? '+' : '−'}${fmt(e.amount)}`]),
      foot: [['', '', 'Saldo gruppo', `${sub < 0 ? '−' : '+'}${fmt(Math.abs(sub))}`]]
    });
  });
  const debP = round2(entries.filter(e => e.kind === 'debit').reduce((t, e) => t + (e.amount || 0), 0));
  const creP = round2(entries.filter(e => e.kind === 'credit').reduce((t, e) => t + (e.amount || 0), 0));
  exportTable({ title: 'Programmati — scadenziario', subtitle: `${scopeLabel()} · addebiti ${fmt(debP)} · accrediti ${fmt(creP)} · saldo previsto ${fmt(round2(creP - debP))} · ${nowStamp()}`, sections });
}

export function bind(root) {
  const rerender = () => { root.innerHTML = render(); bind(root); };
  root.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { fKind = b.dataset.k; rerender(); });
  root.querySelector('[data-manual]').onclick = () => { manualOnly = !manualOnly; rerender(); };
  root.querySelector('[data-done]').onclick = () => { showDone = !showDone; rerender(); };
  root.querySelector('[data-new]')?.addEventListener('click', () => openScheduled(null));
  root.querySelector('[data-export]')?.addEventListener('click', exportProgrammati);
  root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => {
    const key = el.dataset.open;
    if (key.startsWith('s:')) openScheduled(key.slice(2));
    else { const { l, i } = loanOf(key); if (l && i) openInstPay(l, i); }
  });
  root.querySelectorAll('[data-complete]').forEach(b => b.onclick = () => {
    const key = b.dataset.complete;
    if (key.startsWith('s:')) openComplete(key.slice(2));
    else { const { l, i } = loanOf(key); if (l && i) openInstPay(l, i); }
  });
  root.querySelectorAll('[data-reopen]').forEach(b => b.onclick = () => {
    const key = b.dataset.reopen;
    if (key.startsWith('s:')) { const s = data.scheduled.find(x => x.id === key.slice(2)); if (s) { reopenScheduled(s); toast('Riaperto'); } }
    else { const { i } = loanOf(key); if (i) { unpayInst(i); toast('Rata riaperta'); } }
  });
}

// ---- editor programmato ----
export function openScheduled(id) {
  const s = id ? data.scheduled.find(x => x.id === id) : null;
  // Salvare un NUOVO programmato = crea; un ESISTENTE = modifica; eliminarlo = elimina.
  const wSave = id ? can('programmati.modifica') : can('programmati.crea');
  const wDel = !!id && can('programmati.elimina');
  const w = wSave;   // editabilità dei campi del form
  const kind = s?.kind || 'debit';
  const cid = s?.companyId || activeCompany() || data.companies[0]?.id;
  const html = `
    <h2>${id ? 'Modifica programmato' : 'Nuovo programmato'}</h2>
    <div class="chips" id="sc_kind">
      <button class="chip ${kind === 'debit' ? 'on' : ''}" data-k="debit">Addebito</button>
      <button class="chip ${kind === 'credit' ? 'on' : ''}" data-k="credit">Accredito</button>
    </div>
    <div class="field"><label>Importo</label><input id="sc_amt" inputmode="decimal" value="${s && s.amount != null ? String(s.amount).replace('.', ',') : ''}" placeholder="lascia vuoto se non lo conosci ancora" style="font-size:18px;font-weight:700"><div class="muted" style="font-size:12px;margin-top:4px">Vuoto = promemoria senza importo, da definire al completamento.</div></div>
    <div class="frow">
      <div class="field"><label>Data prevista</label><input id="sc_date" type="date" value="${s?.date || todayStr()}"></div>
      <div class="field"><label>Ricorrenza</label><select id="sc_rec"><option value="">Nessuna (una volta)</option>${Object.entries(RECURRENCES).map(([k, r]) => `<option value="${k}" ${s?.recurrence === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Azienda</label><select id="sc_co">${companyOptions(cid)}</select></div>
    <div class="field"><label>Descrizione</label><input id="sc_desc" value="${esc(s?.description || '')}" placeholder="es. RID Enel · Affitto"></div>
    <div id="sc_dyn"></div>
    <div class="field"><label><input type="checkbox" id="sc_manual" ${s?.manual ? 'checked' : ''}> Manuale (da eseguire a mano, evidenziato)</label></div>
    <div class="actions">${wDel ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>${w ? 'Annulla' : 'Chiudi'}</button>${w ? '<button class="btn primary" data-save>Salva</button>' : ''}</div>`;
  openSheet(html, sheet => {
    let curKind = kind;
    const coSel = sheet.querySelector('#sc_co');
    const dyn = sheet.querySelector('#sc_dyn');
    const renderDyn = () => {
      dyn.innerHTML = `<div class="frow">
        <div class="field"><label>Categoria</label><select id="sc_cat">${categoryOptions(txTypeFor(curKind), s?.categoryId)}</select></div>
        <div class="field"><label>Conto</label><select id="sc_acc">${accountOptions(coSel.value, s?.accountId, { allowNone: true, noneLabel: '— da definire —' })}</select></div>
      </div>
      <div class="field"><label>${curKind === 'credit' ? 'Cliente' : 'Fornitore'}</label>${supplierPicker('sc_sup', s?.supplierId, { placeholder: curKind === 'credit' ? 'Cerca cliente…' : 'Cerca fornitore…', noneLabel: curKind === 'credit' ? '— nessun cliente —' : '— nessun fornitore —' })}</div>`;
      bindCombos(dyn);
    };
    renderDyn();
    sheet.querySelectorAll('#sc_kind [data-k]').forEach(b => b.onclick = () => { curKind = b.dataset.k; sheet.querySelectorAll('#sc_kind .chip').forEach(c => c.classList.toggle('on', c.dataset.k === curKind)); renderDyn(); });
    coSel.onchange = renderDyn;
    sheet.querySelector('[data-cancel]').onclick = closeSheet;
    sheet.querySelector('[data-save]')?.addEventListener('click', () => {
      const amount = parseAmount(sheet.querySelector('#sc_amt').value); // null se vuoto → promemoria senza importo
      const rec = {
        kind: curKind, companyId: coSel.value, amount: amount != null ? amount : null, date: sheet.querySelector('#sc_date').value || todayStr(),
        recurrence: sheet.querySelector('#sc_rec').value || null,
        description: sheet.querySelector('#sc_desc').value.trim(), categoryId: sheet.querySelector('#sc_cat').value || null,
        accountId: sheet.querySelector('#sc_acc').value || null, supplierId: sheet.querySelector('#sc_sup').value || null,
        manual: sheet.querySelector('#sc_manual').checked
      };
      if (id) updateScheduled(s, rec); else addScheduled(rec);
      closeSheet(); toast('Programmato salvato ✓');
    });
    if (wDel) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare il programmato?', '', 'Elimina', () => { deleteScheduled(s); closeSheet(); toast('Eliminato'); }, { danger: true });
    // Sola lettura senza programmati.manage: campi e chip inerti, resta solo "Chiudi".
    if (!w) {
      sheet.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
      sheet.querySelectorAll('#sc_kind .chip').forEach(b => { b.disabled = true; });
    }
  });
}

// ---- completamento (crea movimento / abbina esistente / solo completato) ----
function openComplete(id) {
  const s = data.scheduled.find(x => x.id === id); if (!s) return;
  const cands = candidates(s);
  const candHtml = cands.length ? cands.map(t => `<div class="row click" data-pick="${t.id}">
      <div class="emoji">${s.kind === 'credit' ? '⬆️' : '⬇️'}</div>
      <div class="mid"><div class="t1">${esc(txLabel(t))}</div><div class="t2">${fmtDate(t.date)}${acc(t.accountId) ? ' · ' + esc(acc(t.accountId).name) : ''}</div></div>
      <div class="amt tnum">${fmt(t.amount)}</div>
    </div>`).join('') : '';
  const noAmt = !hasAmount(s);
  const recNote = s.recurrence ? ` · 🔁 ${esc(recurLabel(s.recurrence).toLowerCase())}` : '';
  const okToast = s.recurrence ? ' · prossima occorrenza creata' : '';
  const html = `
    <h2>Completa programmato</h2>
    <div class="sheetsub">${esc(s.description || '')} · ${noAmt ? '💶 importo da definire' : (s.kind === 'credit' ? '+' : '−') + fmt(s.amount)} · ${s.date ? fmtDateFull(s.date) : ''}${recNote}</div>
    ${cands.length ? `<div class="section-title">Abbina a un movimento già presente</div><div class="list">${candHtml}</div>` : ''}
    <div class="section-title">Oppure registra ora</div>
    ${noAmt ? `<div class="field"><label>Importo${s.kind === 'credit' ? ' incassato' : ' pagato'}</label><input id="cmp_amt" inputmode="decimal" placeholder="0,00" style="font-size:18px;font-weight:700"></div>` : ''}
    <div class="frow">
      <div class="field"><label>Data</label><input id="cmp_date" type="date" value="${s.date || todayStr()}"></div>
      <div class="field"><label>Conto</label><select id="cmp_acc">${accountOptions(s.companyId, s.accountId, { allowNone: true, noneLabel: '— senza conto —' })}</select></div>
    </div>
    <div class="actions">
      <button class="btn" data-cancel>Annulla</button>
      <button class="btn" data-mark>Solo completato</button>
      <button class="btn primary" data-create>Crea movimento</button>
    </div>`;
  openSheet(html, sheet => {
    sheet.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      const t = data.transactions.find(x => x.id === el.dataset.pick);
      completeWithTx(s, t); closeSheet(); toast('Abbinato e completato ✓' + okToast);
    });
    sheet.querySelector('[data-cancel]').onclick = closeSheet;
    sheet.querySelector('[data-mark]').onclick = () => { completeMarkOnly(s); closeSheet(); toast('Segnato completato ✓' + okToast); };
    sheet.querySelector('[data-create]').onclick = () => {
      let amount;
      if (noAmt) {
        amount = parseAmount(sheet.querySelector('#cmp_amt').value);
        if (!amount) { toast('Inserisci l\'importo'); return; }
      }
      completeWithMovement(s, { date: sheet.querySelector('#cmp_date').value || todayStr(), accountId: sheet.querySelector('#cmp_acc').value || null, amount });
      closeSheet(); toast('Movimento creato e completato ✓' + okToast);
    };
  });
}
