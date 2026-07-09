// ============ Autenticazione lato client ============
// Stato di sessione del browser: token Bearer in localStorage, utente pubblico e
// registro permessi (meta). Tutte le fetch dati passano da authFetch(), che inietta
// l'header Authorization e, su 401, riporta l'app alla schermata di login.
// Nota: NON si persiste l'utente/meta (solo il token): al reload si ricarica da /me.

const TOKEN_KEY = 'zenfinance_token';

// Utente pubblico corrente: { id, username, nome, ruolo, permessi[], attivo } o null.
export let user = null;
// Registro dal server: { permessi[], assegnabili[], nav[], ruoli }. Serve alla UI (Fase 3).
export let meta = null;

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

// L'utente ha un permesso? Gli admin hanno tutto; gli adminOnly non sono mai
// concessi ai non-admin. Rispecchia hasPermission() lato server.
export function can(key) {
  if (!user) return false;
  if (user.ruolo === 'admin') return true;
  const p = (meta?.permessi || []).find(x => x.key === key);
  if (p && p.adminOnly) return false;
  return Array.isArray(user.permessi) && user.permessi.includes(key);
}

// Una voce di navigazione (dal registro `meta.nav`) è visibile all'utente?
// Rispecchia canSeeNav() lato server: usa `any` (almeno uno) se presente, altrimenti `perm`.
export function canSeeNav(nav) {
  if (!nav) return false;
  return Array.isArray(nav.any) ? nav.any.some(k => can(k)) : can(nav.perm);
}

export function clear() { setToken(null); user = null; }

// Carica il registro permessi/nav dal server e lo assegna a `meta`. Da invocare dopo
// aver impostato token/utente: è ciò che alimenta il gating della UI (nav + permessi).
// Ritorna true se il registro è stato caricato.
export async function loadMeta() {
  try {
    const res = await authFetch('/api/meta/permessi');
    if (res.ok) { meta = await res.json(); return true; }
  } catch (e) {}
  return false;
}

// Login: su 200 salva token e utente; su 401 rilancia l'errore (credenziali errate).
// Carica ANCHE `meta`: senza, al primo accesso (login fresco o bypass) il gating della
// nav resterebbe senza dati fino a un reload → buco di gating per gli operatori standard.
export async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new Error('Credenziali non valide');
  if (!res.ok) throw new Error('Accesso non riuscito');
  const j = await res.json();
  setToken(j.token);
  user = j.utente;
  await loadMeta();
  return user;
}

// Ricarica la sessione dal token presente: /me (utente) + /meta/permessi (registro),
// in parallelo. Ritorna false se il token non è valido (401 su /me), true se ok.
export async function loadSession() {
  if (!getToken()) return false;
  try {
    const [meRes] = await Promise.all([
      authFetch('/api/auth/me'),
      loadMeta(),
    ]);
    if (meRes.status === 401 || !meRes.ok) return false;
    user = (await meRes.json()).utente;
    return true;
  } catch (e) { return false; }
}

export async function logout() {
  try { await authFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  clear();
}

// Wrapper di fetch che inietta il Bearer token (se presente), fondendo gli header
// già passati senza sovrascriverli. Su 401 (fuori dal login) azzera la sessione e
// ricarica la pagina, riportando alla schermata di login.
export async function authFetch(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const t = getToken();
  if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !String(path).startsWith('/auth/login') && !String(path).startsWith('/api/auth/login')) {
    clear();
    if (typeof location !== 'undefined') location.reload();
    throw new Error('Sessione scaduta');
  }
  return res;
}

// ---- API gestione utenti/permessi (richiedono `utenti.manage` lato server) ----
// Ogni helper lancia un Error col messaggio del server (campo {error}) sugli stati 4xx,
// così le view possono mostrarlo direttamente con toast.
async function jsonOrThrow(res, fallback) {
  let j = null; try { j = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((j && j.error) || fallback);
  return j;
}

export async function listUsers() {
  return jsonOrThrow(await authFetch('/api/utenti'), 'Impossibile caricare gli utenti');
}
export async function createUser(body) {
  return jsonOrThrow(await authFetch('/api/utenti', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), 'Creazione non riuscita');
}
export async function updateUser(id, body) {
  return jsonOrThrow(await authFetch('/api/utenti/' + encodeURIComponent(id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), 'Modifica non riuscita');
}
export async function deleteUser(id) {
  return jsonOrThrow(await authFetch('/api/utenti/' + encodeURIComponent(id), { method: 'DELETE' }), 'Eliminazione non riuscita');
}

// Cambio password dell'utente corrente.
export async function changePassword(attuale, nuova) {
  return jsonOrThrow(await authFetch('/api/auth/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attuale, nuova }),
  }), 'Cambio password non riuscito');
}
