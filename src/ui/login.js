// ============ Schermata di login (gate all'avvio) ============
// Vista a tutto schermo mostrata quando l'auth è attiva e manca una sessione valida.
// Usa i token di styles.css (colori/raggi/ombre/tipografia) + l'accento brand di Finance.
import './styles.css';
import { login } from '../state/auth.js';

// Stili scoped alla schermata di login (coerenti con la card della famiglia Zen).
const CSS = `
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bg); }
.login-card { width: min(380px, 94vw); background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px 26px 26px; }
.login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.login-brand .dot { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); flex-shrink: 0; }
.login-brand .nm { font-size: 19px; font-weight: 600; letter-spacing: -.2px; }
.login-sub { color: var(--sub); font-size: 13px; margin: 0 0 22px 40px; }
.login-card .btn.primary { width: 100%; justify-content: center; margin-top: 6px; padding: 11px 15px; }
.login-err { color: var(--red); font-size: 13px; font-weight: 600; min-height: 18px; margin: 8px 2px 0; }
`;

// Renderizza la schermata e risolve la Promise quando il login riesce.
// onDone() viene invocato dopo un accesso valido (avvio dell'app).
export function showLogin(onDone) {
  if (!document.getElementById('login-style')) {
    const st = document.createElement('style');
    st.id = 'login-style'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="loginForm" autocomplete="on">
        <div class="login-brand"><span class="dot"></span><span class="nm">Zen Finance</span></div>
        <p class="login-sub">Accedi per continuare</p>
        <div class="field">
          <label for="lg-user">Nome utente</label>
          <input id="lg-user" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" required>
        </div>
        <div class="field">
          <label for="lg-pass">Password</label>
          <input id="lg-pass" name="password" type="password" autocomplete="current-password" required>
        </div>
        <div class="login-err" id="lg-err"></div>
        <button class="btn primary" type="submit" id="lg-go">Accedi</button>
      </form>
    </div>`;

  const form = app.querySelector('#loginForm');
  const uEl = app.querySelector('#lg-user');
  const pEl = app.querySelector('#lg-pass');
  const errEl = app.querySelector('#lg-err');
  const btn = app.querySelector('#lg-go');
  uEl.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const u = uEl.value.trim(), p = pEl.value;
    if (!u) { uEl.focus(); return; }
    btn.disabled = true; btn.textContent = 'Accesso…';
    try {
      await login(u, p);
      onDone();
    } catch (err) {
      errEl.textContent = err?.message || 'Accesso non riuscito';
      btn.disabled = false; btn.textContent = 'Accedi';
      pEl.value = ''; pEl.focus();
    }
  });
}
