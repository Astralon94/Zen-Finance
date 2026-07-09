// ============ Utenti/permessi — tabella STANDALONE `utenti` ============
// Mirror architetturale di attachments.js: possiede le operazioni sulla tabella
// `utenti` (creata nella DDL di db.js), fuori dal ciclo COLLECTIONS/serialize.
// Import/export/reset/changes NON toccano questa tabella.
import { db } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { assegnabili } from './permissions.js';

// Serializza un utente per il client (MAI la password).
export function utentePubblico(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, nome: u.nome, ruolo: u.ruolo,
    permessi: JSON.parse(u.permessi || '[]'), attivo: !!u.attivo,
  };
}

// Accetta solo chiavi di permesso reali e assegnabili (mai adminOnly).
export function sanitizzaPermessi(list) {
  const valide = new Set(assegnabili().map((p) => p.key));
  return (Array.isArray(list) ? list : []).filter((k) => valide.has(k));
}

const nowISO = () => new Date().toISOString();

export function countUtenti() { return db.prepare('SELECT COUNT(*) AS n FROM utenti').get().n; }
export function countAdminAttivi() {
  return db.prepare("SELECT COUNT(*) AS n FROM utenti WHERE ruolo='admin' AND attivo=1").get().n;
}

export function getById(id) { return db.prepare('SELECT * FROM utenti WHERE id=?').get(Number(id)); }
export function findByUsernameAttivo(username) {
  return db.prepare('SELECT * FROM utenti WHERE username=? AND attivo=1').get(String(username || '').trim());
}
export function getByIdAttivo(id) {
  return db.prepare('SELECT * FROM utenti WHERE id=? AND attivo=1').get(Number(id));
}
export function listPublic() {
  return db.prepare('SELECT * FROM utenti ORDER BY ruolo, username').all().map(utentePubblico);
}

// Seed idempotente: crea l'amministratore iniziale SOLO se non esiste alcun utente.
// Password di default "admin" — DA CAMBIARE al primo accesso.
export function seedAdminIfEmpty() {
  if (countUtenti() > 0) return { seeded: false };
  db.prepare('INSERT INTO utenti (username, nome, password_hash, ruolo, permessi, attivo, creato_il) VALUES (?,?,?,?,?,1,?)')
    .run('admin', 'Amministratore', hashPassword('admin'), 'admin', '[]', nowISO());
  console.log('[auth] utente iniziale creato — admin/admin (amministratore). CAMBIARE la password al primo accesso.');
  return { seeded: true };
}

export function verifyLogin(username, password) {
  const u = findByUsernameAttivo(username);
  if (!u || !verifyPassword(password || '', u.password_hash)) return null;
  return u;
}

export function setPassword(id, nuova) {
  db.prepare('UPDATE utenti SET password_hash=? WHERE id=?').run(hashPassword(nuova), Number(id));
}

// Crea un utente. `ruolo` normalizzato ad admin|standard; agli standard i permessi
// sono sanitizzati (mai adminOnly), agli admin si azzerano (hanno tutto implicitamente).
export function create({ username, nome, password, ruolo, permessi }) {
  const uname = String(username || '').trim();
  if (!uname || !password) throw Object.assign(new Error('Username e password obbligatori'), { code: 400 });
  if (db.prepare('SELECT 1 FROM utenti WHERE username=?').get(uname))
    throw Object.assign(new Error('Username già esistente'), { code: 409 });
  const r = ruolo === 'admin' ? 'admin' : 'standard';
  const perms = r === 'admin' ? '[]' : JSON.stringify(sanitizzaPermessi(permessi));
  const res = db.prepare('INSERT INTO utenti (username, nome, password_hash, ruolo, permessi, attivo, creato_il) VALUES (?,?,?,?,?,1,?)')
    .run(uname, nome || '', hashPassword(password), r, perms, nowISO());
  return utentePubblico(getById(res.lastInsertRowid));
}

// Aggiorna un utente esistente. Protegge l'ultimo amministratore attivo.
export function update(id, { nome, password, ruolo, permessi, attivo }) {
  const target = getById(id);
  if (!target) throw Object.assign(new Error('Utente non trovato'), { code: 404 });
  const r = ruolo === 'admin' ? 'admin' : 'standard';
  // Non lasciare il sistema senza amministratori (declassamento o disattivazione dell'ultimo).
  const restaAdmin = r === 'admin' && attivo !== false;
  if (target.ruolo === 'admin' && target.attivo && !restaAdmin && countAdminAttivi() <= 1)
    throw Object.assign(new Error('Deve restare almeno un amministratore'), { code: 409 });
  const perms = r === 'admin' ? '[]' : JSON.stringify(sanitizzaPermessi(permessi));
  db.prepare('UPDATE utenti SET nome=?, ruolo=?, permessi=?, attivo=? WHERE id=?')
    .run(nome ?? target.nome, r, perms, attivo === false ? 0 : 1, Number(id));
  if (password) setPassword(id, password);
  return utentePubblico(getById(id));
}

// Elimina un utente. Protegge l'ultimo amministratore attivo (il divieto di
// auto-eliminazione è gestito dal chiamante, che conosce l'utente corrente).
export function remove(id) {
  const target = getById(id);
  if (!target) return { ok: true };
  if (target.ruolo === 'admin' && target.attivo && countAdminAttivi() <= 1)
    throw Object.assign(new Error('Deve restare almeno un amministratore'), { code: 409 });
  db.prepare('DELETE FROM utenti WHERE id=?').run(Number(id));
  return { ok: true };
}
