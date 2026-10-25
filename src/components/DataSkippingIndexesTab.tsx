import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { fetchDataSkippingIndexes, type DataSkippingIndex } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

interface DataSkippingIndexesTabProps {
  filters: Record<string, string[]>;
  search: string;
}

export function DataSkippingIndexesTab({ filters, search }: DataSkippingIndexesTabProps) {
  const gridTheme = useGridTheme();
  const [indexes, setIndexes] = useState<DataSkippingIndex[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [selectedIndex, setSelectedIndex] = useState<DataSkippingIndex | null>(null);

  // Fetch data skipping indexes
  useEffect(() => {
    setLoading(true);
    fetchDataSkippingIndexes(filters, search)
      .then(setIndexes)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters, search]);

  // Handle viewing index details
  const handleViewDetails = useCallback((idx: DataSkippingIndex) => {
    setSelectedIndex(idx);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedIndex(null);
  }, []);

  // Close modal on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedIndex) {
        handleCloseModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedIndex, handleCloseModal]);

  const columnDefs = useMemo((): ColDef<DataSkippingIndex>[] => [
    {
      headerName: '',
      field: 'database' as const,
      width: 50,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: (params: ICellRendererParams<DataSkippingIndex>) => {
        if (!params.data) return null;
        return (
          <button
            onClick={() => handleViewDetails(params.data!)}
            className="p-1.5 hover:bg-gray-700 rounded text-gray-300 hover:text-blue-400 transition-colors"
            title="View index details"
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
      headerName: 'Table',
      field: 'table',
      width: 250,
      sortable: true,
      cellStyle: { color: '#93c5fd' },
    },
    {
      headerName: 'Name',
      field: 'name',
      width: 200,
      sortable: true,
      cellStyle: { color: '#fbbf24' },
    },
    {
      headerName: 'Type',
      field: 'type_full',
      width: 250,
      sortable: true,
      cellStyle: { color: '#a78bfa' },
    },
    {
      headerName: 'Size',
      field: 'size',
      flex: 1,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
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
      <AgGridReact<DataSkippingIndex> {...GRID_OVERLAYS}
        theme={gridTheme}
        rowData={indexes}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        loading={loading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        onFirstDataRendered={onFirstDataRendered}
        getRowId={(params) => `${params.data.database}-${params.data.table}-${params.data.name}`}
      />

      {/* Index Details Modal */}
      {selectedIndex && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[700px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Data Skipping Index Details</h2>
                <p className="text-xs text-gray-400 font-mono">
                  {selectedIndex.database}.{selectedIndex.table} / {selectedIndex.name}
                </p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Index Info Grid */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Name</div>
                  <div className="text-sm font-semibold text-yellow-300">{selectedIndex.name}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Size</div>
                  <div className="text-sm font-semibold text-green-300">{selectedIndex.size}</div>
                </div>
              </div>

              {/* Full Type */}
              <div className="bg-gray-800 p-2 rounded mb-4">
                <div className="text-xs text-gray-400 mb-1">Type</div>
                <pre className="text-xs text-purple-300 font-mono overflow-x-auto whitespace-pre-wrap">{selectedIndex.type_full}</pre>
              </div>

              {/* Database and Table */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Database</div>
                  <div className="text-sm font-semibold text-blue-300">{selectedIndex.database}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Table</div>
                  <div className="text-sm font-semibold text-blue-300">{selectedIndex.table}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
