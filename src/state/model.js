// ============ Modello dati e default ============
// Principio chiave del refactoring: lo STATO delle fatture NON è mai memorizzato.
// Si memorizzano solo i FATTI (totale, ritenuta, pagamenti[]). Lo stato è SEMPRE derivato
// (vedi domain/invoices.js). Questo elimina i cambi di stato involontari dovuti a
// salvataggi/merge/migrazioni.

export const DATA_VERSION = 2;

export const DEFAULT_DATA = () => ({
  version: DATA_VERSION,
  rev: 0,                 // contatore monotòno: difende dagli overwrite con copie stale
  savedAt: 0,
  settings: { theme: 'auto', currency: 'EUR', activeCompany: null },
  companies: [{ id: 'co1', name: 'Azienda 1', emoji: '🏢', color: '#545ea6', piva: '', note: '' }],
  accounts: [{ id: 'acc1', companyId: 'co1', name: 'Conto corrente', emoji: '🏦', initial: 0, kind: 'standard', excluded: false, fido: 0 }],
  categories: defaultCategories(),
  suppliers: [],          // {id,name,type:'supplier'|'client'|'both',piva,cf,iban,email,note}
  // regole auto-categorizzazione: {id,keyword,enabled,applyIncome,categoryId,supplierId,displayName}
  rules: [],
  // movimenti: {id,companyId,type,amount,categoryId,accountId,toAccountId,supplierId,date,
  //             desc (descrizione grezza banca), note (nome visualizzato), invoiceId, imported, impHash, reconIgnore}
  transactions: [],
  // fatture passive: {id,companyId,supplierId,supplierName,number,date,due,net,vat,total,withholding,
  //                   categoryId,payments:[{id,amount,date,accountId,txId,note}],source:'manual'|'xml',xml,note,createdAt}
  invoices: [],
  // movimenti programmati (scadenziario): {id,companyId,kind:'debit'|'credit',manual,amount,date,
  //   description,accountId,categoryId,supplierId,status:'pending'|'done',doneDate,txId,createdAt}
  scheduled: [],
  // rateizzazioni: {id,companyId,accountId,name,type,lender,totalDebt,startDate,endDate,categoryId,notes,paymentMethod,
  //   installments:[{id,n,date,amount,status:'pending'|'paid',paidDate,txId}],
  //   attachments:[{id,name,size,type,addedAt,file}] (in modalità server i binari andranno in BLOB nel DB),createdAt}
  loans: [],
  // storico eventi fatture (append-only, ultimi 500): {id,at,companyId,type,label,amount,account}
  log: []
});

export function defaultCategories() {
  return [
    { id: 'c-for', name: 'Acquisti / Fornitori', emoji: '📦', type: 'expense' },
    { id: 'c-mat', name: 'Materie prime', emoji: '🧱', type: 'expense' },
    { id: 'c-sti', name: 'Stipendi e compensi', emoji: '👥', type: 'expense' },
    { id: 'c-con', name: 'Consulenze', emoji: '💼', type: 'expense' },
    { id: 'c-aff', name: 'Affitto e locali', emoji: '🏢', type: 'expense' },
    { id: 'c-ute', name: 'Utenze', emoji: '💡', type: 'expense' },
    { id: 'c-tra', name: 'Trasporti e logistica', emoji: '🚚', type: 'expense' },
    { id: 'c-mkt', name: 'Marketing', emoji: '📣', type: 'expense' },
    { id: 'c-sof', name: 'Software e SaaS', emoji: '💻', type: 'expense' },
    { id: 'c-tax', name: 'Tasse e imposte', emoji: '🏛️', type: 'expense' },
    { id: 'c-ban', name: 'Banca e commissioni', emoji: '🏦', type: 'expense' },
    { id: 'c-axp', name: 'Altri costi', emoji: '📌', type: 'expense' },
    { id: 'c-ven', name: 'Vendite', emoji: '🧾', type: 'income' },
    { id: 'c-pre', name: 'Prestazioni', emoji: '🛠️', type: 'income' },
    { id: 'c-int', name: 'Interessi attivi', emoji: '📈', type: 'income' },
    { id: 'c-ain', name: 'Altri ricavi', emoji: '➕', type: 'income' },
    { id: 'c-gou', name: 'Giroconti e ricariche', emoji: '🔁', type: 'expense', neutral: true },
    { id: 'c-gin', name: 'Versamenti e giroconti', emoji: '🔁', type: 'income', neutral: true }
  ];
}

// Normalizza/ripara un archivio caricato (difensivo, non distruttivo).
export function migrate(d) {
  if (!d || typeof d !== 'object') return DEFAULT_DATA();
  d.version = DATA_VERSION;
  d.rev = d.rev || 0;
  d.settings = d.settings || { theme: 'auto', currency: 'EUR', activeCompany: null };
  d.companies = Array.isArray(d.companies) ? d.companies : [];
  d.accounts = Array.isArray(d.accounts) ? d.accounts : [];
  d.categories = Array.isArray(d.categories) && d.categories.length ? d.categories : defaultCategories();
  d.suppliers = Array.isArray(d.suppliers) ? d.suppliers : [];
  d.rules = Array.isArray(d.rules) ? d.rules : [];
  // ambito regola: 'expense' | 'income' | 'both'. Migra il vecchio flag applyIncome.
  d.rules.forEach(r => { if (!r.appliesTo) r.appliesTo = r.applyIncome ? 'both' : 'expense'; });
  d.transactions = Array.isArray(d.transactions) ? d.transactions : [];
  // Il legame movimento↔fattura è derivato dai payments[]: rimuove il vecchio campo tx.invoiceId.
  // Stato di gestione: migra il vecchio flag awaitingInvoice al nuovo campo t.mgmt ('await').
  d.transactions.forEach(t => {
    delete t.invoiceId;
    if (t.awaitingInvoice && t.mgmt == null) t.mgmt = 'await';
    delete t.awaitingInvoice;
  });
  d.invoices = Array.isArray(d.invoices) ? d.invoices : [];
  d.scheduled = Array.isArray(d.scheduled) ? d.scheduled : [];
  d.loans = Array.isArray(d.loans) ? d.loans : [];
  d.loans.forEach(l => { if (!Array.isArray(l.attachments)) l.attachments = []; if (l.variableRate == null) l.variableRate = false; });
  d.log = Array.isArray(d.log) ? d.log : [];
  // Le fatture devono SEMPRE avere payments[] come array di fatti.
  d.invoices.forEach(inv => {
    if (!Array.isArray(inv.payments)) inv.payments = [];
    if (inv.total == null) inv.total = round2safe((inv.net || 0) + (inv.vat || 0));
    if (inv.withholding == null) inv.withholding = 0;
    inv.toPay = !!inv.toPay; // flag "in pagamento" (intenzione, ortogonale allo stato)
    inv.creditNote = !!inv.creditNote; // nota di credito a favore (scala il dovuto al fornitore)
    // rimuove ogni residuo del vecchio campo "status" memorizzato: lo stato è derivato.
    delete inv.status;
    delete inv.paidDate;
    delete inv.ficId;
    delete inv.ficCompanyId;
  });
  return d;
}

function round2safe(n) { return Math.round((Number(n) || 0) * 100) / 100; }
