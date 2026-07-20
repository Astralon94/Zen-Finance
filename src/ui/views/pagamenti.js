// ============ Vista "In pagamento" — raggruppata per fornitore + saldo multiplo ============
import { data } from '../../state/store.js';
import { can } from '../../state/auth.js';
import { esc, fmt, fmtDate, todayStr, round2 } from '../../domain/util.js';
import { activeCompany, sup, co, acc, txLabel } from '../../domain/finance.js';
import { invoicesInScope, invResiduo, invSignedResiduo, isCreditNote, invOverdue, isToPay, supNameOf, setToPay, applyBatch } from '../../domain/invoices.js';
import { reconcileMany, batchCandidates, searchFreeMovements } from '../../domain/reconcile.js';
import { openSheet, closeSheet, toast } from '../dom.js';
import { openSepaWizard } from '../sepawizard.js';
import { accountOptions } from '../forms.js';
import { mountPicker } from '../matchpicker.js';
import { openInvoice } from './fatture.js';

// id esplicitamente deselezionati (default: tutte selezionate)
let deselected = new Set();

function groups() {
  const list = invoicesInScope(activeCompany()).filter(isToPay);
  const map = new Map();
  list.forEach(i => {
    const key = i.supplierId || ('free:' + (i.supplierName || '—'));
    if (!map.has(key)) map.set(key, { key, supplierId: i.supplierId, name: supNameOf(i), invoices: [] });
    map.get(key).invoices.push(i);
  });
  return [...map.values()].sort((a, b) => b.invoices.reduce((s, i) => s + invSignedResiduo(i), 0) - a.invoices.reduce((s, i) => s + invSignedResiduo(i), 0));
}
const isSel = id => !deselected.has(id);

export function countToPay(scope) { return invoicesInScope(scope).filter(isToPay).length; }

export function renderBody() {
  const gs = groups();
  const totAll = round2(gs.reduce((s, g) => s + g.invoices.reduce((a, i) => a + invSignedResiduo(i), 0), 0));

  const exportBtn = (gs.length && can('fatture.esporta')) ? `<button class="btn sm" data-sepa title="Esporta bonifici SEPA">🏦 Esporta bonifici</button>` : '';
  let h = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 2px 12px">
      <span class="muted" style="font-size:13px">${gs.length} fornitor${gs.length === 1 ? 'e' : 'i'} · totale ${fmt(totAll)}</span>${exportBtn}</div>`;
  if (!gs.length) {
    h += `<div class="card empty">Nessuna fattura in pagamento.<br><span class="muted">Marca le fatture con ★ dalla sezione Fatture per pianificarne il saldo.</span></div>`;
    return h;
  }

  gs.forEach(g => {
    const s = g.supplierId ? sup(g.supplierId) : null;
    const selInvs = g.invoices.filter(i => isSel(i.id));
    const selTot = round2(selInvs.reduce((a, i) => a + invSignedResiduo(i), 0));
    const grpTot = round2(g.invoices.reduce((a, i) => a + invSignedResiduo(i), 0));
    h += `<div class="list" style="margin-bottom:14px">
      <div class="suphdr">
        <span>🏷️ ${esc(g.name)}</span>
        ${s?.iban ? `<span class="muted" style="font-weight:500;font-size:12px">IBAN ${esc(s.iban)}</span>` : ''}
        <span class="gtot">${fmt(grpTot)}</span>
      </div>`;
    g.invoices.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).forEach(i => {
      const ndc = isCreditNote(i);
      const od = invOverdue(i);
      h += `<div class="row">
        <input type="checkbox" class="selbox" data-pick="${i.id}" ${isSel(i.id) ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">
        <div class="mid" data-open="${i.id}" style="cursor:pointer">
          <div class="t1">${ndc ? '↩️ ' : ''}${i.number ? 'N. ' + esc(i.number) : '(senza numero)'} ${ndc ? '<span class="badge b-paid">nota di credito</span>' : (od ? '<span class="badge b-overdue">scaduta</span>' : '')}</div>
          <div class="t2">${i.date ? fmtDate(i.date) : ''}${!ndc && i.due ? ' · scad. ' + fmtDate(i.due) : ''} · ${esc(co(i.companyId)?.name || '')}</div>
        </div>
        <div class="amt ${ndc ? 'pos' : 'neg'} tnum" data-open="${i.id}" style="cursor:pointer">${ndc ? '+' + fmt(invResiduo(i)) : fmt(invResiduo(i))}</div>
        <button class="btn sm" data-unflag="${i.id}" title="Togli da In pagamento">✕</button>
      </div>`;
    });
    const selNdc = selInvs.filter(isCreditNote).length;
    h += `<div class="row" style="background:var(--card2)">
        <div class="mid"><b>${selInvs.length}</b> selezionate${selNdc ? ` (${selNdc} NDC)` : ''} · netto <span class="tnum">${fmt(selTot)}</span></div>
        <button class="btn sm primary" data-settle="${g.key}" ${selInvs.length ? '' : 'disabled'}>Salda selezionate</button>
      </div>`;
    h += `</div>`;
  });
  return h;
}

export function bindBody(root, rerender) {
  root.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => { cb.checked ? deselected.delete(cb.dataset.pick) : deselected.add(cb.dataset.pick); rerender(); });
  root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openInvoice(el.dataset.open));
  root.querySelectorAll('[data-unflag]').forEach(b => b.onclick = () => { const i = data.invoices.find(x => x.id === b.dataset.unflag); if (i) { setToPay(i, false); toast('Tolta da In pagamento'); } });
  root.querySelectorAll('[data-settle]').forEach(b => b.onclick = () => openSettle(b.dataset.settle));
  root.querySelector('[data-sepa]')?.addEventListener('click', () => openSepaWizard());
}

function openSettle(groupKey) {
  const g = groups().find(x => x.key === groupKey);
  if (!g) return;
  const items = g.invoices.filter(i => isSel(i.id) && invResiduo(i) > 0.005);
  if (!items.length) { toast('Nessuna fattura selezionata'); return; }
  const invs = items.filter(i => !isCreditNote(i));
  const cns = items.filter(isCreditNote);
  const gross = round2(invs.reduce((s, i) => s + invResiduo(i), 0));
  const credit = round2(cns.reduce((s, c) => s + invResiduo(c), 0));
  const net = round2(Math.max(0, gross - credit));
  const cid = items[0].companyId;
  const hasNdc = cns.length > 0;

  openSheet(`
    <h2>Salda ${invs.length} fattur${invs.length === 1 ? 'a' : 'e'}${hasNdc ? ` · ${cns.length} NDC` : ''}</h2>
    <div class="sheetsub">${esc(g.name)}${hasNdc ? ` · fatture ${fmt(gross)} − note di credito ${fmt(credit)} = ` : ' · totale '}<b>${fmt(net)}</b></div>
    <div class="frow">
      <div class="field"><label>Data pagamento</label><input id="b_date" type="date" value="${todayStr()}"></div>
      <div class="field"><label>Conto</label><select id="b_acc">${accountOptions(cid, null, { allowNone: true, noneLabel: '— solo registrazione —' })}</select></div>
    </div>
    ${hasNdc ? '' : `<div class="field"><label>Movimento sul conto</label>
      <div class="chips" id="b_mode">
        <button class="chip on" data-m="cumulative">Un movimento cumulativo</button>
        <button class="chip" data-m="separate">Uno per fattura</button>
      </div>
    </div>`}
    <div class="muted" style="font-size:12px">${hasNdc ? `Le fatture vanno a "pagata", le note di credito a "usata". Il movimento sul conto è il <b>netto ${fmt(net)}</b>.` : 'Ogni fattura selezionata verrà saldata per intero. Con un conto selezionato esce il relativo movimento; scegli "— solo registrazione —" per non crearlo.'}</div>
    ${!hasNdc ? `<div class="section-title">Oppure abbina a un movimento già presente</div>
      <div class="muted" style="font-size:12px;margin-bottom:6px">Es. un bonifico unico già importato che ha pagato queste fatture.</div>
      <div id="bm_picker"></div>` : ''}
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-ok>Conferma saldo</button></div>`,
    sheet => {
      let mode = 'cumulative';
      sheet.querySelectorAll('#b_mode [data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; sheet.querySelectorAll('#b_mode .chip').forEach(c => c.classList.toggle('on', c.dataset.m === mode)); });
      // abbina in blocco a un movimento esistente, con ricerca (selezione singola)
      const bmHost = sheet.querySelector('#bm_picker');
      if (bmHost) {
        const settleToMov = txId => {
          const tx = data.transactions.find(t => t.id === txId); if (!tx) return;
          const ordered = items.slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
          ordered.forEach(i => { i.toPay = false; });
          const r = reconcileMany(tx, ordered);
          ordered.forEach(i => deselected.delete(i.id));
          closeSheet();
          toast(`Abbinato a movimento · ${r.linked} fattur${r.linked === 1 ? 'a' : 'e'}${r.leftover > 0.005 ? ' · residuo movimento ' + fmt(r.leftover) : ''}`);
        };
        mountPicker(bmHost, {
          multi: false,
          placeholder: 'Cerca tra tutti i movimenti non riconciliati…',
          fetch: term => term.trim() ? searchFreeMovements(cid, term, net) : batchCandidates(cid, net),
          id: ({ tx }) => tx.id,
          row: ({ tx, diff }) => `<div class="emoji">⬇️</div>
            <div class="mid"><div class="t1">${esc(txLabel(tx))} ${diff < 0.02 ? '<span class="badge b-unpaid">importo ✓</span>' : ''}</div><div class="t2">${tx.date ? fmtDate(tx.date) : ''}${acc(tx.accountId) ? ' · ' + esc(acc(tx.accountId).name) : ''}</div></div>
            <div class="amt tnum">${fmt(tx.amount)}</div>`,
          empty: term => `<div class="muted" style="padding:10px 2px">${term.trim() ? 'Nessun movimento trovato.' : 'Nessun movimento vicino al totale. Usa la ricerca.'}</div>`,
          onPick: settleToMov
        });
      }
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-ok]').onclick = () => {
        const date = sheet.querySelector('#b_date').value || todayStr();
        const accountId = sheet.querySelector('#b_acc').value || null;
        const r = applyBatch(items, { date, accountId, mode });
        items.forEach(i => deselected.delete(i.id));
        closeSheet();
        toast(r.used ? `${r.paid} fatture saldate · ${r.used} NDC usate ✓` : `${r.paid} fatture saldate ✓`);
      };
    });
}
