// Costruisce il pacchetto di aggiornamento (JSON gzippato) e il manifest, da pubblicare
// come release su GitHub (repo Astralon94/zen-finance-update).
// Uso:  node scripts/build-update.mjs [--note "testo"]
// Produce:  dist/zen-finance-<version>.json.gz  e  dist/manifest.json
// ATTENZIONE: il frontend runnable è public/index.html → esegui PRIMA `npm run build`
// se sono cambiati i sorgenti in src/ (lo script avvisa se sembra vecchio).
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costruisciPacchetto, currentVersion } from '../server/updater.js';

const APP_SLUG = 'zen-finance';
const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
// Cartelle/file da NON includere nel pacchetto (dati locali, dipendenze, artefatti, note interne).
const ESCLUSI = new Set(['data', 'node_modules', '.git', 'dist', '.netlify', '.DS_Store', 'CLAUDE.md']);
// Estensioni testuali ammesse (il pacchetto è UTF-8: niente binari come immagini).
const OK_EXT = /\.(js|mjs|cjs|json|css|html|md|txt|svg|webmanifest|bat|command|sh)$/i;

function elenca(dir, base = APP, out = []) {
  for (const n of readdirSync(dir)) {
    if (ESCLUSI.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) elenca(p, base, out);
    else if (OK_EXT.test(n)) out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

// Guardia: se un sorgente in src/ è più recente della build in public/, probabilmente
// manca `npm run build` (il pacchetto distribuirebbe un frontend vecchio).
function maxMtime(dir) {
  let max = 0;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    max = Math.max(max, st.isDirectory() ? maxMtime(p) : st.mtimeMs);
  }
  return max;
}
const indexPath = join(APP, 'public', 'index.html');
if (existsSync(join(APP, 'src')) && existsSync(indexPath) && maxMtime(join(APP, 'src')) > statSync(indexPath).mtimeMs) {
  console.warn('⚠️  ATTENZIONE: src/ è più recente di public/index.html — esegui `npm run build` prima del pacchetto.');
}

const args = process.argv.slice(2);
const noteIdx = args.indexOf('--note');
const note = noteIdx >= 0 ? (args[noteIdx + 1] || '') : '';
const version = currentVersion(APP);
const pubblicato = new Date().toISOString().slice(0, 10);

const relativi = elenca(APP);
const gz = costruisciPacchetto(APP, relativi, { version, note, pubblicato });

const distDir = join(APP, 'dist');
mkdirSync(distDir, { recursive: true });
const nomePkg = `${APP_SLUG}-${version}.json.gz`;
writeFileSync(join(distDir, nomePkg), gz);
writeFileSync(join(distDir, 'manifest.json'), JSON.stringify({ version, note, pubblicato, url: nomePkg }, null, 2));

console.log(`Pacchetto: dist/${nomePkg} (${relativi.length} file, ${(gz.length / 1024).toFixed(1)} KB)`);
console.log('Manifest:  dist/manifest.json');
console.log(`\nPubblica con:  gh release create v${version} dist/manifest.json dist/${nomePkg} \\`);
console.log(`  --repo Astralon94/${APP_SLUG}-update --title "Zen-Finance ${version}" --notes "${note || '...'}"`);
