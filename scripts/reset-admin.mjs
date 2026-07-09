// ============ Recupero accesso amministratore (anti-lockout) ============
// Ripristina/crea un amministratore attivo, per rientrare se si perde la password
// o l'auth si comporta male. NON tocca i dati (`data/`): agisce solo sulla tabella
// standalone `utenti`. La via di fuga complementare è la env ZEN_AUTH_DISABLED=1.
//
// Uso:
//   node scripts/reset-admin.mjs                 → admin / admin
//   node scripts/reset-admin.mjs <password>      → admin / <password>
//   node scripts/reset-admin.mjs <user> <pass>   → <user> (admin) / <pass>
import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const args = process.argv.slice(2);
const username = (args.length >= 2 ? args[0] : 'admin').trim();
const password = args.length >= 2 ? args[1] : (args[0] || 'admin');

const existing = db.prepare('SELECT * FROM utenti WHERE username=?').get(username);
if (existing) {
  db.prepare("UPDATE utenti SET password_hash=?, ruolo='admin', attivo=1 WHERE id=?")
    .run(hashPassword(password), existing.id);
  console.log(`[reset-admin] utente "${username}" ripristinato come amministratore attivo, password aggiornata.`);
} else {
  db.prepare("INSERT INTO utenti (username, nome, password_hash, ruolo, permessi, attivo, creato_il) VALUES (?,?,?,?,'[]',1,?)")
    .run(username, 'Amministratore', hashPassword(password), 'admin', new Date().toISOString());
  console.log(`[reset-admin] creato nuovo amministratore "${username}".`);
}
console.log('[reset-admin] Accedi e cambia subito la password.');
