import { useState, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, RowClassParams, SortChangedEvent, ICellRendererParams } from 'ag-grid-community';
import { Eye, X } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useQueryStore } from '../stores/queryStore';
import { fetchProfileEvents } from '../services/api';
import type { QueryLogEntry } from '../types/queryLog';
import { useGridTheme } from '../hooks/useTheme';
import { parseServerTime, formatDateTime } from '../utils/formatters';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

// All available profile events
const ALL_PROFILE_EVENTS = [
  'IOBufferAllocBytes',
  'NetworkReceiveBytes',
  'InterfaceHTTPReceiveBytes',
  'MergeTreeDataWriterUncompressedBytes',
  'InsertedBytes',
  'SelectedBytes',
  'LoggerElapsedNanoseconds',
  'OSWriteBytes',
  'RealTimeMicroseconds',
  'OSWriteChars',
  'WriteBufferFromFileDescriptorWriteBytes',
  'MergeTreeDataWriterCompressedBytes',
  'OSCPUVirtualTimeMicroseconds',
  'UserTimeMicroseconds',
  'OSReadChars',
  'InsertedRows',
  'SelectedRows',
  'MergeTreeDataWriterRows',
  'MergeTreeDataWriterMergingBlocksMicroseconds',
  'NetworkReceiveElapsedMicroseconds',
  'SystemTimeMicroseconds',
  'PartsLockHoldMicroseconds',
  'PartsLockWaitMicroseconds',
  'NetworkSendBytes',
  'InterfaceHTTPSendBytes',
  'DiskWriteElapsedMicroseconds',
  'SoftPageFaults',
  'NetworkSendElapsedMicroseconds',
  'LocalThreadPoolThreadCreationMicroseconds',
  'IOBufferAllocs',
  'OSCPUWaitMicroseconds',
  'MergeTreeDataWriterSortingBlocksMicroseconds',
  'ContextLock',
  'GlobalThreadPoolLockWaitMicroseconds',
  'FileOpen',
  'WriteBufferFromFileDescriptorWrite',
  'FunctionExecute',
  'AsyncLoggingFileLogTotalMessages',
  'AsyncLoggingTextLogTotalMessages',
  'LogTrace',
  'GlobalThreadPoolJobs',
  'LocalThreadPoolExpansions',
  'LocalThreadPoolJobs',
  'LocalThreadPoolShrinks',
  'LogDebug',
  'ConcurrencyControlSlotsAcquired',
  'MergeTreeDataWriterBlocks',
  'MergeTreeDataWriterBlocksAlreadySorted',
  'InsertedCompactParts',
  'RWLockAcquiredReadLocks',
  'Query',
  'InsertQuery',
  'InitialQuery',
  'ConcurrencyControlSlotsGranted',
  'ConcurrencyControlSlotsAcquiredNonCompeting',
  'CompressedReadBufferBlocks',
  'CompressedReadBufferBytes',
  'CreatedReadBufferOrdinary',
  'DiskReadElapsedMicroseconds',
  'FilteringMarksWithPrimaryKeyMicroseconds',
  'FilteringMarksWithSecondaryKeysMicroseconds',
  'IndexBinarySearchAlgorithm',
  'LoadedMarksCount',
  'LoadedMarksFiles',
  'LoadedMarksMemoryBytes',
  'MarkCacheHits',
  'MarkCacheMisses',
  'OpenedFileCacheMicroseconds',
  'OpenedFileCacheMisses',
  'OSReadBytes',
  'QueriesWithSubqueries',
  'QueryConditionCacheMisses',
  'QueryProfilerRuns',
  'ReadBufferFromFileDescriptorReadBytes',
  'ReadCompressedBytes',
  'RowsReadByMainReader',
  'RowsReadByPrewhereReaders',
  'SelectQuery',
  'SelectQueriesWithPrimaryKeyUsage',
  'SelectQueriesWithSubqueries',
  'SelectedMarks',
  'SelectedMarksTotal',
  'SelectedParts',
  'SelectedPartsTotal',
  'SelectedRanges',
  'SynchronousReadWaitMicroseconds',
  'ThreadPoolReaderPageCacheHit',
  'ThreadPoolReaderPageCacheHitBytes',
  'ThreadPoolReaderPageCacheHitElapsedMicroseconds',
  'ThreadPoolReaderPageCacheMiss',
  'ThreadPoolReaderPageCacheMissBytes',
  'ThreadPoolReaderPageCacheMissElapsedMicroseconds',
  'UncompressedCacheMisses',
  'UncompressedCacheWeightLost',
  'WaitMarksLoadMicroseconds',
];

// Most important profile events to show by default
const DEFAULT_VISIBLE_EVENTS = [
  'RealTimeMicroseconds',
  'UserTimeMicroseconds',
  'SystemTimeMicroseconds',
  'SelectedRows',
  'SelectedBytes',
  'InsertedRows',
  'InsertedBytes',
  'OSWriteBytes',
  'OSReadChars',
  'NetworkReceiveBytes',
  'NetworkSendBytes',
];

// Colors for chart lines
const CHART_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#6366f1', // indigo
];

function formatValue(value: number, columnName: string): string {
  if (value === 0 || value === null || value === undefined) return '-';

  // Format bytes
  if (columnName.includes('Bytes')) {
    if (value >= 1073741824) return (value / 1073741824).toFixed(2) + ' GB';
    if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MB';
    if (value >= 1024) return (value / 1024).toFixed(2) + ' KB';
    return value + ' B';
  }

  // Format microseconds
  if (columnName.includes('Microseconds')) {
    if (value >= 1000000) return (value / 1000000).toFixed(2) + 's';
    if (value >= 1000) return (value / 1000).toFixed(2) + 'ms';
    return value.toLocaleString() + 'us';
  }

  // Format nanoseconds
  if (columnName.includes('Nanoseconds')) {
    if (value >= 1000000000) return (value / 1000000000).toFixed(2) + 's';
    if (value >= 1000000) return (value / 1000000).toFixed(2) + 'ms';
    if (value >= 1000) return (value / 1000).toFixed(2) + 'us';
    return value.toLocaleString() + 'ns';
  }

  // Default number format
  return value.toLocaleString();
}

// Format value for chart tooltip
function formatChartValue(value: number, columnName: string): string {
  return formatValue(value, columnName);
}

function formatQueryForTooltip(query: string): string {
  if (!query) return '';
  return query
    .replace(/\s+/g, ' ')
    .replace(/(SELECT|FROM|WHERE|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP BY|ORDER BY|LIMIT|HAVING|UNION|INSERT|UPDATE|DELETE|SET|INTO|VALUES)/gi, '\n$1')
    .trim();
}

function formatEventTime(value: string): string {
  return formatDateTime(value, { ms: true });
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeProfileEventRow(row: Record<string, unknown>): ProfileEventRow {
  const normalized: ProfileEventRow = {
    event_time: String(row.event_time ?? ''),
    query_id: String(row.query_id ?? ''),
    query_text: row.query_text ? String(row.query_text) : '',
    query_duration_ms: toNumberOrUndefined(row.query_duration_ms),
  };

  ALL_PROFILE_EVENTS.forEach((eventName) => {
    const value = toNumberOrUndefined(row[eventName]);
    if (value !== undefined) {
      normalized[eventName] = value;
    }
  });

  return normalized;
}

interface ProfileEventRow {
  event_time: string;
  query_id: string;
  query_text?: string;
  query_duration_ms?: number;
  [key: string]: string | number | undefined;
}

// Exported ref interface for parent to control
export interface ProfileEventsTableRef {
  openChart: () => void;
  openColumnSelector: () => void;
  closeColumnSelector: () => void;
  toggleEventVisibility: (eventName: string) => void;
  visibleEvents: Set<string>;
  allEvents: string[];
}

export const ProfileEventsTable = forwardRef<ProfileEventsTableRef, object>(function ProfileEventsTable(_props, ref) {
  const gridTheme = useGridTheme();
  const { timeRange, bucketSize, fieldFilters, rangeFilters, search, pinnedEntries, sortField, sortOrder, pageSize, currentPage, setSortField, setSortOrder, setSelectedEntry } = useQueryStore();
  const [apiData, setApiData] = useState<ProfileEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleEvents, setVisibleEvents] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_EVENTS));
  const [columnSelectorOpen, setColumnSelectorOpen] = useState(false);
  const [chartModalOpen, setChartModalOpen] = useState(false);

  // Convert pinned entries to ProfileEventRow format
  const pinnedData = useMemo((): ProfileEventRow[] => {
    return pinnedEntries.map(entry => {
      const row: ProfileEventRow = {
        event_time: String(entry.event_time),
        query_id: String(entry.query_id),
        query_text: String(entry.query || ''),
        query_duration_ms: toNumberOrUndefined(entry.query_duration_ms),
      };
      // Add ProfileEvents data
      const profileEvents = (entry.ProfileEvents || {}) as Record<string, number>;
      Object.entries(profileEvents).forEach(([key, value]) => {
        const numericValue = toNumberOrUndefined(value);
        if (numericValue !== undefined) {
          row[key] = numericValue;
        }
      });
      return row;
    });
  }, [pinnedEntries]);

  // Split pinned data from API data, avoiding duplicates
  const unpinnedData = useMemo(() => {
    const pinnedIds = new Set(pinnedData.map(p => p.query_id));
    return apiData.filter(row => !pinnedIds.has(row.query_id));
  }, [pinnedData, apiData]);

  const combinedData = useMemo(() => {
    return [...pinnedData, ...unpinnedData];
  }, [pinnedData, unpinnedData]);

  const toggleEventVisibility = useCallback((eventName: string) => {
    setVisibleEvents(prev => {
      const next = new Set(prev);
      if (next.has(eventName)) {
        next.delete(eventName);
      } else {
        next.add(eventName);
      }
      return next;
    });
  }, []);

  // Expose controls to parent via ref
  useImperativeHandle(ref, () => ({
    openChart: () => setChartModalOpen(true),
    openColumnSelector: () => setColumnSelectorOpen(true),
    closeColumnSelector: () => setColumnSelectorOpen(false),
    toggleEventVisibility,
    visibleEvents,
    allEvents: ALL_PROFILE_EVENTS,
  }), [visibleEvents, toggleEventVisibility]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const offset = currentPage * pageSize;
      // Always fetch all columns so we have data for charting
      const result = await fetchProfileEvents(
        timeRange,
        fieldFilters,
        ALL_PROFILE_EVENTS,
        search,
        sortField,
        sortOrder,
        rangeFilters,
        pageSize,
        offset,
        bucketSize
      );
      const normalized = (result as Record<string, unknown>[]).map(normalizeProfileEventRow);
      setApiData(normalized);
    } catch (err) {
      console.error('Failed to load profile events:', err);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    timeRange.start.getTime(),
    timeRange.end.getTime(),
    bucketSize,
    fieldFilters,
    rangeFilters,
    search,
    sortField,
    sortOrder,
    pageSize,
    currentPage,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const ActionCellRenderer = useCallback((params: ICellRendererParams<ProfileEventRow>) => {
    const row = params.data;
    if (!row) return null;

    const profileEvents: Record<string, number> = {};
    ALL_PROFILE_EVENTS.forEach((eventName) => {
      const value = toNumberOrUndefined(row[eventName]);
      if (value !== undefined) {
        profileEvents[eventName] = value;
      }
    });

    const entry: QueryLogEntry = {
      event_time: row.event_time,
      query_id: row.query_id,
      query: row.query_text,
      query_duration_ms: row.query_duration_ms,
      ProfileEvents: profileEvents,
    };

    return (
      <button
        onClick={() => setSelectedEntry(entry)}
        className="p-1 hover:bg-gray-600 rounded"
        title="View details (read-only)"
      >
        <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
      </button>
    );
  }, [setSelectedEntry]);

  const columnDefs = useMemo((): ColDef[] => {
    const cols: ColDef[] = [
      {
        headerName: '',
        field: 'query_id',
        width: 40,
        sortable: false,
        pinned: 'left',
        cellRenderer: ActionCellRenderer,
        cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      },
      {
        headerName: 'Event Time',
        field: 'event_time',
        width: 215,
        sortable: true,
        pinned: 'left',
        cellStyle: { color: '#fca5a5' },
        valueFormatter: (params) => {
          return formatEventTime(String(params.value || ''));
        },
      },
      {
        headerName: 'Duration',
        field: 'query_duration_ms',
        width: 90,
        sortable: true,
        cellStyle: { textAlign: 'right', color: '#86efac' },
        valueFormatter: (params) => {
          const ms = Number(params.value);
          if (isNaN(ms)) return '-';
          if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
          return ms + 'ms';
        },
      },
      {
        headerName: 'Query',
        field: 'query_text',
        width: 420,
        sortable: true,
        cellStyle: { color: '#93c5fd' },
        valueFormatter: (params) => {
          const q = (params.value as string) || (params.data?.query_id as string) || '';
          return q.length > 80 ? q.substring(0, 80) + '...' : q;
        },
        tooltipValueGetter: (params) => {
          const q = (params.value as string) || (params.data?.query_id as string) || '';
          if (!q) return '';
          const formatted = formatQueryForTooltip(q);
          const maxLen = 1000;
          return formatted.length > maxLen ? formatted.substring(0, maxLen) + '\n...(truncated)' : formatted;
        },
      },
    ];

    // Add only visible profile event columns
    ALL_PROFILE_EVENTS.filter(e => visibleEvents.has(e)).forEach((eventName) => {
      cols.push({
        headerName: eventName.replace(/([A-Z])/g, ' $1').trim(),
        field: eventName,
        width: 120,
        sortable: true,
        cellStyle: { textAlign: 'right', color: '#86efac' },
        valueFormatter: (params) => formatValue(params.value, eventName),
        headerTooltip: eventName,
      });
    });

    return cols;
  }, [visibleEvents, ActionCellRenderer]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  // Check if a row is from pinned entries
  const pinnedQueryIds = useMemo(() => new Set(pinnedEntries.map(e => String(e.query_id))), [pinnedEntries]);

  const getRowClass = useCallback((params: RowClassParams<ProfileEventRow>) => {
    if (params.data && pinnedQueryIds.has(params.data.query_id)) {
      return 'pinned-row';
    }
    return '';
  }, [pinnedQueryIds]);

  const onSortChanged = useCallback(
    (event: SortChangedEvent) => {
      const sortModel = event.api.getColumnState().find((col) => col.sort);
      if (sortModel) {
        setSortField(sortModel.colId);
        setSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
      }
    },
    [setSortField, setSortOrder]
  );

  // Prepare chart data - sorted by time
  const chartData = useMemo(() => {
    return [...combinedData].sort((a, b) =>
      parseServerTime(a.event_time).getTime() - parseServerTime(b.event_time).getTime()
    ).map(row => ({
      ...row,
      time: formatDateTime(row.event_time, { seconds: false }),
    }));
  }, [combinedData]);

  const visibleEventsList = useMemo(() =>
    ALL_PROFILE_EVENTS.filter(e => visibleEvents.has(e)),
  [visibleEvents]);

  return (
    <div className="h-full flex flex-col bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <style>{`
        .pinned-row {
          background-color: rgba(59, 130, 246, 0.15) !important;
        }
        .pinned-row:hover {
          background-color: rgba(59, 130, 246, 0.25) !important;
        }
      `}</style>
      {/* AG Grid */}
      <div className="flex-1">
        <AgGridReact {...GRID_OVERLAYS}
          theme={gridTheme}
          rowData={unpinnedData}
          pinnedTopRowData={pinnedData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          initialState={{
            sort: {
              sortModel: [{
                colId: sortField,
                sort: sortOrder === 'ASC' ? 'asc' : 'desc',
              }],
            },
          }}
          onSortChanged={onSortChanged}
          loading={loading}
          getRowClass={getRowClass}
          animateRows={false}
          suppressCellFocus={true}
          enableCellTextSelection={true}
          getRowId={(params) => params.data.query_id}
        />
      </div>

      {/* Column Selector Modal */}
      {columnSelectorOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-end z-50 pt-16 pr-4" onClick={() => setColumnSelectorOpen(false)}>
          <div
            className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl w-80 max-h-[70vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
              <h3 className="text-sm font-semibold text-white">Profile Event Columns</h3>
              <button onClick={() => setColumnSelectorOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-2 flex-1">
              {[...ALL_PROFILE_EVENTS].sort((a, b) => a.localeCompare(b)).map((eventName) => (
                <label
                  key={eventName}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-700 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleEvents.has(eventName)}
                    onChange={() => toggleEventVisibility(eventName)}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                  />
                  <span className="text-xs text-gray-300">{eventName.replace(/([A-Z])/g, ' $1').trim()}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Chart Modal */}
      {chartModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setChartModalOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[90vw] h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-white">Profile Events Chart</h2>
                <p className="text-xs text-gray-400">{visibleEventsList.length} series, {chartData.length} data points</p>
              </div>
              <button onClick={() => setChartModalOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 p-4 overflow-auto">
              {chartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  No data to chart
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 15, right: 15, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 9, fill: '#9ca3af' }}
                      axisLine={{ stroke: '#374151' }}
                      tickLine={{ stroke: '#374151' }}
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: '#9ca3af' }}
                      axisLine={{ stroke: '#374151' }}
                      tickLine={{ stroke: '#374151' }}
                      width={60}
                      tickFormatter={(value) => {
                        if (value >= 1000000000) return (value / 1000000000).toFixed(0) + 'B';
                        if (value >= 1000000) return (value / 1000000).toFixed(0) + 'M';
                        if (value >= 1000) return (value / 1000).toFixed(0) + 'K';
                        return value;
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1f2937',
                        border: '1px solid #374151',
                        borderRadius: '4px',
                        fontSize: '11px',
                      }}
                      labelStyle={{ color: '#9ca3af' }}
                      formatter={(value: number, name: string) => [
                        formatChartValue(value, name),
                        name.replace(/([A-Z])/g, ' $1').trim()
                      ]}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }}
                      formatter={(value) => value.replace(/([A-Z])/g, ' $1').trim()}
                    />
                    {visibleEventsList.map((eventName, idx) => (
                      <Line
                        key={eventName}
                        type="monotone"
                        dataKey={eventName}
                        stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                        strokeWidth={2}
                        dot={chartData.length < 50}
                        name={eventName}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
