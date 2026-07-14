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
//  Modello (Livello A, granularità FINE): autenticazione + gating UI + guardia di
//  scrittura sul backend (un solo endpoint dati). I permessi sono decomposti per
//  ENTITÀ × AZIONE: ogni singolo controllo di scrittura della UI è gatinato dal
//  permesso specifico. Nessun filtraggio del dataset per utente: tutti gli
//  autenticati caricano lo stato intero (app locale su un Mac).
//
//  Vocabolario azioni (suffissi): .view (consultare, una sola per AREA di nav),
//  .crea, .modifica, .elimina, .importa, .esporta + azioni di dominio
//  (.riconcilia, .pagamenti, .esegui, .rate, .allegati).
//
//  Regole d'oro:
//   - Gli utenti con ruolo 'admin' hanno SEMPRE tutti i permessi.
//   - I permessi con adminOnly:true valgono solo per gli admin (non assegnabili).
//   - I permessi con write:true abilitano la scrittura dei DATI (vedi DATA_MANAGE).
//   - I permessi standard sono "particellari": assegnabili singolarmente.
// =============================================================================

export const RUOLI = { admin: 'Amministratore', standard: 'Operatore' };

// Catalogo permessi (particellari). `group` serve a raggrupparli nella UI;
// `write:true` marca le azioni che modificano le collezioni dati.
export const PERMISSIONS = [
  // ---- Riepiloghi (sola lettura) ----
  { key: 'dashboard.view',       group: 'Riepiloghi',     label: 'Vedere la Dashboard' },
  { key: 'pnl.view',             group: 'Riepiloghi',     label: 'Vedere il Conto economico' },

  // ---- Movimenti ----
  { key: 'movimenti.view',       group: 'Movimenti',      label: 'Consultare i movimenti' },
  { key: 'movimenti.crea',       group: 'Movimenti',      label: 'Registrare nuovi movimenti', write: true },
  { key: 'movimenti.modifica',   group: 'Movimenti',      label: 'Modificare i movimenti (dati e stato)', write: true },
  { key: 'movimenti.elimina',    group: 'Movimenti',      label: 'Eliminare i movimenti', write: true },
  { key: 'movimenti.importa',    group: 'Movimenti',      label: 'Importare estratti conto', write: true },
  { key: 'movimenti.riconcilia', group: 'Movimenti',      label: 'Riconciliare e scollegare i movimenti', write: true },

  // ---- Fatture ----
  { key: 'fatture.view',         group: 'Fatture',        label: 'Consultare le fatture' },
  { key: 'fatture.crea',         group: 'Fatture',        label: 'Registrare fatture manuali', write: true },
  { key: 'fatture.importa',      group: 'Fatture',        label: 'Importare fatture (XML/P7M/ZIP)', write: true },
  { key: 'fatture.modifica',     group: 'Fatture',        label: 'Modificare le fatture e gli allegati', write: true },
  { key: 'fatture.elimina',      group: 'Fatture',        label: 'Eliminare le fatture', write: true },
  { key: 'fatture.pagamenti',    group: 'Fatture',        label: 'Registrare pagamenti e saldi delle fatture', write: true },
  { key: 'fatture.esporta',      group: 'Fatture',        label: 'Esportare le fatture in XML' },

  // ---- Scadenze (F24 + Programmati) ----
  { key: 'f24.view',             group: 'Scadenze',       label: 'Consultare gli F24' },
  { key: 'programmati.view',     group: 'Scadenze',       label: 'Consultare i movimenti programmati' },
  { key: 'programmati.crea',     group: 'Scadenze',       label: 'Creare movimenti programmati', write: true },
  { key: 'programmati.modifica', group: 'Scadenze',       label: 'Modificare i movimenti programmati', write: true },
  { key: 'programmati.elimina',  group: 'Scadenze',       label: 'Eliminare i movimenti programmati', write: true },
  { key: 'programmati.esegui',   group: 'Scadenze',       label: 'Completare e riaprire le scadenze', write: true },

  // ---- Rateizzazioni / Finanziamenti ----
  { key: 'finanziamenti.view',     group: 'Rateizzazioni', label: 'Consultare rateizzazioni e finanziamenti' },
  { key: 'finanziamenti.crea',     group: 'Rateizzazioni', label: 'Creare rateizzazioni', write: true },
  { key: 'finanziamenti.modifica', group: 'Rateizzazioni', label: 'Modificare rateizzazioni e piani rate', write: true },
  { key: 'finanziamenti.elimina',  group: 'Rateizzazioni', label: 'Eliminare le rateizzazioni', write: true },
  { key: 'finanziamenti.rate',     group: 'Rateizzazioni', label: 'Pagare e riaprire le rate', write: true },
  { key: 'finanziamenti.allegati', group: 'Rateizzazioni', label: 'Gestire gli allegati delle rateizzazioni', write: true },

  // ---- Anagrafiche (una view di area + azioni per singola entità) ----
  { key: 'anagrafiche.view',     group: 'Anagrafiche',    label: 'Consultare aziende, conti, categorie, fornitori, regole' },
  { key: 'aziende.crea',         group: 'Anagrafiche',    label: 'Creare aziende', write: true },
  { key: 'aziende.modifica',     group: 'Anagrafiche',    label: 'Modificare le aziende', write: true },
  { key: 'aziende.elimina',      group: 'Anagrafiche',    label: 'Eliminare le aziende', write: true },
  { key: 'conti.crea',           group: 'Anagrafiche',    label: 'Creare conti', write: true },
  { key: 'conti.modifica',       group: 'Anagrafiche',    label: 'Modificare i conti', write: true },
  { key: 'conti.elimina',        group: 'Anagrafiche',    label: 'Eliminare i conti', write: true },
  { key: 'categorie.crea',       group: 'Anagrafiche',    label: 'Creare categorie', write: true },
  { key: 'categorie.modifica',   group: 'Anagrafiche',    label: 'Modificare le categorie', write: true },
  { key: 'categorie.elimina',    group: 'Anagrafiche',    label: 'Eliminare le categorie', write: true },
  { key: 'fornitori.crea',       group: 'Anagrafiche',    label: 'Creare fornitori', write: true },
  { key: 'fornitori.modifica',   group: 'Anagrafiche',    label: 'Modificare i fornitori', write: true },
  { key: 'fornitori.elimina',    group: 'Anagrafiche',    label: 'Eliminare i fornitori', write: true },
  { key: 'regole.crea',          group: 'Anagrafiche',    label: 'Creare regole di auto-categorizzazione', write: true },
  { key: 'regole.modifica',      group: 'Anagrafiche',    label: 'Modificare le regole e riapplicarle', write: true },
  { key: 'regole.elimina',       group: 'Anagrafiche',    label: 'Eliminare le regole', write: true },

  // ---- Configurazione (non concorrono a DATA_MANAGE) ----
  { key: 'audit.view',           group: 'Configurazione', label: 'Consultare il registro attività' },
  { key: 'impostazioni.manage',  group: 'Configurazione', label: 'Gestire aspetto e manutenzione' },
  { key: 'software.aggiorna',    group: 'Configurazione', label: 'Controllare e installare gli aggiornamenti software' },
  { key: 'dati.export',          group: 'Configurazione', label: 'Esportare il backup JSON' },
  { key: 'dati.import',          group: 'Configurazione', label: 'Importare/sostituire i dati (operazione totale)' },
  { key: 'dati.reset',           group: 'Configurazione', label: 'Azzerare tutti i dati' },
  { key: 'utenti.manage',        group: 'Configurazione', label: 'Gestire utenti e permessi', adminOnly: true },
];

// Voci di navigazione: ognuna richiede un permesso (`perm`). La voce Impostazioni
// è raggiungibile con UNO QUALSIASI dei permessi in `any` (contiene sotto-sezioni
// export/import/reset/aggiornamento gestite da permessi distinti).
export const NAV = [
  { key: 'dash',   icon: '◷',  label: 'Dashboard',       perm: 'dashboard.view' },
  { key: 'mov',    icon: '↕',  label: 'Movimenti',       perm: 'movimenti.view' },
  { key: 'fatt',   icon: '🧾', label: 'Fatture',         perm: 'fatture.view' },
  { key: 'f24',    icon: '🏛️', label: 'F24',             perm: 'f24.view' },
  { key: 'prog',   icon: '🗓️', label: 'Programmati',     perm: 'programmati.view' },
  { key: 'fin',    icon: '🏦', label: 'Rateizzazioni',   perm: 'finanziamenti.view' },
  { key: 'pnl',    icon: '📊', label: 'Conto economico', perm: 'pnl.view' },
  { key: 'anag',   icon: '👤', label: 'Anagrafiche',     perm: 'anagrafiche.view' },
  { key: 'attivita', icon: '🕘', label: 'Attività',      perm: 'audit.view' },
  { key: 'utenti', icon: '👥', label: 'Utenti',          perm: 'utenti.manage' },
  { key: 'set',    icon: '⚙',  label: 'Impostazioni',    perm: 'impostazioni.manage', any: ['impostazioni.manage', 'software.aggiorna', 'dati.export', 'dati.import', 'dati.reset'] },
];

// Permessi che abilitano la scrittura dei DATI (collezioni). Derivati dal flag
// `write` del catalogo: sono le azioni crea/modifica/elimina/importa/riconcilia/
// pagamenti/esegui/rate/allegati di ogni entità (esclusi i .view, gli .esporta e
// le chiavi di Configurazione). Servono alla guardia grossolana su POST /api/changes:
// chi non ne ha nessuno è di sola lettura.
export const DATA_MANAGE = PERMISSIONS.filter((p) => p.write).map((p) => p.key);

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
