// ============ Server HTTP — zero dipendenze (solo core Node) ============
// Serve la SPA statica in /public ed espone l'API dati in /api.
// Fase attuale: fondamenta dati (export/import/reset + boot). Il porting del frontend
// e gli endpoint granulari CRUD arriveranno nella fase successiva.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportData, importData, applyChanges, resetData, seedIfEmpty, counts, getInvoiceXml } from './server/serialize.js';
import { putAttachment, getAttachment, deleteAttachment } from './server/attachments.js';
import { backupDb } from './server/db.js';
import * as updater from './server/updater.js';
import { createSession, getSession, destroySession, destroySessionsOfUser, verifyPassword } from './server/auth.js';
import { PERMISSIONS, NAV, RUOLI, hasPermission, canWriteData, assegnabili } from './server/permissions.js';
import {
  seedAdminIfEmpty, verifyLogin, utentePubblico, getByIdAttivo, setPassword,
  listPublic, create as createUser, update as updateUser, remove as removeUser,
} from './server/users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 4331;

// ---- Aggiornamento software (metodo Zen-Store: manifest + pacchetto su GitHub Releases) ----
// Codice di uscita che chiede al supervisore/launcher di riavviare (per applicare un aggiornamento).
const EXIT_RESTART = 42;
// URL del manifest "latest" (repo pubblica). Sovrascrivibile/disattivabile con la env ZEN_UPDATE_URL.
const UPDATE_URL = process.env.ZEN_UPDATE_URL !== undefined
  ? process.env.ZEN_UPDATE_URL
  : 'https://github.com/Astralon94/zen-finance-update/releases/latest/download/manifest.json';
// Cache dell'ultimo controllo (per la UI, senza richiamare la rete a ogni richiesta).
let ultimoCheck = { corrente: updater.currentVersion(__dirname), disponibile: false, controllato_il: null };

async function controllaAggiornamenti() {
  if (!UPDATE_URL) return;
  try {
    const r = await updater.checkUpdate(UPDATE_URL, __dirname);
    ultimoCheck = { ...r, controllato_il: new Date().toISOString() };
    if (r.disponibile) console.log(`[update] disponibile la versione ${r.ultima} (attuale ${r.corrente})`);
  } catch { /* rete non disponibile: riprova al prossimo giro */ }
}
function programmaAggiornamenti() {
  if (!UPDATE_URL) return;
  controllaAggiornamenti();
  const t = setInterval(controllaAggiornamenti, 12 * 60 * 60 * 1000);
  if (t.unref) t.unref();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
});
const readRawBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', () => resolve(Buffer.alloc(0)));
});

// ---- Autenticazione (multiutenza, Livello A) ----
// Interruttore anti-lockout: ZEN_AUTH_DISABLED=1 disattiva l'auth (un unico admin
// locale, comportamento pre-multiutenza). È la via di fuga se il login si rompe o
// si perde la password (insieme allo script scripts/reset-admin.mjs).
const AUTH_ON = process.env.ZEN_AUTH_DISABLED !== '1' && process.env.ZEN_AUTH_DISABLED !== 'true';
// Utente sintetico usato quando l'auth è disattivata (bypass): admin con tutti i permessi.
const LOCAL_ADMIN = { id: 0, username: 'local', nome: 'Locale', ruolo: 'admin', permessi: [] };

// Risolve l'utente della richiesta dal token di sessione. null = non autenticato.
// Ritorna { user (pubblico), row (record DB o null), token }.
function resolveUser(req) {
  if (!AUTH_ON) return { user: LOCAL_ADMIN, row: null, token: '' };
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-token'] || '');
  const s = getSession(token);
  if (!s) return null;
  const row = getByIdAttivo(s.userId);
  if (!row) return null;
  return { user: utentePubblico(row), row, token };
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', <resource>, <id>?]
  const resource = parts[1], id = parts[2];
  const method = req.method;

  // ---- AUTENTICAZIONE: health e login sono PUBBLICI; il resto richiede sessione ----
  if (resource === 'health' && method === 'GET') {
    return json(res, 200, { ok: true, app: 'zen-finance-server', auth: AUTH_ON, ...counts() });
  }
  if (resource === 'auth' && id === 'login' && method === 'POST') {
    if (!AUTH_ON) return json(res, 200, { token: 'local', utente: LOCAL_ADMIN });
    const b = await readBody(req);
    const u = verifyLogin(b?.username, b?.password);
    if (!u) return json(res, 401, { error: 'Credenziali non valide' });
    return json(res, 200, { token: createSession(u.id), utente: utentePubblico(u) });
  }

  const me = resolveUser(req);
  if (!me) return json(res, 401, { error: 'Non autenticato' });
  const user = me.user;
  const need = (key) => hasPermission(user, key);
  const forbid = () => json(res, 403, { error: 'Permesso negato' });

  // Auth self-service (utente corrente).
  if (resource === 'auth') {
    if (id === 'me' && method === 'GET') return json(res, 200, { utente: user });
    if (id === 'logout' && method === 'POST') { if (me.token) destroySession(me.token); return json(res, 200, { ok: true }); }
    if (id === 'password' && method === 'POST') {
      if (!AUTH_ON) return json(res, 200, { ok: true });
      const b = await readBody(req);
      if (!me.row || !verifyPassword(b?.attuale || '', me.row.password_hash)) return json(res, 400, { error: 'Password attuale errata' });
      if (!b.nuova || String(b.nuova).length < 4) return json(res, 400, { error: 'La nuova password è troppo corta' });
      setPassword(me.row.id, b.nuova);
      return json(res, 200, { ok: true });
    }
  }

  // Registro permessi per la UI (gating menu + schermata permessi).
  if (resource === 'meta' && id === 'permessi' && method === 'GET') {
    return json(res, 200, { permessi: PERMISSIONS, assegnabili: assegnabili(), nav: NAV, ruoli: RUOLI });
  }

  // XML fattura on-demand (lazy-load): NON viaggia nel boot.
  if (resource === 'invoices' && id && parts[3] === 'xml' && method === 'GET') {
    const xml = getInvoiceXml(id);
    if (xml == null) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(xml);
  }

  // Stato completo: GET per il boot (leggero, senza xml), PUT per sostituzione totale.
  // GET /api/data?full=1 include gli xml (usato dall'export backup).
  if (resource === 'data') {
    if (method === 'GET') {
      // Boot: qualsiasi autenticato. Export completo (?full=1, con xml) = backup → dati.export.
      const full = url.searchParams.get('full') === '1';
      if (full && !need('dati.export')) return forbid();
      return json(res, 200, exportData({ includeXml: full }));
    }
    if (method === 'PUT') { // sostituzione totale (import/wipe): alto privilegio
      if (!need('dati.import')) return forbid();
      const b = await readBody(req);
      if (b == null) return json(res, 400, { error: 'JSON non valido' });
      const force = url.searchParams.get('force') === '1';
      try { return json(res, 200, { ok: true, ...importData(b, { force }) }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
  }

  // Scritture GRANULARI: applica solo i record cambiati.
  if (resource === 'changes' && method === 'POST') {
    const b = await readBody(req);
    if (b == null) return json(res, 400, { error: 'JSON non valido' });
    // Guardia di scrittura GROSSOLANA (Livello A): un changeset che tocca le collezioni
    // richiede un permesso di gestione dati; uno solo di `settings` (tema/azienda attiva)
    // è consentito a qualsiasi autenticato (preferenze di vista).
    const toccaCollezioni = b.collections && typeof b.collections === 'object' &&
      Object.values(b.collections).some((ch) => ch && ((ch.upsert && ch.upsert.length) || (ch.remove && ch.remove.length)));
    if (toccaCollezioni && !canWriteData(user)) return forbid();
    try { return json(res, 200, { ok: true, ...applyChanges(b) }); }
    catch (e) {
      if (e && e.conflict) return json(res, 409, { error: 'conflict', rev: e.rev }); // revisione superata: il client ricarica o forza
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (resource === 'reset' && method === 'POST') {
    if (!need('dati.reset')) return forbid();
    return json(res, 200, { ok: true, ...resetData() });
  }

  // ---- AGGIORNAMENTO SOFTWARE ----
  if (resource === 'updates') {
    // Stato corrente (versione + ultimo controllo in cache)
    if (method === 'GET') {
      return json(res, 200, { ...ultimoCheck, url_configurato: !!UPDATE_URL });
    }
    // Controlla ora (interroga il manifest su GitHub)
    if (method === 'POST' && id === 'check') {
      if (!need('software.aggiorna')) return forbid();
      if (!UPDATE_URL) return json(res, 400, { error: 'Aggiornamenti disattivati (ZEN_UPDATE_URL vuota)' });
      try {
        const r = await updater.checkUpdate(UPDATE_URL, __dirname);
        ultimoCheck = { ...r, controllato_il: new Date().toISOString() };
        return json(res, 200, ultimoCheck);
      } catch (e) { return json(res, 502, { error: 'Controllo fallito: ' + e.message }); }
    }
    // Scarica e installa l'aggiornamento, poi esce con codice 42 (il supervisore riavvia sul codice nuovo).
    if (method === 'POST' && id === 'install') {
      if (!need('software.aggiorna')) return forbid();
      if (!UPDATE_URL) return json(res, 400, { error: 'Aggiornamenti disattivati (ZEN_UPDATE_URL vuota)' });
      try {
        const chk = await updater.checkUpdate(UPDATE_URL, __dirname);
        if (!chk.disponibile) return json(res, 409, { error: 'Nessun aggiornamento disponibile' });
        if (!chk.download_url) return json(res, 400, { error: 'Il manifest non indica il pacchetto (url)' });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rep = await updater.installaAggiornamento(chk.download_url, { appDir: __dirname, dataDir: join(__dirname, 'data'), stamp });
        // backup del database prima del riavvio, poi uscita differita per far tornare la risposta
        try { backupDb({ force: true }); } catch {}
        setTimeout(() => process.exit(EXIT_RESTART), 800);
        return json(res, 200, { ok: true, ...rep, riavvio: true });
      } catch (e) { return json(res, 500, { error: 'Installazione fallita: ' + e.message }); }
    }
  }

  // Allegati (BLOB): upload / download / delete.
  if (resource === 'attachments') {
    if (method === 'POST' && !id) {
      if (!canWriteData(user)) return forbid();
      const bin = await readRawBody(req);
      if (!bin.length) return json(res, 400, { error: 'File vuoto' });
      const name = decodeURIComponent(req.headers['x-filename'] || 'file');
      const type = req.headers['content-type'] || 'application/octet-stream';
      return json(res, 201, putAttachment(name, type, bin));
    }
    if (method === 'GET' && id) { // lettura: qualsiasi autenticato
      const row = getAttachment(id);
      if (!row) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': row.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(row.name || 'file')}"`,
      });
      return res.end(Buffer.from(row.bin));
    }
    if (method === 'DELETE' && id) { if (!canWriteData(user)) return forbid(); return json(res, 200, { ok: deleteAttachment(id) }); }
  }

  // ---- UTENTI (gestione account e permessi) ----
  if (resource === 'utenti') {
    if (!need('utenti.manage')) return forbid();
    if (method === 'GET' && !id) return json(res, 200, listPublic());
    if (method === 'POST' && !id) {
      const b = await readBody(req);
      try { return json(res, 201, createUser(b || {})); }
      catch (e) { return json(res, e.code || 400, { error: String(e.message || e) }); }
    }
    if (method === 'PUT' && id) {
      const b = await readBody(req);
      try {
        const pub = updateUser(id, b || {});
        destroySessionsOfUser(Number(id)); // permessi/ruolo cambiati → nuovo login
        return json(res, 200, pub);
      } catch (e) { return json(res, e.code || 400, { error: String(e.message || e) }); }
    }
    if (method === 'DELETE' && id) {
      if (Number(id) === user.id) return json(res, 409, { error: 'Non puoi eliminare te stesso' });
      try { const r = removeUser(id); destroySessionsOfUser(Number(id)); return json(res, 200, r); }
      catch (e) { return json(res, e.code || 400, { error: String(e.message || e) }); }
    }
  }

  return json(res, 404, { error: 'endpoint non trovato' });
}

// Pagina di stato provvisoria finché non è portato il frontend.
function statusPage() {
  const c = counts();
  const rows = Object.entries(c).filter(([k]) => k !== 'rev')
    .map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right">${v}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Zen-Finance server</title>
  <style>body{font:15px/1.5 system-ui;margin:3rem auto;max-width:34rem;color:#26303a}
  h1{font-size:1.2rem}code{background:#eef;padding:.1em .35em;border-radius:4px}
  table{border-collapse:collapse;margin-top:1rem}td{border-bottom:1px solid #e5e7eb;padding:.3rem .8rem}</style>
  <h1>🟢 Zen-Finance — server dati attivo</h1>
  <p>DB relazionale (node:sqlite) — <b>rev ${c.rev}</b>. Frontend non ancora portato.</p>
  <p>API: <code>GET /api/data</code> · <code>PUT /api/data</code> · <code>POST /api/reset</code> · <code>GET /api/health</code></p>
  <table><tr><th style="text-align:left">Tabella</th><th>Righe</th></tr>${rows}</table>`;
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  // favicon.ico non esiste come file: rispondi con la PNG brand (il 404 fa scattare l'icona generica)
  if (rel === '/favicon.ico') rel = '/icon-180.png';
  if (rel === '/') {
    // SPA: index.html SEMPRE rivalidato (no-cache) così dopo un aggiornamento il browser
    // non serve mai il vecchio bundle inlinato. Locale = costo di refetch trascurabile.
    try { const html = await readFile(join(PUBLIC, 'index.html')); res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); return res.end(html); }
    catch { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); return res.end(statusPage()); }
  }
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

seedIfEmpty();       // primo avvio: DB vuoto → dati di default
seedAdminIfEmpty();  // primo avvio (o DB pre-multiutenza): crea admin/admin se non ci sono utenti

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Errore interno', detail: String(err.message || err) });
  }
}).listen(PORT, () => {
  console.log(`\n  Zen-Finance — server dati (v${updater.currentVersion(__dirname)})`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ rev ${counts().rev}\n`);
  updater.bootstrapAssets(__dirname); // materializza le icone (bootstrap una-tantum)
  programmaAggiornamenti(); // controllo aggiornamenti all'avvio e ogni 12 ore
});
