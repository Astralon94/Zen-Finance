// ============ Mini-writer ZIP (entry "stored", senza compressione) ============
// Sostituisce fflate per l'export: il codice di fflate contiene stringhe binarie
// (magic number ZIP/gzip) che nel bundle single-file inseriscono un byte NUL crudo
// nell'HTML → il tokenizer lo sostituisce con U+FFFD e il modulo inline muore a
// page-load (pagina bianca). Questo writer è ASCII puro: nessun rischio, zero dip.
// Gli XML sono piccoli: lo ZIP non compresso va benissimo.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (v) => [v & 255, (v >>> 8) & 255];
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

// files: { 'nome.xml': Uint8Array, ... } → Blob application/zip.
export function buildZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = ((((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = enc.encode(name);
    const crc = crc32(data);
    // local file header: firma PK\3\4, versione 20, flag 0x0800 (nomi UTF-8), metodo 0 (stored)
    const local = new Uint8Array([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(n.length), ...u16(0)]);
    parts.push(local, n, data);
    central.push({ n, crc, size: data.length, offset });
    offset += local.length + n.length + data.length;
  }
  let cdSize = 0;
  for (const e of central) {
    const h = new Uint8Array([0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset)]);
    parts.push(h, e.n);
    cdSize += h.length + e.n.length;
  }
  // end of central directory
  parts.push(new Uint8Array([0x50, 0x4B, 5, 6, ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)]));
  return new Blob(parts, { type: 'application/zip' });
}
