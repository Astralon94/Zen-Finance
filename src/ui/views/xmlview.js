// ============ Visualizzatore XML fattura (nuova scheda) ============
import { esc } from '../../domain/util.js';
import { getInvoiceXml } from '../../state/store.js';

const all = (root, name) => root ? [...root.getElementsByTagName('*')].filter(e => e.localName === name) : [];
const one = (root, name) => all(root, name)[0] || null;
const tx = (root, name) => { const e = one(root, name); return e ? e.textContent.trim() : ''; };
const money = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? (v || '') : n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const dt = v => { if (!v) return ''; const p = v.slice(0, 10).split('-'); return p.length === 3 ? `${+p[2]}/${+p[1]}/${p[0]}` : v; };

// id = id fattura (per il lazy-load dal server); inMemoryXml = xml già in memoria (fatture
// appena importate in questa sessione), se presente si evita il fetch.
export async function openXmlViewer(id, inMemoryXml) {
  const w = window.open('', '_blank');
  if (!w) { alert('Consenti i popup per vedere la fattura'); return; }
  const notice = (msg) => { w.document.open(); w.document.write(`<meta charset="utf-8"><p style="font:14px system-ui;padding:24px;color:#555">${msg}</p>`); w.document.close(); };
  notice('Caricamento fattura…');
  let xmlStr = inMemoryXml;
  if (!xmlStr) xmlStr = await getInvoiceXml(id);
  if (!xmlStr) { notice('XML non disponibile per questa fattura.'); return; }
  let doc = null;
  try { doc = new DOMParser().parseFromString(xmlStr, 'application/xml'); } catch (e) {}
  if (!doc || doc.getElementsByTagName('parsererror').length) {
    w.document.open();
    w.document.write('<meta charset="utf-8"><pre style="white-space:pre-wrap;font:13px system-ui;padding:16px">' + esc(xmlStr) + '</pre>');
    w.document.close(); return;
  }
  const ced = one(doc, 'CedentePrestatore') || doc, ces = one(doc, 'CessionarioCommittente') || doc, dgd = one(doc, 'DatiGeneraliDocumento') || doc;
  const anag = r => { const den = tx(r, 'Denominazione'); return den || `${tx(r, 'Nome')} ${tx(r, 'Cognome')}`.trim(); };
  const piva = r => { const id = one(r, 'IdFiscaleIVA'); return id ? (tx(id, 'IdPaese') + tx(id, 'IdCodice')) : (tx(r, 'CodiceFiscale') || ''); };
  const righe = all(doc, 'DettaglioLinee').map(l => `<tr><td class="r">${esc(tx(l, 'NumeroLinea'))}</td><td>${esc(tx(l, 'Descrizione'))}</td><td class="r">${esc(tx(l, 'Quantita') ? money(tx(l, 'Quantita')) : '')}</td><td class="r">${esc(money(tx(l, 'PrezzoUnitario')))}</td><td class="r">${esc(tx(l, 'AliquotaIVA') ? money(tx(l, 'AliquotaIVA')) + '%' : '')}</td><td class="r">${esc(money(tx(l, 'PrezzoTotale')))}</td></tr>`).join('');
  const riep = all(doc, 'DatiRiepilogo').map(s => `<tr><td>IVA ${esc(money(tx(s, 'AliquotaIVA')))}%</td><td class="r">imponibile ${esc(money(tx(s, 'ImponibileImporto')))}</td><td class="r">imposta ${esc(money(tx(s, 'Imposta')))}</td></tr>`).join('');
  const numero = tx(dgd, 'Numero'), datad = tx(dgd, 'Data'), totDoc = tx(dgd, 'ImportoTotaleDocumento');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Fattura ${esc(numero)}</title><style>
    body{font-family:system-ui,Arial;color:#111;padding:24px;max-width:820px;margin:0 auto}
    h1{font-size:19px;margin:0 0 2px}.muted{color:#555;font-size:13px}.box{border:1px solid #e3e3e6;border-radius:10px;padding:12px 14px;margin:10px 0}
    .grid{display:flex;gap:12px;flex-wrap:wrap}.grid>div{flex:1;min-width:220px}
    table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
    th{background:#f3f4f6}.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.tot{font-size:17px;font-weight:800;text-align:right;margin-top:10px}
    @media print{.noprint{display:none}}
  </style></head><body>
    <h1>Fattura n. ${esc(numero) || '—'}</h1><div class="muted">del ${esc(dt(datad))}</div>
    <div class="grid">
      <div class="box"><b>Fornitore</b><br>${esc(anag(ced)) || '—'}<br><span class="muted">${esc(piva(ced))}</span></div>
      <div class="box"><b>Cliente</b><br>${esc(anag(ces)) || '—'}<br><span class="muted">${esc(piva(ces))}</span></div>
    </div>
    <table><thead><tr><th>#</th><th>Descrizione</th><th class="r">Q.tà</th><th class="r">Prezzo</th><th class="r">IVA</th><th class="r">Totale</th></tr></thead><tbody>${righe || '<tr><td colspan="6" class="muted">Nessuna riga di dettaglio</td></tr>'}</tbody></table>
    ${riep ? `<table style="margin-top:10px">${riep}</table>` : ''}
    <div class="tot">Totale documento: ${esc(money(totDoc))} €</div>
    <p class="noprint muted" style="margin-top:18px">Vista generata dall'XML. Usa Stampa del browser per salvarla in PDF.</p>
  </body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}
