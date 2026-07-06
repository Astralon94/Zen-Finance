// ============ Specifica dello schema (Zen-Finance) ============
// Modello IBRIDO documento-relazionale, pensato per la VERITÀ del dato:
//  - ogni entità ha una colonna `doc` con il JSON VERBATIM dell'oggetto → fonte di verità.
//    La ricostruzione avviene sempre da `doc`: il round-trip è lossless per costruzione.
//  - le altre colonne sono DERIVATE (sola scrittura) e servono solo a query/indici/JOIN.
//  - i figli "posseduti" (payments, installments, attachments) vivono in tabelle separate
//    con FK ON DELETE CASCADE. I riferimenti incrociati "morbidi" (categoryId, supplierId,
//    accountId…) restano colonne indicizzate ma NON vincolate: un dato reale leggermente
//    inconsistente non deve mai essere rifiutato o perso all'import.

const col = (n, type = 'TEXT', bool = false) => ({ n, type, bool });

export const COLLECTIONS = [
  { key: 'companies', table: 'companies', cols: [col('name'), col('piva')] },
  { key: 'accounts', table: 'accounts', index: ['companyId'],
    cols: [col('companyId'), col('kind'), col('excluded', 'INTEGER', true)] },
  { key: 'categories', table: 'categories',
    cols: [col('type'), col('neutral', 'INTEGER', true)] },
  { key: 'suppliers', table: 'suppliers', cols: [col('type'), col('piva')] },
  { key: 'rules', table: 'rules',
    cols: [col('enabled', 'INTEGER', true), col('appliesTo'), col('categoryId'), col('supplierId')] },
  { key: 'transactions', table: 'transactions', index: ['companyId', 'date', 'accountId'],
    cols: [col('companyId'), col('type'), col('accountId'), col('toAccountId'),
      col('categoryId'), col('supplierId'), col('date'), col('amount', 'REAL')] },
  { key: 'invoices', table: 'invoices', index: ['companyId', 'supplierId'],
    cols: [col('companyId'), col('supplierId'), col('date'), col('due'), col('total', 'REAL')],
    // L'XML grezzo (pesante: ~93% del dataset) NON sta nel doc: vive nella tabella
    // standalone `invoice_xml` e NON viene inviato nel boot (GET /api/data). Si carica
    // on-demand via GET /api/invoices/:id/xml (lazy-load) e nell'export backup (?full=1).
    externalText: { field: 'xml', table: 'invoice_xml' },
    children: [
      { key: 'payments', table: 'invoice_payments', fk: 'invoiceId',
        cols: [col('amount', 'REAL'), col('date'), col('accountId'), col('txId')] },
    ] },
  { key: 'scheduled', table: 'scheduled', index: ['companyId'],
    cols: [col('companyId'), col('status'), col('date'), col('accountId')] },
  { key: 'loans', table: 'loans', index: ['companyId'],
    cols: [col('companyId'), col('accountId')],
    // NB: loan.attachments[] (SOLO metadati) resta nel doc del loan e ci round-trippa;
    // i BINARI stanno nella tabella standalone `attachments_bin` (vedi db.js), NON toccata
    // dai salvataggi/changeset → nessun binario viene mai sovrascritto da un update del loan.
    children: [
      { key: 'installments', table: 'loan_installments', fk: 'loanId',
        cols: [col('n', 'INTEGER'), col('date'), col('amount', 'REAL'), col('status'), col('paidDate'), col('txId')] },
    ] },
  { key: 'log', table: 'log', index: ['companyId'],
    cols: [col('companyId'), col('at', 'INTEGER'), col('type'), col('amount', 'REAL')] },
];
