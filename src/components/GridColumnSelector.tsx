// Column picker for any AG Grid, matching the app's other column selectors
// (gear button, filterable checkbox list). Columns without a header (row
// actions) are not listed.
import { useMemo, useState } from 'react';
import { Settings, X, Search } from 'lucide-react';
import type { ColDef } from 'ag-grid-community';
import { columnIdOf } from '../hooks/useHiddenColumns';

export function GridColumnSelector<T>({ columns, hidden, onToggle }: {
  columns: ColDef<T>[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  const choices = useMemo(() => {
    const listed = columns.filter(c => c.headerName && columnIdOf(c)).map(c => ({ id: columnIdOf(c), label: c.headerName! }));
    const q = search.trim().toLowerCase();
    return q ? listed.filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : listed;
  }, [columns, search]);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
        title="Configure columns"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[240px]">
            <div className="flex items-center justify-between p-2 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-300">Columns</span>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="p-1.5 border-b border-gray-700">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter columns..."
                  className="w-full pl-6 pr-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto p-1">
              {choices.map(col => (
                <label key={col.id} className="flex items-center gap-2 p-1.5 hover:bg-gray-700 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!hidden.has(col.id)}
                    onChange={() => onToggle(col.id)}
                    className="w-3 h-3 rounded border-gray-500 bg-gray-700 text-blue-500"
                  />
                  <span className="text-xs text-gray-300">{col.label}</span>
                </label>
              ))}
              {choices.length === 0 && <div className="text-xs text-gray-500 p-2 text-center">No columns match</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
