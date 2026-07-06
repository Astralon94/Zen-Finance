# Zen Finance — versione server (sperimentale)

App di contabilità **100% locale** (ex *Inconty* / *Credit Business*). Niente cloud,
niente Fatture in Cloud, niente account.

> **Variante `-server`.** A differenza dell'originale (Vite + File System Access API,
> solo Chrome), questa versione gira su un **server locale Node** (`node:http`) con un
> **database relazionale `node:sqlite`** (zero dipendenze a runtime). Il frontend resta
> la stessa SPA, ma persiste via API (`/api/data`) invece che su cartella del disco.
> I dati vivono nel file `data/zenfinance.db`, con backup automatici in `data/backups/`.

## Cosa fa

**Base multi-azienda**
- Aziende, conti (con saldo, fido, esclusione da liquidità/P&L), categorie (anche "neutre"), fornitori/clienti.
- Conto economico per anno/mese con ricavi, costi, utile e ripartizione per categoria.
- Dashboard con liquidità, fatture da pagare, scaduto, utile dell'anno e prossime scadenze.

**Movimenti**
- Uscite, entrate, trasferimenti tra conti.
- In lista è sempre visibile la **categoria** (emoji + nome), oltre a conto e data.
- Ricerca testuale e filtri combinabili: tipo, conto, categoria, anno, mese.
- Ogni movimento conserva la **descrizione grezza** della banca e può avere un **nome visualizzato** leggibile.
- Flag **"In attesa di fattura"**: evidenzia un movimento (es. contanti pagati) la cui fattura arriverà dopo; resta evidenziato finché non viene abbinato.

**Fatture passive** (stato sempre **derivato** dai pagamenti, vedi sotto)
- Filtri combinabili (fornitore, anno/mese per data documento, stato) con riepilogo aggregato live.
- **Import XML**: singolo o massivo, file `.xml`, firmati `.p7m`, archivi `.zip`; dedup per P.IVA/CF + numero. Le **note di credito** (TipoDocumento TD04) vengono riconosciute automaticamente.
- **Note di credito a favore**: trattate come fatture passive *in positivo*. Non risultano "da pagare"/scadute; nel riepilogo e in Dashboard **scalano** il dovuto netto al fornitore. Marcabili anche a mano dall'editor fattura.
- Sotto-sezione **In pagamento** dentro Fatture: raggruppato per fornitore, con **saldo multiplo** (cumulativo o per fattura). Selezionando fatture + note di credito dello stesso fornitore, il movimento sul conto è il **netto** (fatture − note di credito): le fatture vanno a "pagata", le NDC a "usata".

**F24** (sezione propria nel menù)
- Elenco dei movimenti segnati come F24 (versamenti tributi) con periodo/riferimento, totali e filtro per anno. Il flag si imposta dall'editor del movimento.

**Programmati** (scadenziario, sezione propria)
- Movimenti futuri previsti, divisi in **Addebiti** e **Accrediti**, con data e flag **Manuale** evidenziato (es. affitto da pagare a mano).
- **Raggruppati per periodo** (Scadute, Oggi, Questa settimana, Settimana prossima, Questo mese, Più avanti) con subtotale per gruppo.
- Include automaticamente anche le **rate dei finanziamenti** (badge "finanz."): scadenziario unico.
- Completamento: **crea il movimento reale**, **abbina a un movimento già presente** oppure **segna solo completato**. Riapribile.

**Finanziamenti** (sezione propria)
- Schede per mutui, prestiti, leasing: ente/banca, debito totale, date inizio/scadenza, collegate a **azienda** e **conto**.
- **Piano rate** generabile oppure inserito/modificato a mano rata per rata (importi e date non omogenei).
- Tracciamento rate: paga creando il movimento, abbinando un movimento esistente o segnando solo pagata; residuo, pagato, prossima rata e rate scadute evidenziate.
- *(Allegati alle rateizzazioni: in arrivo nella versione server — BLOB nel DB.)*

**Banca**
- **Import estratto conto**: XML bancario **CBI/camt** e `.xls/.xlsx/.csv/.tsv` con auto-rilevamento colonne e anteprima di mappatura. Dedup e conto di destinazione.
- **Riconciliazione**: abbina le uscite alle fatture con conferma manuale, anche **un movimento ↔ più fatture**.
- **Regole** di categorizzazione automatica da parola chiave; applicate all'import e riapplicabili. Creabili al volo con **"Crea regola da questo movimento"**.

**Altro**: tema chiaro/scuro, **backup/ripristino JSON** dalle Impostazioni.

## Architettura

Server Node (zero dipendenze a runtime) + SPA. Il frontend resta modulare in `src/`,
buildato con Vite in un **`index.html` self-contained** servito dal server da `public/`.

```
server.js          server node:http — statico da public/ + API /api
server/
  schema.js        specifica tabelle (colonne indicizzate + doc JSON verbatim)
  db.js            connessione node:sqlite, WAL + foreign_keys, DDL, backup
  serialize.js     import/export DB ⇄ modello app (transazionale, lossless)
scripts/           reset.mjs, roundtrip.mjs (test d'integrità)
src/               frontend (invariato salvo state/store.js → API)
  state/     model.js (dati+migrazioni), store.js (persistenza via /api/data)
  domain/    util, finance, invoices, rules, reconcile, scheduled, loans
  importers/ fatturapa, p7m, index (xml/p7m/zip), commit, bankxls, bankxml
  ui/        app.js (shell+router), views/ (dashboard, movimenti, fatture, …)
data/              zenfinance.db (+ backups/) — NON versionato
```

## Persistenza e integrità
Fonte di verità: il **DB SQLite** del server. Modello **ibrido documento-relazionale**:
ogni entità ha colonne tipizzate/indicizzate per le query **più** una colonna `doc` con il
JSON verbatim → l'export ricostruito dal `doc` è **lossless per costruzione**. `WAL` +
`foreign_keys`, import **transazionale all-or-nothing** con **backup del DB prima**,
contatore `rev` **monotòno** (non torna mai indietro).

## Stato fatture (anti cambi involontari)
Si memorizzano **solo fatti**: `total`, `withholding`, `payments[]`. Lo stato
(`da pagare` / `parziale` / `pagata` / `scaduta`) e il residuo sono **calcolati**, mai salvati.

## Comandi
```bash
npm install          # dipendenze SOLO di build (vite, xlsx, fflate)
npm run build        # builda il frontend → public/index.html
npm start            # avvia il server → http://localhost:4331
npm run reset-db     # riporta il DB ai dati di default (con backup)
npm run test:roundtrip  # test d'integrità import/export (in memoria)
```

## Uso
1. `npm install && npm run build` (la prima volta, e dopo ogni modifica al frontend)
2. `npm start` → apri **http://localhost:4331**

Backup/trasferimento dati: Impostazioni → *Esporta backup* / *Importa backup* (JSON),
compatibile con l'export dell'app originale.
