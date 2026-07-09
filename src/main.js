// ============ Entry point ============
import { boot } from './state/store.js';
import { startUI, applyTheme } from './ui/app.js';
import { login, loadSession, getToken } from './state/auth.js';
import { showLogin } from './ui/login.js';

// Avvia l'app vera e propria (dati + UI), da eseguire SOLO una volta autenticati.
async function startApp() {
  await boot();
  applyTheme();
  startUI();
}

// Gate di autenticazione all'avvio.
//  1) /api/health dice se l'auth è attiva lato server.
//     - auth === false (bypass): prendo un token locale e salto il login.
//  2) auth attiva: senza token (o sessione non valida) → schermata di login.
//  3) autenticato → startApp().
(async function () {
  // Nel modello server il service worker è DISATTIVATO: farebbe cache di /api/data
  // (dati stale). Se un SW era stato registrato da una sessione FSA precedente, lo rimuovo.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations?.().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }

  let authOn = true;
  try {
    const res = await fetch('/api/health');
    if (res.ok) authOn = (await res.json()).auth !== false;
  } catch (e) { /* server non raggiungibile: prosegui col login */ }

  if (!authOn) {
    // Backend in bypass: qualsiasi credenziale è accettata; niente schermata di login.
    try { await login('local', ''); } catch (e) {}
    return startApp();
  }

  if (getToken() && await loadSession()) return startApp();

  // Nessuna sessione valida → mostra il login; a successo avvia l'app.
  showLogin(() => startApp());
})();
