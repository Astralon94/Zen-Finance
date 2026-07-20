# Zen Finance

Contabilità aziendale **self-hosted e 100% locale**: movimenti, fatture passive con import delle fatture elettroniche italiane (FatturaPA), scadenziario, conto economico ed export dei bonifici SEPA/CBI. Niente cloud, niente abbonamenti: un server Node **senza dipendenze a runtime** e un database SQLite in un singolo file.

## Caratteristiche

- **Multi-azienda** — aziende con dati separati; conti (con fido ed esclusioni), categorie, fornitori e clienti.
- **Movimenti** — uscite, entrate e trasferimenti; ricerca e filtri combinabili; descrizione bancaria grezza affiancata a un nome leggibile; regole di categorizzazione.
- **Fatture passive** — import XML FatturaPA (singolo, massivo, `.p7m`, `.zip`) con deduplica; note di credito riconosciute e compensate; stato (da pagare / parziale / pagata / scaduta) **sempre derivato dai pagamenti, mai salvato**.
- **Bonifici SEPA/CBI** — wizard che genera dalle fatture in pagamento il flusso XML per i bonifici massivi da caricare sull'home banking: tracciato **CBI** (`CBIPaymentRequest`, con o senza CUC) o **pain.001.001.03**, causale per fornitore o per fattura, validazione IBAN, saldo opzionale delle fatture esportate.
- **Scadenziario** — movimenti programmati raggruppati per periodo, con le rate dei finanziamenti incluse automaticamente.
- **F24, finanziamenti, carte** — sezioni dedicate per tributi, piani di ammortamento e carte di credito con addebito differito.
- **Conto economico e dashboard** — ricavi, costi e utile per anno/mese; liquidità, scaduto e prossime scadenze a colpo d'occhio.
- **Multi-utente** — login con permessi granulari per sezione e azione; registro attività.
- **Export** — PDF, CSV, backup JSON completo, XML delle fatture.
- **Aggiornamenti in-app** — l'app controlla le release di questo repository e si aggiorna da sola (vedi sotto).

## Requisiti

- **Node.js ≥ 22.5** (usa il modulo nativo `node:sqlite`; consigliata l'ultima LTS).
- Nessuna dipendenza a runtime: `npm install` serve solo per lo sviluppo del frontend.

## Avvio rapido

```bash
git clone https://github.com/Astralon94/Zen-Finance.git
cd Zen-Finance
npm start            # avvia il server su http://localhost:4331
```

Al primo avvio viene creato l'utente **admin / admin**: cambiare subito la password (Impostazioni → Utenti). La porta si cambia con `PORT=8080 npm start`.

I dati vivono in `data/zenfinance.db` (creato al primo avvio, con backup automatici in `data/backups/`): la cartella `data/` non è mai versionata e non viene mai toccata dagli aggiornamenti.

> **Nota di sicurezza** — l'app è pensata per uso locale o su rete privata. Se esposta a Internet, va protetta con un livello di autenticazione aggiuntivo (VPN o reverse proxy con access control).

## Aggiornamenti

L'app controlla all'avvio (e ogni 12 ore, o con "Controlla ora" in Impostazioni) il manifest dell'ultima [release](https://github.com/Astralon94/Zen-Finance/releases) di questo repository, scarica il pacchetto, salva una copia dei file sovrascritti in `data/updates-backup/` e si riavvia sul nuovo codice. La variabile `ZEN_UPDATE_URL` permette di puntare a un altro manifest, oppure — se vuota — di disattivare gli aggiornamenti.

## Architettura

```
server.js          server node:http — statici da public/ + API /api
server/            schema, DB (node:sqlite, WAL), serializzazione/changeset, auth, updater
src/               frontend (Vite): state/, domain/, ui/ (viste)
public/index.html  SPA buildata, self-contained: è ciò che il server serve
scripts/           utilità: reset DB, reset admin, test round-trip, build pacchetto update
tests/             test (node --test)
data/              database + backup — locale, mai versionato
```

Principi: il documento JSON di ogni record è la **fonte di verità** (colonne SQL solo per query/indici); il frontend invia **changeset granulari** (`POST /api/changes`) con guardia di concorrenza; i valori derivati (stati, totali) **non vengono mai salvati**.

## Sviluppo

```bash
npm install          # dipendenze di build (Vite)
npm run dev          # frontend in sviluppo
npm run build        # build → public/index.html
node --test tests/   # test
npm run test:roundtrip
```

## Licenza

Rilasciato sotto licenza [MIT](LICENSE).

## Famiglia Zen

Zen Finance fa parte di una piccola famiglia di app self-hosted con la stessa architettura: [Zen Human](https://github.com/Astralon94/Zen-Human) (presenze e turni del personale) e [Zen Warehouse](https://github.com/Astralon94/Zen-Warehouse) (ordini fornitori e magazzino).
