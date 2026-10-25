import { useMemo, useState, useCallback } from 'react';

export interface ClientFilterField<T> {
  field: string;
  label: string;
  // Defaults to String(row[field]); return several values for array-like fields
  getValue?: (row: T) => string | string[] | null | undefined;
}

export function filterValuesOf<T>(row: T, f: ClientFilterField<T>): string[] {
  const raw = f.getValue ? f.getValue(row) : (row as Record<string, unknown>)[f.field];
  if (raw === null || raw === undefined) return [''];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

// Value filters + free-text search applied in the browser. Used by every
// screen whose data is already loaded client-side so they all filter the
// same way as the Observability FilterPanel.
export function useClientFilters<T>(rows: T[], fields: ClientFilterField<T>[], searchText?: (row: T) => string) {
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');

  const setFilter = useCallback((field: string, values: string[]) => {
    setFilters(prev => {
      const next = { ...prev };
      if (values.length) next[field] = values;
      else delete next[field];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setFilters({});
    setSearch('');
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(row => {
      for (const f of fields) {
        const selected = filters[f.field];
        if (selected?.length && !filterValuesOf(row, f).some(v => selected.includes(v))) return false;
      }
      if (term && searchText && !searchText(row).toLowerCase().includes(term)) return false;
      return true;
    });
  }, [rows, fields, filters, search, searchText]);

  const activeCount = Object.keys(filters).length;

  return { filters, setFilter, clearAll, search, setSearch, filtered, activeCount };
}
