// ============ Da draft import → fatture nello store ============
import { data, save, addAttachment } from '../state/store.js';
import { uid, round2, todayStr } from '../domain/util.js';

function norm(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function findOrCreateSupplier(draft) {
  const piva = (draft.piva || '').trim();
  const cf = (draft.cf || '').trim();
  let s = null;
  if (piva) s = data.suppliers.find(x => (x.piva || '').trim().toUpperCase() === piva.toUpperCase());
  if (!s && cf) s = data.suppliers.find(x => (x.cf || '').trim().toUpperCase() === cf.toUpperCase());
  if (!s && draft.supplierName) s = data.suppliers.find(x => norm(x.name) === norm(draft.supplierName));
  if (s) {
    // arricchisce dati mancanti
    if (!s.piva && piva) s.piva = piva;
    if (!s.cf && cf) s.cf = cf;
    if (!s.iban && draft.iban) s.iban = draft.iban;
    return s.id;
  }
  if (!draft.supplierName && !piva) return null;
  const ns = { id: uid(), name: draft.supplierName || piva || 'Fornitore', type: 'supplier', piva, cf, iban: draft.iban || '', email: '', note: 'da import XML' };
  data.suppliers.push(ns);
  return ns.id;
}

// existing dedup key, coerente con fatturapa.dedupKey ma calcolata sui dati salvati
function existingKey(inv) {
  const s = inv.supplierId ? data.suppliers.find(x => x.id === inv.supplierId) : null;
  const id = (s?.piva || s?.cf || inv.supplierName || '').toUpperCase();
  return `${id}|${(inv.number || '').toUpperCase()}`;
}

// drafts: array da importFiles; companyId: azienda di destinazione.
// I draft possono portare d.attachFiles[] (PDF dalla cartella): vengono caricati come BLOB
// e agganciati alla fattura (inv.attachments[]). È async per via dell'upload degli allegati.
export async function commitDrafts(drafts, companyId) {
  const existing = new Set(data.invoices.map(existingKey));
  let added = 0, skipped = 0, attached = 0;
  const addedInvoices = [];

  for (const d of drafts) {
    if (existing.has(d.dedupKey)) { skipped++; continue; }
    const supId = findOrCreateSupplier(d);
    const inv = {
      id: uid(), companyId,
      supplierId: supId, supplierName: supId ? null : (d.supplierName || null),
      number: d.number || '', date: d.date || todayStr(), due: d.due || null,
      net: d.net ?? null, vat: d.vat ?? null, total: round2(d.total), withholding: round2(d.withholding || 0),
      creditNote: !!d.creditNote,
      categoryId: 'c-for', payments: [], attachments: [], source: 'xml', xml: d.xml || null,
      note: '', createdAt: Date.now()
    };
    // allegati PDF trovati nella cartella della fattura → upload BLOB + metadati nel doc
    for (const f of (d.attachFiles || [])) {
      const r = await addAttachment(f);
      if (r.ok) { inv.attachments.push(r.meta); attached++; }
    }
    data.invoices.push(inv);
    addedInvoices.push(inv);
    existing.add(d.dedupKey);
    added++;
  }

  if (added) save();
  return { added, skipped, attached, addedInvoices };
}
