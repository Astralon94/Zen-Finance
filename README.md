# Zen Finance

App di contabilità **offline-first, 100% locale** (ex *Inconty* / *Credit Business*). Niente cloud,
niente Fatture in Cloud, niente backend. I dati vivono in una cartella sul disco (File System Access
di Chrome), obbligatoria; il browser ne tiene una copia interna come rete di sicurezza.

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
- **Raggruppati per periodo** (Scadute, Oggi, Questa settimana, Settimana prossima, Questo mese, Più avanti) con subtotale per gruppo, per una panoramica immediata.
- Include automaticamente anche le **rate dei finanziamenti** (badge "finanz."): scadenziario unico.
- Riepilogo addebiti/accrediti previsti e saldo previsto; scaduti evidenziati.
- Completamento: **crea il movimento reale**, **abbina a un movimento già presente** (stile riconciliazione, es. RID da estratto conto) oppure **segna solo completato**. Riapribile.

**Finanziamenti** (sezione propria)
- Schede per mutui, prestiti, leasing: ente/banca, debito totale, date inizio/scadenza, collegate a **azienda** e **conto**.
- **Piano rate** generabile (numero rate, importo, prima scadenza, frequenza in mesi) **oppure inserito/modificato a mano** rata per rata (importi e date non omogenei).
- Tracciamento rate: paga creando il movimento, abbinando un movimento esistente (riconciliazione) o segnando solo pagata; residuo, pagato, prossima rata e rate scadute evidenziate.

**Banca**
- **Import estratto conto**: XML bancario **CBI/camt** (consigliato, importi e segno affidabili, un clic) e `.xls/.xlsx/.csv/.tsv` con auto-rilevamento colonne e anteprima di mappatura. Dedup e conto di destinazione; i `.xls` testuali (TSV) sono letti rispettando il formato numerico italiano.
- **Riconciliazione**: abbina le uscite (importate o "in attesa di fattura") alle fatture con conferma manuale, anche **un movimento ↔ più fatture** (bonifico unico che salda più fatture); sezione "Da riconciliare" in Movimenti.
- **Regole** di categorizzazione automatica: da parola chiave nella descrizione impostano categoria, fornitore e nome visualizzato; applicate all'import e riapplicabili. Creabili al volo con **"Crea regola da questo movimento"**.

**Altro**: tema chiaro/scuro, backup/ripristino JSON, installabile come PWA.
- **Cartella dati / vault (Chrome)**: se usata come app installata in Chrome, può collegare una cartella su disco (anche iCloud/Dropbox) in cui salva tutto automaticamente: `inconty.json` (snello), gli XML delle fatture in `xml/`, più `backups/` a rotazione e `snapshots/` giornalieri ripristinabili dalle Impostazioni. La copia nel browser resta come rete di sicurezza; al boot vince la copia con `rev` più alto. Dove l'API non c'è (Safari/iPhone) resta lo storage del browser + export/import.
- **Badge sull'icona**: numero totale di scadute (fatture, programmati, rate finanziamenti) sull'icona dell'app installata.

## Architettura
Sorgenti modulari in `src/`, build in un **unico `index.html` self-contained** (tutto JS/CSS
inlinato) → gira offline anche da file locale ed è installabile come PWA quando servito.

```
src/
  state/     model.js (dati+migrazioni), store.js (persistenza)
  domain/    util.js, finance.js (conti/P&L/etichette), invoices.js (stato fatture),
             rules.js (regole), reconcile.js (riconciliazione), scheduled.js (programmati), loans.js (finanziamenti)
  importers/ fatturapa.js, p7m.js, index.js (xml/p7m/zip), commit.js,
             bankxls.js (estratto .xls/.csv), bankxml.js (CBI/camt)
  ui/        app.js (shell+router), ruleeditor.js, forms.js, dom.js, styles.css,
             views/ (dashboard, movimenti, fatture, pagamenti, f24, programmati, finanziamenti, pnl, anagrafiche, impostazioni, xmlview)
```

## Persistenza robusta
Fonte di verità in memoria; due copie durevoli: **localStorage + IndexedDB**. Ogni salvataggio
incrementa un contatore `rev` monotòno: al boot si adotta **sempre** la copia con `rev` più alto.
Niente euristiche "a conteggio record" → nessun ripristino di dati vecchi per sbaglio.

## Stato fatture (anti cambi involontari)
Si memorizzano **solo fatti**: `total`, `withholding`, `payments[]`. Lo stato
(`da pagare` / `parziale` / `pagata` / `scaduta`) e il residuo sono **calcolati**, mai salvati.
Migrazione e import eliminano ogni vecchio campo `status` memorizzato. Registrare un pagamento
su un conto crea un movimento di uscita collegato (saldi e P&L coerenti); rimuoverlo lo elimina.

## Comandi
```bash
npm install      # dipendenze (solo build)
npm run dev      # sviluppo con hot-reload
npm run build    # genera dist/index.html (app da usare/distribuire)
npm run preview  # anteprima della build
```

## Uso / deploy (web app)
Apri **`dist/index.html`**. Per la PWA installabile e il service worker servila via HTTP
(qualsiasi static server: `npm run preview`, `python -m http.server`, il Raspberry Pi, ecc.).
Su macOS/iOS puoi installarla come app da Safari → *Aggiungi al Dock* / *Aggiungi a Home*.
Per backup o trasferimento dati: Impostazioni → *Esporta backup* / *Importa backup* (JSON).
