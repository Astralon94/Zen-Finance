// Ripristina il DB ai dati di default (con backup automatico del DB corrente).
import { resetData } from '../server/serialize.js';
const r = resetData();
console.log('[reset] DB riportato ai default — rev', r.rev);
console.log('[reset] conteggi:', JSON.stringify(r.counts));
