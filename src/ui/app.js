// ============ Shell applicativa: topbar, nav a tendina, router ============
import './styles.css';
import { data, subscribe, save, onSaveStatus, saveStatus, reloadFromServer, forceSave } from '../state/store.js';
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
import * as settings from './views/impostazioni.js';

const VIEWS = {
  dash: { mod: dash, title: 'Dashboard', icon: '◷' },
  mov: { mod: mov, title: 'Movimenti', icon: '↕' },
  fatt: { mod: fatt, title: 'Fatture', icon: '🧾' },
  f24: { mod: f24, title: 'F24', icon: '🏛️' },
  prog: { mod: prog, title: 'Programmati', icon: '🗓️' },
  fin: { mod: fin, title: 'Rateizzazioni', icon: '🏦' },
  pnl: { mod: pnl, title: 'Conto economico', icon: '📊' },
  anag: { mod: anag, title: 'Anagrafiche', icon: '👤' },
  set: { mod: settings, title: 'Impostazioni', icon: '⚙' }
};
const ORDER = ['dash', 'mov', 'fatt', 'f24', 'prog', 'fin', 'pnl', 'anag', 'set'];

let current = 'dash';
let mql = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const t = data.settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && mql.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
mql.addEventListener('change', applyTheme);

export function go(view) { current = view; renderApp(); window.scrollTo(0, 0); }

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
  const items = ORDER.map(k => {
    const v = VIEWS[k];
    const n = (k === 'fatt') ? od : (k === 'prog') ? sc : (k === 'fin') ? lo : 0;
    const badge = n ? `<span class="navbadge">${n}</span>` : '';
    return `<button data-go="${k}" class="${current === k ? 'on' : ''}"><span class="ic">${v.icon}</span>${esc(v.title)}${badge}</button>`;
  }).join('');
  return `<div class="navwrap">
    <button class="navbtn" id="navToggle"><span>☰</span><span>${esc(VIEWS[current].title)}</span></button>
    <div class="navmenu" id="navMenu">${items}</div>
  </div>`;
}

export function renderApp() {
  applyTheme();
  const app = document.getElementById('app');
  updateBadge();
  app.innerHTML = `
    <div class="topbar">
      ${navMenu()}
      <span class="brand">Zen Finance</span>
      <span class="savebadge" id="saveBadge" title="Stato del salvataggio sul database" style="font-size:12px;font-weight:600;white-space:nowrap;margin-left:10px">${saveBadgeInner()}</span>
      <span class="spacer"></span>
      ${companySelect()}
    </div>
    <main><div id="view"></div></main>`;

  // nav
  const toggle = app.querySelector('#navToggle');
  const menu = app.querySelector('#navMenu');
  toggle.onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
  menu.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { menu.classList.remove('open'); go(b.dataset.go); });

  // company
  const sel = app.querySelector('#coSel');
  sel.onchange = () => { data.settings.activeCompany = sel.value || null; save(); };

  // spia salvataggio: in conflitto è cliccabile per riaprire la scelta ricarica/forza
  const badge = app.querySelector('#saveBadge');
  if (badge) { badge.style.cursor = 'pointer'; badge.onclick = () => { if (saveStatus() === 'conflict') showConflictDialog(); }; }

  // view
  const root = app.querySelector('#view');
  const v = VIEWS[current].mod;
  root.innerHTML = v.render();
  if (v.bind) v.bind(root);
}

// re-render quando lo store cambia (mantiene la vista corrente)
let booted = false;
export function startUI() {
  if (!booted) { subscribe(() => renderApp()); onSaveStatus(refreshSaveBadge); booted = true; }
  renderApp();
}
