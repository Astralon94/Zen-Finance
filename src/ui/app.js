// ============ Shell applicativa: topbar, nav a tendina, router ============
import './styles.css';
import { data, subscribe, save, vaultStatus, vaultTimes, connectVault, reauthorizeVault } from '../state/store.js';
import { esc, pad2 } from '../domain/util.js';
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

// Timestamp leggibile: hh:mm se di oggi, altrimenti gg/mm hh:mm. null → stato neutro.
function stamp(ms) {
  if (!ms) return { txt: '—', none: true, full: 'mai (in questa sessione)' };
  const d = new Date(ms), now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  return { txt: sameDay ? hm : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hm}`, none: false, full: d.toLocaleString('it-IT') };
}

// Badge accanto al brand: ultimo snapshot e ultimo backup del vault, aggiornati in tempo reale.
function vaultBadge() {
  const t = vaultTimes();
  const s = stamp(t.snapshot), b = stamp(t.backup);
  const item = (k, v) => `<span class="sb-item"><span class="sb-k">${k}</span><span class="sb-v${v.none ? ' none' : ''}" title="${esc(v.full)}">${esc(v.txt)}</span></span>`;
  return `<span class="snapbadge">${item('Snapshot', s)}<span class="sb-sep"></span>${item('Backup', b)}</span>`;
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

// Schermata bloccante: la cartella dati è obbligatoria. Senza, l'app non parte.
const GATE_ICON = `<svg class="gate-icon" viewBox="92 92 840 840" width="66" height="66" xmlns="http://www.w3.org/2000/svg"><rect x="92" y="92" width="840" height="840" rx="208" ry="208" fill="#545ea6"/><g fill="none" stroke="#fff" stroke-width="74" stroke-linecap="round"><path d="M 700 360 A 222 222 0 1 0 700 664"/><line x1="250" y1="455" x2="610" y2="455"/><line x1="250" y1="569" x2="566" y2="569"/></g></svg>`;
function gateScreen() {
  const v = vaultStatus();
  if (!v.supported) {
    return `<div class="gate"><div class="gate-card">
      ${GATE_ICON}
      <h1>Zen Finance</h1>
      <p>Questa app è local-first e richiede l'accesso a una cartella sul disco tramite il <b>File System Access</b> di Chrome. Aprila con Google Chrome o un browser Chromium su Mac/PC.</p>
    </div></div>`;
  }
  const reauth = v.needsPerm;
  return `<div class="gate"><div class="gate-card">
    ${GATE_ICON}
    <h1>Zen Finance</h1>
    <p>${reauth
      ? 'La cartella dati è collegata ma va <b>riautorizzata</b> per continuare.'
      : 'Scegli una cartella sul disco (anche in iCloud/Dropbox): Zen Finance vi salverà automaticamente fatture, movimenti, conti e tutto il resto, con backup e snapshot ripristinabili. Nessun cloud, nessun account.'}</p>
    <button class="btn primary" id="gateBtn">${reauth ? 'Riautorizza la cartella' : 'Scegli la cartella dati…'}</button>
    <p class="muted">La copia nel browser resta come rete di sicurezza.</p>
  </div></div>`;
}

export function renderApp() {
  applyTheme();
  const app = document.getElementById('app');
  // cartella obbligatoria: se non attiva, mostra la schermata bloccante e basta
  if (!vaultStatus().active) {
    app.innerHTML = gateScreen();
    const btn = app.querySelector('#gateBtn');
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Attendere…';
      const r = vaultStatus().needsPerm ? await reauthorizeVault() : await connectVault();
      if (!r.ok) { btn.disabled = false; btn.textContent = r.canceled ? 'Collega una cartella' : 'Riprova'; }
      // in caso di successo lo store emette → renderApp ridisegna l'app normale
    };
    return;
  }
  updateBadge();
  app.innerHTML = `
    <div class="topbar">
      ${navMenu()}
      <span class="brand">Zen Finance</span>
      ${vaultBadge()}
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

  // view
  const root = app.querySelector('#view');
  const v = VIEWS[current].mod;
  root.innerHTML = v.render();
  if (v.bind) v.bind(root);
}

// re-render quando lo store cambia (mantiene la vista corrente)
let booted = false;
export function startUI() {
  if (!booted) { subscribe(() => renderApp()); booted = true; }
  renderApp();
}
