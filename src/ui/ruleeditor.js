// ============ Editor regola condiviso (Anagrafiche + da movimento) ============
import { data, save } from '../state/store.js';
import { can } from '../state/auth.js';
import { esc, uid } from '../domain/util.js';
import { openSheet, closeSheet, toast, confirmDialog } from './dom.js';
import { categoryOptions, supplierPicker, bindCombos } from './forms.js';

// id = regola esistente (modifica) | null (nuova). prefill = valori iniziali per la nuova regola.
export function openRuleEditor(id, prefill = {}, onSaved) {
  // Le regole sono un'anagrafica ma possono anche nascere da un movimento: la scrittura
  // è ammessa a chi gestisce anagrafiche oppure movimenti (entrambi valgono lato backend).
  const w = can('anagrafiche.manage') || can('movimenti.manage');
  const r = id ? data.rules.find(x => x.id === id) : null;
  const v = {
    keyword: r?.keyword ?? prefill.keyword ?? '',
    categoryId: r?.categoryId ?? prefill.categoryId ?? null,
    supplierId: r?.supplierId ?? prefill.supplierId ?? null,
    displayName: r?.displayName ?? prefill.displayName ?? '',
    appliesTo: r?.appliesTo ?? prefill.appliesTo ?? (r?.applyIncome ? 'both' : 'expense'),
    enabled: r ? r.enabled !== false : true
  };
  const scopeChip = (val, lbl) => `<button type="button" class="chip ${v.appliesTo === val ? 'on' : ''}" data-scope="${val}">${lbl}</button>`;
  openSheet(`<h2>${id ? 'Modifica regola' : 'Nuova regola'}</h2>
    <div class="field"><label>Se la descrizione contiene</label><input id="r_kw" value="${esc(v.keyword)}" placeholder="es. ENEL"></div>
    <div class="field"><label>Si applica a</label><div class="chips" id="r_scope">${scopeChip('expense', 'Solo uscite')}${scopeChip('income', 'Solo entrate')}${scopeChip('both', 'Entrambe')}</div></div>
    <div class="field"><label>Imposta categoria</label><select id="r_cat"><option value="">— nessuna —</option>${categoryOptions('expense', v.categoryId)}${categoryOptions('income', v.categoryId)}</select></div>
    <div class="field"><label>Imposta fornitore/cliente</label>${supplierPicker('r_sup', v.supplierId)}</div>
    <div class="field"><label>Nome visualizzato</label><input id="r_name" value="${esc(v.displayName)}" placeholder="facoltativo"></div>
    <div class="field"><label><input type="checkbox" id="r_en" ${v.enabled ? 'checked' : ''}> Attiva</label></div>
    <div class="actions">${id && w ? '<button class="btn danger" data-del>Elimina</button>' : ''}<button class="btn" data-cancel>${w ? 'Annulla' : 'Chiudi'}</button>${w ? '<button class="btn primary" data-save>Salva</button>' : ''}</div>`,
    sheet => {
      bindCombos(sheet);
      let scope = v.appliesTo;
      sheet.querySelectorAll('#r_scope [data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; sheet.querySelectorAll('#r_scope .chip').forEach(c => c.classList.toggle('on', c.dataset.scope === scope)); });
      sheet.querySelector('[data-cancel]').onclick = closeSheet;
      sheet.querySelector('[data-save]')?.addEventListener('click', () => {
        const keyword = sheet.querySelector('#r_kw').value.trim();
        if (!keyword) { toast('Inserisci una parola chiave'); return; }
        const rec = {
          keyword,
          categoryId: sheet.querySelector('#r_cat').value || null,
          supplierId: sheet.querySelector('#r_sup').value || null,
          displayName: sheet.querySelector('#r_name').value.trim(),
          appliesTo: scope,
          enabled: sheet.querySelector('#r_en').checked
        };
        if (id) Object.assign(r, rec); else data.rules.push({ id: uid(), ...rec });
        save(); closeSheet(); toast('Regola salvata ✓');
        if (onSaved) onSaved();
      });
      if (id && w) sheet.querySelector('[data-del]').onclick = () => confirmDialog('Eliminare la regola?', '', 'Elimina', () => { data.rules = data.rules.filter(x => x.id !== id); save(); closeSheet(); toast('Eliminata'); }, { danger: true });
      // Sola lettura (regola aperta senza permesso di scrittura): campi e chip inerti.
      if (!w) {
        sheet.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
        sheet.querySelectorAll('#r_scope .chip').forEach(b => { b.disabled = true; });
      }
    });
}
