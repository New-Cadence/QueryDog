// Which columns of a grid are hidden, remembered per grid in this browser
// (a viewing preference, like a remembered tab). Use with GridColumnSelector.
import { useCallback, useState } from 'react';
import type { ColDef } from 'ag-grid-community';

const storageKey = (gridId: string) => `querydog.hiddenColumns.${gridId}`;
// Hidden-by-default columns the viewer has switched on, kept apart so a
// default added later still starts hidden for viewers with saved choices
const shownKey = (gridId: string) => `querydog.shownColumns.${gridId}`;

const readSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
};

const writeSet = (key: string, value: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    // Storage unavailable: the choice lasts for this visit only
  }
};

export const columnIdOf = (c: ColDef) => c.colId ?? (typeof c.field === 'string' ? c.field : '');

export function useHiddenColumns(gridId: string, defaultHidden: readonly string[] = []) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const shown = readSet(shownKey(gridId));
    const next = readSet(storageKey(gridId));
    defaultHidden.forEach(id => { if (!shown.has(id)) next.add(id); });
    return next;
  });

  const toggle = useCallback((id: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      const shown = readSet(shownKey(gridId));
      if (next.has(id)) {
        next.delete(id);
        if (defaultHidden.includes(id)) shown.add(id);
      } else {
        next.add(id);
        shown.delete(id);
      }
      writeSet(storageKey(gridId), new Set([...next].filter(c => !defaultHidden.includes(c))));
      writeSet(shownKey(gridId), shown);
      return next;
    });
  }, [gridId, defaultHidden]);

  // Column defs with `hide` set on every listed column: AG Grid keeps a
  // column's previous hide state when the attribute is left out
  const applyHidden = useCallback(<T,>(cols: ColDef<T>[]) =>
    cols.map(c => (columnIdOf(c) ? { ...c, hide: hidden.has(columnIdOf(c)) } : c)), [hidden]);

  return { hidden, toggle, applyHidden };
}
