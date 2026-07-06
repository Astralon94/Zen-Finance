// ============ Vista Impostazioni ============
import { data, save, setData, exportJSON, importJSON } from '../../state/store.js';
import { DEFAULT_DATA } from '../../state/model.js';
import { esc, fmt, todayStr, fmtDateFull } from '../../domain/util.js';
import { toast, confirmDialog } from '../dom.js';
import { backfillMatchNames } from '../../domain/backfill.js';
import { mgmtState, deleteInvoice, supNameOf, invTotal, statusLabelOf, isCreditNote } from '../../domain/invoices.js';
import { co } from '../../domain/finance.js';
import { applyTheme } from '../app.js';

const APP_BUILD = '2.9.0';

export function render() {
  const t = data.settings.theme || 'auto';
  const opt = (v, l) => `<button class="chip ${t === v ? 'on' : ''}" data-th="${v}">${l}</button>`;
  let h = `<div class="pagehead"><h1>Impostazioni</h1></div>`;

  h += `<div class="section-title">Aspetto</div>`;
  h += `<div class="chips">${opt('auto', 'Automatico')}${opt('light', 'Chiaro')}${opt('dark', 'Scuro')}</div>`;

  h += `<div class="section-title">Backup</div>`;
  h += `<div class="card">
    <div class="muted" style="font-size:13px;margin-bottom:10px">I dati sono salvati nel <b>database locale</b> del server (con backup automatici lato server). Puoi comunque esportare o importare un backup completo in formato <b>JSON</b> — utile anche per trasferire i dati dalla vecchia versione.</div>
    <div class="btnrow">
      <button class="btn" data-export>Esporta backup (JSON)</button>
      <button class="btn" data-import>Importa backup (JSON)…</button>
      <input type="file" id="imp_file" accept="application/json,.json" style="display:none">
    </div>
  </div>`;

  h += `<div class="section-title">Archivio</div>`;
  h += `<div class="card">
    <table class="tbl">
      <tr><td>Aziende</td><td class="r tnum">${data.companies.length}</td></tr>
      <tr><td>Conti</td><td class="r tnum">${data.accounts.length}</td></tr>
      <tr><td>Movimenti</td><td class="r tnum">${data.transactions.length}</td></tr>
      <tr><td>Fatture</td><td class="r tnum">${data.invoices.length}</td></tr>
      <tr><td>Fornitori</td><td class="r tnum">${data.suppliers.length}</td></tr>
      <tr><td>Revisione salvataggio</td><td class="r tnum">#${data.rev || 0}</td></tr>
    </table>
  </div>`;

  h += `<div class="section-title">Manutenzione</div>`;
  h += `<div class="card">
    <div class="muted" style="font-size:13px;margin-bottom:10px">Riallinea i movimenti <b>già abbinati</b> (rate, scadenze, fatture) al nome e categoria dell'elemento collegato. Utile una tantum dopo l'aggiornamento. <b>Attenzione:</b> sovrascrive eventuali nomi personalizzati a mano dopo l'abbinamento (riaprendo l'elemento il nome precedente viene comunque ripristinato).</div>
    <button class="btn" data-backfill>Riallinea nomi movimenti abbinati</button>
  </div>`;

  h += `<div class="card" style="margin-top:10px">
    <div class="muted" style="font-size:13px;margin-bottom:10px">Segna come <b>Gestiti</b> tutti i movimenti (di <b>tutte le aziende</b>) fino alla data scelta, compresa. Operazione una-tantum per sistemare lo storico. Trasferimenti e movimenti già collegati restano invariati (sono già gestiti).</div>
    <div class="frow" style="align-items:flex-end;gap:8px">
      <div class="field" style="margin:0"><label>Fino al (compreso)</label><input id="mark_date" type="date" value="${todayStr()}"></div>
      <button class="btn" data-markmanaged>Segna gestiti</button>
    </div>
  </div>`;

  h += `<div class="section-title">Elimina una fattura</div>`;
  h += `<div class="card">
    <div class="muted" style="font-size:13px;margin-bottom:10px">Operazione eccezionale: elimina una fattura e <b>tutti i pagamenti collegati</b>. Cerca la fattura per fornitore o numero.</div>
    <div class="field" style="margin:0 0 10px"><input id="delinv_q" placeholder="Cerca fornitore o numero…" autocomplete="off"></div>
    <div class="list" id="delinv_list"></div>
  </div>`;

  h += `<div class="section-title">Zona pericolosa</div>`;
  h += `<div class="card"><button class="btn danger" data-wipe>Cancella tutti i dati</button></div>`;

  h += `<div class="muted" style="text-align:center;font-size:12px;margin-top:24px">Zen Finance · v${APP_BUILD} · server locale · nessun cloud</div>`;
  return h;
}

export function bind(root) {
  root.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { data.settings.theme = b.dataset.th; save(); applyTheme(); });
  root.querySelector('[data-export]')?.addEventListener('click', () => { exportJSON(); toast('Backup esportato ✓'); });
  const impFile = root.querySelector('#imp_file');
  root.querySelector('[data-import]')?.addEventListener('click', () => impFile?.click());
  if (impFile) impFile.onchange = () => {
    const f = impFile.files[0]; impFile.value = '';
    if (!f) return;
    confirmDialog('Importare questo backup?', 'I dati attuali verranno sostituiti con quelli del file. Ne viene comunque tenuto un backup del database lato server.', 'Importa', async () => {
      try { await importJSON(f); toast('Backup importato ✓'); }
      catch (e) { toast('File non valido: ' + (e.message || 'errore')); }
    }, { danger: true });
  };

  root.querySelector('[data-backfill]').onclick = () => confirmDialog('Riallineare i nomi?', 'I movimenti già abbinati prenderanno nome e categoria dell\'elemento collegato. Eventuali nomi messi a mano dopo l\'abbinamento verranno sovrascritti.', 'Riallinea', () => {
    const n = backfillMatchNames();
    toast(n ? `${n} movimenti riallineati ✓` : 'Nessun movimento da riallineare');
  });

  root.querySelector('[data-markmanaged]').onclick = () => {
    const cutoff = root.querySelector('#mark_date').value;
    if (!cutoff) { toast('Scegli una data'); return; }
    const targets = data.transactions.filter(t => t.date && t.date <= cutoff && mgmtState(t) !== 'managed');
    if (!targets.length) { toast('Nessun movimento da aggiornare'); return; }
    confirmDialog(`Segnare ${targets.length} movimenti come gestiti?`, `Tutti i movimenti fino al ${fmtDateFull(cutoff)} (compreso) non ancora gestiti verranno marcati come "Gestito". Operazione una-tantum.`, 'Segna gestiti', () => {
      targets.forEach(t => { t.mgmt = 'managed'; });
      save();
      toast(`${targets.length} movimenti segnati come gestiti ✓`);
    });
  };

  // Elimina una fattura: ricerca per fornitore/numero su tutte le aziende
  const dq = root.querySelector('#delinv_q'), dlist = root.querySelector('#delinv_list');
  if (dq && dlist) {
    const drawDel = () => {
      const term = (dq.value || '').trim().toLowerCase();
      let invs = data.invoices.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (term) invs = invs.filter(i => supNameOf(i).toLowerCase().includes(term) || (i.number || '').toLowerCase().includes(term));
      invs = invs.slice(0, 25);
      if (!invs.length) { dlist.innerHTML = `<div class="row"><div class="mid muted">${term ? 'Nessuna fattura trovata.' : 'Digita fornitore o numero per cercare.'}</div></div>`; return; }
      dlist.innerHTML = invs.map(i => `<div class="row">
        <div class="emoji">${isCreditNote(i) ? '↩️' : '🧾'}</div>
        <div class="mid"><div class="t1">${esc(supNameOf(i))}${i.number ? ' · N. ' + esc(i.number) : ''}</div>
          <div class="t2">${i.date ? fmtDateFull(i.date) : ''} · ${fmt(invTotal(i))} · ${esc(co(i.companyId)?.name || '')} · ${esc(statusLabelOf(i))}</div></div>
        <button class="btn sm danger" data-delinv="${i.id}">Elimina</button>
      </div>`).join('');
      dlist.querySelectorAll('[data-delinv]').forEach(b => b.onclick = () => {
        const inv = data.invoices.find(x => x.id === b.dataset.delinv); if (!inv) return;
        confirmDialog('Eliminare la fattura?', `${supNameOf(inv)}${inv.number ? ' · N. ' + inv.number : ''} · ${fmt(invTotal(inv))}. Verranno rimossi anche i pagamenti collegati. Operazione irreversibile.`, 'Elimina', () => {
          deleteInvoice(inv); toast('Fattura eliminata'); drawDel();
        }, { danger: true });
      });
    };
    dq.oninput = drawDel;
    drawDel();
  }

  root.querySelector('[data-wipe]').onclick = () => confirmDialog('Cancellare tutti i dati?', 'Operazione irreversibile. Ne viene comunque tenuto un backup del database lato server.', 'Continua', () => {
    confirmDialog('Sei davvero sicuro?', 'Tutte le aziende, conti, movimenti e fatture verranno eliminati.', 'Cancella tutto', () => {
      setData(DEFAULT_DATA()); toast('Dati cancellati');
    }, { danger: true });
  }, { danger: true });
}
