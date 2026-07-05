// ============ Entry point ============
import { boot } from './state/store.js';
import { startUI, applyTheme } from './ui/app.js';

(async function () {
  await boot();
  applyTheme();
  startUI();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
