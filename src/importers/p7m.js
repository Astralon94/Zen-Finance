// ============ Estrazione XML da .p7m (PKCS#7 / CAdES) ============
// Approccio pragmatico e senza dipendenze: il file p7m è un contenitore firmato
// (binario DER/BER oppure base64). L'XML originale della fattura è incapsulato in chiaro.
// Lo estraiamo ricostruendolo dal root <...FatturaElettronica ...> ... </...FatturaElettronica>.
//
// IMPORTANTE — p7m BER a lunghezza indefinita: alcuni firmatari incapsulano l'XML in un
// OCTET STRING *costruito*, spezzato in segmenti (es. `04 82 03 e8` = chunk da 1000 byte).
// Quei byte di framing ASN.1 finiscono in mezzo all'XML e lo corrompono. Poiché un XML
// valido non contiene MAI byte 0x04 (OCTET STRING) né 0x00, li trattiamo come framing e li
// scartiamo (de-chunk). Per i p7m DER contigui è un no-op. Funziona per i p7m emessi dallo SdI.

function bytesToLatin1(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}
function latin1ToBytes(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
  return u8;
}

// Ricostruisce l'XML dai byte partendo da <?xml (o dal '<' del root) e de-chunkando i
// segmenti OCTET STRING. Si ferma alla chiusura </...FatturaElettronica>. null se assente.
function extractContiguousXml(u8) {
  const bin = bytesToLatin1(u8);
  const fe = bin.indexOf('FatturaElettronica');
  if (fe < 0) return null;
  let start = bin.lastIndexOf('<?xml', fe);
  if (start < 0) start = bin.lastIndexOf('<', fe);
  if (start < 0) return null;

  const out = new Uint8Array(u8.length - start);
  let n = 0, i = start;
  const CLOSE = 'FatturaElettronica>'; // il root FatturaPA ha sempre attributi → questo tail = tag di chiusura
  while (i < u8.length) {
    const b = u8[i];
    if (b === 0x04) {                 // header OCTET STRING (framing) → salta tag + lunghezza
      const L = u8[i + 1];
      if (L === undefined) break;
      i += (L < 0x80) ? 2 : 2 + (L & 0x7f); // 04 LL | 04 81 LL | 04 82 LL LL | …
      continue;
    }
    if (b === 0x00) { i++; continue; } // end-of-contents / padding → salta
    out[n++] = b; i++;
    if (b === 0x3e && n >= CLOSE.length) { // '>' : controlla se chiude "…FatturaElettronica>"
      let ok = true;
      for (let k = 0; k < CLOSE.length; k++) { if (out[n - CLOSE.length + k] !== CLOSE.charCodeAt(k)) { ok = false; break; } }
      if (ok) break;
    }
  }
  const slice = out.subarray(0, n);
  try { return new TextDecoder('utf-8', { fatal: false }).decode(slice); }
  catch (e) { return bytesToLatin1(slice); }
}

// content: Uint8Array del file .p7m
export function extractXmlFromP7m(content) {
  // 1) prova diretta (DER/BER binario con XML incapsulato in chiaro)
  let xml = extractContiguousXml(content);
  if (xml && xml.includes('FatturaElettronica')) return xml;

  // 2) il file potrebbe essere base64 (eventuale wrapper PEM)
  const txt = bytesToLatin1(content)
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (txt.length > 100) {
    try {
      const decoded = atob(txt);
      xml = extractContiguousXml(latin1ToBytes(decoded));
      if (xml && xml.includes('FatturaElettronica')) return xml;
    } catch (e) { /* non era base64 */ }
  }
  return null;
}
