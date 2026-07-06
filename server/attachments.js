// ============ Allegati: binari come BLOB in attachments_bin ============
// Tabella standalone, indipendente dai salvataggi del modello dati: un update/delete di un
// finanziamento NON tocca i binari. I metadati (id,name,size,type,addedAt) vivono invece
// nel doc del loan (loan.attachments[]) e round-trippano con esso.
import { db } from './db.js';
import { randomUUID } from 'node:crypto';

export function putAttachment(name, type, bin) {
  const id = randomUUID();
  const addedAt = Date.now();
  db.prepare('INSERT INTO attachments_bin (id,name,type,size,addedAt,bin) VALUES (?,?,?,?,?,?)')
    .run(id, name || 'file', type || 'application/octet-stream', bin.length, addedAt, bin);
  return { id, name: name || 'file', type: type || '', size: bin.length, addedAt };
}

export function getAttachment(id) {
  return db.prepare('SELECT name, type, bin FROM attachments_bin WHERE id=?').get(id) || null;
}

export function deleteAttachment(id) {
  return db.prepare('DELETE FROM attachments_bin WHERE id=?').run(id).changes > 0;
}
