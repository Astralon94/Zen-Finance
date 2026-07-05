// ============ Persistenza robusta (offline-first) ============
// Fonte di verità in memoria: `data`. Due copie durevoli: localStorage + IndexedDB.
// Anti-overwrite: ogni save incrementa `rev` (monotòno). Al boot si adotta SEMPRE la
// copia con `rev` più alto (savedAt come spareggio). Niente euristiche "a conteggio record"
// che in passato causavano cambi di stato involontari. Backup/trasferimento via export/import JSON.

import { DEFAULT_DATA, migrate, DATA_VERSION } from './model.js';
import { todayStr, pad2, uid } from '../domain/util.js';

// Identificatori di archiviazione (Zen Finance).
const LS_KEY = 'zen-finance.data.v2';
const IDB_NAME = 'zen-finance-db';
const IDB_STORE = 'kv';
const MAIN = 'zen-finance.json';
const FILE_PREFIX = 'zen-finance-';   // prefisso di backup/snapshot
const KEEP_BACKUPS = 20, KEEP_SNAPSHOTS = 30;

export let data = DEFAULT_DATA();
const listeners = new Set();
let idbTimer = null;
let lsFull = false;

// ---- Vault su cartella (Chrome/Chromium: File System Access API) ----
let vaultDir = null, vaultOn = false, vaultNeedsPerm = false, vaultTimer = null;
let xmlOnDisk = new Set();   // id fatture il cui XML è già scritto in xml/
// Istanti (ms) dell'ultimo snapshot/backup scritti nel vault in questa sessione (solo UI, non persistiti).
let lastSnapshotAt = null, lastBackupAt = null;
export const fileSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

// ---- IndexedDB ----
function idbOpen() {
  return new Promise(res => {
    if (typeof indexedDB === 'undefined') return res(null);
    try {
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
async function idbPut(obj) {
  const db = await idbOpen(); if (!db) return;
  try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(JSON.stringify(obj), 'data'); } catch (e) {}
}
function idbGet() {
  return idbOpen().then(db => {
    if (!db) return null;
    return new Promise(res => {
      try {
        const rq = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('data');
        rq.onsuccess = () => { try { res(JSON.parse(rq.result) || null); } catch (e) { res(null); } };
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  });
}

// ---- IndexedDB: chiavi grezze (per memorizzare l'handle del file) ----
async function idbSetRaw(key, val) { const db = await idbOpen(); if (!db) return; try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key); } catch (e) {} }
function idbGetRaw(key) {
  return idbOpen().then(db => { if (!db) return null; return new Promise(res => { try { const rq = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null); } catch (e) { res(null); } }); });
}

// Legge il dato da localStorage.
function readLS() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// ---- Vault su cartella (File System Access) ----
async function ensurePerm(handle, request) {
  if (!handle?.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  let p = await handle.queryPermission(opts);
  if (p === 'granted') return true;
  if (request) p = await handle.requestPermission(opts);
  return p === 'granted';
}
const ts = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };
// dati "snelli" per il file principale: senza l'XML grezzo delle fatture (salvato a parte in xml/)
export function leanData(d) { return { ...d, invoices: (d.invoices || []).map(i => { const { xml, ...rest } = i; return rest; }) }; }

async function dirWriteJson(dir, name, obj) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(JSON.stringify(obj, null, 2)); await w.close(); }
async function dirReadJson(dir, name) { const fh = await dir.getFileHandle(name); const f = await fh.getFile(); return JSON.parse(await f.text()); }
async function dirWriteText(dir, name, text) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close(); }
async function listJson(dir) { const out = []; try { for await (const [n, h] of dir.entries()) if (h.kind === 'file' && n.endsWith('.json')) out.push(n); } catch (e) {} return out.sort(); }
async function pruneDir(dir, keep) { const files = await listJson(dir); for (let i = 0; i < files.length - keep; i++) { try { await dir.removeEntry(files[i]); } catch (e) {} } }

// scrive l'intero vault: backup del principale, principale snello, snapshot del giorno, XML mancanti
async function writeVault(dir, d) {
  const backups = await dir.getDirectoryHandle('backups', { create: true });
  const snaps = await dir.getDirectoryHandle('snapshots', { create: true });
  const xmlDir = await dir.getDirectoryHandle('xml', { create: true });
  const lean = JSON.stringify(leanData(d), null, 2);
  // backup del principale corrente, poi sovrascrivi
  try { const cur = await dirReadJson(dir, MAIN); await dirWriteText(backups, `${FILE_PREFIX}${ts()}.json`, JSON.stringify(cur)); await pruneDir(backups, KEEP_BACKUPS); lastBackupAt = Date.now(); } catch (e) {}
  await dirWriteText(dir, MAIN, lean);
  try { await dirWriteText(snaps, `${FILE_PREFIX}${todayStr()}.json`, lean); await pruneDir(snaps, KEEP_SNAPSHOTS); lastSnapshotAt = Date.now(); } catch (e) {}
  // XML fatture: scrivi quelli non ancora su disco
  for (const inv of (d.invoices || [])) {
    if (inv.xml && !xmlOnDisk.has(inv.id)) { try { await dirWriteText(xmlDir, inv.id + '.xml', inv.xml); xmlOnDisk.add(inv.id); } catch (e) {} }
  }
  emit();   // notifica la UI: il badge snapshot/backup si aggiorna in tempo reale a scrittura avvenuta
}

// legge il vault: principale (con auto-recupero da backup/snapshot) + riattacca gli XML
async function readVault(dir) {
  let obj = null;
  try { const o = await dirReadJson(dir, MAIN); if (Array.isArray(o.transactions)) obj = o; } catch (e) {}
  if (!obj) { // auto-recupero
    for (const sub of ['backups', 'snapshots']) {
      try { const h = await dir.getDirectoryHandle(sub); const files = (await listJson(h)).reverse(); for (const f of files) { try { const o = JSON.parse(await (await (await h.getFileHandle(f)).getFile()).text()); if (Array.isArray(o.transactions)) { obj = o; break; } } catch (e) {} } } catch (e) {}
      if (obj) break;
    }
  }
  if (!obj) return null;
  // riattacca gli XML dalle file in xml/
  xmlOnDisk = new Set();
  try {
    const xmlDir = await dir.getDirectoryHandle('xml');
    for await (const [n, h] of xmlDir.entries()) {
      if (h.kind === 'file' && n.endsWith('.xml')) {
        const id = n.slice(0, -4); xmlOnDisk.add(id);
        const inv = (obj.invoices || []).find(x => x.id === id);
        if (inv) { try { inv.xml = await (await h.getFile()).text(); } catch (e) {} }
      }
    }
  } catch (e) {}
  return obj;
}

// ---- Save / persistenza ----
// `silent` = salva senza ridisegnare (es. durante boot)
export function save({ silent = false } = {}) {
  data.rev = (data.rev || 0) + 1;
  data.savedAt = Date.now();
  data.version = DATA_VERSION;
  // localStorage è la rete di sicurezza SINCRONA (scritta a ogni save, durevole prima della chiusura).
  // Se la quota è piena (tipicamente per gli XML delle fatture), ripiega su una copia SNELLA senza XML:
  // così i dati critici (movimenti, conti, fatture-meta, log) restano sempre sincroni qui, mentre gli
  // XML restano in IndexedDB e nel vault (cartella xml/, riattaccata a ogni boot).
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); lsFull = false; }
  catch (e) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(leanData(data))); lsFull = false; }
    catch (e2) { if (!lsFull) { lsFull = true; console.warn('localStorage pieno: solo IndexedDB/vault'); } }
  }
  clearTimeout(idbTimer);
  idbTimer = setTimeout(() => idbPut(data), 300);
  if (vaultOn && vaultDir) { clearTimeout(vaultTimer); vaultTimer = setTimeout(() => writeVault(vaultDir, data).catch(() => recheckVault()), 400); }
  if (!silent) emit();
}

// Verifica i permessi della cartella collegata: se sono stati revocati, marca la cartella come
// non attiva (così l'app mostra la schermata bloccante). Emette solo se lo stato cambia.
export async function recheckVault() {
  if (!fileSupported() || !vaultDir) return false;
  let granted = false;
  try { granted = (await vaultDir.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { granted = false; }
  const was = vaultOn;
  vaultOn = granted; vaultNeedsPerm = !granted;
  if (was !== vaultOn) emit();
  return vaultOn;
}

// scrittura immediata (chiusura pagina): IndexedDB + vault
export function flush() {
  try { idbPut(data); } catch (e) {}
  if (vaultOn && vaultDir) { try { writeVault(vaultDir, data); } catch (e) {} }
}

// rilegge ed emette (per import/wipe)
export function setData(newData, { persist = true } = {}) {
  data = migrate(newData);
  if (persist) save({ silent: true });
  emit();
}

function pickFresher(a, b) {
  // ritorna la copia con rev più alto; spareggio su savedAt; null-safe
  if (!a) return b; if (!b) return a;
  const ra = a.rev || 0, rb = b.rev || 0;
  if (ra !== rb) return ra > rb ? a : b;
  return (a.savedAt || 0) >= (b.savedAt || 0) ? a : b;
}

// ---- Boot ----
export async function boot() {
  const ls = readLS();
  if (ls && Array.isArray(ls.transactions)) data = migrate(ls);
  else data = DEFAULT_DATA();
  emit();

  // confronta con IndexedDB e adotta la copia più "avanti" (rev più alto)
  const idb = await idbGet();
  if (idb && Array.isArray(idb.transactions)) {
    const winner = pickFresher(data, idb);
    if (winner !== data) {
      data = migrate(winner);
      try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
      emit();
    } else {
      if ((idb.rev || 0) < (data.rev || 0)) idbPut(data); // riallinea IndexedDB se è indietro
    }
  } else {
    idbPut(data);
  }

  // se è collegata una cartella-vault (Chrome), confrontala e adotta lo stato più "avanti"
  if (fileSupported()) {
    try {
      vaultDir = await idbGetRaw('vaultDir');
      if (vaultDir) {
        if (await ensurePerm(vaultDir, false)) {
          vaultOn = true;
          const vd = await readVault(vaultDir);
          if (vd && Array.isArray(vd.transactions)) {
            const winner = pickFresher(data, vd);
            if (winner === vd) {
              data = migrate(vd);
              try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
              idbPut(data);
            } else if ((data.rev || 0) > (vd.rev || 0)) {
              writeVault(vaultDir, data).catch(() => {}); // il browser era più avanti: riallinea il vault
            }
            emit();
          }
        } else {
          vaultNeedsPerm = true; // serve riautorizzazione (gesto utente): intanto si usa la copia browser
        }
      }
    } catch (e) {}
  }

  // flush alla chiusura/nascondimento; al ritorno in primo piano ricontrolla i permessi della cartella
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); else recheckVault(); });
  window.addEventListener('pagehide', flush);

  // chiede storage persistente (riduce il rischio di eviction su iOS/Safari)
  try { if (navigator.storage?.persist) navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist().catch(() => {}); }); } catch (e) {}

  // pulizia allegati orfani (best-effort, non blocca il boot)
  if (vaultOn) reconcileAttachments().catch(() => {});
}

// ---- Export / Import JSON ----
export function exportJSON() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `zen-finance-backup-${d}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.transactions) || !Array.isArray(d.companies)) throw new Error('Struttura non valida');
        d.rev = Math.max(d.rev || 0, data.rev || 0) + 1;  // mantiene rev monotòno: non torna indietro
        setData(d);
        resolve(d);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(new Error('Lettura file fallita'));
    r.readAsText(file);
  });
}

// ---- Gestione vault su cartella (per la UI Impostazioni, solo Chrome) ----
export const vaultStatus = () => ({ supported: fileSupported(), active: vaultOn, needsPerm: vaultNeedsPerm, name: vaultDir?.name || null });
// Istanti (ms) dell'ultimo snapshot/backup scritti su disco nella sessione corrente (null = mai avvenuto).
export const vaultTimes = () => ({ snapshot: lastSnapshotAt, backup: lastBackupAt });

export async function connectVault() {
  if (!fileSupported()) return { ok: false };
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
  catch (e) { return { ok: false, canceled: true }; }
  if (!(await ensurePerm(dir, true))) return { ok: false };
  vaultDir = dir; vaultOn = true; vaultNeedsPerm = false;
  await idbSetRaw('vaultDir', dir);
  const vd = await readVault(dir);
  if (vd && Array.isArray(vd.transactions)) {            // cartella con dati esistenti
    const winner = pickFresher(data, vd);
    if (winner === vd) { data = migrate(vd); try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {} idbPut(data); }
    else { await writeVault(dir, data); }
  } else {                                               // cartella nuova/vuota
    xmlOnDisk = new Set();
    try { await writeVault(dir, data); } catch (e) { return { ok: false, error: e.message }; }
  }
  emit();
  return { ok: true, name: dir.name };
}

export async function reauthorizeVault() {
  if (!vaultDir) return { ok: false };
  if (!(await ensurePerm(vaultDir, true))) return { ok: false };
  vaultNeedsPerm = false; vaultOn = true;
  const vd = await readVault(vaultDir);
  if (vd && Array.isArray(vd.transactions)) {
    const winner = pickFresher(data, vd);
    if (winner === vd) { data = migrate(vd); try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {} idbPut(data); }
    else if ((data.rev || 0) > (vd.rev || 0)) await writeVault(vaultDir, data);
  }
  emit();
  return { ok: true };
}

export async function disconnectVault() {
  vaultDir = null; vaultOn = false; vaultNeedsPerm = false; xmlOnDisk = new Set();
  await idbSetRaw('vaultDir', null);
  emit();
}

// ---- Ripristino da backup/snapshot del vault ----
export async function listRestorePoints() {
  if (!vaultDir) return [];
  const out = [];
  for (const [sub, type] of [['backups', 'backup'], ['snapshots', 'snapshot']]) {
    try { const h = await vaultDir.getDirectoryHandle(sub); for (const f of (await listJson(h))) { try { const file = await (await h.getFileHandle(f)).getFile(); out.push({ type, file: f, mtime: file.lastModified, size: file.size }); } catch (e) {} } } catch (e) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
export async function restorePoint(type, file) {
  if (!vaultDir) return { ok: false };
  try {
    const h = await vaultDir.getDirectoryHandle(type === 'snapshot' ? 'snapshots' : 'backups');
    const obj = JSON.parse(await (await (await h.getFileHandle(file)).getFile()).text());
    if (!Array.isArray(obj.transactions)) return { ok: false };
    try { const xmlDir = await vaultDir.getDirectoryHandle('xml'); for (const inv of (obj.invoices || [])) { if (!inv.xml) { try { inv.xml = await (await (await xmlDir.getFileHandle(inv.id + '.xml')).getFile()).text(); } catch (e) {} } } } catch (e) {}
    obj.rev = Math.max(obj.rev || 0, data.rev || 0) + 1;
    data = migrate(obj);
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
    idbPut(data);
    await writeVault(vaultDir, data);
    emit();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---- Allegati (binari su disco, solo vault: cartella allegati/) ----
// I metadati {id,name,size,type,addedAt,file} stanno nel JSON; il binario sta in allegati/<file>.
// Disponibili solo con cartella collegata (come gli XML, non entrano in backup/snapshot/export JSON).
export const attachmentsReady = () => vaultOn && !!vaultDir;
async function allegatiDir() { if (!vaultDir) return null; try { return await vaultDir.getDirectoryHandle('allegati', { create: true }); } catch (e) { return null; } }
const safeFileName = n => String(n || 'file').replace(/[^\p{L}\p{N}.\-_ ]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';

// Scrive il file e ritorna i metadati (il chiamante li aggiunge al record e salva).
export async function addAttachment(file) {
  const dir = await allegatiDir();
  if (!dir) return { ok: false, reason: 'no-vault' };
  const id = uid();
  const stored = `${id}__${safeFileName(file.name)}`;
  try {
    const fh = await dir.getFileHandle(stored, { create: true });
    const w = await fh.createWritable();
    await w.write(file);
    await w.close();
  } catch (e) { return { ok: false, reason: 'write', error: e.message }; }
  return { ok: true, meta: { id, name: file.name || stored, size: file.size || 0, type: file.type || '', addedAt: Date.now(), file: stored } };
}

// Ritorna un File leggibile dal disco, o null se mancante.
export async function readAttachment(meta) {
  const dir = await allegatiDir();
  if (!dir || !meta?.file) return null;
  try { const fh = await dir.getFileHandle(meta.file); return await fh.getFile(); } catch (e) { return null; }
}

// Rimuove il file dal disco (best-effort).
export async function deleteAttachment(meta) {
  const dir = await allegatiDir();
  if (!dir || !meta?.file) return false;
  try { await dir.removeEntry(meta.file); return true; } catch (e) { return false; }
}

// Rimuove l'XML di una fattura eliminata dalla cartella xml/ (best-effort, evita accumulo di orfani).
export async function deleteXmlFile(invId) {
  xmlOnDisk.delete(invId);
  if (!vaultDir || !invId) return;
  try { const xmlDir = await vaultDir.getDirectoryHandle('xml'); await xmlDir.removeEntry(invId + '.xml'); } catch (e) {}
}

// Riconciliazione: rimuove dalla cartella allegati/ i file non più referenziati da alcuna
// rateizzazione (orfani da crash o da snapshot ripristinati). Best-effort, eseguito al boot.
export async function reconcileAttachments() {
  const dir = await allegatiDir();
  if (!dir) return { removed: 0 };
  const referenced = new Set();
  (data.loans || []).forEach(l => (l.attachments || []).forEach(a => { if (a.file) referenced.add(a.file); }));
  const orphans = [];
  try { for await (const [name, h] of dir.entries()) { if (h.kind === 'file' && !referenced.has(name)) orphans.push(name); } } catch (e) { return { removed: 0 }; }
  let removed = 0;
  for (const name of orphans) { try { await dir.removeEntry(name); removed++; } catch (e) {} }
  return { removed };
}
