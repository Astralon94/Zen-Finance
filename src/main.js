// ============ Entry point ============
import { boot } from './state/store.js';
import { startUI, applyTheme } from './ui/app.js';

(async function () {
  await boot();
  applyTheme();
  startUI();
  // Nel modello server il service worker è DISATTIVATO: farebbe cache di /api/data
  // (dati stale). Se un SW era stato registrato da una sessione FSA precedente, lo rimuovo.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations?.().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }
})();
