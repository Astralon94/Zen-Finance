# Zen-Finance · Server MCP (sola lettura)

POC **Fase 1**: permette a un assistente AI (Claude Desktop) di interrogare i dati di
Zen-Finance **in linguaggio naturale**, in **sola lettura**.

## Caratteristiche
- **Zero dipendenze**: nessun `npm install`. Il protocollo MCP (JSON-RPC su stdio) è
  gestito a mano in `server.mjs`.
- **Sola lettura**: non scrive mai. Legge lo stato via `GET /api/data` del server locale
  di Zen-Finance (quello su `http://localhost:4331`).
- **Verità dei dati**: riusa la **logica di dominio reale** dell'app (`src/domain/*`), quindi
  liquidità, residui, scaduto e utile coincidono ESATTAMENTE con la dashboard.

## Strumenti esposti
| Strumento | A cosa serve |
|---|---|
| `lista_aziende` | elenco aziende (per sapere su cosa filtrare) |
| `riepilogo` | KPI di un'azienda o di tutte (liquidità, da pagare, scaduto, debito carte, utile) |
| `cerca_fatture` | ricerca fatture con filtri (azienda, fornitore, stato, anno/mese, testo) |
| `prossime_scadenze` | fatture da pagare ordinate per scadenza (incluse le scadute) |
| `dettaglio_fornitore` | riepilogo per fornitore + ultime fatture |

## Prerequisito
Il server di Zen-Finance deve essere **in esecuzione** (`avvia-zen.command`, porta 4331):
l'MCP legge da lì. Se è spento, gli strumenti rispondono con un errore che lo segnala.

## Collegarlo a Claude Desktop (macOS)
Aggiungi questo blocco al file di configurazione:
`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "zen-finance": {
      "command": "node",
      "args": ["/percorso/assoluto/di/Zen-Manager-Apps/Zen-Finance/mcp/server.mjs"]
    }
  }
}
```

Se hai già altri `mcpServers`, aggiungi solo la voce `"zen-finance"` dentro l'oggetto
esistente (non duplicare le graffe esterne). Poi **riavvia Claude Desktop**.
Variabile opzionale: `ZEN_FINANCE_URL` (default `http://localhost:4331`).

Esempi di domande: «quanto ho da pagare in Flavor?», «fatture scadute di Pezzella»,
«qual è la liquidità totale?», «cosa scade nei prossimi 15 giorni?».

## Prova rapida da terminale (debug)
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"riepilogo","arguments":{}}}' \
 | (cat; sleep 3) | node mcp/server.mjs
```

## Limiti (voluti, per questa fase)
- Solo lettura: nessuna modifica ai dati.
- I dati escono verso l'AI cloud a cui è collegato Claude Desktop: gli strumenti
  restituiscono **slice/aggregati**, non l'intero database, ma tienilo presente.
- Solo Zen-Finance. In Fase 2 la stessa architettura si estende a Human e Staff.
