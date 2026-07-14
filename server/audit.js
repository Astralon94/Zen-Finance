// ============ Registro attività (audit log) — tabella STANDALONE `audit_log` ============
// Mirror architetturale di attachments.js/users.js: possiede le operazioni sulla tabella
// `audit_log` (creata nella DDL di db.js), fuori dal ciclo COLLECTIONS/serialize.
// Import/export/reset/changes NON la toccano → il registro sopravvive a qualunque
// operazione sui dati. Regola d'oro: qui NON si scrive mai una password o un hash.
import { db } from './db.js';

// Tetto massimo di righe: oltre questo, all'inserimento si eliminano le più vecchie.
const MAX_ROWS = 20000;
const TRIM_SLACK = 500; // si sfoltisce a blocchi per non pagare il DELETE a ogni insert

const insertStmt = db.prepare(
  'INSERT INTO audit_log (ts, username, action, collection, record_id, label, details) VALUES (?,?,?,?,?,?,?)'
);

let sinceTrim = 0;
function maybeTrim() {
  if (++sinceTrim < TRIM_SLACK) return;
  sinceTrim = 0;
  const n = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  if (n > MAX_ROWS) {
    // Elimina le righe più vecchie (id crescente = più vecchie) fino a rientrare nel cap.
    db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)')
      .run(n - MAX_ROWS);
  }
}

// Scrive un evento. `username` è già risolto dal chiamante (l'utente autenticato).
// Non lancia mai: un fallimento del log non deve interrompere l'operazione principale.
export function logEvent({ username, action, collection = null, record_id = null, label = null, details = null }) {
  try {
    insertStmt.run(
      Date.now(), username || null, action || null, collection, record_id != null ? String(record_id) : null,
      label != null ? String(label).slice(0, 200) : null,
      details != null ? JSON.stringify(details) : null,
    );
    maybeTrim();
  } catch { /* il log è best-effort: mai bloccante */ }
}

// Scrive più eventi in blocco (usa la stessa transazione implicita del chiamante se aperta).
export function logMany(username, events) {
  if (!Array.isArray(events) || !events.length) return;
  for (const e of events) logEvent({ username, ...e });
}

// Elenco paginato con filtri opzionali: q (testo su label/username/collection/action),
// action (esatta), user (username esatto). Ritorna { rows, total }.
export function listAudit({ limit = 30, offset = 0, q = '', action = '', user = '' } = {}) {
  const where = [];
  const args = [];
  if (action) { where.push('action = ?'); args.push(String(action)); }
  if (user) { where.push('username = ?'); args.push(String(user)); }
  if (q && String(q).trim()) {
    const like = '%' + String(q).trim().toLowerCase() + '%';
    where.push('(lower(label) LIKE ? OR lower(username) LIKE ? OR lower(collection) LIKE ? OR lower(action) LIKE ?)');
    args.push(like, like, like, like);
  }
  const wsql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${wsql}`).get(...args).n;
  const lim = Math.min(200, Math.max(1, Number(limit) || 30));
  const off = Math.max(0, Number(offset) || 0);
  const rows = db.prepare(`SELECT id, ts, username, action, collection, record_id, label, details FROM audit_log${wsql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, lim, off)
    .map((r) => ({ ...r, details: r.details ? safeParse(r.details) : null }));
  return { rows, total };
}

// Valori distinti presenti (per popolare i filtri della UI).
export function auditFacets() {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL ORDER BY action').all().map((r) => r.action);
  const users = db.prepare('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY username').all().map((r) => r.username);
  return { actions, users };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
