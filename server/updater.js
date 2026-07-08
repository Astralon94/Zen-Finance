// ============ Aggiornamento automatico del software — zero dipendenze ============
// Metodo condiviso della famiglia Zen (derivato da Zen-Store).
// Il pacchetto di aggiornamento è un JSON gzippato: { version, note, pubblicato, files: { "percorso/relativo": "contenuto", ... } }.
// Il manifest (per il controllo versione) è un piccolo JSON: { version, note, pubblicato, url }.
// La cartella data/ (DB + backup) NON viene MAI toccata: l'aggiornamento sostituisce solo il codice.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

const APP_DIR = resolve(new URL('..', import.meta.url).pathname);

export function currentVersion(appDir = APP_DIR) {
  try { return JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

// Confronto semver semplice: ritorna >0 se a>b, <0 se a<b, 0 se uguali. Ignora eventuali suffissi -pre.
export function cmpVer(a, b) {
  const p = (v) => String(v || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = p(a), B = p(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Scarica un URL (http/https) con timeout, seguendo i redirect. Ritorna un Buffer.
export function fetchBuffer(url, { timeoutMs = 15000, redirects = 5 } = {}) {
  return new Promise((res, rej) => {
    let u; try { u = new URL(url); } catch { return rej(new Error('URL non valido')); }
    const getter = u.protocol === 'https:' ? httpsGet : (u.protocol === 'http:' ? httpGet : null);
    if (!getter) return rej(new Error('Protocollo non supportato (usa http/https)'));
    const req = getter(u, { headers: { 'User-Agent': 'Zen-Updater' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        if (redirects <= 0) return rej(new Error('Troppi redirect'));
        return res(fetchBuffer(new URL(r.headers.location, u).toString(), { timeoutMs, redirects: redirects - 1 }));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    });
    req.on('error', rej);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout di connessione')); });
  });
}

export async function fetchJson(url, opt) {
  const buf = await fetchBuffer(url, opt);
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('Risposta non in formato JSON'); }
}

// Controlla se è disponibile un aggiornamento leggendo il manifest.
export async function checkUpdate(manifestUrl, appDir = APP_DIR) {
  const corrente = currentVersion(appDir);
  if (!manifestUrl) return { corrente, disponibile: false, motivo: 'nessun URL configurato' };
  const m = await fetchJson(manifestUrl);
  const ultima = String(m.version || '0.0.0');
  // L'url del pacchetto può essere relativo al manifest (es. "zen-finance-1.0.0.json.gz"): lo risolvo.
  let download_url = '';
  if (m.url) { try { download_url = new URL(m.url, manifestUrl).toString(); } catch { download_url = m.url; } }
  return {
    corrente, ultima,
    disponibile: cmpVer(ultima, corrente) > 0,
    note: m.note || '', pubblicato: m.pubblicato || '',
    download_url,
  };
}

// Valida un percorso relativo di un file dell'aggiornamento (niente assoluti, niente "..", niente aree protette).
const PROTETTI = ['data', 'node_modules', '.git'];
export function pathAmmesso(rel) {
  if (!rel || typeof rel !== 'string') return false;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false;      // assoluti
  const parti = norm.split('/').filter(Boolean);
  if (parti.includes('..') || parti.includes('.')) return false;
  if (PROTETTI.includes(parti[0])) return false;
  return true;
}

// Estrae il pacchetto (Buffer gz) → { version, note, files:{...} }.
export function leggiPacchetto(buf) {
  let obj;
  try { obj = JSON.parse(gunzipSync(buf).toString('utf8')); }
  catch { throw new Error('Pacchetto di aggiornamento illeggibile o corrotto'); }
  if (!obj || typeof obj !== 'object' || !obj.files || typeof obj.files !== 'object') {
    throw new Error('Pacchetto senza elenco file');
  }
  return obj;
}

// Applica un pacchetto già scaricato (Buffer gz). Fa il backup dei file sovrascritti e scrive i nuovi.
export function applicaPacchetto(buf, { appDir = APP_DIR, dataDir = join(APP_DIR, 'data'), stamp = 'update' } = {}) {
  const pkg = leggiPacchetto(buf);
  const files = pkg.files;
  const filesB64 = pkg.filesB64 && typeof pkg.filesB64 === 'object' ? pkg.filesB64 : {};
  const rels = Object.keys(files);
  const relsB64 = Object.keys(filesB64);
  const rifiutati = [...rels, ...relsB64].filter((r) => !pathAmmesso(r));
  if (rifiutati.length) throw new Error('Percorsi non ammessi nel pacchetto: ' + rifiutati.slice(0, 3).join(', '));

  const backupDir = join(dataDir, 'updates-backup', stamp);
  mkdirSync(backupDir, { recursive: true });
  let scritti = 0, nuovi = 0;
  const scrivi = (rel, contenuto) => {
    const dest = join(appDir, rel);
    if (existsSync(dest)) {
      const b = join(backupDir, rel);
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(dest, b);
      scritti++;
    } else { nuovi++; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contenuto);
  };
  for (const rel of rels) scrivi(rel, files[rel]);
  // binari (icone, ecc.): trasportati in base64 nel campo additivo filesB64
  for (const rel of relsB64) scrivi(rel, Buffer.from(filesB64[rel], 'base64'));
  // ritenzione: tieni gli ultimi 5 backup di aggiornamento
  try {
    const base = join(dataDir, 'updates-backup');
    const dirs = readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort();
    for (const d of dirs.slice(0, -5)) rmSync(join(base, d), { recursive: true, force: true });
  } catch {}
  return { version: pkg.version, note: pkg.note || '', file_totali: rels.length + relsB64.length, sovrascritti: scritti, nuovi, backup: backupDir };
}

// Scarica + applica in un colpo solo.
export async function installaAggiornamento(downloadUrl, opts = {}) {
  if (!downloadUrl) throw new Error('URL del pacchetto mancante');
  const buf = await fetchBuffer(downloadUrl, { timeoutMs: 60000 });
  return applicaPacchetto(buf, opts);
}

// Costruisce un pacchetto dai file dell'app (usato dallo script di build lato distributore).
const BIN_EXT = /\.(png|ico|jpg|jpeg|gif|webp|woff2?)$/i;
export function costruisciPacchetto(appDir, relativi, { version, note = '', pubblicato = '' } = {}) {
  const files = {}, filesB64 = {};
  for (const rel of relativi) {
    const p = join(appDir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    if (BIN_EXT.test(rel)) filesB64[rel] = readFileSync(p).toString('base64');
    else files[rel] = readFileSync(p, 'utf8');
  }
  const obj = { version: version || currentVersion(appDir), note, pubblicato, files, filesB64 };
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
}

// Bootstrap binari una-tantum: gli updater precedenti al supporto filesB64 non
// applicavano i binari del pacchetto; all'avvio materializziamo le icone da
// server/icons-bootstrap.json (solo se diverse da quanto su disco). Rimuovibile
// quando tutte le installazioni hanno l'updater con filesB64.
export function bootstrapAssets(appDir = APP_DIR) {
  let map;
  try { map = JSON.parse(readFileSync(join(appDir, 'server', 'icons-bootstrap.json'), 'utf8')); } catch { return 0; }
  let scritti = 0;
  for (const [rel, b64] of Object.entries(map)) {
    if (!pathAmmesso(rel)) continue;
    try {
      const dest = join(appDir, rel);
      const want = Buffer.from(b64, 'base64');
      let cur = null; try { cur = readFileSync(dest); } catch {}
      if (!cur || !cur.equals(want)) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, want); scritti++; }
    } catch {}
  }
  if (scritti) console.log(`[update] bootstrap asset binari: ${scritti} file aggiornati`);
  return scritti;
}
