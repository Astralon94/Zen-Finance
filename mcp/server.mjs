#!/usr/bin/env node
// ============ Zen-Finance · Server MCP (SOLA LETTURA) ============
// Espone i dati di Zen-Finance a un assistente AI (es. Claude Desktop) tramite il
// Model Context Protocol, su stdio. Caratteristiche volute per la famiglia Zen:
//   • ZERO dipendenze: il protocollo JSON-RPC (newline-delimited) è gestito a mano.
//   • SOLA LETTURA: non scrive mai. Legge lo stato via GET /api/data del server locale.
//   • VERITÀ DEI DATI: RIUSA la logica di dominio REALE dell'app (src/domain/*) iniettando
//     il payload del boot nel singleton `data`. Così i valori derivati (residuo, scaduto,
//     liquidità, utile) coincidono ESATTAMENTE con quelli mostrati dall'app, senza
//     reimplementare formule che potrebbero divergere.
//
// Config env:  ZEN_FINANCE_URL (default http://localhost:4331)
// Avvio manuale (debug):  node mcp/server.mjs   (parla JSON-RPC su stdin/stdout)

import { data } from '../src/state/store.js';
import { migrate } from '../src/state/model.js';
import { co, sup, liquidityOf, cashOf, cardDebtOf, pnl, txsInScope, periodTxs } from '../src/domain/finance.js';
import {
  invoicesInScope, invResiduo, invSignedResiduo, invTotal, invPaid, invPayable,
  isCreditNote, invOverdue, invDueSoon, invStatus, supNameOf, statusLabelOf,
} from '../src/domain/invoices.js';

const BASE = process.env.ZEN_FINANCE_URL || 'http://localhost:4331';
const VERSION = '0.1.0';
const eur = n => Math.round(n * 100) / 100;

// ---- Caricamento dati: fresh a ogni chiamata (la verità è il DB del server) ----
// Non riassegna il binding `data` (non si può da fuori): ne muta le PROPRIETÀ, così i
// moduli di dominio — che leggono lo stesso oggetto — vedono i dati aggiornati.
async function loadData() {
  const res = await fetch(BASE + '/api/data');
  if (!res.ok) throw new Error(`HTTP ${res.status} da ${BASE}/api/data`);
  const payload = migrate(await res.json());
  for (const k of Object.keys(payload)) data[k] = payload[k];
}

// ---- Risoluzione azienda: id esatto, nome (match parziale), oppure vuoto/"tutte" → null ----
function resolveScope(arg) {
  if (arg == null || /^\s*(tutte|tutti|all|)\s*$/i.test(String(arg))) return null;
  const byId = data.companies.find(c => c.id === arg);
  if (byId) return byId.id;
  const q = String(arg).trim().toLowerCase();
  const byName = data.companies.find(c => (c.name || '').toLowerCase().includes(q));
  if (byName) return byName.id;
  throw new Error(`Azienda non trovata: "${arg}". Disponibili: ${data.companies.map(c => c.name).join(', ')}`);
}
const scopeName = s => (s ? (co(s)?.name || s) : 'Tutte le aziende');

// ============ Strumenti (tutti in sola lettura) ============
const TOOLS = {
  lista_aziende: {
    description: 'Elenca le aziende gestite in Zen-Finance (id, nome, emoji). Usalo per sapere su quale azienda filtrare le altre richieste.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => data.companies.map(c => ({ id: c.id, nome: c.name, emoji: c.emoji || null })),
  },

  riepilogo: {
    description: "KPI finanziari di un'azienda (o di tutte): liquidità disponibile, fatture da pagare, di cui scaduto, debito carte di credito, utile dell'anno corrente. Rispecchia la dashboard dell'app.",
    inputSchema: {
      type: 'object',
      properties: { azienda: { type: 'string', description: 'Nome o id azienda; vuoto o "tutte" = tutte le aziende' } },
      additionalProperties: false,
    },
    run: ({ azienda } = {}) => {
      const scope = resolveScope(azienda);
      const invs = invoicesInScope(scope);
      const unpaid = invs.filter(i => invResiduo(i) > 0.005);
      const daPagare = eur(Math.max(0, unpaid.reduce((s, i) => s + invSignedResiduo(i), 0)));
      const scaduto = eur(unpaid.filter(invOverdue).reduce((s, i) => s + invResiduo(i), 0));
      const year = new Date().getFullYear();
      const pl = pnl(periodTxs(txsInScope(scope), year));
      return {
        azienda: scopeName(scope),
        liquiditaDisponibile: liquidityOf(scope),
        fattureDaPagare: daPagare,
        diCuiScaduto: scaduto,
        debitoCarteCredito: cardDebtOf(scope),
        [`utile_${year}`]: pl.profit,
        ricaviAnno: pl.rev,
        costiAnno: pl.cost,
      };
    },
  },

  cerca_fatture: {
    description: 'Cerca fatture passive con filtri combinabili. Restituisce fornitore, numero, data, scadenza, totale, residuo e stato di ciascuna fattura, più il totale dei residui.',
    inputSchema: {
      type: 'object',
      properties: {
        azienda: { type: 'string', description: 'nome o id azienda; vuoto = tutte' },
        fornitore: { type: 'string', description: 'nome fornitore (match parziale)' },
        stato: { type: 'string', enum: ['da_pagare', 'scadute', 'in_scadenza', 'parziali', 'pagate', 'tutte'], description: 'default: tutte' },
        anno: { type: 'integer', description: 'anno della data documento (es. 2026)' },
        mese: { type: 'integer', minimum: 1, maximum: 12 },
        testo: { type: 'string', description: 'cerca in nome fornitore o numero fattura' },
        limite: { type: 'integer', description: 'max fatture restituite (default 50)' },
      },
      additionalProperties: false,
    },
    run: ({ azienda, fornitore, stato = 'tutte', anno, mese, testo, limite = 50 } = {}) => {
      const scope = resolveScope(azienda);
      let list = invoicesInScope(scope);
      if (fornitore) { const q = fornitore.toLowerCase(); list = list.filter(i => supNameOf(i).toLowerCase().includes(q)); }
      if (anno) list = list.filter(i => (i.date || '').slice(0, 4) === String(anno));
      if (mese) list = list.filter(i => (i.date || '').slice(5, 7) === String(mese).padStart(2, '0'));
      if (testo) { const q = testo.toLowerCase(); list = list.filter(i => supNameOf(i).toLowerCase().includes(q) || (i.number || '').toLowerCase().includes(q)); }
      const passStato = i => {
        switch (stato) {
          case 'da_pagare': return !isCreditNote(i) && invStatus(i) !== 'paid';
          case 'scadute': return invOverdue(i);
          case 'in_scadenza': return invDueSoon(i);
          case 'parziali': return invStatus(i) === 'partial';
          case 'pagate': return invStatus(i) === 'paid';
          default: return true;
        }
      };
      list = list.filter(passStato);
      list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (b.date || '').localeCompare(a.date || ''));
      const total = list.length;
      const rows = list.slice(0, Math.max(1, limite)).map(i => ({
        azienda: co(i.companyId)?.name || null,
        fornitore: supNameOf(i),
        numero: i.number || null,
        data: i.date || null,
        scadenza: i.due || null,
        totale: invTotal(i),
        residuo: invResiduo(i),
        stato: statusLabelOf(i),
        ...(isCreditNote(i) ? { notaCredito: true } : {}),
      }));
      return { trovate: total, mostrate: rows.length, sommaResiduo: eur(list.reduce((s, i) => s + invResiduo(i), 0)), fatture: rows };
    },
  },

  prossime_scadenze: {
    description: 'Fatture non ancora pagate ordinate per scadenza (incluse le scadute): "cosa devo pagare a breve". Le note di credito sono escluse. Con "giorni" limiti la finestra futura.',
    inputSchema: {
      type: 'object',
      properties: {
        azienda: { type: 'string' },
        giorni: { type: 'integer', description: 'finestra in giorni dal oggi; se omesso, tutte le non pagate' },
        limite: { type: 'integer', description: 'max fatture (default 20)' },
      },
      additionalProperties: false,
    },
    run: ({ azienda, giorni, limite = 20 } = {}) => {
      const scope = resolveScope(azienda);
      let list = invoicesInScope(scope).filter(i => !isCreditNote(i) && invResiduo(i) > 0.005);
      if (giorni != null) {
        const lim = new Date(Date.now() + giorni * 86400000);
        list = list.filter(i => i.due && new Date(i.due) <= lim); // include le scadute + entro finestra
      }
      list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
      const rows = list.slice(0, Math.max(1, limite)).map(i => ({
        azienda: co(i.companyId)?.name || null,
        fornitore: supNameOf(i),
        numero: i.number || null,
        scadenza: i.due || null,
        residuo: invResiduo(i),
        ...(invOverdue(i) ? { scaduta: true } : {}),
      }));
      return { totali: list.length, sommaResiduo: eur(list.reduce((s, i) => s + invResiduo(i), 0)), fatture: rows };
    },
  },

  dettaglio_fornitore: {
    description: 'Riepilogo per un fornitore (match parziale sul nome): numero fatture, totale fatturato, ancora da pagare, di cui scaduto, ed elenco delle ultime fatture.',
    inputSchema: {
      type: 'object',
      properties: {
        fornitore: { type: 'string', description: 'nome (anche parziale) del fornitore' },
        azienda: { type: 'string' },
        limite: { type: 'integer', description: 'max fatture recenti elencate (default 10)' },
      },
      required: ['fornitore'],
      additionalProperties: false,
    },
    run: ({ fornitore, azienda, limite = 10 } = {}) => {
      const scope = resolveScope(azienda);
      const q = String(fornitore || '').toLowerCase();
      const list = invoicesInScope(scope).filter(i => supNameOf(i).toLowerCase().includes(q));
      if (!list.length) return { messaggio: `Nessuna fattura per un fornitore che contiene "${fornitore}".` };
      const attive = list.filter(i => !isCreditNote(i));
      const recenti = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, Math.max(1, limite))
        .map(i => ({ numero: i.number || null, data: i.date || null, scadenza: i.due || null, totale: invTotal(i), residuo: invResiduo(i), stato: statusLabelOf(i) }));
      return {
        fornitoriCorrispondenti: [...new Set(list.map(supNameOf))],
        azienda: scopeName(scope),
        nFatture: list.length,
        totaleFatturato: eur(attive.reduce((s, i) => s + invTotal(i), 0)),
        ancoraDaPagare: eur(attive.reduce((s, i) => s + invResiduo(i), 0)),
        diCuiScaduto: eur(list.filter(invOverdue).reduce((s, i) => s + invResiduo(i), 0)),
        ultimeFatture: recenti,
      };
    },
  },
};

// ============ Trasporto MCP: JSON-RPC 2.0, messaggi newline-delimited su stdio ============
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'zen-finance', version: VERSION },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifiche: nessuna risposta
    case 'ping':
      return reply(id, {});
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    case 'tools/list':
      return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return replyError(id, -32602, `Strumento sconosciuto: ${name}`);
      try {
        await loadData();
        const out = await tool.run(params?.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        const hint = /fetch failed|ECONNREFUSED|HTTP \d|networkerror/i.test(String(e.message))
          ? ` — Zen-Finance non raggiungibile su ${BASE}. Avvia i server (avvia-zen.command).` : '';
        return reply(id, { content: [{ type: 'text', text: `Errore: ${e.message}${hint}` }], isError: true });
      }
    }
    default:
      if (id !== undefined) return replyError(id, -32601, `Metodo non supportato: ${method}`);
  }
}

// ---- Lettura stdin (newline-delimited) ----
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch(e => { if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e.message)); });
  }
});
process.stdin.on('end', () => process.exit(0));

// Diagnostica SOLO su stderr: qualsiasi output su stdout romperebbe il protocollo.
process.stderr.write(`[zen-finance-mcp] avviato · sorgente dati ${BASE}\n`);
