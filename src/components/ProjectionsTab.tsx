import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { fetchSystemProjections, fetchProjectionParts, type SystemProjection, type BrowserProjectionPart } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber, formatDateTime } from '../utils/formatters';
import { LoadingState } from './ui';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

interface ProjectionsTabProps {
  filters: Record<string, string[]>;
  search: string;
}

export function ProjectionsTab({ filters, search }: ProjectionsTabProps) {
  const gridTheme = useGridTheme();
  const [projections, setProjections] = useState<SystemProjection[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [selectedProjection, setSelectedProjection] = useState<SystemProjection | null>(null);
  const [projectionParts, setProjectionParts] = useState<BrowserProjectionPart[]>([]);
  const [partsLoading, setPartsLoading] = useState(false);

  // Fetch projections
  useEffect(() => {
    setLoading(true);
    fetchSystemProjections(filters, search)
      .then(setProjections)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters, search]);

  // Handle viewing projection details
  const handleViewDetails = useCallback(async (proj: SystemProjection) => {
    setSelectedProjection(proj);
    setPartsLoading(true);
    try {
      const parts = await fetchProjectionParts(proj.database, proj.table, proj.name);
      setProjectionParts(parts);
    } catch (error) {
      console.error('Error fetching projection parts:', error);
      setProjectionParts([]);
    } finally {
      setPartsLoading(false);
    }
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedProjection(null);
    setProjectionParts([]);
  }, []);

  // Close modal on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedProjection) {
        handleCloseModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedProjection, handleCloseModal]);

  const columnDefs = useMemo((): ColDef<SystemProjection>[] => [
    {
      headerName: '',
      field: 'database' as const,
      width: 50,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: (params: ICellRendererParams<SystemProjection>) => {
        if (!params.data) return null;
        return (
          <button
            onClick={() => handleViewDetails(params.data!)}
            className="p-1.5 hover:bg-gray-700 rounded text-gray-300 hover:text-blue-400 transition-colors"
            title="View projection details and parts"
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
      headerName: 'Projection',
      field: 'name',
      width: 200,
      sortable: true,
      cellStyle: { color: '#f472b6' },
    },
    {
      headerName: 'Type',
      field: 'type',
      width: 100,
      sortable: true,
      cellStyle: { color: '#fde047' },
    },
    {
      headerName: 'Sorting Key',
      field: 'sorting_key',
      flex: 1,
      sortable: true,
      cellStyle: { color: '#86efac' },
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

  // Calculate stats for modal
  const partStats = useMemo(() => {
    if (!projectionParts.length) return null;
    return {
      totalParts: projectionParts.length,
      totalRows: projectionParts.reduce((sum, p) => sum + Number(p.rows), 0),
      totalBytes: projectionParts.reduce((sum, p) => sum + Number(p.bytes_on_disk), 0),
      totalCompressed: projectionParts.reduce((sum, p) => sum + Number(p.data_compressed_bytes), 0),
      totalUncompressed: projectionParts.reduce((sum, p) => sum + Number(p.data_uncompressed_bytes), 0),
      totalMarks: projectionParts.reduce((sum, p) => sum + Number(p.marks), 0),
    };
  }, [projectionParts]);

  return (
    <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <AgGridReact<SystemProjection> {...GRID_OVERLAYS}
        theme={gridTheme}
        rowData={projections}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        loading={loading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        onFirstDataRendered={onFirstDataRendered}
        getRowId={(params) => `${params.data.database}-${params.data.table}-${params.data.name}`}
      />

      {/* Projection Details Modal */}
      {selectedProjection && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[900px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Projection Details</h2>
                <p className="text-xs text-gray-400 font-mono">
                  {selectedProjection.database}.{selectedProjection.table} / {selectedProjection.name}
                </p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Projection Info */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Type</div>
                  <div className="text-sm font-semibold text-yellow-300">{selectedProjection.type}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Sorting Key</div>
                  <div className="text-sm font-semibold text-green-300 font-mono truncate">{selectedProjection.sorting_key || '-'}</div>
                </div>
              </div>

              {/* Query */}
              {selectedProjection.query && (
                <div className="bg-gray-800 p-2 rounded mb-4">
                  <div className="text-xs text-gray-400 mb-1">Projection Query</div>
                  <pre className="text-xs text-blue-300 font-mono overflow-x-auto whitespace-pre-wrap">{selectedProjection.query}</pre>
                </div>
              )}

              {/* Stats */}
              {partsLoading ? (
                <div className="h-32 flex"><LoadingState label="Loading parts…" /></div>
              ) : partStats ? (
                <>
                  <div className="grid grid-cols-6 gap-2 mb-4">
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Parts</div>
                      <div className="text-sm font-semibold text-green-300">{partStats.totalParts}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Rows</div>
                      <div className="text-sm font-semibold text-green-300">{formatNumber(partStats.totalRows)}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Size on Disk</div>
                      <div className="text-sm font-semibold text-green-300">{formatBytes(partStats.totalBytes)}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Compressed</div>
                      <div className="text-sm font-semibold text-green-300">{formatBytes(partStats.totalCompressed)}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Uncompressed</div>
                      <div className="text-sm font-semibold text-green-300">{formatBytes(partStats.totalUncompressed)}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Marks</div>
                      <div className="text-sm font-semibold text-green-300">{formatNumber(partStats.totalMarks)}</div>
                    </div>
                  </div>

                  {/* Parts Table */}
                  <div className="bg-gray-800 rounded max-h-[calc(80vh-350px)] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-800">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400">Part Name</th>
                          <th className="text-left p-2 text-gray-400">Partition</th>
                          <th className="text-right p-2 text-gray-400">Rows</th>
                          <th className="text-right p-2 text-gray-400">Size</th>
                          <th className="text-right p-2 text-gray-400">Marks</th>
                          <th className="text-left p-2 text-gray-400">Parent Part</th>
                          <th className="text-right p-2 text-gray-400">Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectionParts.map((part) => (
                          <tr key={part.part_name} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="p-2 font-mono text-blue-300">{part.part_name}</td>
                            <td className="p-2 font-mono text-gray-300">{part.partition_id || '-'}</td>
                            <td className="p-2 text-right text-green-300">{formatNumber(Number(part.rows))}</td>
                            <td className="p-2 text-right text-green-300">{formatBytes(Number(part.bytes_on_disk))}</td>
                            <td className="p-2 text-right text-green-300">{formatNumber(Number(part.marks))}</td>
                            <td className="p-2 font-mono text-gray-400">{part.parent_part_name || '-'}</td>
                            <td className="p-2 text-right text-red-300">
                              {part.modification_time
                                ? formatDateTime(part.modification_time, { seconds: false })
                                : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-32 text-gray-400">
                  No projection parts found
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
