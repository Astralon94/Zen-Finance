// Importa i dati reali dal vault FSA nel DB del server.
// Legge <vault>/zen-finance.json e riaggancia gli XML delle fatture da <vault>/xml/<id>.xml
// (nel vault il JSON è "snello", senza XML inline). Import transazionale, con backup del DB.
// Uso: node scripts/import-vault.mjs "<cartella-vault>"
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { importData } from '../server/serialize.js';

const vault = process.argv[2];
if (!vault) { console.error('Uso: node scripts/import-vault.mjs "<cartella-vault>"'); process.exit(1); }

const data = JSON.parse(readFileSync(join(vault, 'zen-finance.json'), 'utf8'));

let reattached = 0, missing = 0;
for (const inv of (data.invoices || [])) {
  if (inv.source === 'xml' && !inv.xml) {
    const p = join(vault, 'xml', inv.id + '.xml');
    if (existsSync(p)) { inv.xml = readFileSync(p, 'utf8'); reattached++; }
    else missing++;
  }
}
console.log(`XML riagganciati: ${reattached}${missing ? ` (mancanti: ${missing})` : ''}`);

const r = importData(data, { force: true });
console.log('Import OK — rev', r.rev);
console.log('Conteggi:', JSON.stringify(r.counts));
