// ============ Shell applicativa: topbar, nav a tendina, router ============
import './styles.css';
import { data, subscribe, save, onSaveStatus, saveStatus, reloadFromServer, forceSave } from '../state/store.js';
import { logout, can, canSeeNav, changePassword, user, meta } from '../state/auth.js';
import { openSheet, closeSheet, toast } from './dom.js';
import { esc } from '../domain/util.js';
import { invoicesInScope, invResiduo, invOverdue } from '../domain/invoices.js';
import { activeCompany } from '../domain/finance.js';

import * as dash from './views/dashboard.js';
import * as mov from './views/movimenti.js';
import * as fatt from './views/fatture.js';
import * as f24 from './views/f24.js';
import * as prog from './views/programmati.js';
import { countOverdue as schedOverdueCount } from './views/programmati.js';
import * as fin from './views/finanziamenti.js';
import { countOverdue as loanOverdueCount } from './views/finanziamenti.js';
import * as pnl from './views/pnl.js';
import * as anag from './views/anagrafiche.js';
import * as attivita from './views/attivita.js';
import * as settings from './views/impostazioni.js';
import * as utenti from './views/utenti.js';
import { openSearch, canSearch } from './search.js';

const VIEWS = {
  dash: { mod: dash, title: 'Dashboard', icon: '◷' },
  mov: { mod: mov, title: 'Movimenti', icon: '↕' },
  fatt: { mod: fatt, title: 'Fatture', icon: '🧾' },
  f24: { mod: f24, title: 'F24', icon: '🏛️' },
  prog: { mod: prog, title: 'Programmati', icon: '🗓️' },
  fin: { mod: fin, title: 'Rateizzazioni', icon: '🏦' },
  pnl: { mod: pnl, title: 'Conto economico', icon: '📊' },
  anag: { mod: anag, title: 'Anagrafiche', icon: '👤' },
  attivita: { mod: attivita, title: 'Attività', icon: '🕘' },
  set: { mod: settings, title: 'Impostazioni', icon: '⚙' },
  utenti: { mod: utenti, title: 'Utenti', icon: '👥' }
};
const ORDER = ['dash', 'mov', 'fatt', 'f24', 'prog', 'fin', 'pnl', 'anag', 'attivita', 'utenti', 'set'];

let current = 'dash';
let mql = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const t = data.settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && mql.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
mql.addEventListener('change', applyTheme);

export function go(view) { current = view; renderApp(); window.scrollTo(0, 0); }

// ---- Gating della navigazione (Fase 3) ----
// Le voci visibili = quelle di ORDER accessibili all'utente secondo il registro
// `meta.nav`. Se il registro manca (backend in bypass: auth disattivata, meta null)
// mostriamo tutto: in quel caso non c'è multiutenza da far rispettare.
function visibleViews() {
  const nav = meta?.nav;
  if (!nav || !nav.length) return ORDER.slice();
  return ORDER.filter(k => { const n = nav.find(x => x.key === k); return n && canSeeNav(n); });
}
// Reindirizza `current` alla prima voce accessibile se quella corrente non lo è.
// current = null → l'utente non ha alcuna sezione (stato vuoto gentile).
function ensureAccessible() {
  const vis = visibleViews();
  if (!vis.length) { current = null; return; }
  if (!current || !vis.includes(current)) current = vis[0];
}

function overdueCount() {
  return invoicesInScope(activeCompany()).filter(i => invResiduo(i) > 0.005 && invOverdue(i)).length;
}

// Badge sull'icona app (Chrome/PWA installata): totale scadute su TUTTE le aziende
function updateBadge() {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return;
  const inv = invoicesInScope(null).filter(i => invResiduo(i) > 0.005 && invOverdue(i)).length;
  const n = inv + schedOverdueCount(null) + loanOverdueCount(null);
  try { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) {}
}

// Spia di salvataggio: riflette lo stato reale confermato dal server.
function saveBadgeInner() {
  const conf = {
    saved:    { c: '#6b8f80', dot: '●', t: 'Salvato' },
    saving:   { c: '#b08a4e', dot: '◍', t: 'Salvataggio…' },
    error:    { c: '#c2685f', dot: '▲', t: 'Non salvato' },
    conflict: { c: '#c2685f', dot: '⚠', t: 'Conflitto — risolvi' },
  };
  const m = conf[saveStatus()] || conf.saved;
  return `<span style="color:${m.c}">${m.dot} ${m.t}</span>`;
}
function refreshSaveBadge() {
  const el = document.getElementById('saveBadge');
  if (el) el.innerHTML = saveBadgeInner();
  if (saveStatus() === 'conflict') showConflictDialog();
}

// Conflitto di concorrenza (409): un'altra scheda/dispositivo ha modificato i dati.
// Non si sovrascrive in silenzio: si chiede all'utente se ricaricare o forzare.
function showConflictDialog() {
  openSheet(`
    <h2>⚠️ Modifiche in un'altra scheda</h2>
    <div class="sheetsub">Il database è stato aggiornato altrove (un'altra scheda o dispositivo) mentre lavoravi qui. Per non sovrascrivere quei dati, il salvataggio è in pausa.</div>
    <div class="list" style="margin:12px 0;gap:8px">
      <div class="muted" style="font-size:13px">🔄 <b>Ricarica</b>: riprende i dati aggiornati dal database. Le modifiche non salvate di <b>questa</b> scheda vengono perse.</div>
      <div class="muted" style="font-size:13px">⤴️ <b>Forza salvataggio</b>: sovrascrive col contenuto di questa scheda (l'altra scheda perde le sue modifiche).</div>
    </div>
    <div class="actions">
      <button class="btn" data-force>Forza salvataggio</button>
      <button class="btn primary" data-reload>Ricarica (consigliato)</button>
    </div>`,
    sheet => {
      sheet.querySelector('[data-reload]').onclick = async () => { const ok = await reloadFromServer(); closeSheet(); toast(ok ? 'Dati ricaricati dal database' : 'Ricarica non riuscita'); };
      sheet.querySelector('[data-force]').onclick = () => { forceSave(); closeSheet(); toast('Salvataggio forzato — l\'altra scheda è stata sovrascritta'); };
    });
}

function companySelect() {
  const ac = activeCompany();
  const opts = ['<option value="">Tutte le aziende</option>']
    .concat(data.companies.map(c => `<option value="${c.id}" ${ac === c.id ? 'selected' : ''}>${esc((c.emoji || '') + ' ' + c.name)}</option>`));
  return `<select class="selbox" id="coSel">${opts.join('')}</select>`;
}

function navMenu() {
  const od = overdueCount();
  const sc = schedOverdueCount(activeCompany());
  const lo = loanOverdueCount(activeCompany());
  const items = visibleViews().map(k => {
    const v = VIEWS[k];
    const n = (k === 'fatt') ? od : (k === 'prog') ? sc : (k === 'fin') ? lo : 0;
    const badge = n ? `<span class="navbadge">${n}</span>` : '';
    return `<button data-go="${k}" class="${current === k ? 'on' : ''}"><span class="ic">${v.icon}</span>${esc(v.title)}${badge}</button>`;
  }).join('');
  const label = current ? VIEWS[current].title : 'Zen Finance';
  return `<div class="navwrap">
    <button class="navbtn" id="navToggle"><span>☰</span><span>${esc(label)}</span></button>
    <div class="navmenu" id="navMenu">${items}</div>
  </div>`;
}

// Menu utente compatto in topbar: nome + ruolo, con Cambia password ed Esci.
function userMenu() {
  const nome = user?.nome || user?.username || 'Utente';
  const ruolo = user ? ((meta?.ruoli && meta.ruoli[user.ruolo]) || (user.ruolo === 'admin' ? 'Amministratore' : 'Operatore')) : '';
  return `<div class="navwrap usermenu" style="margin-left:8px">
    <button class="navbtn" id="userToggle" title="Account"><span class="ic">👤</span><span>${esc(nome)}</span><span style="opacity:.6">▾</span></button>
    <div class="navmenu" id="userMenu">
      <div class="muted" style="padding:6px 11px;font-size:12px">${esc(nome)}${ruolo ? ' · ' + esc(ruolo) : ''}</div>
      <button data-chpw><span class="ic">🔑</span>Cambia password</button>
      <button data-logout><span class="ic">⎋</span>Esci</button>
    </div>
  </div>`;
}

// Sheet per il cambio password dell'utente corrente.
function openChangePassword() {
  openSheet(`
    <h2>Cambia password</h2>
    <div class="field"><label>Password attuale</label><input id="cp_old" type="password" autocomplete="current-password"></div>
    <div class="field"><label>Nuova password</label><input id="cp_new" type="password" autocomplete="new-password"></div>
    <div class="field"><label>Ripeti nuova password</label><input id="cp_new2" type="password" autocomplete="new-password"></div>
    <div class="actions"><button class="btn" data-cancel>Annulla</button><button class="btn primary" data-save>Salva</button></div>`,
    sheet => {
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]').onclick = async () => {
        const attuale = sheet.querySelector('#cp_old').value;
        const nuova = sheet.querySelector('#cp_new').value;
        const nuova2 = sheet.querySelector('#cp_new2').value;
        if (!nuova) { toast('Inserisci la nuova password'); return; }
        if (nuova !== nuova2) { toast('Le password non coincidono'); return; }
        const btn = sheet.querySelector('[data-save]'); btn.disabled = true;
        try { await changePassword(attuale, nuova); closeSheet(); toast('Password aggiornata ✓'); }
        catch (e) { toast(e.message || 'Cambio password non riuscito'); btn.disabled = false; }
      };
    });
}

export function renderApp() {
  applyTheme();
  ensureAccessible();   // reindirizza se `current` non è accessibile a questo utente
  const app = document.getElementById('app');
  updateBadge();
  app.innerHTML = `
    <div class="topbar">
      ${navMenu()}
      <span class="brand">Zen Finance</span>
      <span class="savebadge" id="saveBadge" title="Stato del salvataggio sul database" style="font-size:12px;font-weight:600;white-space:nowrap;margin-left:10px">${saveBadgeInner()}</span>
      <span class="spacer"></span>
      ${canSearch() ? '<button class="iconbtn" id="searchBtn" title="Cerca (⌘K)" aria-label="Cerca">🔎</button>' : ''}
      ${companySelect()}
      ${userMenu()}
    </div>
    <main><div id="view"></div></main>`;

  // nav
  const toggle = app.querySelector('#navToggle');
  const menu = app.querySelector('#navMenu');
  toggle.onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
  menu.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { menu.classList.remove('open'); go(b.dataset.go); });

  // ricerca globale (⌘K)
  app.querySelector('#searchBtn')?.addEventListener('click', () => openSearch());

  // company
  const sel = app.querySelector('#coSel');
  sel.onchange = () => { data.settings.activeCompany = sel.value || null; save(); };

  // menu utente: cambia password / esci
  const uToggle = app.querySelector('#userToggle');
  const uMenu = app.querySelector('#userMenu');
  if (uToggle && uMenu) {
    uToggle.onclick = e => { e.stopPropagation(); uMenu.classList.toggle('open'); };
    uMenu.querySelector('[data-chpw]')?.addEventListener('click', () => { uMenu.classList.remove('open'); openChangePassword(); });
    uMenu.querySelector('[data-logout]')?.addEventListener('click', async () => { uMenu.classList.remove('open'); await logout(); location.reload(); });
  }

  // spia salvataggio: in conflitto è cliccabile per riaprire la scelta ricarica/forza
  const badge = app.querySelector('#saveBadge');
  if (badge) { badge.style.cursor = 'pointer'; badge.onclick = () => { if (saveStatus() === 'conflict') showConflictDialog(); }; }

  // view (o stato vuoto se l'utente non ha alcuna sezione accessibile)
  const root = app.querySelector('#view');
  if (!current) {
    root.innerHTML = `<div class="card empty" style="margin-top:40px">Nessuna sezione disponibile.<br><span class="muted">Contatta l'amministratore per farti assegnare i permessi.</span></div>`;
    return;
  }
  const v = VIEWS[current].mod;
  root.innerHTML = v.render();
  if (v.bind) v.bind(root);
}

// Ricerca globale da tastiera: ⌘K (macOS) / Ctrl+K. Registrato una sola volta.
function bindSearchHotkey() {
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      if (!canSearch()) return;
      e.preventDefault();
      openSearch();
    }
  });
}

// re-render quando lo store cambia (mantiene la vista corrente)
let booted = false;
export function startUI() {
  if (!booted) { subscribe(() => renderApp()); onSaveStatus(refreshSaveBadge); bindSearchHotkey(); booted = true; }
  renderApp();
}
