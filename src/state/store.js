// ============ Persistenza via server locale (node:sqlite) ============
// Fonte di verità durevole: il DB del server. In memoria: `data`.
//  - boot()  → GET  /api/data     (carica lo stato dal DB)
//  - save()  → POST /api/changes  (GRANULARE: invia solo i record cambiati dall'ultimo save)
//  - setData/importJSON → PUT /api/data (sostituzione totale, con backup forzato)
// Il frontend continua a mutare `data` e chiamare save(); il diff lo calcola questo modulo.

import { DEFAULT_DATA, migrate, DATA_VERSION } from './model.js';

export let data = DEFAULT_DATA();

// Collezioni versionate (stesso ordine del modello). settings gestite a parte.
const COLLECTION_KEYS = ['companies', 'accounts', 'categories', 'suppliers', 'rules',
  'transactions', 'invoices', 'scheduled', 'loans', 'log'];

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

let lastSavedAt = null;
let saveTimer = null;
let inflight = false;
let snapshot = null; // { <key>: Map(id → JSON), __settings: JSON } dell'ultimo stato confermato dal server

// ---- Stato del salvataggio (spia AFFIDABILE: riflette l'esito reale lato server) ----
// 'saved'  = tutto confermato dal server · 'saving' = modifica in corso/non confermata
// 'error'  = ultima scrittura fallita (resta finché un tentativo non riesce)
let dirty = false, errored = false;
let conflict = false;   // il server ha rifiutato (409): un'altra scheda ha scritto → attende scelta utente
let serverRev = null;   // revisione attuale del server comunicata col 409 (per il "forza")
const statusListeners = new Set();
export function onSaveStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
export function saveStatus() { return conflict ? 'conflict' : errored ? 'error' : (inflight || dirty) ? 'saving' : 'saved'; }
function notifyStatus() { const s = saveStatus(); statusListeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } }); }

// ---- Snapshot & diff -------------------------------------------------------
function snapOf(d) {
  const s = {};
  for (const k of COLLECTION_KEYS) {
    const m = new Map();
    for (const rec of (d[k] || [])) if (rec && rec.id != null) m.set(rec.id, JSON.stringify(rec));
    s[k] = m;
  }
  s.__settings = JSON.stringify(d.settings || {});
  return s;
}
// Confronta lo snapshot col `data` corrente → changeset { settings?, collections:{key:{upsert,remove}} }.
function diff(prev, d) {
  const collections = {};
  let any = false;
  for (const k of COLLECTION_KEYS) {
    const pm = prev[k] || new Map();
    const upsert = [], remove = [], seen = new Set();
    for (const rec of (d[k] || [])) {
      if (!rec || rec.id == null) continue;
      seen.add(rec.id);
      if (pm.get(rec.id) !== JSON.stringify(rec)) upsert.push(rec);
    }
    for (const id of pm.keys()) if (!seen.has(id)) remove.push(id);
    if (upsert.length || remove.length) { collections[k] = { upsert, remove }; any = true; }
  }
  const out = { collections };
  if (JSON.stringify(d.settings || {}) !== prev.__settings) { out.settings = d.settings || {}; any = true; }
  return any ? out : null;
}

// ---- Boot: carica lo stato dal server ----
export async function boot() {
  try {
    const res = await fetch('/api/data');
    data = res.ok ? migrate(await res.json()) : DEFAULT_DATA();
  } catch (e) { console.error('Boot: server non raggiungibile', e); data = DEFAULT_DATA(); }
  snapshot = snapOf(data);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }
  emit();
}

// ---- Save: invia solo il diff (debounced) ----
export function save({ silent = false } = {}) {
  data.savedAt = Date.now();
  data.version = DATA_VERSION;
  dirty = true; notifyStatus();          // c'è qualcosa di non ancora confermato dal server
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushChanges, 300);
  if (!silent) emit();
}

async function flushChanges() {
  if (!snapshot) return;
  if (conflict) return; // in conflitto: si attende la scelta dell'utente (ricarica/forza), niente auto-save
  if (inflight) { clearTimeout(saveTimer); saveTimer = setTimeout(flushChanges, 200); return; } // evita sovrapposizioni
  const cs = diff(snapshot, data);
  if (!cs) { dirty = false; errored = false; notifyStatus(); return; } // niente da inviare = già in sync
  cs.baseRev = data.rev ?? null; // revisione su cui si basano queste modifiche (guardia 409 lato server)
  const sent = snapOf(data); // fotografia esatta di ciò su cui si basa il changeset
  inflight = true; dirty = false; notifyStatus();
  try {
    const res = await fetch('/api/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cs) });
    if (res.ok) { const j = await res.json(); if (j && j.rev) data.rev = j.rev; snapshot = sent; lastSavedAt = Date.now(); errored = false; }
    else if (res.status === 409) { // un'altra scheda ha scritto: NON sovrascrivere, chiedi all'utente
      const j = await res.json().catch(() => ({}));
      serverRev = (j && j.rev != null) ? j.rev : null;
      conflict = true; dirty = true; errored = false; // modifiche locali conservate
      console.warn('Conflitto di concorrenza: il database è stato modificato altrove.');
    }
    else { errored = true; dirty = true; console.error('Salvataggio non riuscito:', res.status); } // NON confermato → resta da salvare
  } catch (e) { errored = true; dirty = true; console.error('Errore di salvataggio:', e); }
  finally {
    inflight = false; notifyStatus();
    if (dirty && !conflict) { clearTimeout(saveTimer); saveTimer = setTimeout(flushChanges, errored ? 3000 : 250); } // riprova (non in conflitto)
  }
}

// Ricarica lo stato dal server SCARTANDO le modifiche locali non salvate (scelta "Ricarica" nel conflitto).
export async function reloadFromServer() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) return false;
    data = migrate(await res.json());
    snapshot = snapOf(data);
    conflict = false; dirty = false; errored = false; serverRev = null;
    notifyStatus(); emit();
    return true;
  } catch (e) { return false; }
}

// Forza il salvataggio delle modifiche locali sovrascrivendo l'altra scheda (scelta "Forza" nel conflitto):
// allinea il baseRev alla revisione attuale del server, così il prossimo changeset viene accettato.
export function forceSave() {
  if (serverRev != null) data.rev = serverRev;
  conflict = false; serverRev = null; dirty = true; notifyStatus();
  clearTimeout(saveTimer); saveTimer = setTimeout(flushChanges, 0);
}

// Sostituzione TOTALE (import/wipe): PUT dell'intero stato + backup forzato lato server.
async function putWhole({ force = false } = {}) {
  inflight = true; notifyStatus();
  try {
    const res = await fetch('/api/data' + (force ? '?force=1' : ''), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    if (res.ok) { const j = await res.json(); if (j && j.rev) data.rev = j.rev; lastSavedAt = Date.now(); dirty = false; errored = false; }
    else { errored = true; console.error('Salvataggio totale non riuscito:', res.status); }
  } catch (e) { errored = true; console.error('Errore salvataggio totale:', e); }
  finally { inflight = false; notifyStatus(); }
}

export function setData(newData, { persist = true } = {}) {
  data = migrate(newData);
  snapshot = snapOf(data);
  if (persist) putWhole({ force: true });
  emit();
}

// Scrittura immediata all'uscita pagina (invia il diff residuo con keepalive).
export function flush() {
  if (!snapshot || conflict) return;
  const cs = diff(snapshot, data);
  if (!cs) return;
  cs.baseRev = data.rev ?? null; // se un'altra scheda ha già scritto, il server rifiuta (protegge i dati)
  try {
    fetch('/api/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cs), keepalive: true });
  } catch (e) {}
}

// ---- Export / Import JSON (backup manuale) ----
// Il backup deve essere COMPLETO: chiede al server l'export con gli xml (?full=1),
// che in memoria (leggera) non abbiamo. Fallback all'in-memory se il server non risponde.
export async function exportJSON() {
  let payload;
  try { const res = await fetch('/api/data?full=1'); payload = res.ok ? await res.text() : null; } catch (e) { payload = null; }
  if (payload == null) payload = JSON.stringify(data);
  const blob = new Blob([payload], { type: 'application/json' });
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
    r.onload = async () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.transactions) || !Array.isArray(d.companies)) throw new Error('Struttura non valida');
        data = migrate(d);
        snapshot = snapOf(data);
        await putWhole({ force: true });        // invia al server anche gli xml presenti nel file
        // rirendi lo stato in memoria "leggero" (senza xml), coerente col boot
        try { const res = await fetch('/api/data'); if (res.ok) { data = migrate(await res.json()); snapshot = snapOf(data); } } catch (e) {}
        emit();
        resolve(data);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(new Error('Lettura file fallita'));
    r.readAsText(file);
  });
}

// XML di una fattura, on-demand (lazy-load). Ritorna la stringa XML o null.
export async function getInvoiceXml(id) {
  if (!id) return null;
  try { const res = await fetch('/api/invoices/' + id + '/xml'); return res.ok ? await res.text() : null; }
  catch (e) { return null; }
}

// ---- Compat "vault"/FSA: nel modello server lo store durevole è il DB ----
export const fileSupported = () => false;
export const vaultStatus = () => ({ supported: true, active: true, needsPerm: false, name: 'server' });
export const vaultTimes = () => ({ snapshot: lastSavedAt, backup: null });
export async function connectVault() { return { ok: true }; }
export async function reauthorizeVault() { return { ok: true }; }
export async function disconnectVault() { return { ok: false }; }
export async function recheckVault() { return true; }
export async function listRestorePoints() { return []; }
export async function restorePoint() { return { ok: false }; }

// ---- Allegati: binari come BLOB via API dedicata ----
export const attachmentsReady = () => true;
export async function addAttachment(file) {
  try {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'file') },
      body: file,
    });
    if (!res.ok) return { ok: false, reason: 'upload' };
    return { ok: true, meta: await res.json() };
  } catch (e) { return { ok: false, reason: 'upload', error: e.message }; }
}
export async function readAttachment(meta) {
  if (!meta?.id) return null;
  try { const res = await fetch('/api/attachments/' + meta.id); return res.ok ? await res.blob() : null; }
  catch (e) { return null; }
}
export async function deleteAttachment(meta) {
  if (!meta?.id) return false;
  try { return (await fetch('/api/attachments/' + meta.id, { method: 'DELETE' })).ok; }
  catch (e) { return false; }
}
export function deleteXmlFile() { /* l'XML ora vive nel DB (doc fattura): nessun file separato */ }
