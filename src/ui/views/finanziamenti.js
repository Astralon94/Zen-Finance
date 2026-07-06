// ============ Vista Rateizzazioni (mutui, prestiti, leasing, dilazioni) ============
import { data, save, attachmentsReady, addAttachment, readAttachment, deleteAttachment } from '../../state/store.js';
import { esc, fmt, fmtDate, fmtDateFull, parseAmount, todayStr, round2, uid } from '../../domain/util.js';
import { activeCompany, acc, co, txLabel } from '../../domain/finance.js';
import { openSheet, closeSheet, toast, confirmDialog } from '../dom.js';
import { exportTable, scopeLabel, nowStamp } from '../pdf.js';
import { companyOptions, accountOptions, categoryOptions } from '../forms.js';
import { go } from '../app.js';
import {
  loansInScope, insts, instAmount, loanPaid, loanResiduo, paidCount, isInstOverdue, nextDue, overdueInstCount,
  generatePlan, addLoan, updateLoan, deleteLoan, candidates, addMonths, markPreviousPaid,
  payInstWithMovement, payInstWithTx, payInstMarkOnly, unpayInst,
  isManualLoan, PAYMENT_METHOD_LIST
} from '../../domain/loans.js';

const TYPES = ['Mutuo', 'Finanziamento', 'Leasing', 'Prestito', 'Dilazione', 'Altro'];
let currentId = null;

export { overdueInstCount as countOverdue };
// apre la scheda di una rateizzazione (es. da un link in un altro vista)
export function openLoan(id) { currentId = id; go('fin'); }

export function render() {
  const loan = currentId ? data.loans.find(l => l.id === currentId) : null;
  return loan ? detail(loan) : list();
}

// ---------- lista schede ----------
function list() {
  const loans = loansInScope(activeCompany());
  const totRes = round2(loans.reduce((s, l) => s + loanResiduo(l), 0));
  let h = `<div class="pagehead"><h1>Rateizzazioni</h1><span class="sub">${loans.length ? 'debito residuo ' + fmt(totRes) : ''}</span></div>`;
  h += `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-new>+ Nuova rateizzazione</button>${loans.length ? '<button class="btn" data-export-list>⤓ Esporta PDF</button>' : ''}</div>`;
  if (!loans.length) return h + `<div class="card empty">Nessuna rateizzazione.<br><span class="muted">Aggiungi mutui, prestiti, leasing o debiti con il loro piano rate.</span></div>`;
  loans.forEach(l => {
    const tot = insts(l).length, pc = paidCount(l), pct = tot ? Math.round(pc / tot * 100) : 0;
    const nd = nextDue(l);
    const manual = isManualLoan(l);
    const pmBadge = manual ? ' <span class="badge b-partial">✋ manuale</span>' : '';
    const varBadge = l.variableRate ? ' <span class="badge b-unpaid">tasso var.</span>' : '';
    h += `<div class="card click ${manual ? 'manualpay' : ''}" data-loan="${l.id}" style="margin-bottom:12px;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <b>${esc(l.name)}${pmBadge}${varBadge}</b><span class="tnum" style="font-weight:800">${fmt(loanResiduo(l))}</span>
      </div>
      <div class="muted" style="font-size:12.5px">${esc(l.type || 'Finanziamento')}${l.lender ? ' · ' + esc(l.lender) : ''}${l.paymentMethod ? ' · ' + esc(l.paymentMethod) : ''} · ${esc(co(l.companyId)?.name || '')}</div>
      <div class="bar"><i style="width:${pct}%;background:var(--accent)"></i></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${pc}/${tot} rate · ${nd ? 'prossima ' + fmtDate(nd.date) + ' · ' + fmt(nd.amount) : 'estinto ✓'}</div>
    </div>`;
  });
  return h;
}

// ---------- dettaglio ----------
function detail(l) {
  const tot = insts(l).length, pc = paidCount(l);
  const info = (lbl, v) => `<div class="row"><div class="mid t2">${lbl}</div><div class="amt" style="font-weight:600">${v}</div></div>`;
  const kpi = (lbl, v, c = '') => `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val tnum ${c}">${v}</div></div>`;
  let h = `<div class="btnrow" style="margin-bottom:8px"><button class="btn sm" data-back>← Rateizzazioni</button></div>`;
  h += `<div class="pagehead"><h1>${esc(l.name)}</h1><span class="sub">${esc(l.type || '')}</span></div>`;
  h += `<div class="grid k3" style="margin-bottom:8px">
    ${kpi('Debito residuo', fmt(loanResiduo(l)), 'neg')}
    ${kpi('Pagato', fmt(loanPaid(l)), 'pos')}
    ${kpi('Rate', `${pc}/${tot}`)}
  </div>`;
  h += `<div class="list" style="margin-bottom:12px">
    ${info('Ente / banca', esc(l.lender || '—'))}
    ${info('Modalità pagamento', l.paymentMethod ? esc(l.paymentMethod) + (isManualLoan(l) ? ' <span class="badge b-partial">✋ manuale</span>' : ' <span class="badge b-unpaid">automatico</span>') : '—')}
    ${info('Tasso', l.variableRate ? 'Variabile <span class="badge b-unpaid">rate reali</span>' : 'Fisso')}
    ${info('Azienda', esc(co(l.companyId)?.name || '—'))}
    ${info('Conto addebito', esc(acc(l.accountId)?.name || '—'))}
    ${info('Debito totale', l.totalDebt != null ? fmt(l.totalDebt) : '—')}
    ${info('Periodo', `${l.startDate ? fmtDateFull(l.startDate) : '—'} → ${l.endDate ? fmtDateFull(l.endDate) : '—'}`)}
  </div>`;
  h += `<div class="section-title">Piano rate</div>`;
  const list = insts(l).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!list.length) h += `<div class="card empty">Nessuna rata. Modifica la rateizzazione per generare il piano.</div>`;
  else h += `<div class="list">${list.map(i => instRow(l, i)).join('')}</div>`;
  h += `<div class="section-title">Allegati</div>`;
  h += attachmentsBlock(l);
  h += `<div class="btnrow" style="margin-top:12px"><button class="btn" data-edit>Modifica</button><button class="btn" data-export-loan>⤓ PDF</button><button class="btn danger" data-del>Elimina</button></div>`;
  return h;
}

const fmtSize = b => { b = b || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };
function attachmentsBlock(l) {
  const atts = l.attachments || [];
  let h = '';
  if (atts.length) {
    h += `<div class="list">${atts.map(a => `<div class="row">
      <div class="emoji">📎</div>
      <div class="mid" data-att-open="${a.id}" style="cursor:pointer"><div class="t1">${esc(a.name)}</div><div class="t2">${fmtSize(a.size)}${a.addedAt ? ' · ' + new Date(a.addedAt).toLocaleDateString('it-IT') : ''}</div></div>
      <button class="btn sm danger" data-att-del="${a.id}">Elimina</button>
    </div>`).join('')}</div>`;
  } else if (attachmentsReady()) {
    h += `<div class="card empty" style="padding:18px">Nessun allegato.</div>`;
  }
  if (attachmentsReady()) {
    h += `<div class="btnrow" style="margin-top:10px"><button class="btn" data-att-add>+ Aggiungi allegato</button><input type="file" id="att_input" style="display:none"></div>`;
  } else {
    h += `<div class="card empty" style="padding:18px">Allegati non ancora disponibili in questa versione server (in arrivo).</div>`;
  }
  return h;
}

// ---------- export PDF ----------
function exportLoansOverview() {
  const loans = loansInScope(activeCompany());
  if (!loans.length) return;
  const rows = loans.map(l => {
    const tot = insts(l).length, pc = paidCount(l);
    return [l.name, l.type || 'Finanziamento', l.lender || '—', l.paymentMethod || '—', `${pc}/${tot}`, fmt(loanResiduo(l))];
  });
  const totRes = round2(loans.reduce((s, l) => s + loanResiduo(l), 0));
  exportTable({
    title: 'Rateizzazioni — panoramica',
    subtitle: `${scopeLabel()} · ${loans.length} rateizzazioni · debito residuo ${fmt(totRes)} · ${nowStamp()}`,
    sections: [{
      cols: [{ label: 'Nome' }, { label: 'Tipo' }, { label: 'Ente' }, { label: 'Metodo' }, { label: 'Rate', right: true }, { label: 'Residuo', right: true }],
      rows, foot: [['', '', '', '', 'Totale', fmt(totRes)]]
    }]
  });
}
function exportLoan(l) {
  const plan = insts(l).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const tot = plan.length, pc = paidCount(l);
  const statusOf = i => i.status === 'paid' ? 'Pagata' : (isInstOverdue(i) ? 'Scaduta' : 'Da pagare');
  const info = [
    ['Tipo', l.type || '—'], ['Ente / banca', l.lender || '—'], ['Modalità di pagamento', l.paymentMethod || '—'],
    ['Azienda', co(l.companyId)?.name || '—'], ['Conto addebito', acc(l.accountId)?.name || '—'],
    ['Debito totale', l.totalDebt != null ? fmt(l.totalDebt) : '—'],
    ['Periodo', `${l.startDate ? fmtDateFull(l.startDate) : '—'} → ${l.endDate ? fmtDateFull(l.endDate) : '—'}`],
    ['Pagato', fmt(loanPaid(l))], ['Debito residuo', fmt(loanResiduo(l))]
  ];
  exportTable({
    title: `Rateizzazione — ${l.name}`,
    subtitle: `${scopeLabel()} · ${pc}/${tot} rate · ${nowStamp()}`,
    sections: [
      { heading: 'Dati', cols: [{ label: 'Voce' }, { label: 'Valore', right: true }], rows: info },
      {
        heading: 'Piano rate',
        cols: [{ label: '#', right: true }, { label: 'Scadenza' }, { label: 'Importo', right: true }, { label: 'Stato' }, { label: 'Pagata il' }],
        rows: plan.map(i => [String(i.n), i.date ? fmtDateFull(i.date) : '—', fmt(instAmount(i)), statusOf(i), i.paidDate ? fmtDateFull(i.paidDate) : '—']),
        foot: [['', 'Totale', fmt(round2(plan.reduce((s, i) => s + instAmount(i), 0))), '', '']]
      }
    ]
  });
}
function instRow(l, i) {
  const paid = i.status === 'paid', od = isInstOverdue(i);
  const eff = instAmount(i);
  const variance = paid && i.paidAmount != null && Math.abs(round2(i.paidAmount) - round2(i.amount || 0)) > 0.005;
  return `<div class="row ${od ? 'await' : ''}">
    <div class="emoji">${paid ? '✅' : '📅'}</div>
    <div class="mid"><div class="t1">Rata ${i.n}${od ? ' <span class="badge b-overdue">scaduta</span>' : ''}</div>
      <div class="t2">${i.date ? fmtDate(i.date) : ''}${paid && i.paidDate ? ' · pagata ' + fmtDate(i.paidDate) : ''}${variance ? ' · piano ' + fmt(i.amount) : ''}</div></div>
    <div class="amt tnum ${paid ? '' : 'neg'}">${fmt(eff)}</div>
    ${paid ? `<button class="btn sm" data-unpay="${i.id}">↩</button>` : `<button class="btn sm primary" data-pay="${i.id}">✓</button>`}
  </div>`;
}

export function bind(root) {
  const rerender = () => { root.innerHTML = render(); bind(root); };
  root.querySelector('[data-new]')?.addEventListener('click', () => openLoanEditor(null));
  root.querySelector('[data-export-list]')?.addEventListener('click', exportLoansOverview);
  root.querySelectorAll('[data-loan]').forEach(el => el.onclick = () => { currentId = el.dataset.loan; rerender(); });
  root.querySelector('[data-back]')?.addEventListener('click', () => { currentId = null; rerender(); });
  const loan = currentId ? data.loans.find(l => l.id === currentId) : null;
  if (loan) {
    root.querySelector('[data-edit]')?.addEventListener('click', () => openLoanEditor(loan.id));
    root.querySelector('[data-export-loan]')?.addEventListener('click', () => exportLoan(loan));
    root.querySelector('[data-del]')?.addEventListener('click', () => confirmDialog('Eliminare la rateizzazione?', 'Verranno rimossi anche i movimenti delle rate creati da qui.', 'Elimina', () => { deleteLoan(loan); currentId = null; rerender(); toast('Eliminato'); }, { danger: true }));
    root.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => openInstPay(loan, insts(loan).find(i => i.id === b.dataset.pay)));
    root.querySelectorAll('[data-unpay]').forEach(b => b.onclick = () => { unpayInst(insts(loan).find(i => i.id === b.dataset.unpay)); toast('Rata riaperta'); rerender(); });
    // allegati
    const attInput = root.querySelector('#att_input');
    root.querySelector('[data-att-add]')?.addEventListener('click', () => attInput?.click());
    if (attInput) attInput.onchange = async () => {
      const f = attInput.files[0]; attInput.value = '';
      if (!f) return;
      toast('Caricamento…');
      const r = await addAttachment(f);
      if (!r.ok) { toast('Caricamento allegato non riuscito'); return; }
      loan.attachments = (loan.attachments || []).concat(r.meta);
      save(); toast('Allegato aggiunto ✓');
    };
    root.querySelectorAll('[data-att-open]').forEach(el => el.onclick = async () => {
      const a = (loan.attachments || []).find(x => x.id === el.dataset.attOpen);
      if (!a) return;
      const file = await readAttachment(a);
      if (!file) { toast('File non trovato nella cartella'); return; }
      const url = URL.createObjectURL(file);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    root.querySelectorAll('[data-att-del]').forEach(b => b.onclick = () => {
      const a = (loan.attachments || []).find(x => x.id === b.dataset.attDel);
      if (!a) return;
      confirmDialog('Eliminare l\'allegato?', a.name, 'Elimina', async () => {
        await deleteAttachment(a);
        loan.attachments = (loan.attachments || []).filter(x => x.id !== a.id);
        save(); toast('Allegato eliminato');
      }, { danger: true });
    });
  }
}

// ---------- editor finanziamento ----------
function openLoanEditor(id) {
  const l = id ? data.loans.find(x => x.id === id) : null;
  const cid = l?.companyId || activeCompany() || data.companies[0]?.id;
  const typeOpts = TYPES.map(t => `<option ${l?.type === t ? 'selected' : ''}>${t}</option>`).join('');
  const pmOpts = ['<option value="">— da definire —</option>']
    .concat(PAYMENT_METHOD_LIST.map(m => `<option ${l?.paymentMethod === m ? 'selected' : ''}>${m}</option>`)).join('');
  const html = `
    <h2>${id ? 'Modifica rateizzazione' : 'Nuova rateizzazione'}</h2>
    <div class="frow">
      <div class="field"><label>Nome</label><input id="l_name" value="${esc(l?.name || '')}" placeholder="es. Mutuo sede"></div>
      <div class="field" style="flex:0 0 130px"><label>Tipo</label><select id="l_type">${typeOpts}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Ente / banca</label><input id="l_lender" value="${esc(l?.lender || '')}" placeholder="es. Intesa Sanpaolo"></div>
      <div class="field" style="flex:0 0 190px"><label>Modalità di pagamento</label><select id="l_pm">${pmOpts}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Azienda</label><select id="l_co">${companyOptions(cid)}</select></div>
      <div class="field"><label>Conto addebito</label><select id="l_acc">${accountOptions(cid, l?.accountId, { allowNone: true, noneLabel: '— da definire —' })}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Debito totale</label><input id="l_tot" inputmode="decimal" value="${l?.totalDebt != null ? String(l.totalDebt).replace('.', ',') : ''}"></div>
      <div class="field"><label>Categoria movimenti</label><select id="l_cat">${categoryOptions('expense', l?.categoryId || 'c-ban')}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Data inizio</label><input id="l_start" type="date" value="${l?.startDate || todayStr()}"></div>
      <div class="field"><label>Scadenza</label><input id="l_end" type="date" value="${l?.endDate || ''}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="l_variable" ${l?.variableRate ? 'checked' : ''}> Tasso variabile — l'importo effettivo delle rate può differire dal piano (la rata eredita l'importo del movimento)</label></div>
    <div class="section-title">Piano rate</div>
    <div class="frow">
      <div class="field"><label>N. rate</label><input id="p_count" inputmode="numeric" placeholder="es. 60"></div>
      <div class="field"><label>Importo rata</label><input id="p_amt" inputmode="decimal" placeholder="0,00"></div>
    </div>
    <div class="frow">
      <div class="field"><label>1ª scadenza</label><input id="p_first" type="date" value="${l?.startDate || todayStr()}"></div>
      <div class="field" style="flex:0 0 130px"><label>Ogni (mesi)</label><input id="p_freq" inputmode="numeric" value="1"></div>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:6px">Genera un piano uniforme, oppure aggiungi/modifica le rate a mano qui sotto (per importi non omogenei).</div>
    <div class="btnrow"><button class="btn" data-gen>Genera piano uniforme</button><span class="muted" id="p_info" style="align-self:center;font-size:12.5px"></span></div>
    <div id="p_list" style="margin-top:10px;max-height:34vh;overflow:auto"></div>
    <div class="btnrow" style="margin-top:6px"><button class="btn sm" data-addrata>+ Aggiungi rata</button></div>
    <div class="field" style="margin-top:8px"><label>Note</label><input id="l_note" value="${esc(l?.notes || '')}"></div>
    <div class="actions">${id ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`;
  openSheet(html, sheet => {
    const g = x => sheet.querySelector(x);
    let plan = l ? insts(l).map(i => ({ ...i })) : [];   // copia profonda: niente modifiche live su Annulla
    const renumber = () => plan.forEach((i, k) => i.n = k + 1);
    const info = () => { g('#p_info').textContent = plan.length ? `${plan.length} rate · totale ${fmt(plan.reduce((s, i) => s + (i.amount || 0), 0))}` : 'nessun piano'; };
    const renderList = () => {
      renumber();
      g('#p_list').innerHTML = plan.length ? plan.map((i, idx) => `<div class="frow" style="gap:6px;align-items:center;margin-bottom:6px">
        <span class="muted tnum" style="flex:0 0 24px;text-align:right">${i.n}</span>
        <input type="date" data-pd="${idx}" value="${i.date || ''}" style="flex:1;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:7px 9px">
        <input inputmode="decimal" data-pa="${idx}" value="${i.amount != null ? String(i.amount).replace('.', ',') : ''}" placeholder="0,00" style="flex:0 0 96px;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:7px 9px;text-align:right">
        ${i.status === 'paid' ? '<span class="badge b-paid">pagata</span>' : `<button type="button" class="btn sm" data-prm="${idx}">✕</button>`}
      </div>`).join('') : '<div class="muted" style="font-size:12.5px;padding:4px 2px">Nessuna rata: genera un piano o aggiungile a mano.</div>';
      g('#p_list').querySelectorAll('[data-pd]').forEach(el => el.onchange = () => { plan[+el.dataset.pd].date = el.value; });
      g('#p_list').querySelectorAll('[data-pa]').forEach(el => el.onchange = () => { const v = parseAmount(el.value); if (v != null) plan[+el.dataset.pa].amount = v; info(); });
      g('#p_list').querySelectorAll('[data-prm]').forEach(el => el.onclick = () => { plan.splice(+el.dataset.prm, 1); renderList(); info(); });
      info();
    };
    renderList();
    g('[data-addrata]').onclick = () => {
      const last = plan[plan.length - 1];
      plan.push({ id: uid(), n: plan.length + 1, date: last?.date ? addMonths(last.date, 1) : (g('#p_first').value || todayStr()), amount: last?.amount ?? (parseAmount(g('#p_amt').value) || 0), status: 'pending', paidDate: null, txId: null });
      renderList();
    };
    g('[data-gen]').onclick = () => {
      const count = parseInt(g('#p_count').value, 10), amount = parseAmount(g('#p_amt').value), first = g('#p_first').value, freq = Math.max(1, parseInt(g('#p_freq').value, 10) || 1);
      if (!count || !amount || !first) { toast('Compila n. rate, importo e 1ª scadenza'); return; }
      const apply = () => { plan = generatePlan({ count, firstDate: first, amount, freqMonths: freq }); if (!g('#l_end').value) g('#l_end').value = plan[plan.length - 1].date; if (!g('#l_tot').value) g('#l_tot').value = String(round2(count * amount)).replace('.', ','); renderList(); toast('Piano generato'); };
      if (plan.some(i => i.status === 'paid')) confirmDialog('Rigenerare il piano?', 'Ci sono rate già pagate: verranno sostituite.', 'Rigenera', apply, { danger: true });
      else apply();
    };
    g('[data-cancel]').onclick = closeSheet;
    g('[data-save]').onclick = () => {
      const name = g('#l_name').value.trim(); if (!name) { toast('Inserisci il nome'); return; }
      plan.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')); plan.forEach((i, k) => i.n = k + 1);
      const rec = {
        name, type: g('#l_type').value, lender: g('#l_lender').value.trim(),
        paymentMethod: g('#l_pm').value || null, variableRate: g('#l_variable').checked,
        companyId: g('#l_co').value, accountId: g('#l_acc').value || null, categoryId: g('#l_cat').value || 'c-ban',
        totalDebt: parseAmount(g('#l_tot').value), startDate: g('#l_start').value || null, endDate: g('#l_end').value || null,
        notes: g('#l_note').value.trim(), installments: plan
      };
      if (id) updateLoan(l, rec); else { const nl = addLoan(rec); currentId = nl.id; }
      closeSheet(); toast('Rateizzazione salvata ✓');    };
    if (id) g('[data-del]')?.addEventListener('click', () => confirmDialog('Eliminare la rateizzazione?', 'Verranno rimossi anche i movimenti delle rate creati da qui.', 'Elimina', () => { deleteLoan(l); currentId = null; closeSheet(); toast('Eliminato'); }, { danger: true }));
  });
}

// ---------- pagamento rata ----------
export function openInstPay(l, i) {
  if (!i) return;
  const cands = candidates(l, i);
  const candHtml = cands.map(t => `<div class="row click" data-pick="${t.id}">
      <div class="emoji">⬇️</div>
      <div class="mid"><div class="t1">${esc(txLabel(t))}</div><div class="t2">${fmtDate(t.date)}${acc(t.accountId) ? ' · ' + esc(acc(t.accountId).name) : ''}</div></div>
      <div class="amt tnum">${fmt(t.amount)}</div>
    </div>`).join('');
  // quante rate precedenti (cronologiche) sono ancora da pagare
  const ordered = insts(l).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.n - b.n));
  const prevPending = ordered.slice(0, Math.max(0, ordered.findIndex(x => x.id === i.id))).filter(x => x.status !== 'paid').length;
  openSheet(`
    <h2>Paga rata ${i.n}</h2>
    <div class="sheetsub">${esc(l.name)} · piano ${fmt(i.amount)}${l.variableRate ? ' <span class="badge b-unpaid">tasso var.</span>' : ''} · ${i.date ? fmtDateFull(i.date) : ''}</div>
    ${prevPending ? `<div class="field"><label><input type="checkbox" id="ip_prev"> Segna pagate anche le ${prevPending} rate precedenti (storico, senza movimento)</label></div>` : ''}
    ${cands.length ? `<div class="section-title">Abbina a un movimento già presente</div>${l.variableRate ? '<div class="muted" style="font-size:12px;margin:0 2px 6px">La rata erediterà l\'importo del movimento selezionato.</div>' : ''}<div class="list">${candHtml}</div>` : ''}
    <div class="section-title">Oppure registra ora</div>
    ${l.variableRate ? `<div class="field"><label>Importo effettivo</label><input id="ip_amt" inputmode="decimal" value="${String(i.amount).replace('.', ',')}" style="font-size:16px;font-weight:700"></div>` : ''}
    <div class="frow">
      <div class="field"><label>Data</label><input id="ip_date" type="date" value="${i.date || todayStr()}"></div>
      <div class="field"><label>Conto</label><select id="ip_acc">${accountOptions(l.companyId, l.accountId, { allowNone: true, noneLabel: '— senza conto —' })}</select></div>
    </div>
    <div class="actions">
      <button class="btn" data-cancel>Annulla</button>
      <button class="btn" data-mark>Solo pagata</button>
      <button class="btn primary" data-create>Crea movimento</button>
    </div>`, sheet => {
    const doPrev = () => { if (sheet.querySelector('#ip_prev')?.checked) markPreviousPaid(l, i); };
    sheet.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => { payInstWithTx(l, i, data.transactions.find(t => t.id === el.dataset.pick)); doPrev(); closeSheet(); toast('Abbinata e pagata ✓'); });
    sheet.querySelector('[data-cancel]').onclick = closeSheet;
    sheet.querySelector('[data-mark]').onclick = () => { payInstMarkOnly(i); doPrev(); closeSheet(); toast('Rata segnata pagata ✓'); };
    sheet.querySelector('[data-create]').onclick = () => {
      const amount = l.variableRate ? (parseAmount(sheet.querySelector('#ip_amt').value) ?? undefined) : undefined;
      payInstWithMovement(l, i, { date: sheet.querySelector('#ip_date').value || todayStr(), accountId: sheet.querySelector('#ip_acc').value || null, amount });
      doPrev(); closeSheet(); toast('Movimento creato, rata pagata ✓');
    };
  });
}
