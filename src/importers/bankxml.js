// ============ Import estratto conto bancario in XML (CBI / ISO 20022 camt.05x) ============
// Formato strutturato: ogni movimento è un <Ntry> con importo (Amt), segno (CdtDbtInd
// DBIT/CRDT), data contabile (BookgDt) e descrizione (AddtlTxInf / Ustrd).
// Ritorna righe nello stesso formato di bankxls.buildRows → riusa commitBankRows.

const all = (root, name) => root ? [...root.getElementsByTagName('*')].filter(e => e.localName === name) : [];
const first = (root, name) => all(root, name)[0] || null;
const txt = (root, name) => { const e = first(root, name); return e ? e.textContent.trim() : ''; };

export function looksLikeBankXml(s) {
  const head = s.slice(0, 2000);
  return /CBIBkToCstmr|BkToCstmrStmt|camt\.05|<\w*:?Ntry>/.test(head);
}

export function parseBankXml(xmlStr) {
  let doc;
  try { doc = new DOMParser().parseFromString(xmlStr, 'application/xml'); } catch (e) { return null; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;
  const ntrys = all(doc, 'Ntry');
  if (!ntrys.length) return null;

  const ibanEl = first(doc, 'IBAN');
  const iban = ibanEl ? ibanEl.textContent.trim() : '';

  const rows = [];
  ntrys.forEach(n => {
    const amtEl = first(n, 'Amt'); if (!amtEl) return;
    const amt = parseFloat(String(amtEl.textContent).replace(',', '.'));
    if (isNaN(amt)) return;
    const ind = (txt(n, 'CdtDbtInd') || '').toUpperCase();
    const bk = first(n, 'BookgDt'), vd = first(n, 'ValDt');
    const dtEl = (bk && first(bk, 'Dt')) || (bk && first(bk, 'DtTm')) || (vd && first(vd, 'Dt')) || first(n, 'Dt');
    const date = dtEl ? dtEl.textContent.trim().slice(0, 10) : null;
    if (!date) return;
    // descrizione: AddtlTxInf > Ustrd (RmtInf) > AddtlNtryInf
    const parts = all(n, 'AddtlTxInf').map(e => e.textContent.trim())
      .concat(all(n, 'Ustrd').map(e => e.textContent.trim()))
      .concat(all(n, 'AddtlNtryInf').map(e => e.textContent.trim()))
      .filter(Boolean);
    const desc = [...new Set(parts)].join(' · ');
    const amount = ind === 'DBIT' ? -Math.abs(amt) : Math.abs(amt);
    // riferimento univoco della banca: ideale per il dedup (stabile tra re-import)
    const ref = txt(n, 'AcctSvcrRef') || '';
    rows.push({ date, desc, amount, ref: ref || null });
  });
  return { rows, iban };
}
