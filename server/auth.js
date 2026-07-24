// ============ Autenticazione — hashing password (scrypt) + sessioni persistenti ============
// Nessuna dipendenza esterna (solo node:crypto/node:fs/node:path). Derivato dal modello
// di Zen-Store. Le sessioni sono PERSISTENTI su file (data/sessions.json, accanto al DB)
// con scadenza SCORREVOLE per inattività: sopravvivono a riavvii e aggiornamenti del
// server (l'updater non tocca data/, che non è nemmeno versionata). File mancante o
// corrotto → si riparte senza sessioni, senza errori. Con DB in memoria (test) non si
// persiste su disco: le sessioni restano solo in RAM.
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH } from './db.js';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return calc.length === known.length && timingSafeEqual(calc, known);
}

// ---- Sessioni: token -> { userId, creata, lastSeen } ----
// Fonte di verità in RAM; il file sessions.json ne è la copia durevole. Scadenza
// SCORREVOLE: ogni accesso valido rinnova lastSeen; oltre IDLE_TTL_MS di inattività la
// sessione è scaduta. Il file si riscrive SEMPRE su creazione/distruzione; il rinnovo di
// lastSeen è THROTTLED (al più una scrittura ogni PERSIST_THROTTLE_MS) per non toccare il
// disco a ogni richiesta.
const IDLE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 giorni di inattività
const PERSIST_THROTTLE_MS = 1000 * 60 * 5;    // rinnovo lastSeen: riscrivi al più ogni 5 min
// Percorso del file sessioni: accanto al DB (in data/). DB in memoria → nessuna persistenza.
const SESSIONS_PATH = DB_PATH === ':memory:' ? null : join(dirname(DB_PATH), 'sessions.json');

const sessions = new Map();

// Rimuove le sessioni scadute per inattività. Ritorna true se ha cambiato qualcosa.
function pruneExpired(now = Date.now()) {
  let changed = false;
  for (const [t, s] of sessions) {
    if (now - (s.lastSeen ?? s.creata ?? 0) > IDLE_TTL_MS) { sessions.delete(t); changed = true; }
  }
  return changed;
}

// Scrittura ATOMICA: file temporaneo + rename (stesso filesystem). Errori ignorati:
// la persistenza non deve mai far cadere una richiesta.
function persist() {
  if (!SESSIONS_PATH) return;
  const obj = { v: 1, sessions: Object.fromEntries(sessions) };
  const tmp = `${SESSIONS_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSIONS_PATH);
  } catch {}
}

// Carica il file all'avvio del modulo. Tollerante: mancante/corrotto → vuoti; ignora
// record malformati; accetta campi extra futuri. Pulisce le scadute e, se necessario,
// riscrive il file già ripulito.
function load() {
  if (!SESSIONS_PATH) return;
  let raw;
  try { raw = readFileSync(SESSIONS_PATH, 'utf8'); } catch { return; } // file assente → si parte vuoti
  try {
    const obj = JSON.parse(raw);
    const map = obj && typeof obj === 'object' ? obj.sessions : null;
    if (map && typeof map === 'object') {
      for (const [t, s] of Object.entries(map)) {
        if (s && typeof s === 'object' && s.userId != null) {
          const creata = s.creata ?? Date.now();
          sessions.set(t, { userId: s.userId, creata, lastSeen: s.lastSeen ?? creata });
        }
      }
    }
  } catch {} // JSON corrotto → si riparte vuoti
  if (pruneExpired()) persist();
}
load();

export function createSession(userId) {
  const token = randomUUID();
  const now = Date.now();
  sessions.set(token, { userId, creata: now, lastSeen: now });
  persist();
  return token;
}

export function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  const last = s.lastSeen ?? s.creata ?? 0;
  if (now - last > IDLE_TTL_MS) { sessions.delete(token); persist(); return null; }
  // Rinnovo scorrevole. Avanza lastSeen (e persiste) solo oltre la soglia di throttle:
  // così una sessione attiva si mantiene viva senza scrivere su disco a ogni richiesta.
  if (now - last > PERSIST_THROTTLE_MS) { s.lastSeen = now; persist(); }
  return s;
}

export function destroySession(token) {
  if (sessions.delete(token)) persist();
}
export function destroySessionsOfUser(userId) {
  let changed = false;
  for (const [t, s] of sessions) if (s.userId === userId) { sessions.delete(t); changed = true; }
  if (changed) persist();
}
