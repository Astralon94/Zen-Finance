// ============ Vista Impostazioni ============
import { data, save, exportJSON, importJSON, resetAll } from '../../state/store.js';
import { can, authFetch } from '../../state/auth.js';
import { esc, fmt, todayStr, fmtDateFull } from '../../domain/util.js';
import { toast, confirmDialog } from '../dom.js';
import { backfillMatchNames } from '../../domain/backfill.js';
import { mgmtState, deleteInvoice, supNameOf, invTotal, statusLabelOf, isCreditNote } from '../../domain/invoices.js';
import { co } from '../../domain/finance.js';
import { applyTheme } from '../app.js';
import * as utenti from './utenti.js';

export function render() {
  const cManage = can('impostazioni.manage');   // aspetto, manutenzione
  const cSoftware = can('software.aggiorna');    // aggiornamento software
  const cExport = can('dati.export');            // esporta backup
  const cImport = can('dati.import');            // importa/sostituisci
  const cReset = can('dati.reset');              // azzera dati (zona pericolosa)
  const cFatt = can('fatture.elimina');          // elimina fattura
  const cUtenti = can('utenti.manage');          // gestione utenti (accessi)
  const t = data.settings.theme || 'auto';
  const opt = (v, l) => `<button class="chip ${t === v ? 'on' : ''}" data-th="${v}">${l}</button>`;
  let h = `<div class="pagehead"><h1>Impostazioni</h1></div>`;
  let any = false;   // qualche sezione operativa mostrata?

  if (cManage) {
    any = true;
    h += `<div class="section-title">Aspetto</div>`;
    h += `<div class="chips">${opt('auto', 'Automatico')}${opt('light', 'Chiaro')}${opt('dark', 'Scuro')}</div>`;
  }

  if (cExport || cImport) {
    any = true;
    h += `<div class="section-title">Backup</div>`;
    h += `<div class="card">
      <div class="muted" style="font-size:13px;margin-bottom:10px">I dati sono salvati nel <b>database locale</b> del server (con backup automatici lato server). Puoi comunque esportare o importare un backup completo in formato <b>JSON</b> — utile anche per trasferire i dati dalla vecchia versione.</div>
      <div class="btnrow">
        ${cExport ? '<button class="btn" data-export>Esporta backup (JSON)</button>' : ''}
        ${cImport ? '<button class="btn" data-import>Importa backup (JSON)…</button><input type="file" id="imp_file" accept="application/json,.json" style="display:none">' : ''}
      </div>
    </div>`;
  }

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

  if (cManage) {
    any = true;
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
  }

  if (cFatt) {
    any = true;
    h += `<div class="section-title">Elimina una fattura</div>`;
    h += `<div class="card">
      <div class="muted" style="font-size:13px;margin-bottom:10px">Operazione eccezionale: elimina una fattura e <b>tutti i pagamenti collegati</b>. Cerca la fattura per fornitore o numero.</div>
      <div class="field" style="margin:0 0 10px"><input id="delinv_q" placeholder="Cerca fornitore o numero…" autocomplete="off"></div>
      <div class="list" id="delinv_list"></div>
    </div>`;
  }

  if (cSoftware) {
    any = true;
    h += `<div class="section-title">Aggiornamento software</div>`;
    h += `<div class="card">
      <div class="muted" style="font-size:13px;margin-bottom:10px">Gli aggiornamenti vengono scaricati da <b>GitHub</b> e installati senza toccare i dati (la cartella <b>data/</b> non viene mai modificata). Il controllo è automatico all'avvio e ogni 12 ore; al termine dell'installazione il server si riavvia da solo.</div>
      <div class="muted" id="upd_stato" style="font-size:13px;margin-bottom:10px">Versione installata: …</div>
      <div class="btnrow">
        <button class="btn" data-updcheck>Controlla ora</button>
        <button class="btn" data-updinstall style="display:none">Installa e riavvia</button>
      </div>
    </div>`;
  }

  if (cUtenti) {
    any = true;
    h += `<div class="section-title">👥 Utenti</div>`;
    h += `<div id="utenti_sec">${utenti.render()}</div>`;
  }

  if (cReset) {
    any = true;
    h += `<div class="section-title">Zona pericolosa</div>`;
    h += `<div class="card"><button class="btn danger" data-wipe>Cancella tutti i dati</button></div>`;
  }

  if (!any) h += `<div class="card empty">Non hai sezioni modificabili qui.<br><span class="muted">Contatta l'amministratore per ulteriori permessi.</span></div>`;

  h += `<div class="muted" style="text-align:center;font-size:12px;margin-top:24px">Zen Finance · <span id="app_ver">v…</span> · server locale</div>`;
  return h;
}

export function bind(root) {
  // Sezione Utenti: la gestione vive in utenti.js (rendering + bind autonomi sul
  // proprio contenitore, così il redraw interno resta confinato a #utenti_sec).
  const utentiSec = root.querySelector('#utenti_sec');
  if (utentiSec && can('utenti.manage')) utenti.bind(utentiSec);

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

  root.querySelector('[data-backfill]')?.addEventListener('click', () => confirmDialog('Riallineare i nomi?', 'I movimenti già abbinati prenderanno nome e categoria dell\'elemento collegato. Eventuali nomi messi a mano dopo l\'abbinamento verranno sovrascritti.', 'Riallinea', () => {
    const n = backfillMatchNames();
    toast(n ? `${n} movimenti riallineati ✓` : 'Nessun movimento da riallineare');
  }));

  const markBtn = root.querySelector('[data-markmanaged]');
  if (markBtn) markBtn.onclick = () => {
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

  // Aggiornamento software: stato, controllo manuale, installazione con riavvio
  const updStato = root.querySelector('#upd_stato'), updVer = root.querySelector('#app_ver');
  const updCheckBtn = root.querySelector('[data-updcheck]'), updInstBtn = root.querySelector('[data-updinstall]');
  const showUpd = (s) => {
    if (!updStato || !s) return;
    if (updVer && s.corrente) updVer.textContent = 'v' + s.corrente;
    let txt = `Versione installata: <b>v${esc(s.corrente || '?')}</b>`;
    if (s.disponibile) txt += ` · disponibile <b>v${esc(s.ultima)}</b>${s.note ? ' — ' + esc(s.note) : ''}`;
    else if (s.controllato_il) txt += ' · aggiornata (ultimo controllo: ' + fmtDateFull(s.controllato_il.slice(0, 10)) + ')';
    else if (!s.url_configurato) txt += ' · aggiornamenti disattivati';
    updStato.innerHTML = txt;
    if (updInstBtn) updInstBtn.style.display = s.disponibile ? '' : 'none';
  };
  authFetch('/api/updates').then(r => r.ok ? r.json() : null).then(showUpd).catch(() => {});
  if (updCheckBtn) updCheckBtn.onclick = async () => {
    updCheckBtn.disabled = true;
    try {
      const r = await authFetch('/api/updates/check', { method: 'POST' });
      const s = await r.json();
      if (!r.ok) { toast(s.error || 'Controllo fallito'); return; }
      showUpd(s);
      toast(s.disponibile ? `Disponibile la versione ${s.ultima}` : 'Nessun aggiornamento disponibile');
    } catch { toast('Controllo fallito (rete non disponibile?)'); }
    finally { updCheckBtn.disabled = false; }
  };
  if (updInstBtn) updInstBtn.onclick = () => confirmDialog('Installare l\'aggiornamento?', 'Il nuovo software verrà scaricato e installato; il server si riavvia da solo e la pagina si ricarica. I dati non vengono toccati.', 'Installa', async () => {
    updInstBtn.disabled = true;
    try {
      const r = await authFetch('/api/updates/install', { method: 'POST' });
      const s = await r.json();
      if (!r.ok) { toast(s.error || 'Installazione fallita'); updInstBtn.disabled = false; return; }
      toast(`Versione ${s.version} installata — riavvio in corso…`);
      // attende che il server torni su, poi ricarica sul codice nuovo
      const attesa = async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise(ok => setTimeout(ok, 1500));
          try { const h = await fetch('/api/health'); if (h.ok) { location.reload(); return; } } catch {}
        }
        toast('Il server non è ancora ripartito: ricarica la pagina a mano.');
      };
      attesa();
    } catch { toast('Installazione fallita'); updInstBtn.disabled = false; }
  });

  root.querySelector('[data-wipe]')?.addEventListener('click', () => confirmDialog('Cancellare tutti i dati?', 'Operazione irreversibile. Ne viene comunque tenuto un backup del database lato server.', 'Continua', () => {
    confirmDialog('Sei davvero sicuro?', 'Tutte le aziende, conti, movimenti e fatture verranno eliminati.', 'Cancella tutto', async () => {
      const ok = await resetAll(); toast(ok ? 'Dati cancellati' : 'Azzeramento non riuscito (permesso mancante?)');
    }, { danger: true });
  }, { danger: true }));
}
