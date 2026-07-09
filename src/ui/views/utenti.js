// ============ Vista Utenti (gestione accessi e permessi) ============
// Riservata a chi ha `utenti.manage` (gate di nav in app.js + guardia backend).
// I dati arrivano dagli endpoint /api/utenti; il registro permessi/ruoli da meta.
import { esc } from '../../domain/util.js';
import { openSheet, closeSheet, toast, confirmDialog } from '../dom.js';
import { meta, user, can, listUsers, createUser, updateUser, deleteUser } from '../../state/auth.js';

let usersCache = null;   // null = non ancora caricato
let rootEl = null;

const permLabel = k => (meta?.permessi || []).find(p => p.key === k)?.label || k;

export function render() {
  let h = `<div class="pagehead"><h1>Utenti</h1><span class="sub">accessi e permessi</span></div>`;
  // Difesa a valle del gating di nav: senza `utenti.manage` non si mostra nulla.
  if (!can('utenti.manage')) return h + `<div class="card empty">Sezione riservata agli amministratori.</div>`;
  h += `<div class="btnrow" style="margin-bottom:12px"><button class="btn primary" data-new>+ Nuovo utente</button></div>`;
  if (usersCache === null) return h + `<div class="card empty">Caricamento…</div>`;
  if (!usersCache.length) return h + `<div class="card empty">Nessun utente.</div>`;
  h += usersCache.map(userRow).join('');
  return h;
}

function userRow(u) {
  const admin = u.ruolo === 'admin';
  const ruoloBadge = admin ? '<span class="badge b-paid">Admin</span>' : '<span class="badge b-unpaid">Operatore</span>';
  const stato = u.attivo === false ? ' <span class="badge b-overdue">disattivato</span>' : '';
  const isSelf = user && user.id === u.id;
  const perms = admin
    ? '<span class="muted" style="font-size:12.5px">accesso completo</span>'
    : ((u.permessi && u.permessi.length)
      ? u.permessi.map(k => `<span class="chip" style="pointer-events:none;font-size:12px">${esc(permLabel(k))}</span>`).join('')
      : '<span class="muted" style="font-size:12.5px">nessun permesso assegnato</span>');
  return `<div class="card" style="margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div><div><b>${esc(u.nome)}</b> ${ruoloBadge}${stato}</div><div class="muted" style="font-size:12.5px">@${esc(u.username)}</div></div>
      <div class="btnrow" style="flex-wrap:nowrap">
        <button class="btn sm" data-edit="${u.id}">Modifica</button>
        ${isSelf ? '' : `<button class="btn sm danger" data-del="${u.id}">Elimina</button>`}
      </div>
    </div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${perms}</div>
  </div>`;
}

export function bind(root) {
  rootEl = root;
  if (!can('utenti.manage')) return;
  root.querySelector('[data-new]')?.addEventListener('click', () => openUserForm(null));
  // NB: b.dataset.* è SEMPRE stringa, mentre u.id è numerico (INTEGER del DB): confronta come stringhe.
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const u = (usersCache || []).find(x => String(x.id) === b.dataset.edit); if (u) openUserForm(u); });
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const u = (usersCache || []).find(x => String(x.id) === b.dataset.del); if (u) doDelete(u); });
  if (usersCache === null) refresh();
}

async function refresh() {
  try { usersCache = await listUsers(); }
  catch (e) { usersCache = []; toast(e.message || 'Errore nel caricamento utenti'); }
  redraw();
}
function redraw() { if (rootEl) { rootEl.innerHTML = render(); bind(rootEl); } }

// Checkbox dei permessi assegnabili (non-adminOnly), raggruppate per `group`.
function permGroupsHtml(selected) {
  const order = [];
  const byGroup = new Map();
  (meta?.assegnabili || []).forEach(p => {
    if (!byGroup.has(p.group)) { byGroup.set(p.group, []); order.push(p.group); }
    byGroup.get(p.group).push(p);
  });
  return order.map(g => `<div class="section-title">${esc(g)}</div>
    <div class="list">${byGroup.get(g).map(p => `<label class="row" style="cursor:pointer">
      <input type="checkbox" class="selbox" data-perm="${esc(p.key)}" ${selected.includes(p.key) ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">
      <div class="mid"><div class="t1">${esc(p.label)}</div><div class="t2">${esc(p.key)}</div></div>
    </label>`).join('')}</div>`).join('');
}

function openUserForm(u) {
  const isEdit = !!u;
  const ruoli = meta?.ruoli || { admin: 'Amministratore', standard: 'Operatore' };
  const curRuolo = u?.ruolo || 'standard';
  const selectedPerms = new Set(u?.permessi || []);
  openSheet(`
    <h2>${isEdit ? 'Modifica utente' : 'Nuovo utente'}</h2>
    <div class="field"><label>Nome</label><input id="u_nome" value="${esc(u?.nome || '')}"></div>
    <div class="field"><label>Username</label><input id="u_user" value="${esc(u?.username || '')}" ${isEdit ? 'disabled style="opacity:.6"' : 'autocapitalize="none" autocorrect="off" autocomplete="off"'}></div>
    <div class="field"><label>Password</label><input id="u_pass" type="password" placeholder="${isEdit ? 'lascia vuoto per non cambiare' : ''}" autocomplete="new-password"></div>
    <div class="field"><label>Ruolo</label><select id="u_ruolo">
      ${Object.entries(ruoli).map(([k, l]) => `<option value="${k}" ${curRuolo === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select></div>
    ${isEdit ? `<div class="field"><label><input type="checkbox" id="u_attivo" ${u.attivo !== false ? 'checked' : ''}> Attivo</label></div>` : ''}
    <div id="u_perms"></div>
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      const permsBox = sheet.querySelector('#u_perms');
      const ruoloSel = sheet.querySelector('#u_ruolo');
      const drawPerms = () => {
        if (ruoloSel.value === 'admin') {
          permsBox.innerHTML = `<div class="section-title">Permessi</div><div class="card"><div class="muted" style="font-size:13px">Gli amministratori hanno <b>tutti i permessi</b>: nessuna selezione necessaria.</div></div>`;
        } else {
          permsBox.innerHTML = `<div class="section-title">Permessi</div>${permGroupsHtml([...selectedPerms])}`;
          permsBox.querySelectorAll('[data-perm]').forEach(cb => cb.onchange = () => { cb.checked ? selectedPerms.add(cb.dataset.perm) : selectedPerms.delete(cb.dataset.perm); });
        }
      };
      ruoloSel.onchange = drawPerms;
      drawPerms();
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]').onclick = async () => {
        const nome = sheet.querySelector('#u_nome').value.trim();
        const ruolo = ruoloSel.value;
        const pass = sheet.querySelector('#u_pass').value;
        const permessi = ruolo === 'admin' ? [] : [...selectedPerms];
        if (!nome) { toast('Inserisci il nome'); return; }
        const btn = sheet.querySelector('[data-save]'); btn.disabled = true;
        try {
          if (isEdit) {
            const body = { nome, ruolo, permessi, attivo: sheet.querySelector('#u_attivo').checked };
            if (pass) body.password = pass;
            await updateUser(u.id, body);
            toast('Utente aggiornato ✓');
          } else {
            const username = sheet.querySelector('#u_user').value.trim();
            if (!username) { toast('Inserisci lo username'); btn.disabled = false; return; }
            if (!pass) { toast('Imposta una password'); btn.disabled = false; return; }
            await createUser({ username, nome, password: pass, ruolo, permessi });
            toast('Utente creato ✓');
          }
          closeSheet();
          await refresh();
        } catch (e) { toast(e.message || 'Operazione non riuscita'); btn.disabled = false; }
      };
    });
}

function doDelete(u) {
  confirmDialog('Eliminare l\'utente?', `${u.nome} (@${u.username})`, 'Elimina', async () => {
    try { await deleteUser(u.id); toast('Utente eliminato'); await refresh(); }
    catch (e) { toast(e.message || 'Eliminazione non riuscita'); }
  }, { danger: true });
}
