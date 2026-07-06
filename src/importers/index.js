// ============ Orchestratore import fatture (xml / p7m / zip) ============
import { unzipSync } from 'fflate';
import { parseFatturaPA } from './fatturapa.js';
import { extractXmlFromP7m } from './p7m.js';

const readBytes = file => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(new Uint8Array(r.result));
  r.onerror = () => rej(new Error('Lettura fallita: ' + file.name));
  r.readAsArrayBuffer(file);
});

function decodeXml(u8) {
  let s = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  // se l'XML dichiara un'altra codifica (es. ISO-8859-1), ridecodifica
  const m = s.slice(0, 200).match(/encoding=["']([\w-]+)["']/i);
  if (m && !/utf-?8/i.test(m[1])) {
    try { s = new TextDecoder(m[1].toLowerCase(), { fatal: false }).decode(u8); } catch (e) {}
  }
  return s;
}

const ext = name => (name.split('.').pop() || '').toLowerCase();

// Estrae un draft (o lancia errore) dai byte di un singolo file non-zip.
function draftFromBytes(name, u8) {
  const e = ext(name);
  if (e === 'p7m') {
    const xml = extractXmlFromP7m(u8);
    if (!xml) throw new Error('XML non trovato nel p7m');
    const d = parseFatturaPA(xml, name);
    if (!d) throw new Error('XML del p7m non valido');
    return d;
  }
  if (e === 'xml') {
    const d = parseFatturaPA(decodeXml(u8), name);
    if (!d) throw new Error('Non è una fattura elettronica valida');
    return d;
  }
  throw new Error('Formato non supportato');
}

// Processa un FileList/array di File. Ritorna { drafts, errors }.
export async function importFiles(files) {
  const drafts = [];
  const errors = [];
  const list = [...files];

  for (const file of list) {
    try {
      const u8 = await readBytes(file);
      if (ext(file.name) === 'zip') {
        let entries;
        try { entries = unzipSync(u8); } catch (e) { errors.push({ name: file.name, msg: 'ZIP illeggibile' }); continue; }
        for (const [entryName, bytes] of Object.entries(entries)) {
          const en = entryName.split('/').pop();
          if (!en || en.startsWith('.') || en.startsWith('__MACOSX')) continue;
          const ee = ext(en);
          if (ee !== 'xml' && ee !== 'p7m') continue;
          try { const d = draftFromBytes(en, bytes); d.path = `${file.name}/${entryName}`; drafts.push(d); }
          catch (err) { errors.push({ name: en, msg: err.message }); }
        }
      } else {
        const d = draftFromBytes(file.name, u8);
        d.path = file._path || file.webkitRelativePath || file.name; // per agganciare gli allegati per cartella
        drafts.push(d);
      }
    } catch (err) {
      errors.push({ name: file.name, msg: err.message });
    }
  }

  // dedup interno al batch (per dedupKey)
  const seen = new Set();
  const unique = [];
  let dupInBatch = 0;
  for (const d of drafts) {
    if (seen.has(d.dedupKey)) { dupInBatch++; continue; }
    seen.add(d.dedupKey); unique.push(d);
  }

  return { drafts: unique, errors, dupInBatch };
}
