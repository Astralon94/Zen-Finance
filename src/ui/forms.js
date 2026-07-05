// ============ Costruttori di <option> condivisi ============
import { data } from '../state/store.js';
import { esc } from '../domain/util.js';

export function companyOptions(sel) {
  return data.companies.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc((c.emoji || '') + ' ' + c.name)}</option>`).join('');
}
export function accountOptions(companyId, sel, { allowNone = false, noneLabel = '— nessun conto —', predicate = null } = {}) {
  let list = data.accounts.filter(a => !companyId || a.companyId === companyId);
  if (predicate) list = list.filter(predicate);
  const none = allowNone ? `<option value="">${esc(noneLabel)}</option>` : '';
  return none + list.map(a => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc((a.emoji || '') + ' ' + a.name)}</option>`).join('');
}
export function categoryOptions(type, sel) {
  return data.categories.filter(c => c.type === type).map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc((c.emoji || '') + ' ' + c.name)}</option>`).join('');
}
export function supplierOptions(sel, { allowNone = true } = {}) {
  const none = allowNone ? `<option value="">— nessun fornitore —</option>` : '';
  return none + data.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

// Selettore fornitore con RICERCA (combobox), non un menu a tendina.
// Si legge come una <select>: `sheet.querySelector('#ID').value` → id fornitore (o '').
// Dopo aver inserito l'HTML nel DOM va chiamato bindCombos(contenitore).
export function supplierPicker(id, selectedId, { noneLabel = '— nessun fornitore —', placeholder = 'Cerca fornitore…' } = {}) {
  const s = selectedId ? data.suppliers.find(x => x.id === selectedId) : null;
  return `<div class="combo" data-combo="${id}" data-none="${esc(noneLabel)}">
    <input type="hidden" id="${id}" value="${s ? esc(s.id) : ''}">
    <input type="text" class="combo-q" id="${id}__q" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${s ? esc(s.name) : ''}">
    <div class="combo-list" id="${id}__list" hidden></div>
  </div>`;
}

// Aggancia tutti i combobox fornitore presenti in `root` (idempotente).
export function bindCombos(root) {
  root.querySelectorAll('.combo[data-combo]').forEach(box => {
    if (box._bound) return; box._bound = true;
    const hidden = box.querySelector('input[type="hidden"]');
    const q = box.querySelector('.combo-q');
    const list = box.querySelector('.combo-list');
    const noneLabel = box.dataset.none || '— nessuno —';
    const nameOf = vid => { const s = vid ? data.suppliers.find(x => x.id === vid) : null; return s ? s.name : ''; };
    const close = () => { list.hidden = true; };
    const draw = term => {
      const t = (term || '').trim().toLowerCase();
      const items = data.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name)).filter(s => !t || s.name.toLowerCase().includes(t));
      let h = `<div class="combo-item combo-none" data-pick="">${esc(noneLabel)}</div>`;
      h += items.map(s => `<div class="combo-item" data-pick="${esc(s.id)}">${esc(s.name)}</div>`).join('');
      if (!items.length) h += `<div class="combo-empty">Nessun fornitore${t ? ' per "' + esc(term.trim()) + '"' : ''}</div>`;
      list.innerHTML = h;
      list.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('mousedown', e => {
        e.preventDefault();                              // mousedown: scatta prima del blur
        hidden.value = el.dataset.pick || '';
        q.value = el.dataset.pick ? nameOf(el.dataset.pick) : '';
        close();
      }));
    };
    q.addEventListener('focus', () => { q.select(); draw(''); list.hidden = false; });
    q.addEventListener('input', () => { draw(q.value); list.hidden = false; });
    q.addEventListener('blur', () => { setTimeout(() => { close(); q.value = nameOf(hidden.value); }, 150); });
  });
}
