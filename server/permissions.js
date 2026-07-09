// =============================================================================
//  ZEN-FINANCE · CATALOGO PERMESSI — UNICA FONTE DI VERITÀ
// -----------------------------------------------------------------------------
//  Registro centrale di TUTTI i permessi e delle voci di navigazione dell'app.
//  Usato dal backend (guardie API) e servito al frontend (gating menu + schermata
//  permessi utente). Quando si aggiunge una funzione all'app si aggiorna QUI:
//    1) il/i permesso/i in PERMISSIONS
//    2) la voce in NAV (se ha una schermata)
//    3) la guardia nell'endpoint in server.js
//
//  Modello (Livello A): autenticazione + gating UI + guardia di scrittura
//  GROSSOLANA sul backend (un solo endpoint dati). Nessun filtraggio del dataset
//  per utente: tutti gli autenticati caricano lo stato intero (app locale su un Mac).
//
//  Regole d'oro:
//   - Gli utenti con ruolo 'admin' hanno SEMPRE tutti i permessi.
//   - I permessi con adminOnly:true valgono solo per gli admin (non assegnabili).
//   - I permessi standard sono "particellari": assegnabili singolarmente.
// =============================================================================

export const RUOLI = { admin: 'Amministratore', standard: 'Operatore' };

// Catalogo permessi (particellari). `group` serve solo a raggrupparli nella UI.
export const PERMISSIONS = [
  { key: 'dashboard.view',     group: 'Riepiloghi',    label: 'Vedere la Dashboard' },
  { key: 'pnl.view',           group: 'Riepiloghi',    label: 'Vedere il Conto economico' },

  { key: 'movimenti.view',     group: 'Movimenti',     label: 'Consultare i movimenti' },
  { key: 'movimenti.manage',   group: 'Movimenti',     label: 'Registrare/modificare/eliminare movimenti e importare estratti conto' },

  { key: 'fatture.view',       group: 'Fatture',       label: 'Consultare le fatture' },
  { key: 'fatture.manage',     group: 'Fatture',       label: 'Registrare/importare/eliminare fatture e registrare pagamenti' },

  { key: 'f24.view',           group: 'Scadenze',      label: 'Consultare gli F24' },
  { key: 'programmati.view',   group: 'Scadenze',      label: 'Consultare i movimenti programmati' },
  { key: 'programmati.manage', group: 'Scadenze',      label: 'Gestire i movimenti programmati' },

  { key: 'finanziamenti.view', group: 'Rateizzazioni', label: 'Consultare rateizzazioni e finanziamenti' },
  { key: 'finanziamenti.manage', group: 'Rateizzazioni', label: 'Gestire piani, rate e allegati' },

  { key: 'anagrafiche.view',   group: 'Anagrafiche',   label: 'Consultare aziende, conti, categorie, fornitori, regole' },
  { key: 'anagrafiche.manage', group: 'Anagrafiche',   label: 'Gestire aziende, conti, categorie, fornitori, regole' },

  { key: 'impostazioni.manage', group: 'Configurazione', label: 'Gestire le impostazioni e l\'aggiornamento software' },
  { key: 'dati.export',        group: 'Configurazione', label: 'Esportare il backup JSON' },
  { key: 'dati.import',        group: 'Configurazione', label: 'Importare/sostituire i dati (operazione totale)' },
  { key: 'utenti.manage',      group: 'Configurazione', label: 'Gestire utenti e permessi', adminOnly: true },
];

// Voci di navigazione: ognuna richiede un permesso (`perm`). La voce Impostazioni
// è raggiungibile con UNO QUALSIASI dei permessi in `any` (contiene sotto-sezioni
// export/import gestite da permessi distinti).
export const NAV = [
  { key: 'dash',   icon: '◷',  label: 'Dashboard',       perm: 'dashboard.view' },
  { key: 'mov',    icon: '↕',  label: 'Movimenti',       perm: 'movimenti.view' },
  { key: 'fatt',   icon: '🧾', label: 'Fatture',         perm: 'fatture.view' },
  { key: 'f24',    icon: '🏛️', label: 'F24',             perm: 'f24.view' },
  { key: 'prog',   icon: '🗓️', label: 'Programmati',     perm: 'programmati.view' },
  { key: 'fin',    icon: '🏦', label: 'Rateizzazioni',   perm: 'finanziamenti.view' },
  { key: 'pnl',    icon: '📊', label: 'Conto economico', perm: 'pnl.view' },
  { key: 'anag',   icon: '👤', label: 'Anagrafiche',     perm: 'anagrafiche.view' },
  { key: 'utenti', icon: '👥', label: 'Utenti',          perm: 'utenti.manage' },
  { key: 'set',    icon: '⚙',  label: 'Impostazioni',    perm: 'impostazioni.manage', any: ['impostazioni.manage', 'dati.export', 'dati.import'] },
];

// Permessi che abilitano la scrittura dei DATI (collezioni). Servono alla guardia
// grossolana su POST /api/changes: chi non ne ha nessuno è di sola lettura.
export const DATA_MANAGE = [
  'movimenti.manage', 'fatture.manage', 'programmati.manage',
  'finanziamenti.manage', 'anagrafiche.manage',
];

const PERM_INDEX = new Map(PERMISSIONS.map((p) => [p.key, p]));

// Un utente possiede un permesso? Gli admin hanno tutto; adminOnly solo agli admin.
export function hasPermission(user, key) {
  if (!user) return false;
  if (user.ruolo === 'admin') return true;
  const p = PERM_INDEX.get(key);
  if (p && p.adminOnly) return false;
  return Array.isArray(user.permessi) && user.permessi.includes(key);
}

// Verifica che almeno uno dei permessi sia posseduto.
export function hasAny(user, keys) {
  return keys.some((k) => hasPermission(user, k));
}

// Può scrivere i dati (ha almeno un permesso di gestione collezioni)? Gli admin sì.
export function canWriteData(user) {
  return hasAny(user, DATA_MANAGE);
}

// Voce di nav accessibile all'utente (usa `any` se presente, altrimenti `perm`).
export function canSeeNav(user, nav) {
  return nav.any ? hasAny(user, nav.any) : hasPermission(user, nav.perm);
}

// Permessi realmente assegnabili a un operatore standard (esclude gli adminOnly).
export function assegnabili() {
  return PERMISSIONS.filter((p) => !p.adminOnly);
}
