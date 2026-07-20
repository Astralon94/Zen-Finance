// ============ Wizard export bonifici SEPA (CBI / pain.001) ============
// Dalla vista "In pagamento": seleziona i fornitori, imposta l'ordinante e i parametri,
// genera il file XML da caricare sull'home banking. Opzionalmente registra i pagamenti.
// La generazione XML è delegata al modulo puro domain/sepa.js.

import { data, save, getInvoiceXml } from '../state/store.js';
import { esc, fmt, round2, todayStr, pad2, uid, fmtDateLong } from '../domain/util.js';
import { activeCompany, co, sup, accKind } from '../domain/finance.js';
import { invoicesInScope, invResiduo, isCreditNote, isToPay, supNameOf, batchSettle, applyBatch } from '../domain/invoices.js';
import { parseFatturaPA } from '../importers/fatturapa.js';
import { generateSepaXml, validIban, normalizeIban, sepaField } from '../domain/sepa.js';
import { openSheet, closeSheet, toast } from './dom.js';

let sheet, step, W;

// ---- utilità locali ----
function tomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
const isWeekend = d => { const day = new Date(d + 'T00:00:00').getDay(); return day === 0 || day === 6; };
const defaultUnicoCausale = g => 'Fatture ' + g.invs.map(i => i.number).filter(Boolean).join(', ');
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sanitizeFileName(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'azienda'; }

// ---- costruzione gruppi dai "In pagamento" dell'azienda attiva ----
function buildGroups() {
  const list = invoicesInScope(activeCompany()).filter(isToPay);
  const map = new Map();
  list.forEach(i => {
    const key = i.supplierId || ('free:' + (i.supplierName || '—'));
    if (!map.has(key)) map.set(key, { key, supplierId: i.supplierId, name: supNameOf(i), invs: [], ndc: [] });
    (isCreditNote(i) ? map.get(key).ndc : map.get(key).invs).push(i);
  });
  // solo gruppi con almeno una fattura da pagare (quelli con sole NDC non generano bonifici)
  const groups = [...map.values()].filter(g => g.invs.length > 0);
  groups.forEach(g => {
    const s = g.supplierId ? sup(g.supplierId) : null;
    g.iban = s?.iban ? normalizeIban(s.iban) : '';
    g.ibanFromAnag = !!s?.iban;
    g.selected = true;
    g.mode = 'per';                          // default: un bonifico per fattura
    g.manualCausale = defaultUnicoCausale(g); // prefill per la modalità "unico"
  });
  return groups;
}

// Prova a recuperare l'IBAN dagli XML FatturaPA delle fatture del gruppo (lazy, asincrono).
async function prefillIbanFromXml(g) {
  const cands = g.invs.concat(g.ndc).filter(i => i.source === 'xml');
  for (const i of cands) {
    try {
      const xml = await getInvoiceXml(i.id);
      if (!xml) continue;
      const p = parseFatturaPA(xml);
      if (p && p.iban && validIban(p.iban)) return normalizeIban(p.iban);
    } catch (e) { /* ignora */ }
  }
  return '';
}

// ============ API ============
export function openSepaWizard() {
  const groups = buildGroups();
  if (!groups.length) { toast('Nessuna fattura da pagare'); return; }
  step = 1;
  const company = co(activeCompany());
  // ordinante: preseleziona il primo conto bancario dell'azienda con IBAN
  const banks = data.accounts.filter(a => a.companyId === activeCompany() && (accKind(a) === 'standard' || accKind(a) === 'prepaid'));
  const withIban = banks.find(a => a.iban && validIban(a.iban)) || banks[0] || null;
  W = {
    groups,
    accountId: withIban?.id || '',
    accountIban: withIban?.iban ? normalizeIban(withIban.iban) : '',
    execDate: tomorrowStr(),
    format: 'cbi',
    cbiVersion: '00.04.01',
    cuc: (company?.cuc || '').toUpperCase(),
    batchBooking: true,
    registerPayments: false
  };
  sheet = openSheet('<div id="wiz"></div>', () => render());
  // avvia il recupero IBAN dagli XML per i gruppi senza IBAN
  W.groups.filter(g => !g.iban).forEach(async g => {
    const ib = await prefillIbanFromXml(g);
    if (ib && !g.iban) { g.iban = ib; if (step === 1) render(); }
  });
}

// ============ render dispatcher ============
function render() {
  if (step === 1) renderStep1();
  else if (step === 2) renderStep2();
  else renderStep3();
}
const stepBar = n => `<div class="muted" style="font-size:12px;margin-bottom:8px">Passo ${n} di 3</div>`;

// ============ PASSO 1 — selezione e modalità per fornitore ============
function renderStep1() {
  let h = `${stepBar(1)}<h2>🏦 Esporta bonifici</h2>
    <div class="sheetsub">Seleziona i fornitori da pagare e la modalità del bonifico.</div>`;
  W.groups.forEach(g => {
    const gross = round2(g.invs.reduce((s, i) => s + invResiduo(i), 0));
    const credit = round2(g.ndc.reduce((s, c) => s + invResiduo(c), 0));
    const multi = g.invs.length >= 2;
    const net = round2(gross - credit);
    const ibanValid = validIban(g.iban);
    h += `<div class="list" style="margin-bottom:12px" data-grp="${esc(g.key)}">
      <div class="suphdr">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" class="selbox" data-gsel="${esc(g.key)}" ${g.selected ? 'checked' : ''} style="width:18px;height:18px">
          <span>🏷️ ${esc(g.name)}</span>
        </label>
        <span class="gtot">${fmt(gross)}${credit > 0.005 ? ` <span class="muted" style="font-size:11px">− NDC ${fmt(credit)}</span>` : ''}</span>
      </div>`;
    // righe fatture
    g.invs.forEach(i => { h += `<div class="row"><div class="mid"><div class="t1">${i.number ? 'N. ' + esc(i.number) : '(senza numero)'}</div><div class="t2">${i.date ? fmtDateLong(i.date) : ''}</div></div><div class="amt neg tnum">${fmt(invResiduo(i))}</div></div>`; });
    g.ndc.forEach(c => { h += `<div class="row" style="opacity:.7"><div class="mid"><div class="t1">↩️ ${c.number ? 'N. ' + esc(c.number) : 'NDC'} <span class="badge b-paid">nota di credito</span></div></div><div class="amt pos tnum">+${fmt(invResiduo(c))}</div></div>`; });
    // scelta modalità (solo con 2+ fatture)
    if (multi) {
      h += `<div class="row" style="background:var(--card2)"><div class="mid" style="width:100%">
        <div class="chips" data-gmode="${esc(g.key)}" style="margin-bottom:6px">
          <button class="chip ${g.mode === 'per' ? 'on' : ''}" data-m="per">Un bonifico per fattura</button>
          <button class="chip ${g.mode === 'unico' ? 'on' : ''}" data-m="unico">Un bonifico unico</button>
        </div>`;
      if (g.mode === 'unico') {
        if (net <= 0.005) {
          h += `<div class="muted" style="font-size:12px;color:var(--neg)">Netto ≤ 0 (le note di credito coprono le fatture): questo gruppo verrà escluso.</div>`;
        } else {
          const prev = sepaField(g.manualCausale, 140);
          h += `<label style="font-size:12px;font-weight:600">Causale (obbligatoria)</label>
            <textarea class="gcausale" data-gcaus="${esc(g.key)}" rows="2" maxlength="180" style="width:100%;resize:vertical">${esc(g.manualCausale)}</textarea>
            <div class="muted" style="font-size:11px"><span data-ccount="${esc(g.key)}">${prev.length}</span>/140 · anteprima: <span data-cprev="${esc(g.key)}">${esc(prev) || '—'}</span></div>`;
        }
      } else {
        h += `<div class="muted" style="font-size:11.5px">Causale automatica per ciascuna fattura.${g.ndc.length ? ' Le note di credito non generano bonifici (da compensare a mano).' : ''}</div>`;
      }
      h += `</div></div>`;
    } else if (g.ndc.length) {
      h += `<div class="row" style="background:var(--card2)"><div class="muted" style="font-size:11.5px">Le note di credito non generano bonifici (da compensare a mano).</div></div>`;
    }
    // IBAN
    if (g.ibanFromAnag && ibanValid) {
      h += `<div class="row" style="background:var(--card2)"><div class="muted" style="font-size:12px">IBAN ${esc(g.iban)} <span class="badge b-paid">✓</span></div></div>`;
    } else {
      h += `<div class="row" style="background:var(--card2)"><div class="mid" style="width:100%">
        <label style="font-size:12px;font-weight:600">IBAN beneficiario (obbligatorio)</label>
        <input class="gib" data-gib="${esc(g.key)}" value="${esc(g.iban)}" placeholder="IT.." style="width:100%">
        <div class="muted" style="font-size:11px" data-gibmsg="${esc(g.key)}">${g.iban ? (ibanValid ? '✓ valido' : '⚠️ IBAN non valido') : 'Un fornitore senza IBAN non può essere selezionato.'}</div>
      </div></div>`;
    }
    h += `</div>`;
  });
  h += `<div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-next>Avanti</button></div>`;
  sheet.innerHTML = h;
  bindStep1();
}

function bindStep1() {
  sheet.querySelector('[data-cancel]').onclick = closeSheet;
  const G = k => W.groups.find(g => g.key === k);
  sheet.querySelectorAll('[data-gsel]').forEach(cb => cb.onchange = () => { G(cb.dataset.gsel).selected = cb.checked; render(); });
  sheet.querySelectorAll('[data-gmode] [data-m]').forEach(b => b.onclick = () => { G(b.closest('[data-gmode]').dataset.gmode).mode = b.dataset.m; render(); });
  sheet.querySelectorAll('[data-gcaus]').forEach(ta => ta.oninput = () => {
    const g = G(ta.dataset.gcaus); g.manualCausale = ta.value;
    const prev = sepaField(g.manualCausale, 140);
    const cnt = sheet.querySelector(`[data-ccount="${g.key}"]`); if (cnt) cnt.textContent = prev.length;
    const pv = sheet.querySelector(`[data-cprev="${g.key}"]`); if (pv) pv.textContent = prev || '—';
  });
  sheet.querySelectorAll('[data-gib]').forEach(inp => inp.oninput = () => {
    const g = G(inp.dataset.gib); g.iban = normalizeIban(inp.value);
    const msg = sheet.querySelector(`[data-gibmsg="${g.key}"]`);
    if (msg) msg.textContent = g.iban ? (validIban(g.iban) ? '✓ valido' : '⚠️ IBAN non valido') : 'Un fornitore senza IBAN non può essere selezionato.';
  });
  sheet.querySelector('[data-next]').onclick = () => {
    const sel = W.groups.filter(g => g.selected);
    if (!sel.length) { toast('Seleziona almeno un fornitore'); return; }
    // ogni gruppo selezionato deve avere IBAN valido
    const noIban = sel.find(g => !validIban(g.iban));
    if (noIban) { toast(`IBAN mancante o non valido: ${noIban.name}`); return; }
    // modalità unico: causale obbligatoria e netto > 0
    for (const g of sel) {
      if (g.mode === 'unico') {
        const net = round2(g.invs.reduce((s, i) => s + invResiduo(i), 0) - g.ndc.reduce((s, c) => s + invResiduo(c), 0));
        if (net > 0.005 && !sepaField(g.manualCausale, 140)) { toast(`Inserisci la causale per ${g.name}`); return; }
      }
    }
    persistIbans(sel);   // salva gli IBAN in anagrafica (e crea i fornitori mancanti)
    step = 2; render();
  };
}

// Salva gli IBAN sui fornitori; per le fatture a nome libero crea il record fornitore e lo aggancia.
function persistIbans(sel) {
  let dirty = false;
  sel.forEach(g => {
    if (!validIban(g.iban)) return;
    if (g.supplierId) {
      const s = sup(g.supplierId);
      if (s && normalizeIban(s.iban || '') !== g.iban) { s.iban = g.iban; dirty = true; }
    } else {
      const rec = { id: uid(), type: 'supplier', name: g.name, iban: g.iban };
      data.suppliers.push(rec);
      g.invs.concat(g.ndc).forEach(i => { i.supplierId = rec.id; delete i.supplierName; });
      g.supplierId = rec.id; g.ibanFromAnag = true; dirty = true;
    }
  });
  if (dirty) save();
}

// ============ PASSO 2 — parametri ============
function renderStep2() {
  const cid = activeCompany();
  const banks = data.accounts.filter(a => a.companyId === cid && (accKind(a) === 'standard' || accKind(a) === 'prepaid'));
  const accOpts = banks.map(a => `<option value="${a.id}" ${W.accountId === a.id ? 'selected' : ''}>${esc((a.emoji || '🏦') + ' ' + a.name)}${a.iban ? '' : ' (no IBAN)'}</option>`).join('');
  const chosen = banks.find(a => a.id === W.accountId);
  const chosenHasIban = chosen && chosen.iban && validIban(chosen.iban);
  const dateWarn = W.execDate < todayStr() ? '⚠️ data nel passato' : (isWeekend(W.execDate) ? '⚠️ è un weekend: l\'esecuzione slitterà al giorno lavorativo successivo' : '');

  let h = `${stepBar(2)}<h2>Parametri del bonifico</h2>
    <div class="field"><label>Conto ordinante</label><select id="w_acc">${accOpts || '<option value="">— nessun conto bancario —</option>'}</select></div>`;
  if (!chosenHasIban) {
    h += `<div class="field"><label>IBAN ordinante (obbligatorio)</label><input id="w_accib" value="${esc(chosen?.iban || W.accountIban || '')}" placeholder="IT..">
      <div class="muted" style="font-size:11px" id="w_accibmsg"></div></div>`;
  } else {
    h += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">IBAN ${esc(normalizeIban(chosen.iban))} <span class="badge b-paid">✓</span></div>`;
  }
  h += `<div class="field"><label>Data esecuzione</label><input id="w_date" type="date" value="${W.execDate}">
      ${dateWarn ? `<div class="muted" style="font-size:11px">${dateWarn}</div>` : ''}</div>
    <div class="field"><label>Formato</label>
      <div class="chips" id="w_fmt">
        <button class="chip ${W.format === 'cbi' ? 'on' : ''}" data-f="cbi">CBI (consigliato)</button>
        <button class="chip ${W.format === 'pain001' ? 'on' : ''}" data-f="pain001">pain.001</button>
      </div>
    </div>`;
  if (W.format === 'cbi') {
    h += `<div class="frow">
      <div class="field"><label>CUC <span class="muted" style="font-weight:400">(obbligatorio per CBI)</span></label><input id="w_cuc" value="${esc(W.cuc)}" placeholder="es. ABCD1234"></div>
      <div class="field"><label>Tracciato</label><select id="w_ver"><option value="00.04.01" ${W.cbiVersion === '00.04.01' ? 'selected' : ''}>CBI 00.04.01</option><option value="00.04.00" ${W.cbiVersion === '00.04.00' ? 'selected' : ''}>CBI 00.04.00</option></select></div>
    </div>
    ${!W.cuc ? '<div class="muted" style="font-size:11.5px;color:var(--neg)">Senza CUC il tracciato CBI non è valido: inserisci il CUC o scegli il formato pain.001.</div>' : ''}`;
  }
  h += `<div class="field"><label>Addebito sul conto</label>
      <div class="chips" id="w_batch">
        <button class="chip ${W.batchBooking ? 'on' : ''}" data-b="1">Unico cumulativo</button>
        <button class="chip ${!W.batchBooking ? 'on' : ''}" data-b="0">Un addebito per bonifico</button>
      </div>
    </div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="w_reg" ${W.registerPayments ? 'checked' : ''} style="width:18px;height:18px">
      Registra i pagamenti e salda le fatture</label>
      <div class="muted" style="font-size:11px">Dopo il download registra i pagamenti sul conto ordinante alla data di esecuzione.</div></div>
    <div class="actions"><button class="btn" data-back>Indietro</button><button class="btn primary" data-next>Avanti</button></div>`;
  sheet.innerHTML = h;
  bindStep2();
}

function bindStep2() {
  const q = x => sheet.querySelector(x);
  const cid = activeCompany();
  const banks = data.accounts.filter(a => a.companyId === cid && (accKind(a) === 'standard' || accKind(a) === 'prepaid'));
  q('#w_acc').onchange = () => { W.accountId = q('#w_acc').value; render(); };
  const ibIn = q('#w_accib');
  if (ibIn) ibIn.oninput = () => { W.accountIban = normalizeIban(ibIn.value); const m = q('#w_accibmsg'); if (m) m.textContent = W.accountIban ? (validIban(W.accountIban) ? '✓ valido' : '⚠️ IBAN non valido') : ''; };
  q('#w_date').onchange = () => { W.execDate = q('#w_date').value || tomorrowStr(); render(); };
  sheet.querySelectorAll('#w_fmt [data-f]').forEach(b => b.onclick = () => { W.format = b.dataset.f; render(); });
  const cuc = q('#w_cuc'); if (cuc) cuc.oninput = () => { W.cuc = cuc.value.toUpperCase(); };
  const ver = q('#w_ver'); if (ver) ver.onchange = () => { W.cbiVersion = ver.value; };
  sheet.querySelectorAll('#w_batch [data-b]').forEach(b => b.onclick = () => { W.batchBooking = b.dataset.b === '1'; render(); });
  q('#w_reg').onchange = () => { W.registerPayments = q('#w_reg').checked; };
  q('[data-back]').onclick = () => { step = 1; render(); };
  q('[data-next]').onclick = () => {
    const chosen = banks.find(a => a.id === W.accountId);
    if (!chosen) { toast('Scegli il conto ordinante'); return; }
    // IBAN ordinante: da anagrafica o inline
    let iban = (chosen.iban && validIban(chosen.iban)) ? normalizeIban(chosen.iban) : W.accountIban;
    if (!validIban(iban)) { toast('IBAN ordinante mancante o non valido'); return; }
    W.accountIban = iban;
    // salva l'IBAN sul conto se inserito a mano
    if (normalizeIban(chosen.iban || '') !== iban) { chosen.iban = iban; save(); }
    if (W.format === 'cbi' && !W.cuc.trim()) { toast('Inserisci il CUC o scegli pain.001'); return; }
    // salva il CUC sull'azienda se cambiato
    const company = co(cid);
    if (company && (company.cuc || '') !== W.cuc.trim()) { company.cuc = W.cuc.trim(); save(); }
    step = 3; render();
  };
}

// ============ PASSO 3 — riepilogo e genera ============
function buildPlan() {
  const txs = [], warnings = [];
  let seq = 0;
  W.groups.filter(g => g.selected).forEach(g => {
    const gross = round2(g.invs.reduce((s, i) => s + invResiduo(i), 0));
    if (g.mode === 'unico') {
      const credit = round2(g.ndc.reduce((s, c) => s + invResiduo(c), 0));
      const net = round2(gross - credit);
      if (net <= 0.005) { warnings.push(`${g.name}: netto ≤ 0, gruppo escluso.`); return; }
      txs.push({ group: g, endToEndId: g.invs[0].number || ('B' + (++seq)), amount: net, creditorName: g.name, creditorIban: g.iban, remittance: sepaField(g.manualCausale, 140) });
    } else {
      if (g.ndc.length) warnings.push(`${g.name}: ${g.ndc.length} nota/e di credito escluse (da compensare a mano).`);
      g.invs.forEach(i => {
        txs.push({ group: g, endToEndId: i.number || ('B' + (++seq)), amount: invResiduo(i), creditorName: g.name, creditorIban: g.iban, remittance: sepaField(`Fattura nr ${i.number || ''} del ${fmtDateLong(i.date)}`, 140) });
      });
    }
  });
  return { txs, warnings };
}

function renderStep3() {
  const { txs, warnings } = buildPlan();
  const total = round2(txs.reduce((s, t) => s + t.amount, 0));
  let h = `${stepBar(3)}<h2>Riepilogo</h2>
    <div class="sheetsub">${txs.length} bonific${txs.length === 1 ? 'o' : 'i'} · totale ${fmt(total)} · formato ${W.format === 'cbi' ? 'CBI ' + W.cbiVersion : 'pain.001'}</div>`;
  if (warnings.length) h += `<div class="card" style="background:var(--card2);font-size:12px;margin-bottom:10px">${warnings.map(w => '⚠️ ' + esc(w)).join('<br>')}</div>`;
  if (!txs.length) {
    h += `<div class="card empty">Nessun bonifico da generare.</div>
      <div class="actions"><button class="btn" data-back>Indietro</button></div>`;
    sheet.innerHTML = h; sheet.querySelector('[data-back]').onclick = () => { step = 2; render(); };
    return;
  }
  h += `<div class="list">`;
  txs.forEach(t => {
    h += `<div class="row"><div class="mid"><div class="t1">${esc(t.creditorName)}</div><div class="t2">${esc(t.creditorIban)} · ${esc(t.remittance)}</div></div><div class="amt neg tnum">${fmt(t.amount)}</div></div>`;
  });
  h += `</div>
    <div class="muted" style="font-size:12px;margin:6px 2px">${W.registerPayments ? 'Alla generazione i pagamenti verranno registrati sul conto ordinante.' : 'I pagamenti NON verranno registrati (solo file XML).'}</div>
    <div class="actions"><button class="btn" data-back>Indietro</button><button class="btn primary" data-gen>Genera XML</button></div>`;
  sheet.innerHTML = h;
  sheet.querySelector('[data-back]').onclick = () => { step = 2; render(); };
  sheet.querySelector('[data-gen]').onclick = () => doGenerate(txs);
}

function doGenerate(txs) {
  const company = co(activeCompany());
  let xml;
  try {
    xml = generateSepaXml({
      format: W.format,
      cbiVersion: W.cbiVersion,
      executionDate: W.execDate,
      batchBooking: W.batchBooking,
      debtor: { name: company?.name || 'Ordinante', iban: W.accountIban, cuc: W.cuc },
      transactions: txs.map(t => ({ endToEndId: t.endToEndId, amount: t.amount, creditorName: t.creditorName, creditorIban: t.creditorIban, remittance: t.remittance }))
    });
  } catch (e) { toast('Errore: ' + e.message); return; }

  triggerDownload(new Blob([xml], { type: 'application/xml' }), `bonifici_${sanitizeFileName(company?.name)}_${W.execDate}.xml`);

  if (W.registerPayments) {
    // registra i pagamenti sui gruppi effettivamente inclusi nel file
    const paidKeys = new Set(txs.map(t => t.group.key));
    W.groups.filter(g => g.selected && paidKeys.has(g.key)).forEach(g => {
      if (g.mode === 'unico') applyBatch([...g.invs, ...g.ndc], { date: W.execDate, accountId: W.accountId, mode: 'cumulative' });
      else batchSettle(g.invs, { date: W.execDate, accountId: W.accountId, mode: 'separate' });
    });
    toast(`File generato · pagamenti registrati ✓`);
  } else {
    toast('File XML generato ✓');
  }
  closeSheet();
}
