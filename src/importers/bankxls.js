// ============ Import estratto conto bancario (xls/xlsx/csv) ============
import * as XLSX from 'xlsx';
import { data, save } from '../state/store.js';
import { uid, round2, pad2 } from '../domain/util.js';
import { acc } from '../domain/finance.js';
import { applyRules } from '../domain/rules.js';

// --- lettura file → matrice di valori grezzi ---
// IMPORTANTE: molte banche esportano ".xls" che in realtà sono file di testo (TSV/CSV).
// SheetJS, leggendoli, converte "−379,64" in -37964 (assume il punto come decimale):
// quindi i file di testo li parsiamo a mano, mantenendo gli importi come stringhe e
// lasciando a parseSigned la corretta interpretazione del formato italiano.
export function readMatrix(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const u8 = new Uint8Array(r.result);
        if (isBinaryWorkbook(u8)) {
          const wb = XLSX.read(u8, { type: 'array', cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          res(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false }));
        } else {
          res(parseDelimited(decodeText(u8)));
        }
      } catch (e) { rej(new Error('File non leggibile: ' + e.message)); }
    };
    r.onerror = () => rej(new Error('Lettura fallita'));
    r.readAsArrayBuffer(file);
  });
}

// .xlsx = ZIP (PK), .xls legacy = OLE2 (D0 CF 11 E0); altrimenti è testo.
function isBinaryWorkbook(u8) {
  if (u8.length < 4) return false;
  if (u8[0] === 0x50 && u8[1] === 0x4b) return true;                       // PK (xlsx)
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return true; // OLE2 (xls)
  return false;
}
function decodeText(u8) {
  // prova UTF-8; se compaiono caratteri di sostituzione passa a windows-1252 (estratti IT)
  let s = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  if (s.includes('�')) { try { s = new TextDecoder('windows-1252', { fatal: false }).decode(u8); } catch (e) {} }
  return s;
}
function parseDelimited(text) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.length);
  if (!lines.length) return [];
  // delimitatore: tab, ; oppure , (il più frequente nella prima riga)
  const head = lines[0];
  const counts = { '\t': (head.match(/\t/g) || []).length, ';': (head.match(/;/g) || []).length, ',': (head.match(/,/g) || []).length };
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : '\t';
  return lines.map(line => splitLine(line, delim));
}
function splitLine(line, delim) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const isDateVal = v => v instanceof Date || (typeof v === 'string' && /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(v));
const isNumVal = v => typeof v === 'number' || (typeof v === 'string' && /^-?[\d.\s]*,?\d+\s*€?$/.test(v.trim()) && /\d/.test(v));

// parse data → "YYYY-MM-DD"
export function parseDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  if (typeof v === 'number') { // seriale Excel
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
  }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${pad2(m[2])}-${pad2(m[1])}`; }
  return null;
}
// parse importo con segno (formato IT/EN)
export function parseSigned(v) {
  if (typeof v === 'number') return round2(v);
  let s = String(v ?? '').replace(/[€\s]/g, '');
  if (!s) return null;
  const neg = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '').replace(/[^\d,.-]/g, '');
  // se c'è sia . che , l'ultimo è il decimale
  if (s.includes(',') && s.includes('.')) { if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); }
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return round2(neg && n > 0 ? -n : n);
}

// --- rilevamento colonne ---
export function detect(matrix) {
  // riga header: tra le prime 6, quella con più celle stringa
  let headerRow = 0, best = -1;
  for (let i = 0; i < Math.min(6, matrix.length); i++) {
    const strs = (matrix[i] || []).filter(c => typeof c === 'string' && c.trim()).length;
    if (strs > best) { best = strs; headerRow = i; }
  }
  const headers = (matrix[headerRow] || []).map(c => String(c ?? '').trim());
  const rows = matrix.slice(headerRow + 1).filter(r => r && r.some(c => c != null && c !== ''));
  const ncol = Math.max(0, ...matrix.map(r => (r || []).length));

  const stat = [];
  for (let c = 0; c < ncol; c++) {
    let dates = 0, nums = 0, textLen = 0, neg = 0, pos = 0;
    rows.forEach(r => {
      const v = r[c];
      if (v == null || v === '') return;
      if (isDateVal(v)) dates++;
      if (isNumVal(v)) { nums++; const n = parseSigned(v); if (n < 0) neg++; else if (n > 0) pos++; }
      if (typeof v === 'string') textLen += v.length;
    });
    stat.push({ c, dates, nums, textLen, neg, pos, header: (headers[c] || '').toLowerCase() });
  }
  const total = rows.length || 1;
  const dateCol = stat.slice().sort((a, b) => b.dates - a.dates)[0]?.c ?? 0;
  const descCol = stat.filter(s => s.c !== dateCol).slice().sort((a, b) => b.textLen - a.textLen)[0]?.c ?? 1;

  // colonne numeriche (escludi saldo/balance dal header)
  const numCols = stat.filter(s => s.nums >= total * 0.5 && !/saldo|balance|valuta|data/.test(s.header));
  let amountMode = 'single', amountCol = numCols[0]?.c ?? null, debitCol = null, creditCol = null;
  const dare = numCols.find(s => /dare|addebit|uscit|debit/.test(s.header));
  const avere = numCols.find(s => /avere|accredit|entrat|credit/.test(s.header));
  if (dare && avere) { amountMode = 'dual'; debitCol = dare.c; creditCol = avere.c; }
  else if (numCols.length >= 2 && numCols.every(s => s.neg === 0)) {
    // due colonne solo-positive senza header chiari: probabile dare/avere
    amountMode = 'dual'; debitCol = numCols[0].c; creditCol = numCols[1].c;
  } else {
    // singola con segno: preferisci una colonna che ha sia neg che pos
    const signed = numCols.find(s => s.neg > 0 && s.pos > 0) || numCols[0];
    amountCol = signed?.c ?? null;
  }
  return { headerRow, headers, ncol, suggestion: { dateCol, descCol, amountMode, amountCol, debitCol, creditCol } };
}

// --- costruzione righe normalizzate ---
// map: { headerRow, dateCol, descCol, amountMode, amountCol, debitCol, creditCol, invert }
export function buildRows(matrix, map) {
  const rows = matrix.slice(map.headerRow + 1).filter(r => r && r.some(c => c != null && c !== ''));
  const out = [];
  rows.forEach(r => {
    const date = parseDate(r[map.dateCol]);
    const desc = String(r[map.descCol] ?? '').trim();
    let amount = null;
    if (map.amountMode === 'dual') {
      const deb = parseSigned(r[map.debitCol]) || 0;  // uscite
      const cre = parseSigned(r[map.creditCol]) || 0; // entrate
      amount = round2(cre - Math.abs(deb));
    } else {
      amount = parseSigned(r[map.amountCol]);
    }
    if (amount == null || amount === 0 || !date) return;
    if (map.invert) amount = -amount;
    out.push({ date, desc, amount });
  });
  return out;
}

// --- commit nello store ---
// Dedup robusto:
//  • se la riga ha un riferimento univoco della banca (ref, da XML) → chiave = ref:conto:ref
//    (stabile al re-import, niente falsi duplicati né perdite).
//  • altrimenti (XLS/CSV) → impronta su conto+data+importo+descrizione, con CONTATORE
//    progressivo: due righe identiche nello stesso file ricevono chiavi distinte (#0,#1…),
//    così le commissioni ripetute non vengono erroneamente collassate, ma il re-import
//    dello stesso file resta riconosciuto come duplicato.
export function commitBankRows(rows, accountId) {
  const a = acc(accountId);
  if (!a) return { added: 0, skipped: 0 };
  const companyId = a.companyId;
  const existing = new Set(data.transactions.filter(t => t.impHash).map(t => t.impHash));
  const counter = new Map();
  let added = 0, skipped = 0;
  rows.forEach(row => {
    let key;
    if (row.ref) {
      key = `ref:${accountId}:${row.ref}`;
    } else {
      const base = `${accountId}|${row.date}|${row.amount}|${(row.desc || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60)}`;
      const n = counter.get(base) || 0; counter.set(base, n + 1);
      key = `${base}#${n}`;
    }
    if (existing.has(key)) { skipped++; return; }
    const t = {
      id: uid(), companyId, type: row.amount < 0 ? 'expense' : 'income', amount: round2(Math.abs(row.amount)),
      categoryId: null, accountId, toAccountId: null, supplierId: null, date: row.date,
      desc: row.desc, note: '', imported: true, impHash: key, impRef: row.ref || null, createdAt: Date.now()
    };
    applyRules(t, { onlyEmpty: true });
    data.transactions.push(t);
    existing.add(key);
    added++;
  });
  if (added) save();
  return { added, skipped };
}
