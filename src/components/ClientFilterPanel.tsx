import { useMemo, useState } from 'react';
import { Filter, X, ChevronDown, ChevronRight } from 'lucide-react';
import { filterValuesOf, type ClientFilterField } from '../hooks/useClientFilters';

// "Filters" dropdown for client-side data. Visually identical to the
// Observability FilterPanel; values and counts come from the loaded rows.
export function ClientFilterPanel<T>({
  rows,
  fields,
  filters,
  onChange,
  onClearAll,
}: {
  rows: T[];
  fields: ClientFilterField<T>[];
  filters: Record<string, string[]>;
  onChange: (field: string, values: string[]) => void;
  onClearAll: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const activeFilterCount = Object.keys(filters).length;

  const valueCounts = useMemo(() => {
    const out: Record<string, [string, number][]> = {};
    for (const f of fields) {
      const counts = new Map<string, number>();
      for (const row of rows) for (const v of filterValuesOf(row, f)) counts.set(v, (counts.get(v) || 0) + 1);
      out[f.field] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }
    return out;
  }, [rows, fields]);

  const toggleValue = (field: string, value: string) => {
    const current = filters[field] || [];
    onChange(field, current.includes(value) ? current.filter(v => v !== value) : [...current, value]);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
          activeFilterCount > 0 ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
        }`}
      >
        <Filter className="w-3 h-3" />
        <span>Filters</span>
        {activeFilterCount > 0 && <span className="bg-white/20 px-1 rounded text-xs">{activeFilterCount}</span>}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[280px]">
            <div className="flex items-center justify-between p-2 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-300">Filters</span>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <button onClick={onClearAll} className="text-xs text-red-400 hover:text-red-300">Clear all</button>
                )}
                <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {fields.map(({ field, label }) => {
                const selected = filters[field] || [];
                const isExpanded = expandedField === field;
                const values = valueCounts[field] || [];
                return (
                  <div key={field} className="border-b border-gray-700/50 last:border-0">
                    <button
                      onClick={() => setExpandedField(isExpanded ? null : field)}
                      className="w-full flex items-center justify-between p-2 hover:bg-gray-700/50"
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
                        <span className="text-xs text-gray-300">{label}</span>
                      </div>
                      {selected.length > 0 && (
                        <span className="bg-blue-600 px-1.5 py-0.5 rounded text-xs text-white">{selected.length}</span>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="px-2 pb-2">
                        {values.length === 0 ? (
                          <div className="text-xs text-gray-400 py-2 text-center">No values</div>
                        ) : (
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {values.map(([value, count]) => (
                              <label key={value} className="flex items-center gap-2 p-1 hover:bg-gray-700 rounded cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selected.includes(value)}
                                  onChange={() => toggleValue(field, value)}
                                  className="w-3 h-3 rounded border-gray-500 bg-gray-700 text-blue-500"
                                />
                                <span className="text-xs text-gray-300 truncate flex-1" title={value}>{value || '(empty)'}</span>
                                <span className="text-[10px] text-gray-500">{count}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {selected.length > 0 && (
                          <button onClick={() => onChange(field, [])} className="mt-1 text-xs text-red-400 hover:text-red-300">Clear</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
