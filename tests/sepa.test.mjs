// Test di regressione sul modulo puro domain/sepa.js (generazione bonifici SEPA).
// Nessun framework: si lancia con `node tests/sepa.test.mjs`.

import {
  sepaSanitize, sepaField, sepaId, validIban, normalizeIban, ibanAbi,
  amountToCents, centsToStr, buildRef, generateSepaXml
} from '../src/domain/sepa.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failed++; };

// IBAN reali di test (mod-97 corretti)
const IBAN_ORD = 'IT60X0542811101000000123456';
const IBAN_A = 'IT60X0542811101000000123456';
const IBAN_B = 'DE89370400440532013000';

// ---- sanificazione charset SEPA ----
ok('sanitize: accentate traslitterate', sepaSanitize('àèéìòù ÀÈ Ç ñ') === 'aeeiou AE C n');
ok('sanitize: & → e', sepaSanitize('Rossi & Figli') === 'Rossi e Figli');
ok('sanitize: rimuove simboli vietati', sepaSanitize('Fatt#12 @foo €50 *bar!') === 'Fatt12 foo 50 bar');
ok('sanitize: conserva i simboli ammessi', sepaSanitize("A/B-C:D(E).,'+F") === "A/B-C:D(E).,'+F");
ok('sanitize: collassa gli spazi', sepaSanitize('  a   b\tc  ') === 'a b c');
ok('sanitize: null/undefined → stringa vuota', sepaSanitize(null) === '' && sepaSanitize(undefined) === '');

// ---- limiti di lunghezza ----
ok('sepaField: Nm troncato a 70', sepaField('x'.repeat(200), 70).length === 70);
ok('sepaField: Ustrd troncato a 140', sepaField('y'.repeat(300), 140).length === 140);
ok('sepaId: max 35', sepaId('Z'.repeat(100), 35).length === 35);
ok('sepaId: senza spazi', sepaId('Fattura 12 15', 35) === 'Fattura1215');
ok('sepaId: vuoto → NOTPROVIDED', sepaId('###', 35) === 'NOTPROVIDED');

// ---- IBAN mod-97 ----
ok('validIban: IT valido', validIban('IT60 X054 2811 1010 0000 0123 456'));
ok('validIban: DE valido', validIban(IBAN_B));
ok('validIban: check digit errato', !validIban('IT99X0542811101000000123456'));
ok('validIban: formato errato', !validIban('XY00') && !validIban('') && !validIban(null));
ok('normalizeIban: uppercase senza spazi', normalizeIban('it60 x054 2811') === 'IT60X0542811');
ok('ibanAbi: caratteri 6-10 dell IBAN IT', ibanAbi(IBAN_ORD) === '05428');

// ---- aritmetica in centesimi ----
ok('amountToCents: niente float sporchi', amountToCents(0.1) + amountToCents(0.2) === 30);
ok('centsToStr: sempre 2 decimali', centsToStr(30) === '0.30' && centsToStr(100000) === '1000.00');

// ---- buildRef ----
const now = new Date(2026, 6, 20, 14, 39, 2); // 2026-07-20 14:39:02 (mese 0-based)
ok('buildRef: ZF + timestamp + progressivo', buildRef(now, 3) === 'ZF2026072014390203');
ok('buildRef: max 35', buildRef(now, 99).length <= 35);

// ---- generazione CBI ----
const baseTx = [
  { endToEndId: '12', amount: 100.1, creditorName: 'Café Rössi & C.', creditorIban: IBAN_A, remittance: 'Fattura nr 12 del 30 maggio 2026' },
  { endToEndId: '15', amount: 0.2, creditorName: 'Beta S.r.l.', creditorIban: IBAN_B, remittance: 'Fatture 15' }
];
const cbi = generateSepaXml({
  format: 'cbi', cbiVersion: '00.04.01', now,
  executionDate: '2026-07-21', batchBooking: true,
  debtor: { name: 'Mia Azienda S.r.l.', iban: IBAN_ORD, cuc: 'ABCD1234' },
  transactions: baseTx
});
ok('CBI: dichiarazione XML UTF-8', cbi.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
ok('CBI: nessun BOM', cbi.charCodeAt(0) === 0x3c);
ok('CBI: radice CBIPaymentRequest 00.04.01', cbi.includes('<CBIPaymentRequest xmlns="urn:CBI:xsd:CBIPaymentRequest.00.04.01">'));
ok('CBI: PmtMtd TRA', cbi.includes('<PmtMtd>TRA</PmtMtd>'));
ok('CBI: BtchBookg true', cbi.includes('<BtchBookg>true</BtchBookg>'));
ok('CBI: ReqdExctnDt con <Dt> nella 00.04.01', cbi.includes('<ReqdExctnDt><Dt>2026-07-21</Dt></ReqdExctnDt>'));
ok('CBI: CUC in InitgPty con Issr CBI', cbi.includes('<Othr><Id>ABCD1234</Id><Issr>CBI</Issr></Othr>'));
ok('CBI: DbtrAgt MmbId = ABI ordinante', cbi.includes('<ClrSysMmbId><MmbId>05428</MmbId></ClrSysMmbId>'));
ok('CBI: ChrgBr SLEV', cbi.includes('<ChrgBr>SLEV</ChrgBr>'));
ok('CBI: NbOfTxs = 2', cbi.includes('<NbOfTxs>2</NbOfTxs>'));
ok('CBI: CtrlSum quadra in centesimi (100.30)', cbi.includes('<CtrlSum>100.30</CtrlSum>'));
ok('CBI: InstrId progressivi 1 e 2', cbi.includes('<InstrId>1</InstrId>') && cbi.includes('<InstrId>2</InstrId>'));
ok('CBI: importi con 2 decimali', cbi.includes('<InstdAmt Ccy="EUR">100.10</InstdAmt>') && cbi.includes('<InstdAmt Ccy="EUR">0.20</InstdAmt>'));
ok('CBI: causale sanificata (accento/&)', cbi.includes('<Nm>Cafe Rossi e C.</Nm>'));
ok('CBI: nessuna entity/carattere vietato nel corpo', !/&(?!amp;)/.test(cbi) && !cbi.includes('é') && !cbi.includes('&'));

// versione 00.04.00: data senza <Dt>
const cbi00 = generateSepaXml({
  format: 'cbi', cbiVersion: '00.04.00', now, executionDate: '2026-07-21', batchBooking: false,
  debtor: { name: 'Mia Azienda', iban: IBAN_ORD, cuc: 'ABCD1234' }, transactions: baseTx
});
ok('CBI 00.04.00: namespace 00.04.00', cbi00.includes('urn:CBI:xsd:CBIPaymentRequest.00.04.00'));
ok('CBI 00.04.00: ReqdExctnDt senza <Dt>', cbi00.includes('<ReqdExctnDt>2026-07-21</ReqdExctnDt>') && !cbi00.includes('<ReqdExctnDt><Dt>'));
ok('CBI 00.04.00: BtchBookg false', cbi00.includes('<BtchBookg>false</BtchBookg>'));

// ---- generazione pain.001.001.03 ----
const pain = generateSepaXml({
  format: 'pain001', now, executionDate: '2026-07-21', batchBooking: true,
  debtor: { name: 'Mia Azienda', iban: IBAN_ORD }, transactions: baseTx
});
ok('pain: radice Document + namespace pain.001.001.03', pain.includes('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>'));
ok('pain: PmtMtd TRF', pain.includes('<PmtMtd>TRF</PmtMtd>'));
ok('pain: DbtrAgt Othr Id NOTPROVIDED (IBAN-only)', pain.includes('<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>'));
ok('pain: nessun CUC/ABI/InstrId', !pain.includes('CBI') && !pain.includes('<InstrId>') && !pain.includes('ClrSysMmbId'));
ok('pain: ReqdExctnDt semplice', pain.includes('<ReqdExctnDt>2026-07-21</ReqdExctnDt>'));
ok('pain: NbOfTxs/CtrlSum quadrano', pain.includes('<NbOfTxs>2</NbOfTxs>') && pain.includes('<CtrlSum>100.30</CtrlSum>'));

// ---- validazioni: errori attesi ----
const throws = fn => { try { fn(); return false; } catch { return true; } };
ok('genera: lancia se nessuna transazione', throws(() => generateSepaXml({ debtor: { name: 'X', iban: IBAN_ORD }, transactions: [] })));
ok('genera: lancia se IBAN ordinante invalido', throws(() => generateSepaXml({ debtor: { name: 'X', iban: 'IT99X0542811101000000123456' }, transactions: baseTx })));
ok('genera: lancia se IBAN beneficiario invalido', throws(() => generateSepaXml({ debtor: { name: 'X', iban: IBAN_ORD }, transactions: [{ amount: 10, creditorName: 'Y', creditorIban: 'XX00', remittance: '' }] })));
ok('genera: lancia se importo <= 0', throws(() => generateSepaXml({ debtor: { name: 'X', iban: IBAN_ORD }, transactions: [{ amount: 0, creditorName: 'Y', creditorIban: IBAN_A, remittance: '' }] })));

// quadratura su molte transazioni con importi "difficili"
const many = Array.from({ length: 7 }, (_, i) => ({ amount: 0.1, creditorName: 'C' + i, creditorIban: IBAN_A, remittance: 'r' }));
const cbiMany = generateSepaXml({ format: 'cbi', now, executionDate: '2026-07-21', batchBooking: true, debtor: { name: 'X', iban: IBAN_ORD, cuc: 'ABCD1234' }, transactions: many });
ok('quadratura: 7 × 0.10 = 0.70 esatto', cbiMany.includes('<CtrlSum>0.70</CtrlSum>') && cbiMany.includes('<NbOfTxs>7</NbOfTxs>'));


// ---- CBI senza CUC: GrpHdr sempre presente (obbligatorio da XSD) con segnaposto NOTPROVIDED ----
const cbiNoCuc = generateSepaXml({ format: 'cbi', now, executionDate: '2026-07-21', batchBooking: true, debtor: { name: 'X', iban: IBAN_ORD }, transactions: many });
ok('senza CUC: GrpHdr comunque presente (XSD lo impone)', cbiNoCuc.includes('<GrpHdr>'));
ok('senza CUC: segnaposto NOTPROVIDED nel blocco CUC', cbiNoCuc.includes('<Othr><Id>NOTPROVIDED</Id><Issr>CBI</Issr></Othr>'));
ok('senza CUC: PmtInf con tutte le transazioni', (cbiNoCuc.match(/<CdtTrfTxInf>/g) || []).length === 7);
ok('senza CUC: genera senza errori', !throws(() => generateSepaXml({ format: 'cbi', now, executionDate: '2026-07-21', batchBooking: true, debtor: { name: 'X', iban: IBAN_ORD }, transactions: many })));
ok('con CUC: valore reale nel GrpHdr', cbiMany.includes('<Othr><Id>ABCD1234</Id><Issr>CBI</Issr></Othr>'));

console.log(failed ? `\n${failed} test FALLITI` : '\nTutti i test passati');
process.exit(failed ? 1 : 0);
