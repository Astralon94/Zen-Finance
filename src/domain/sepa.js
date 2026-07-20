// ============ Generazione bonifici SEPA (CBI + pain.001) — MODULO PURO ============
// Niente DOM, niente store: input strutturato → stringa XML. Testabile in Node.
//
// input = {
//   format: 'cbi' | 'pain001',            // default 'cbi'
//   cbiVersion: '00.04.01' | '00.04.00',  // solo per CBI (default '00.04.01')
//   msgId, pmtInfId,                       // opzionali: generati se assenti
//   executionDate: 'YYYY-MM-DD',           // data richiesta esecuzione
//   batchBooking: bool,                    // true = addebito unico cumulativo
//   now: Date,                             // opzionale (default new Date()) — per CreDtTm/MsgId
//   debtor: { name, iban, cuc },           // ordinante; cuc solo per CBI — se vuoto viene
//                                          // emesso il segnaposto NOTPROVIDED (GrpHdr e il
//                                          // blocco CUC sono comunque obbligatori da XSD)
//   transactions: [{ endToEndId, amount, creditorName, creditorIban, remittance }]
// }
//
// Regole SEPA (charset, limiti, quadratura, IBAN mod-97) implementate come helper riusabili.

// ---- charset SEPA: a-zA-Z0-9 spazio / - ? : ( ) . , ' + ----
// Traslitterazione minima di lettere non decomposte da NFD (ø, ß, æ…).
const SPECIAL_MAP = {
  'ø': 'o', 'Ø': 'O', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
  'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'TH', 'ł': 'l', 'Ł': 'L'
};

// Traslittera accentate (à→a, é→e, …), sostituisce & → e, rimuove ogni carattere
// fuori dal set SEPA, collassa gli spazi. Da applicare a nomi e causali PRIMA dell'XML.
export function sepaSanitize(s) {
  if (s == null) return '';
  let out = String(s).replace(/&/g, 'e');            // & → e (Rossi & Figli → Rossi e Figli)
  out = out.replace(/[øØßæÆœŒðÐþÞłŁ]/g, c => SPECIAL_MAP[c] ?? '');
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // toglie i diacritici (à→a…)
  out = out.replace(/\s+/g, ' ');                     // ogni spazio bianco (tab, a-capo) → spazio: resta separatore
  out = out.replace(/[^A-Za-z0-9 /?:().,'+\-]/g, '');  // rimuove ogni altro carattere fuori set (lo spazio è preservato)
  return out.replace(/\s+/g, ' ').trim();             // collassa spazi residui
}

// Campo di testo SEPA: sanificato e troncato a `max`.
export function sepaField(s, max) { return sepaSanitize(s).slice(0, max); }

// Identificativo SEPA (MsgId/PmtInfId/EndToEndId): sanificato, senza spazi, troncato.
export function sepaId(s, max = 35) {
  const v = sepaSanitize(s).replace(/\s+/g, '').slice(0, max);
  return v || 'NOTPROVIDED';
}

// ---- IBAN ----
export function normalizeIban(iban) { return String(iban || '').replace(/\s+/g, '').toUpperCase(); }

// Validazione mod-97 (ISO 13616). Ritorna true se formalmente valido.
export function validIban(iban) {
  const v = normalizeIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  // converte lettere in numeri (A=10 … Z=35) e calcola mod 97 a blocchi
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch >= '0' && ch <= '9' ? ch : (ch.charCodeAt(0) - 55).toString();
    for (const d of code) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// ABI di un IBAN italiano: caratteri 6-10 (1-indexed) = indici 5..10.
// IT kk C AAAAA BBBBB CCCCCCCCCCCC → dopo IT+2check+1CIN vengono le 5 cifre ABI.
export function ibanAbi(iban) { return normalizeIban(iban).slice(5, 10); }

// ---- Importi: aritmetica in centesimi, niente float sporchi ----
export function amountToCents(n) { return Math.round((Number(n) || 0) * 100); }
export function centsToStr(c) { return (c / 100).toFixed(2); }

// ---- date/timestamp ----
const p2 = n => String(n).padStart(2, '0');
function tsStamp(now) {
  return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}
function creDtTm(now) {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}
// Riferimento univoco ZF + YYYYMMDDHHMMSS + progressivo (max 35).
export function buildRef(now = new Date(), seq = 0) {
  return `ZF${tsStamp(now)}${p2(seq)}`.slice(0, 35);
}

// ---- costruzione XML ----
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
// tag semplice: il contenuto è già sanificato (nessun < > & " ' vietato dal charset SEPA),
// quindi non servono entity.
const tag = (name, val) => `<${name}>${val}</${name}>`;

// Prepara e valida le transazioni; calcola quadratura in centesimi.
function prepare(input) {
  const txs = Array.isArray(input.transactions) ? input.transactions : [];
  if (!txs.length) throw new Error('SEPA: nessuna transazione da esportare');
  if (!validIban(input.debtor?.iban)) throw new Error('SEPA: IBAN ordinante non valido');

  let totalCents = 0;
  const rows = txs.map((t, i) => {
    const cents = amountToCents(t.amount);
    if (cents <= 0) throw new Error('SEPA: importo non valido (deve essere > 0)');
    if (!validIban(t.creditorIban)) throw new Error(`SEPA: IBAN beneficiario non valido (${sepaField(t.creditorName, 30)})`);
    totalCents += cents;
    return {
      instrId: String(i + 1),
      endToEndId: sepaId(t.endToEndId || `NOTPROVIDED${i + 1}`, 35),
      amountStr: centsToStr(cents),
      creditorName: sepaField(t.creditorName, 70) || 'BENEFICIARIO',
      creditorIban: normalizeIban(t.creditorIban),
      remittance: sepaField(t.remittance, 140)
    };
  });
  return { rows, nbOfTxs: rows.length, ctrlSum: centsToStr(totalCents) };
}

function buildCbi(input, ctx) {
  const version = input.cbiVersion === '00.04.00' ? '00.04.00' : '00.04.01';
  const ns = `urn:CBI:xsd:CBIPaymentRequest.${version}`;
  const { rows, nbOfTxs, ctrlSum } = ctx;
  const cuc = sepaId(input.debtor?.cuc || '', 35);
  const dbtrName = sepaField(input.debtor?.name, 70) || 'ORDINANTE';
  const dbtrIban = normalizeIban(input.debtor.iban);
  const abi = ibanAbi(dbtrIban);
  // 00.04.01 → <ReqdExctnDt><Dt>…</Dt></ReqdExctnDt> ; 00.04.00 → <ReqdExctnDt>…</ReqdExctnDt>
  const reqd = version === '00.04.01'
    ? tag('ReqdExctnDt', tag('Dt', input.executionDate))
    : tag('ReqdExctnDt', input.executionDate);

  // GrpHdr è SEMPRE obbligatorio da XSD CBI (il validatore delle banche lo pretende), così
  // come InitgPty/Id (il CUC). Il CUC però è un Max35Text senza pattern: con CUC vuoto si
  // emette il segnaposto NOTPROVIDED (fallback di sepaId) — schema-valido, e i portali che
  // ricavano il mittente dal conto ordinante (es. RelaxBanking BCC) lo accettano.
  const grpHdr =
    `<GrpHdr>${tag('MsgId', ctx.msgId)}${tag('CreDtTm', ctx.creDtTm)}${tag('NbOfTxs', nbOfTxs)}${tag('CtrlSum', ctrlSum)}` +
    `<InitgPty>${tag('Nm', dbtrName)}<Id><OrgId><Othr>${tag('Id', cuc)}${tag('Issr', 'CBI')}</Othr></OrgId></Id></InitgPty>` +
    `</GrpHdr>`;

  const txXml = rows.map(r =>
    `<CdtTrfTxInf>` +
    `<PmtId>${tag('InstrId', r.instrId)}${tag('EndToEndId', r.endToEndId)}</PmtId>` +
    `<PmtTpInf><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>` +
    `<Amt><InstdAmt Ccy="EUR">${r.amountStr}</InstdAmt></Amt>` +
    `<Cdtr>${tag('Nm', r.creditorName)}</Cdtr>` +
    `<CdtrAcct><Id>${tag('IBAN', r.creditorIban)}</Id></CdtrAcct>` +
    (r.remittance ? `<RmtInf>${tag('Ustrd', r.remittance)}</RmtInf>` : '') +
    `</CdtTrfTxInf>`
  ).join('');

  // PmtMtd: TRF (bonifico). RelaxBanking BCC rifiuta 'TRA' ("deve essere valorizzato solo con
  // CHK in caso di Disposizione di pagamento Italia"): TRF è il valore sicuro per gli SCT.
  // PmtTpInf su DUE livelli, come nell'esempio ufficiale CBI (e XSD): a livello PmtInf porta
  // InstrPrty NORM + SvcLvl/Cd=SEPA; dentro ogni CdtTrfTxInf porta SOLO CtgyPurp (lì l'XSD
  // NON ammette SvcLvl/Cd — 3° report errori RelaxBanking). CtgyPurp Cd=SUPP (pagamento
  // fornitori, ISO ExternalCategoryPurpose1Code) soddisfa il controllo per-disposizione.
  const pmtInf =
    `<PmtInf>${tag('PmtInfId', ctx.pmtInfId)}${tag('PmtMtd', 'TRF')}${tag('BtchBookg', input.batchBooking ? 'true' : 'false')}` +
    `<PmtTpInf><InstrPrty>NORM</InstrPrty><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>${reqd}` +
    `<Dbtr>${tag('Nm', dbtrName)}</Dbtr>` +
    `<DbtrAcct><Id>${tag('IBAN', dbtrIban)}</Id></DbtrAcct>` +
    `<DbtrAgt><FinInstnId><ClrSysMmbId>${tag('MmbId', abi)}</ClrSysMmbId></FinInstnId></DbtrAgt>` +
    `${tag('ChrgBr', 'SLEV')}${txXml}</PmtInf>`;

  return `${XML_DECL}<CBIPaymentRequest xmlns="${ns}">${grpHdr}${pmtInf}</CBIPaymentRequest>`;
}

function buildPain001(input, ctx) {
  const ns = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03';
  const { rows, nbOfTxs, ctrlSum } = ctx;
  const dbtrName = sepaField(input.debtor?.name, 70) || 'ORDINANTE';
  const dbtrIban = normalizeIban(input.debtor.iban);

  const grpHdr =
    `<GrpHdr>${tag('MsgId', ctx.msgId)}${tag('CreDtTm', ctx.creDtTm)}${tag('NbOfTxs', nbOfTxs)}${tag('CtrlSum', ctrlSum)}` +
    `<InitgPty>${tag('Nm', dbtrName)}</InitgPty></GrpHdr>`;

  const txXml = rows.map(r =>
    `<CdtTrfTxInf>` +
    `<PmtId>${tag('EndToEndId', r.endToEndId)}</PmtId>` +
    `<PmtTpInf><CtgyPurp><Cd>SUPP</Cd></CtgyPurp></PmtTpInf>` +
    `<Amt><InstdAmt Ccy="EUR">${r.amountStr}</InstdAmt></Amt>` +
    `<Cdtr>${tag('Nm', r.creditorName)}</Cdtr>` +
    `<CdtrAcct><Id>${tag('IBAN', r.creditorIban)}</Id></CdtrAcct>` +
    (r.remittance ? `<RmtInf>${tag('Ustrd', r.remittance)}</RmtInf>` : '') +
    `</CdtTrfTxInf>`
  ).join('');

  const pmtInf =
    `<PmtInf>${tag('PmtInfId', ctx.pmtInfId)}${tag('PmtMtd', 'TRF')}${tag('BtchBookg', input.batchBooking ? 'true' : 'false')}` +
    `<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>` +
    `${tag('ReqdExctnDt', input.executionDate)}` +
    `<Dbtr>${tag('Nm', dbtrName)}</Dbtr>` +
    `<DbtrAcct><Id>${tag('IBAN', dbtrIban)}</Id></DbtrAcct>` +
    `<DbtrAgt><FinInstnId><Othr>${tag('Id', 'NOTPROVIDED')}</Othr></FinInstnId></DbtrAgt>` +
    `${tag('ChrgBr', 'SLEV')}${txXml}</PmtInf>`;

  return `${XML_DECL}<Document xmlns="${ns}"><CstmrCdtTrfInitn>${grpHdr}${pmtInf}</CstmrCdtTrfInitn></Document>`;
}

// API principale: ritorna la stringa XML (UTF-8 senza BOM). Lancia Error su input non valido.
export function generateSepaXml(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const ctx = prepare(input);
  ctx.msgId = sepaId(input.msgId || buildRef(now, 0), 35);
  ctx.pmtInfId = sepaId(input.pmtInfId || buildRef(now, 1), 35);
  ctx.creDtTm = creDtTm(now);
  return (input.format === 'pain001') ? buildPain001(input, ctx) : buildCbi(input, ctx);
}
