import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, SortChangedEvent, ICellRendererParams, CellStyle } from 'ag-grid-community';
import { Copy, Check, X, Eye, ExternalLink, List, Pin } from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import { fetchGroupedQueryLog, type GroupedQueryEntry } from '../services/api';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber, formatDuration, formatDateTime } from '../utils/formatters';
import { LoadingState } from './ui';
import { GRID_OVERLAYS } from './gridOverlays';

// Register AG Grid Community modules
ModuleRegistry.registerModules([AllCommunityModule]);

// Numeric comparator for AG Grid sorting - handles null values and ensures numeric sorting
function numericComparator(valueA: unknown, valueB: unknown): number {
  const a = valueA === null || valueA === undefined ? null : Number(valueA);
  const b = valueB === null || valueB === undefined ? null : Number(valueB);
  if (a === null && b === null) return 0;
  if (a === null) return 1;  // nulls go to bottom
  if (b === null) return -1;
  if (isNaN(a) && isNaN(b)) return 0;
  if (isNaN(a)) return 1;
  if (isNaN(b)) return -1;
  return a - b;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 hover:bg-gray-600 rounded text-gray-400 hover:text-white"
      title="Copy query"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

export function GroupedQueriesTable() {
  const gridTheme = useGridTheme();
  const {
    timeRange,
    bucketSize,
    search,
    fieldFilters,
    rangeFilters,
    groupedEntries,
    groupedLoading,
    groupedSortField,
    groupedSortOrder,
    normalizeQueries,
    setGroupedEntries,
    setGroupedLoading,
    setGroupedSortField,
    setGroupedSortOrder,
    setSearch,
    setFieldFilter,
    setActiveTab,
    pinnedEntries,
  } = useQueryStore();

  const [selectedEntry, setSelectedEntry] = useState<GroupedQueryEntry | null>(null);
  const requestIdRef = useRef(0);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedEntry) {
        setSelectedEntry(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedEntry]);

  const ActionCellRenderer = useCallback((params: ICellRendererParams<GroupedQueryEntry>) => {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setSelectedEntry(params.data!);
        }}
        className="p-1 hover:bg-gray-600 rounded"
        title="View Details"
      >
        <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
      </button>
    );
  }, []);

  // Fetch grouped data
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setGroupedLoading(true);
    fetchGroupedQueryLog(
      timeRange,
      search,
      groupedSortField,
      groupedSortOrder,
      fieldFilters,
      rangeFilters,
      1000,
      normalizeQueries,
      bucketSize
    )
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        setGroupedEntries(data);
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        console.error(error);
        setGroupedEntries([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setGroupedLoading(false);
        }
      });
  }, [timeRange, bucketSize, search, fieldFilters, rangeFilters, groupedSortField, groupedSortOrder, normalizeQueries, setGroupedEntries, setGroupedLoading]);

  // Column definitions for AG Grid
  const columnDefs: ColDef<GroupedQueryEntry>[] = useMemo(() => [
    {
      headerName: '',
      field: 'example_query' as const,
      width: 44,
      sortable: false,
      cellRenderer: ActionCellRenderer,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 } as CellStyle,
    },
    {
      headerName: 'Last Seen',
      field: 'last_seen',
      width: 175,
      sortable: true,
      valueFormatter: (params) => formatDateTime(params.value),
    },
    {
      headerName: 'Query',
      field: 'example_query',
      minWidth: 300,
      flex: 1,
      sortable: false,
      tooltipValueGetter: (params) => {
        const q = params.value as string;
        if (!q) return '';
        // Format SQL with newlines after keywords and limit to 1000 chars
        const formatted = q
          .replace(/\s+/g, ' ')
          .replace(/(SELECT|FROM|WHERE|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP BY|ORDER BY|LIMIT|HAVING|UNION|INSERT|UPDATE|DELETE|SET|INTO|VALUES)/gi, '\n$1')
          .trim();
        const maxLen = 1000;
        return formatted.length > maxLen ? formatted.substring(0, maxLen) + '\n...(truncated)' : formatted;
      },
      valueFormatter: (params) => {
        const q = params.value as string;
        return q?.length > 100 ? q.substring(0, 100) + '...' : q;
      },
      cellStyle: { color: '#93c5fd' } as CellStyle,
    },
    {
      headerName: 'Count',
      field: 'count',
      width: 80,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Avg Duration',
      field: 'avg_duration',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Max Duration',
      field: 'max_duration',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Total Duration',
      field: 'total_duration',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatDuration(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Avg Memory',
      field: 'avg_memory',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Max Memory',
      field: 'max_memory',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Avg Rows Read',
      field: 'avg_read_rows',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Avg Rows Written',
      field: 'avg_written_rows',
      width: 110,
      sortable: true,
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'Total Read',
      field: 'total_read_bytes',
      width: 100,
      sortable: true,
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
      cellStyle: { textAlign: 'right', color: '#86efac' } as CellStyle,
    },
    {
      headerName: 'User',
      field: 'user',
      width: 100,
      sortable: false,
      cellStyle: { color: '#93c5fd' } as CellStyle,
    },
    {
      headerName: 'First Seen',
      field: 'first_seen',
      width: 175,
      sortable: true,
      valueFormatter: (params) => formatDateTime(params.value),
      cellStyle: { color: '#fca5a5' } as CellStyle,
    },
  ], [ActionCellRenderer]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortingOrder: ['desc', 'asc'] as const,
  }), []);

  const onSortChanged = useCallback((event: SortChangedEvent) => {
    const sortModel = event.api.getColumnState().find(c => c.sort);
    if (sortModel) {
      setGroupedSortField(sortModel.colId);
      setGroupedSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
    }
  }, [setGroupedSortField, setGroupedSortOrder]);


  if (groupedLoading) {
    return (
      <LoadingState label="Loading grouped queries…" />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Pinned queries notice */}
      {pinnedEntries.length > 0 && (
        <div className="bg-blue-900/30 border border-blue-700/50 rounded mx-0 mb-2 px-3 py-2 flex items-center gap-2 text-xs">
          <Pin className="w-3.5 h-3.5 text-blue-400 fill-current" />
          <span className="text-blue-300">
            {pinnedEntries.length} pinned {pinnedEntries.length === 1 ? 'query' : 'queries'} not shown in grouped view.
          </span>
          <button
            onClick={() => setActiveTab('queries')}
            className="text-blue-400 hover:text-blue-300 underline"
          >
            View in Queries tab
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <AgGridReact {...GRID_OVERLAYS}
          theme={gridTheme}
          rowData={groupedEntries}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          onSortChanged={onSortChanged}
          getRowId={(params) => params.data.example_query}
          animateRows={false}
          suppressCellFocus={true}
          enableCellTextSelection={true}
        />
      </div>

      {/* Modal popup for grouped query details */}
      {selectedEntry && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setSelectedEntry(null)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[900px] max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Grouped Query Details</h2>
                <p className="text-xs text-gray-400">
                  {formatNumber(selectedEntry.count)} executions
                </p>
              </div>
              <button onClick={() => setSelectedEntry(null)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Query */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-gray-400">Example Query</h3>
                    <CopyButton text={selectedEntry.example_query} />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        // Filter by normalized_query_hash if using normalization, otherwise by exact query
                        if (normalizeQueries && selectedEntry.normalized_query_hash) {
                          setFieldFilter('normalized_query_hash', [selectedEntry.normalized_query_hash]);
                        } else {
                          // Use exact query match via filter (not search which is ILIKE)
                          setFieldFilter('query', [selectedEntry.example_query]);
                        }
                        setSearch(''); // Clear search to avoid conflicts
                        setActiveTab('queries');
                        setSelectedEntry(null);
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded text-white"
                    >
                      <List className="w-3 h-3" />
                      List All
                    </button>
                    <button
                      onClick={() => {
                        const openQueryEditor = (window as unknown as { openQueryEditor?: (query: string) => void }).openQueryEditor;
                        if (openQueryEditor) {
                          openQueryEditor(selectedEntry.example_query);
                          setSelectedEntry(null);
                        }
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Analyse Query
                    </button>
                  </div>
                </div>
                <pre className="bg-gray-800 p-3 rounded text-xs text-gray-300 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                  {selectedEntry.example_query}
                </pre>
              </div>

              {/* Summary Stats */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Count</div>
                  <div className="text-sm font-semibold text-blue-400">{formatNumber(selectedEntry.count)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">User</div>
                  <div className="text-sm font-semibold text-white">{selectedEntry.user || 'N/A'}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Database</div>
                  <div className="text-sm font-semibold text-white">{selectedEntry.current_database || 'N/A'}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">First Seen</div>
                  <div className="text-sm font-semibold text-white">{formatDateTime(selectedEntry.first_seen)}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Last Seen</div>
                  <div className="text-sm font-semibold text-white">{formatDateTime(selectedEntry.last_seen)}</div>
                </div>
              </div>

              {/* Metrics Table with Min/Avg/Max/Total columns */}
              <div className="bg-gray-800 rounded mb-4 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-700 bg-gray-800/50">
                      <th className="text-left p-2 text-gray-400 font-semibold">Metric</th>
                      <th className="text-right p-2 text-green-400 font-semibold">Min</th>
                      <th className="text-right p-2 text-blue-400 font-semibold">Avg</th>
                      <th className="text-right p-2 text-orange-400 font-semibold">Max</th>
                      <th className="text-right p-2 text-purple-400 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-700/50">
                      <td className="p-2 text-gray-300 font-medium">Duration</td>
                      <td className="p-2 text-right text-green-400">{formatDuration(selectedEntry.min_duration)}</td>
                      <td className="p-2 text-right text-blue-400">{formatDuration(selectedEntry.avg_duration)}</td>
                      <td className="p-2 text-right text-orange-400">{formatDuration(selectedEntry.max_duration)}</td>
                      <td className="p-2 text-right text-purple-400">{formatDuration(selectedEntry.total_duration)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50">
                      <td className="p-2 text-gray-300 font-medium">Memory</td>
                      <td className="p-2 text-right text-green-400">-</td>
                      <td className="p-2 text-right text-blue-400">{formatBytes(selectedEntry.avg_memory)}</td>
                      <td className="p-2 text-right text-orange-400">{formatBytes(selectedEntry.max_memory)}</td>
                      <td className="p-2 text-right text-purple-400">{formatBytes(selectedEntry.total_memory)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50">
                      <td className="p-2 text-gray-300 font-medium">Read Rows</td>
                      <td className="p-2 text-right text-green-400">-</td>
                      <td className="p-2 text-right text-blue-400">{formatNumber(selectedEntry.avg_read_rows)}</td>
                      <td className="p-2 text-right text-orange-400">-</td>
                      <td className="p-2 text-right text-purple-400">{formatNumber(selectedEntry.total_read_rows)}</td>
                    </tr>
                    <tr className="border-b border-gray-700/50">
                      <td className="p-2 text-gray-300 font-medium">Read Bytes</td>
                      <td className="p-2 text-right text-green-400">-</td>
                      <td className="p-2 text-right text-blue-400">-</td>
                      <td className="p-2 text-right text-orange-400">-</td>
                      <td className="p-2 text-right text-purple-400">{formatBytes(selectedEntry.total_read_bytes)}</td>
                    </tr>
                    <tr>
                      <td className="p-2 text-gray-300 font-medium">Result Rows</td>
                      <td className="p-2 text-right text-green-400">-</td>
                      <td className="p-2 text-right text-blue-400">{formatNumber(selectedEntry.avg_result_rows)}</td>
                      <td className="p-2 text-right text-orange-400">-</td>
                      <td className="p-2 text-right text-purple-400">{formatNumber(selectedEntry.total_result_rows)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>


              {/* Note about profile events */}
              <div className="bg-gray-800/50 border border-gray-700 rounded p-3 text-xs text-gray-400">
                <span className="font-semibold">Note:</span> ProfileEvents and Settings are not available for grouped queries as they are aggregated data.
                Click on a specific query in the Queries tab to see detailed ProfileEvents.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
