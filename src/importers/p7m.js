// ============ Estrazione XML da .p7m (PKCS#7 / CAdES) ============
// Approccio pragmatico e senza dipendenze: il file p7m è un contenitore firmato
// (binario DER oppure base64). L'XML originale della fattura è incapsulato al suo interno.
// Lo estraiamo individuando i marcatori del root <...FatturaElettronica ...> ... </...FatturaElettronica>
// e decodificando quei byte come UTF-8. Funziona per i p7m emessi dallo SdI.

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

// Trova ed estrae l'XML dai byte forniti (cercando il root FatturaElettronica). null se assente.
function sliceXml(u8) {
  const bin = bytesToLatin1(u8);
  const tag = 'FatturaElettronica';
  const firstName = bin.indexOf(tag);
  if (firstName < 0) return null;
  // inizio: preferisci <?xml, altrimenti il '<' che apre il tag root
  let start = bin.lastIndexOf('<?xml', firstName);
  if (start < 0) start = bin.lastIndexOf('<', firstName);
  if (start < 0) return null;
  // fine: chiusura dell'ultimo </...FatturaElettronica>
  const lastName = bin.lastIndexOf(tag);
  const end = bin.indexOf('>', lastName);
  if (end < 0) return null;
  const slice = u8.subarray(start, end + 1);
  try { return new TextDecoder('utf-8', { fatal: false }).decode(slice); }
  catch (e) { return bytesToLatin1(slice); }
}

// content: Uint8Array del file .p7m
export function extractXmlFromP7m(content) {
  // 1) prova diretta (DER binario con XML incapsulato in chiaro)
  let xml = sliceXml(content);
  if (xml) return xml;

  // 2) il file potrebbe essere base64 (eventuale wrapper PEM)
  let txt = bytesToLatin1(content)
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (txt.length > 100) {
    try {
      const decoded = atob(txt);
      xml = sliceXml(latin1ToBytes(decoded));
      if (xml) return xml;
    } catch (e) { /* non era base64 */ }
  }
  return null;
}
