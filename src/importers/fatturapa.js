// ============ Parser FatturaPA (fattura elettronica XML) ============
import { round2 } from '../domain/util.js';

const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; };

function all(root, name) {
  if (!root) return [];
  return [...root.getElementsByTagName('*')].filter(e => e.localName === name);
}
function one(root, name) { return all(root, name)[0] || null; }
function txt(root, name) { const e = one(root, name); return e ? e.textContent.trim() : ''; }

// Estrae i dati salienti da una stringa XML FatturaPA. Ritorna un draft o null.
export function parseFatturaPA(xmlStr, filename = '') {
  let doc;
  try { doc = new DOMParser().parseFromString(xmlStr, 'application/xml'); } catch (e) { return null; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  if (!root) return null;

  const ced = one(doc, 'CedentePrestatore');
  const dgd = one(doc, 'DatiGeneraliDocumento');
  if (!ced && !dgd) return null; // non sembra una fattura elettronica

  // --- fornitore (cedente/prestatore) ---
  const anag = one(ced, 'DatiAnagrafici') || ced;
  const den = txt(anag, 'Denominazione');
  const supplierName = den || `${txt(anag, 'Nome')} ${txt(anag, 'Cognome')}`.trim() || null;
  const idIva = one(anag, 'IdFiscaleIVA');
  const piva = idIva ? (txt(idIva, 'IdPaese') + txt(idIva, 'IdCodice')) : '';
  const cf = txt(anag, 'CodiceFiscale');

  // --- dati documento ---
  const number = txt(dgd, 'Numero');
  const date = (txt(dgd, 'Data') || '').slice(0, 10) || null;
  const tipoDoc = txt(dgd, 'TipoDocumento'); // es. TD01
  const totDoc = txt(dgd, 'ImportoTotaleDocumento');

  // --- riepiloghi IVA ---
  let net = 0, vat = 0;
  all(doc, 'DatiRiepilogo').forEach(r => {
    net = round2(net + num(txt(r, 'ImponibileImporto')));
    vat = round2(vat + num(txt(r, 'Imposta')));
  });
  const total = totDoc ? round2(num(totDoc)) : round2(net + vat);

  // --- ritenuta ---
  let withholding = 0;
  all(doc, 'DatiRitenuta').forEach(r => { withholding = round2(withholding + num(txt(r, 'ImportoRitenuta'))); });

  // --- pagamento: scadenza + IBAN ---
  let due = null, iban = '';
  const scad = [];
  all(doc, 'DettaglioPagamento').forEach(p => {
    const ds = (txt(p, 'DataScadenzaPagamento') || '').slice(0, 10);
    if (ds) scad.push(ds);
    if (!iban) iban = txt(p, 'IBAN');
  });
  if (scad.length) due = scad.sort()[scad.length - 1]; // ultima scadenza

  // --- righe (anteprima) ---
  const lines = all(doc, 'DettaglioLinee').map(l => ({
    n: txt(l, 'NumeroLinea'),
    desc: txt(l, 'Descrizione'),
    qty: txt(l, 'Quantita'),
    price: txt(l, 'PrezzoUnitario'),
    vatRate: txt(l, 'AliquotaIVA'),
    tot: txt(l, 'PrezzoTotale')
  }));

  return {
    source: 'xml', filename,
    number, date, due,
    net: round2(net), vat: round2(vat), total, withholding: round2(withholding),
    supplierName, piva, cf, iban, tipoDoc,
    creditNote: tipoDoc === 'TD04',   // nota di credito a favore
    lines, xml: xmlStr,
    // chiave per il dedup: P.IVA + numero (fallback su nome)
    dedupKey: `${(piva || cf || supplierName || '').toUpperCase()}|${(number || '').toUpperCase()}`
  };
}
