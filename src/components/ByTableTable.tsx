import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, SortChangedEvent } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import { fetchByTableStats, type ByTableEntry } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber, formatDuration, formatDateTime } from '../utils/formatters';
import { LoadingState } from './ui';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatPercent(value: unknown, digits = 1): string {
  const num = toNumber(value);
  if (num === null) return '-';
  return `${num.toFixed(digits)}%`;
}

// Numeric comparator for AG Grid sorting
function numericComparator(valueA: unknown, valueB: unknown): number {
  const a = valueA === null || valueA === undefined ? null : Number(valueA);
  const b = valueB === null || valueB === undefined ? null : Number(valueB);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (isNaN(a) && isNaN(b)) return 0;
  if (isNaN(a)) return 1;
  if (isNaN(b)) return -1;
  return a - b;
}

export function ByTableTable() {
  const gridTheme = useGridTheme();
  const {
    timeRange,
    bucketSize,
    search,
    fieldFilters,
    rangeFilters,
    setFieldFilter,
    setActiveTab,
  } = useQueryStore();

  const [data, setData] = useState<ByTableEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortField, setSortField] = useState('count');
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC');
  const [selectedEntry, setSelectedEntry] = useState<ByTableEntry | null>(null);
  const requestIdRef = useRef(0);

  // Fetch data when dependencies change
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    fetchByTableStats(timeRange, search, sortField, sortOrder, fieldFilters, rangeFilters, 500, bucketSize)
      .then((entries) => {
        if (requestId !== requestIdRef.current) return;
        setData(entries);
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        console.error(error);
        setData([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      });
  }, [timeRange, bucketSize, search, sortField, sortOrder, fieldFilters, rangeFilters]);

  const onSortChanged = useCallback((event: SortChangedEvent) => {
    const sortModel = event.api.getColumnState().find(c => c.sort);
    if (sortModel) {
      setSortField(sortModel.colId);
      setSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
    }
  }, []);

  const columnDefs = useMemo((): ColDef<ByTableEntry>[] => [
    {
      headerName: '',
      field: 'table_name',
      width: 44,
      sortable: false,
      cellRenderer: (params: { data: ByTableEntry }) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedEntry(params.data);
          }}
          className="p-1 hover:bg-gray-600 rounded"
          title="View Details"
        >
          <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
        </button>
      ),
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
    },
    {
      headerName: 'Table',
      field: 'table_name',
      minWidth: 250,
      flex: 1,
      sortable: true,
      cellStyle: { color: '#93c5fd' },
    },
    {
      headerName: 'Count',
      field: 'count',
      width: 90,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Avg Duration',
      field: 'avg_duration',
      width: 110,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Max Duration',
      field: 'max_duration',
      width: 110,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Total Duration',
      field: 'total_duration',
      width: 110,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Avg Memory',
      field: 'avg_memory',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Max Memory',
      field: 'max_memory',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Avg Rows Read',
      field: 'avg_read_rows',
      width: 110,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Total Read',
      field: 'total_read_bytes',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' },
    },
    {
      headerName: 'Errors',
      field: 'error_count',
      width: 80,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: (params) => ({
        textAlign: 'right',
        color: params.value > 0 ? '#fca5a5' : '#86efac',
      }),
    },
    {
      headerName: 'Error %',
      field: 'error_rate',
      width: 80,
      sortable: true,
      valueFormatter: (params) => formatPercent(params.value, 1),
      comparator: numericComparator,
      cellStyle: (params) => ({
        textAlign: 'right',
        color: params.value > 0 ? '#fca5a5' : '#86efac',
      }),
    },
    {
      headerName: 'Last Seen',
      field: 'last_seen',
      width: 175,
      sortable: true,
      valueFormatter: (params) => formatDateTime(params.value),
      cellStyle: { color: '#fca5a5' },
    },
  ], []);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  // Close modal on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedEntry) {
        setSelectedEntry(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedEntry]);

  return (
    <div className="h-full flex flex-col">
      {loading && (
        <div className="absolute top-2 right-2 z-10"><LoadingState compact /></div>
      )}
      <div className="flex-1 ag-theme-alpine-dark" style={{ width: '100%' }}>
        <AgGridReact<ByTableEntry> {...GRID_OVERLAYS}
          rowData={data}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          theme={gridTheme}
          onSortChanged={onSortChanged}
          animateRows={false}
          suppressCellFocus={true}
        />
      </div>

      {/* Details Modal */}
      {selectedEntry && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => setSelectedEntry(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[700px] max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Table Details</h2>
                <p className="text-xs text-gray-400 font-mono">{selectedEntry.table_name}</p>
              </div>
              <button onClick={() => setSelectedEntry(null)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Query Count</div>
                  <div className="text-lg font-semibold text-green-300">{formatNumber(selectedEntry.count)}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Avg Duration</div>
                  <div className="text-lg font-semibold text-green-300">{formatDuration(selectedEntry.avg_duration)}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Max Duration</div>
                  <div className="text-lg font-semibold text-green-300">{formatDuration(selectedEntry.max_duration)}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Avg Memory</div>
                  <div className="text-lg font-semibold text-green-300">{formatBytes(selectedEntry.avg_memory)}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Max Memory</div>
                  <div className="text-lg font-semibold text-green-300">{formatBytes(selectedEntry.max_memory)}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-1">Error Rate</div>
                  <div className={`text-lg font-semibold ${selectedEntry.error_rate > 0 ? 'text-red-300' : 'text-green-300'}`}>
                    {formatPercent(selectedEntry.error_rate, 1)}
                  </div>
                </div>
              </div>

              {/* Detailed Stats Table */}
              <div className="bg-gray-800 rounded max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="border-b border-gray-700">
                      <th className="text-left p-1.5 text-gray-400">Metric</th>
                      <th className="text-right p-1.5 text-gray-400">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Total Queries</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatNumber(selectedEntry.count)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Total Duration</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDuration(selectedEntry.total_duration)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Avg Duration</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDuration(selectedEntry.avg_duration)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Max Duration</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDuration(selectedEntry.max_duration)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Min Duration</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDuration(selectedEntry.min_duration)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Total Memory</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatBytes(selectedEntry.total_memory)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Avg Memory</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatBytes(selectedEntry.avg_memory)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Max Memory</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatBytes(selectedEntry.max_memory)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Total Rows Read</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatNumber(selectedEntry.total_read_rows)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Avg Rows Read</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatNumber(selectedEntry.avg_read_rows)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Total Bytes Read</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatBytes(selectedEntry.total_read_bytes)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Error Count</td>
                      <td className={`p-1.5 text-right font-mono ${selectedEntry.error_count > 0 ? 'text-red-300' : 'text-green-300'}`}>
                        {formatNumber(selectedEntry.error_count)}
                      </td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Error Rate</td>
                      <td className={`p-1.5 text-right font-mono ${selectedEntry.error_rate > 0 ? 'text-red-300' : 'text-green-300'}`}>
                        {formatPercent(selectedEntry.error_rate, 2)}
                      </td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">First Seen</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDateTime(selectedEntry.first_seen)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="p-1.5 text-blue-300 font-mono">Last Seen</td>
                      <td className="p-1.5 text-right text-green-300 font-mono">{formatDateTime(selectedEntry.last_seen)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Action Buttons */}
              <div className="mt-4 flex flex-col gap-2">
                <button
                  onClick={() => {
                    // Filter by primary_table (tables[1]) - shows queries where this table is the main target
                    setFieldFilter('primary_table', [selectedEntry.table_name]);
                    setActiveTab('queries');
                    setSelectedEntry(null);
                  }}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs font-medium"
                >
                  View Queries Targeting This Table
                </button>
                <button
                  onClick={() => {
                    // Filter by tables array - shows all queries that touch this table
                    setFieldFilter('tables', [selectedEntry.table_name]);
                    setActiveTab('queries');
                    setSelectedEntry(null);
                  }}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-xs font-medium"
                >
                  View All Queries Touching This Table
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
