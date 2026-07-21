// ============ Annullamento (undo) dell'ultima importazione ============
// Undo "di sessione": vive in memoria e riguarda SEMPRE solo l'ultimo import
// (estratto conto o fatture). Non è persistente: un reload dell'app lo azzera —
// coerente col caso d'uso "mi accorgo subito dell'errore".
//
// Meccanica (rispetta il principio "solo fatti" + doc verbatim):
//  • creates[]  — record CREATI dall'import → rimossi in undo (remove granulare via save()).
//  • restores[] — record ESISTENTI modificati dall'import (es. fornitore arricchito da XML)
//                 → ripristinati col doc INTERO pre-import (verbatim), mai per singolo campo.
//  • attachments[] — BLOB allegati caricati dall'import → eliminati dallo storage.
// Nessuna operazione "bulk" da confronti di stato: si toccano SOLO gli id tracciati.
//
// Invalidazione: un nuovo import sostituisce l'undo disponibile; un reload lo perde;
// la modifica manuale di un record creato viene rilevata (fingerprint) e segnalata
// nel dialogo di conferma. La chiusura del banner (✕) rinuncia all'undo.

import { data, save, deleteAttachment } from '../state/store.js';
import { can } from '../state/auth.js';
import { confirmDialog, toast } from './dom.js';
import { esc } from '../domain/util.js';

let current = null; // { type, companyId, permission, count, noun, creates:[{key,id,fp}], restores:[{key,doc}], attachments:[] }

function coName(id) {
  const c = data.companies.find(x => x.id === id);
  return c ? ((c.emoji ? c.emoji + ' ' : '') + c.name) : 'l\'azienda selezionata';
}
function plural(n, noun) {
  if (n === 1) return noun;
  if (noun.endsWith('a')) return noun.slice(0, -1) + 'e';   // fattura → fatture
  if (noun.endsWith('o')) return noun.slice(0, -1) + 'i';   // movimento → movimenti
  return noun + 'i';
}
// concordanza participio ("importato/a/i/e") col genere del sostantivo
function imported(n, noun) {
  const f = noun.endsWith('a');
  return 'importat' + (f ? (n === 1 ? 'a' : 'e') : (n === 1 ? 'o' : 'i'));
}

// Fingerprint corrente di un record creato (per rilevare modifiche manuali successive).
function fpOf(key, id) {
  const rec = (data[key] || []).find(r => r && r.id === id);
  return rec ? JSON.stringify(rec) : null;
}

// Registra il descrittore restituito da commitBankRows/commitDrafts come UNICO undo
// disponibile (sovrascrive l'eventuale precedente) e mostra il banner.
export function registerImport(desc) {
  if (!desc || !desc.count) return;
  current = {
    type: desc.type, companyId: desc.companyId, permission: desc.permission,
    count: desc.count, noun: desc.noun,
    creates: (desc.creates || []).map(c => ({ key: c.key, id: c.id, fp: fpOf(c.key, c.id) })),
    restores: (desc.restores || []).map(r => ({ key: r.key, doc: r.doc })),
    attachments: desc.attachments || [],
  };
  renderBanner();
}

// Il banner sopravvive ai re-render dell'app perché vive nel <body>, fuori da #app.
function ensureBar() {
  let b = document.getElementById('undobar');
  if (!b) { b = document.createElement('div'); b.id = 'undobar'; b.className = 'undobar'; document.body.appendChild(b); }
  return b;
}
function renderBanner() {
  const b = ensureBar();
  if (!current) { b.classList.remove('show'); return; }
  const n = current.count, noun = current.noun;
  b.innerHTML = `
    <div class="ub-txt">${n} ${esc(plural(n, noun))} ${imported(n, noun)}
      <small>su ${esc(coName(current.companyId))}</small></div>
    <div class="ub-act">
      <button class="btn sm" data-ub-undo>Annulla importazione</button>
      <button class="ub-x" data-ub-x title="Chiudi" aria-label="Chiudi">✕</button>
    </div>`;
  b.querySelector('[data-ub-undo]').onclick = askUndo;
  b.querySelector('[data-ub-x]').onclick = dismiss;
  b.classList.add('show');
}

function hide() { const b = document.getElementById('undobar'); if (b) b.classList.remove('show'); }
function dismiss() { current = null; hide(); }

function askUndo() {
  if (!current) return;
  if (!can(current.permission)) { toast('Permesso mancante per annullare l\'importazione'); return; }

  // Confronta lo stato attuale con la fotografia post-import.
  let present = 0, modified = 0, gone = 0;
  for (const c of current.creates) {
    const fp = fpOf(c.key, c.id);
    if (fp == null) gone++;
    else { present++; if (fp !== c.fp) modified++; }
  }
  const n = current.count, noun = current.noun;
  let body = `Verranno rimoss${present === 1 ? 'o' : 'i'} ${present} record importat${present === 1 ? 'o' : 'i'} su ${coName(current.companyId)}`;
  if (current.restores.length) {
    const r = current.restores.length;
    // import estratto conto: i restore sono movimenti già presenti riabbinati; altrimenti anagrafiche arricchite
    body += current.type === 'bank'
      ? `, ripristinando ${r} moviment${r === 1 ? 'o' : 'i'} abbinat${r === 1 ? 'o' : 'i'}`
      : `, ripristinando ${r} anagrafic${r === 1 ? 'a' : 'he'} arricchit${r === 1 ? 'a' : 'e'}`;
  }
  body += '.';
  if (gone) body += ` ${gone} risultano già eliminati.`;
  if (modified) body += ` Attenzione: ${modified} sono stati modificati a mano dopo l'import e verranno comunque rimossi.`;

  confirmDialog(`Annullare l'importazione?`, body, 'Annulla importazione', doUndo, { danger: true });
}

async function doUndo() {
  if (!current) return;
  const snap = current; current = null; hide();

  // Rimuove i record creati (solo gli id tracciati ancora presenti).
  const removeByKey = {};
  for (const c of snap.creates) (removeByKey[c.key] ||= new Set()).add(c.id);
  for (const key of Object.keys(removeByKey)) {
    if (!Array.isArray(data[key])) continue;
    data[key] = data[key].filter(r => !(r && removeByKey[key].has(r.id)));
  }
  // Ripristina il doc verbatim dei record modificati (solo se ancora esistono).
  for (const r of snap.restores) {
    const arr = data[r.key]; if (!Array.isArray(arr)) continue;
    const i = arr.findIndex(x => x && x.id === r.doc.id);
    if (i >= 0) arr[i] = r.doc;
  }
  save(); // → POST /api/changes: la spia di salvataggio e l'audit log del server registrano remove/update

  // Elimina i BLOB allegati caricati dall'import (non coperti dal changeset).
  for (const meta of (snap.attachments || [])) { try { await deleteAttachment(meta); } catch (e) {} }

  toast(`Importazione annullata · ${snap.count} ${plural(snap.count, snap.noun)} rimoss${snap.count === 1 ? 'a' : 'e'}`);
}
