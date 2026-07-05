// ============ Picker di abbinamento condiviso ============
// Lista selezionabile con ricerca, montata in un contenitore `host`. Incapsula il pattern
// ripetuto da Abbina-a-fattura (movimenti), Salda fattura (fatture) e Salda selezionate (pagamenti):
// input di ricerca + lista con checkbox (multi) o righe cliccabili (single) + stato selezione.
//
// opts:
//   placeholder            testo dell'input di ricerca
//   multi  (default true)  selezione multipla (checkbox) o singola (click → onPick)
//   fetch(term) -> items[] elenco da mostrare (probabili se term vuoto, ricerca estesa altrimenti)
//   id(item)    -> string  identificatore stabile dell'elemento
//   row(item, picked) -> innerHTML del contenuto riga (senza checkbox)
//   empty(term) -> HTML    mostrato quando non ci sono risultati (opzionale)
//   onChange(pickedSet)    callback su variazione selezione (solo multi)
//   onPick(id)             callback su click riga (solo single)
//
// Ritorna { picked:Set, refresh() }.
import { esc } from '../domain/util.js';

export function mountPicker(host, opts) {
  const multi = opts.multi !== false;
  const picked = new Set();
  host.innerHTML = `
    <div class="field" style="margin-bottom:8px"><input class="mp-q" placeholder="${esc(opts.placeholder || 'Cerca…')}" autocomplete="off"></div>
    <div class="list mp-list"></div>`;
  const listEl = host.querySelector('.mp-list');
  let term = '';

  const draw = () => {
    const items = opts.fetch(term) || [];
    if (!items.length) {
      listEl.innerHTML = opts.empty ? opts.empty(term) : `<div class="muted" style="padding:10px 2px">Nessun risultato.</div>`;
      return;
    }
    listEl.innerHTML = items.map(it => {
      const id = opts.id(it);
      return `<div class="row${multi ? '' : ' click'}" data-mp="${esc(id)}">
        ${multi ? `<input type="checkbox" class="selbox" data-cb="${esc(id)}" ${picked.has(id) ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0">` : ''}
        ${opts.row(it, picked.has(id))}
      </div>`;
    }).join('');
    if (multi) {
      listEl.querySelectorAll('[data-cb]').forEach(cb => cb.onchange = () => {
        cb.checked ? picked.add(cb.dataset.cb) : picked.delete(cb.dataset.cb);
        opts.onChange && opts.onChange(picked);
      });
    } else {
      listEl.querySelectorAll('[data-mp]').forEach(el => el.onclick = () => opts.onPick && opts.onPick(el.dataset.mp));
    }
  };

  host.querySelector('.mp-q').oninput = e => { term = e.target.value; draw(); };
  draw();
  return { picked, refresh: draw };
}
