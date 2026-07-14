// ============ Data layer — node:sqlite (nessuna dipendenza esterna) ============
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', 'data');
// DB su file, salvo override (usato dai test con ':memory:').
export const DB_PATH = process.env.ZEN_DB || join(DATA_DIR, 'zenfinance.db');
const onDisk = DB_PATH !== ':memory:';
if (onDisk) mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
// WAL = crash-safety; foreign_keys = integrità referenziale sui figli posseduti.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---- DDL generata dalla specifica ----
function ddl() {
  let sql = `
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    -- Binari degli allegati: tabella STANDALONE, non gestita dalle COLLECTIONS.
    -- I salvataggi/changeset/import NON la toccano → i BLOB non vengono mai sovrascritti.
    CREATE TABLE IF NOT EXISTS attachments_bin (id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, addedAt INTEGER, bin BLOB);
    -- Utenti/permessi (multiutenza): tabella STANDALONE come attachments_bin.
    -- Fuori da COLLECTIONS → import/export/reset/changes NON la toccano mai (le password
    -- non finiscono nei backup JSON e un import non azzera gli account). Additiva: i DB
    -- esistenti ricevono la tabella al primo avvio, dati intatti.
    CREATE TABLE IF NOT EXISTS utenti (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL,
      nome          TEXT,
      password_hash TEXT    NOT NULL,
      ruolo         TEXT    NOT NULL DEFAULT 'standard',  -- admin | standard
      permessi      TEXT    NOT NULL DEFAULT '[]',        -- JSON array di chiavi permesso
      attivo        INTEGER NOT NULL DEFAULT 1,
      creato_il     TEXT    NOT NULL
    );
    -- Registro attività (audit log): tabella STANDALONE come utenti/attachments_bin.
    -- Fuori da COLLECTIONS/serialize → import/export/reset/changes NON la toccano mai:
    -- il registro SOPRAVVIVE a un import o a un azzeramento dei dati. Additiva: i DB
    -- esistenti la ricevono al primo avvio. Cap ~20000 righe (trim all'inserimento).
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,   -- epoch ms
      username   TEXT,               -- chi ha agito (mai la password)
      action     TEXT,               -- crea | modifica | elimina | import | reset | password
      collection TEXT,               -- transactions | invoices | … | utenti (null per import/reset)
      record_id  TEXT,               -- id del record toccato (null per import/reset)
      label      TEXT,               -- etichetta leggibile derivata dal doc
      details    TEXT                -- JSON opzionale (conteggi, metadati); MAI segreti
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `;
  for (const c of COLLECTIONS) {
    const cols = c.cols.map((x) => `${x.n} ${x.type}`).join(', ');
    sql += `CREATE TABLE IF NOT EXISTS ${c.table} (id TEXT PRIMARY KEY${cols ? ', ' + cols : ''}, doc TEXT NOT NULL);\n`;
    for (const ix of c.index || []) sql += `CREATE INDEX IF NOT EXISTS idx_${c.table}_${ix} ON ${c.table}(${ix});\n`;
    // Testo esterno pesante (es. XML fattura): tabella standalone, fuori dal doc e dal boot.
    if (c.externalText) sql += `CREATE TABLE IF NOT EXISTS ${c.externalText.table} (id TEXT PRIMARY KEY, xml TEXT);\n`;
    for (const ch of c.children || []) {
      const ccols = ch.cols.map((x) => `${x.n} ${x.type}`).join(', ');
      sql += `CREATE TABLE IF NOT EXISTS ${ch.table} (`
        + `seq INTEGER PRIMARY KEY AUTOINCREMENT, `
        + `${ch.fk} TEXT NOT NULL REFERENCES ${c.table}(id) ON DELETE CASCADE, `
        + `id TEXT${ccols ? ', ' + ccols : ''}, doc TEXT NOT NULL${ch.blob ? ', bin BLOB' : ''});\n`;
      sql += `CREATE INDEX IF NOT EXISTS idx_${ch.table}_fk ON ${ch.table}(${ch.fk});\n`;
    }
  }
  return sql;
}
db.exec(ddl());

const p2 = (n) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// Backup del DB PRIMA delle operazioni distruttive. Checkpoint del WAL così la copia
// del solo .db è completa. Mantiene gli ultimi KEEP. Con autosave frequenti il backup è
// THROTTLED (max 1 ogni MIN_INTERVAL); import/reset espliciti lo forzano con { force:true }.
const KEEP_BACKUPS = 20;
const MIN_BACKUP_INTERVAL = 120000; // 2 minuti
let lastBackupAt = 0;
export function backupDb({ force = false } = {}) {
  if (!onDisk || !existsSync(DB_PATH)) return null;
  const now = Date.now();
  if (!force && now - lastBackupAt < MIN_BACKUP_INTERVAL) return null;
  lastBackupAt = now;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  const dir = join(DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `zenfinance-${stamp()}.db`);
  try { copyFileSync(DB_PATH, dest); } catch { return null; }
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    for (let i = 0; i < files.length - KEEP_BACKUPS; i++) unlinkSync(join(dir, files[i]));
  } catch {}
  return dest;
}
