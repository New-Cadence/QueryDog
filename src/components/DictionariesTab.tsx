import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { fetchDictionaries, type SystemDictionary } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber } from '../utils/formatters';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

interface DictionariesTabProps {
  filters: Record<string, string[]>;
  search: string;
}

function formatPercent(rate: number): string {
  return (rate * 100).toFixed(1) + '%';
}

export function DictionariesTab({ filters, search }: DictionariesTabProps) {
  const gridTheme = useGridTheme();
  const [dictionaries, setDictionaries] = useState<SystemDictionary[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [selectedDict, setSelectedDict] = useState<SystemDictionary | null>(null);

  // Fetch dictionaries
  useEffect(() => {
    setLoading(true);
    fetchDictionaries(filters, search)
      .then(setDictionaries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters, search]);

  // Handle viewing dictionary details
  const handleViewDetails = useCallback((dict: SystemDictionary) => {
    setSelectedDict(dict);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedDict(null);
  }, []);

  // Close modal on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedDict) {
        handleCloseModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedDict, handleCloseModal]);

  const columnDefs = useMemo((): ColDef<SystemDictionary>[] => [
    {
      headerName: '',
      field: 'database' as const,
      width: 50,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: (params: ICellRendererParams<SystemDictionary>) => {
        if (!params.data) return null;
        return (
          <button
            onClick={() => handleViewDetails(params.data!)}
            className="p-1.5 hover:bg-gray-700 rounded text-gray-300 hover:text-blue-400 transition-colors"
            title="View dictionary details"
          >
            <Eye className="w-4 h-4" />
          </button>
        );
      },
    },
    {
      headerName: 'Database',
      field: 'database',
      width: 150,
      sortable: true,
      cellStyle: { color: '#93c5fd' },
    },
    {
      headerName: 'Name',
      field: 'name',
      width: 200,
      sortable: true,
      cellStyle: { color: '#93c5fd' },
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 120,
      sortable: true,
      cellStyle: (params) => ({
        color: params.value === 'LOADED' ? '#86efac' :
               params.value === 'LOADING' ? '#fde047' :
               params.value === 'FAILED' ? '#f87171' : '#9ca3af'
      }),
    },
    {
      headerName: 'Type',
      field: 'type',
      width: 150,
      sortable: true,
      cellStyle: { color: '#fde047' },
    },
    {
      headerName: 'Elements',
      field: 'element_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#60a5fa' },
      valueFormatter: (params) => formatNumber(params.value || 0),
    },
    {
      headerName: 'Size',
      field: 'bytes_allocated',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#c084fc' },
      valueFormatter: (params) => formatBytes(params.value || 0),
    },
    {
      headerName: 'Hit Rate',
      field: 'hit_rate',
      width: 90,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatPercent(params.value || 0),
    },
    {
      headerName: 'Queries',
      field: 'query_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#fca5a5' },
      valueFormatter: (params) => formatNumber(params.value || 0),
    },
    {
      headerName: 'Source',
      field: 'source',
      flex: 1,
      sortable: true,
      cellStyle: { color: '#9ca3af' },
    },
  ], [handleViewDetails]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  const onFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    const allColumns = event.api.getColumns();
    if (allColumns) {
      const columnsToSize = allColumns.map(col => col.getColId());
      event.api.autoSizeColumns(columnsToSize);
    }
  }, []);

  return (
    <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <AgGridReact<SystemDictionary> {...GRID_OVERLAYS}
        theme={gridTheme}
        rowData={dictionaries}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        loading={loading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        onFirstDataRendered={onFirstDataRendered}
        getRowId={(params) => `${params.data.database}-${params.data.name}`}
      />

      {/* Dictionary Details Modal */}
      {selectedDict && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[800px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Dictionary Details</h2>
                <p className="text-xs text-gray-400 font-mono">
                  {selectedDict.database}.{selectedDict.name}
                </p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Dictionary Info Grid */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Status</div>
                  <div className={`text-sm font-semibold ${
                    selectedDict.status === 'LOADED' ? 'text-green-300' :
                    selectedDict.status === 'LOADING' ? 'text-yellow-300' :
                    selectedDict.status === 'FAILED' ? 'text-red-300' : 'text-gray-300'
                  }`}>
                    {selectedDict.status}
                  </div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Type</div>
                  <div className="text-sm font-semibold text-yellow-300">{selectedDict.type}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Elements</div>
                  <div className="text-sm font-semibold text-blue-300">{formatNumber(selectedDict.element_count)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Memory</div>
                  <div className="text-sm font-semibold text-purple-300">{formatBytes(selectedDict.bytes_allocated)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Hit Rate</div>
                  <div className="text-sm font-semibold text-green-300">{formatPercent(selectedDict.hit_rate)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Found Rate</div>
                  <div className="text-sm font-semibold text-green-300">{formatPercent(selectedDict.found_rate)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Queries</div>
                  <div className="text-sm font-semibold text-red-300">{formatNumber(selectedDict.query_count)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Load Factor</div>
                  <div className="text-sm font-semibold text-gray-300">{(selectedDict.load_factor * 100).toFixed(1)}%</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Lifetime</div>
                  <div className="text-sm font-semibold text-gray-300">{selectedDict.lifetime_min}s - {selectedDict.lifetime_max}s</div>
                </div>
              </div>

              {/* Key */}
              <div className="bg-gray-800 p-2 rounded mb-4">
                <div className="text-xs text-gray-400 mb-1">Key</div>
                <pre className="text-xs text-blue-300 font-mono">{selectedDict.key || '-'}</pre>
              </div>

              {/* Attributes */}
              {selectedDict.attribute_names && selectedDict.attribute_names.length > 0 && (
                <div className="bg-gray-800 p-2 rounded mb-4">
                  <div className="text-xs text-gray-400 mb-1">Attributes</div>
                  <div className="space-y-1">
                    {selectedDict.attribute_names.map((name, idx) => (
                      <div key={name} className="flex items-center gap-2 text-xs">
                        <span className="text-blue-300 font-mono">{name}</span>
                        <span className="text-gray-500">:</span>
                        <span className="text-yellow-300 font-mono">{selectedDict.attribute_types[idx]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Source */}
              <div className="bg-gray-800 p-2 rounded mb-4">
                <div className="text-xs text-gray-400 mb-1">Source</div>
                <pre className="text-xs text-green-300 font-mono whitespace-pre-wrap">{selectedDict.source || '-'}</pre>
              </div>

              {/* Last Exception */}
              {selectedDict.last_exception && (
                <div className="bg-red-900/30 border border-red-800 p-2 rounded">
                  <div className="text-xs text-red-400 mb-1">Last Exception</div>
                  <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap">{selectedDict.last_exception}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
