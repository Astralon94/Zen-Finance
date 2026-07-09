// ============ Autenticazione — hashing password (scrypt) + sessioni in memoria ============
// Nessuna dipendenza esterna (solo node:crypto). Derivato dal modello di Zen-Store.
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

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

// Sessioni in memoria: token -> { userId, creata }.
// Nota: sono volatili — un riavvio del server (anche dopo un aggiornamento) le azzera
// e richiede un nuovo login. Va bene per un'app locale su un solo Mac.
const sessions = new Map();
const TTL_MS = 1000 * 60 * 60 * 12; // 12 ore

export function createSession(userId) {
  const token = randomUUID();
  sessions.set(token, { userId, creata: Date.now() });
  return token;
}

export function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.creata > TTL_MS) { sessions.delete(token); return null; }
  return s;
}

export function destroySession(token) { sessions.delete(token); }
export function destroySessionsOfUser(userId) {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t);
}
