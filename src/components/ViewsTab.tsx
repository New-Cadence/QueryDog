import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { fetchSystemViews, fetchViewDefinition, type SystemView } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { formatDateTime } from '../utils/formatters';
import { LoadingState } from './ui';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

interface ViewsTabProps {
  filters: Record<string, string[]>;
  search: string;
}

export function ViewsTab({ filters, search }: ViewsTabProps) {
  const gridTheme = useGridTheme();
  const [views, setViews] = useState<SystemView[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [selectedView, setSelectedView] = useState<SystemView | null>(null);
  const [viewDefinition, setViewDefinition] = useState<string>('');
  const [definitionLoading, setDefinitionLoading] = useState(false);

  // Fetch views
  useEffect(() => {
    setLoading(true);
    fetchSystemViews(filters, search)
      .then(setViews)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters, search]);

  // Handle viewing view details
  const handleViewDetails = useCallback(async (view: SystemView) => {
    setSelectedView(view);
    setDefinitionLoading(true);
    try {
      const definition = await fetchViewDefinition(view.database, view.name);
      setViewDefinition(definition);
    } catch (error) {
      console.error('Error fetching view definition:', error);
      setViewDefinition('');
    } finally {
      setDefinitionLoading(false);
    }
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedView(null);
    setViewDefinition('');
  }, []);

  // Close modal on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedView) {
        handleCloseModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedView, handleCloseModal]);

  const columnDefs = useMemo((): ColDef<SystemView>[] => [
    {
      headerName: '',
      field: 'database' as const,
      width: 50,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: (params: ICellRendererParams<SystemView>) => {
        if (!params.data) return null;
        return (
          <button
            onClick={() => handleViewDetails(params.data!)}
            className="p-1.5 hover:bg-gray-700 rounded text-gray-300 hover:text-blue-400 transition-colors"
            title="View definition and details"
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
      headerName: 'View Name',
      field: 'name',
      width: 250,
      sortable: true,
      cellStyle: { color: '#93c5fd' },
    },
    {
      headerName: 'Engine',
      field: 'engine',
      width: 150,
      sortable: true,
      cellStyle: { color: '#fde047' },
      valueFormatter: (params) => {
        const engine = params.value;
        if (engine === 'MaterializedView') return 'Materialized View';
        if (engine === 'LiveView') return 'Live View';
        if (engine === 'WindowView') return 'Window View';
        return engine;
      },
    },
    {
      headerName: 'AS SELECT',
      field: 'as_select',
      flex: 1,
      sortable: true,
      cellStyle: { color: '#86efac' },
      valueFormatter: (params) => {
        const value = params.value || '';
        return value.length > 100 ? value.substring(0, 100) + '...' : value;
      },
    },
    {
      headerName: 'Last Modified',
      field: 'metadata_modification_time',
      width: 180,
      sortable: true,
      cellStyle: { color: '#fca5a5' },
      valueFormatter: (params) => {
        if (!params.value) return '-';
        return formatDateTime(params.value);
      },
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
      <AgGridReact<SystemView> {...GRID_OVERLAYS}
        theme={gridTheme}
        rowData={views}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        loading={loading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        onFirstDataRendered={onFirstDataRendered}
        getRowId={(params) => `${params.data.database}-${params.data.name}`}
      />

      {/* View Details Modal */}
      {selectedView && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[1000px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">View Details</h2>
                <p className="text-xs text-gray-400 font-mono">
                  {selectedView.database}.{selectedView.name}
                </p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* View Info */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Engine</div>
                  <div className="text-sm font-semibold text-yellow-300">
                    {selectedView.engine === 'MaterializedView' ? 'Materialized View' :
                     selectedView.engine === 'LiveView' ? 'Live View' :
                     selectedView.engine === 'WindowView' ? 'Window View' : selectedView.engine}
                  </div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Last Modified</div>
                  <div className="text-sm font-semibold text-red-300 font-mono">
                    {selectedView.metadata_modification_time
                      ? formatDateTime(selectedView.metadata_modification_time)
                      : '-'}
                  </div>
                </div>
              </div>

              {/* AS SELECT */}
              {selectedView.as_select && (
                <div className="bg-gray-800 p-2 rounded mb-4">
                  <div className="text-xs text-gray-400 mb-1">AS SELECT Query</div>
                  <pre className="text-xs text-green-300 font-mono overflow-x-auto whitespace-pre-wrap">{selectedView.as_select}</pre>
                </div>
              )}

              {/* Full Definition */}
              <div className="bg-gray-800 p-2 rounded">
                <div className="text-xs text-gray-400 mb-1">Full Definition</div>
                {definitionLoading ? (
                  <div className="h-20 flex"><LoadingState label="Loading definition…" /></div>
                ) : viewDefinition ? (
                  <pre className="text-xs text-blue-300 font-mono overflow-x-auto whitespace-pre-wrap max-h-[40vh] overflow-y-auto">{viewDefinition}</pre>
                ) : (
                  <div className="flex items-center justify-center h-20 text-gray-400">
                    No definition available
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
