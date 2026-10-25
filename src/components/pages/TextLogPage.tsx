import { useState, useEffect, useCallback, useMemo } from 'react';
import { FileText, ChevronLeft, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, RowClickedEvent, SortChangedEvent, SortDirection } from 'ag-grid-community';
import { useQueryStore } from '../../stores/queryStore';
import {
  fetchTextLog,
  fetchTextLogCount,
  fetchTextLogDistinct,
  fetchTextLogTimeSeries,
  isMissingTableError,
  missingTableMessage,
  type TextLogEntry,
  type TextLogTimeSeriesPoint,
} from '../../services/api';
import { TimeRangeSelector } from '../TimeRangeSelector';
import { ActivityFilterPanel } from '../ActivityFilterPanel';
import { EmptyState, PageTabs, PageToolbar, ToolbarSearch, LoadingState } from '../ui';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { addSeconds, addMinutes, addHours } from 'date-fns';
import { useGridTheme } from '../../hooks/useTheme';
import { formatDateTime, parseServerTime } from '../../utils/formatters';
import { GRID_OVERLAYS } from '../gridOverlays';

// Register AG Grid Community modules
ModuleRegistry.registerModules([AllCommunityModule]);

const FILTERABLE_FIELDS = [
  { field: 'level', label: 'Level' },
  { field: 'logger_name', label: 'Logger' },
  { field: 'thread_name', label: 'Thread' },
];

function getLevelColor(level: string): string {
  switch (level) {
    case 'Fatal':
      return 'text-red-500 bg-red-500/20';
    case 'Error':
      return 'text-red-400 bg-red-400/20';
    case 'Warning':
      return 'text-yellow-400 bg-yellow-400/20';
    case 'Information':
      return 'text-blue-400 bg-blue-400/20';
    case 'Debug':
      return 'text-gray-400 bg-gray-400/20';
    case 'Trace':
      return 'text-gray-500 bg-gray-500/20';
    default:
      return 'text-gray-400 bg-gray-400/20';
  }
}

export function TextLogPage() {
  const gridTheme = useGridTheme();
  const { timeRange, bucketSize, setTimeRange } = useQueryStore();

  const [entries, setEntries] = useState<TextLogEntry[]>([]);
  const [timeSeries, setTimeSeries] = useState<TextLogTimeSeriesPoint[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sortField, setSortField] = useState('event_time');
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC');
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState<TextLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);

  // Chart tab state
  const [chartTab, setChartTab] = useState<'count' | 'errors'>('count');
  const [textLogChartType, setTextLogChartType] = useState<'bar' | 'stacked-bar' | 'line' | 'stacked-line'>('bar');

  // Handle tab change with filter update
  const handleChartTabChange = useCallback((tab: 'count' | 'errors') => {
    setChartTab(tab);
    if (tab === 'errors') {
      setFilters(prev => ({ ...prev, level: ['Error', 'Warning', 'Fatal'] }));
    } else {
      // When switching back to count, remove the level filter and reset stacked chart types
      setFilters(prev => {
        const rest = { ...prev };
        delete rest.level;
        return rest;
      });
      setTextLogChartType(prev => (prev === 'stacked-bar' || prev === 'stacked-line') ? 'bar' : prev);
    }
    setCurrentPage(0);
  }, []);

  const pageSize = 500;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, count, series] = await Promise.all([
        fetchTextLog(timeRange, search, sortField, sortOrder, filters, pageSize, currentPage * pageSize),
        fetchTextLogCount(timeRange, search, filters),
        fetchTextLogTimeSeries(timeRange, bucketSize, filters, search),
      ]);
      setEntries(data);
      setTotalCount(count);
      setTimeSeries(series);
      setTableMissing(false);
    } catch (err) {
      setEntries([]);
      setTotalCount(0);
      setTimeSeries([]);
      if (isMissingTableError(err)) setTableMissing(true);
      else setError(err instanceof Error ? err.message : 'Failed to load text log');
    } finally {
      setLoading(false);
    }
  }, [timeRange, search, sortField, sortOrder, filters, currentPage, bucketSize]);

  const fetchDistinct = useCallback((field: string) => fetchTextLogDistinct(field, timeRange), [timeRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Debounced search, like the Queries search bar
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setCurrentPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const setFilter = useCallback((field: string, values: string[]) => {
    setFilters(prev => {
      const next = { ...prev };
      if (values.length) next[field] = values;
      else delete next[field];
      return next;
    });
    setCurrentPage(0);
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters({});
    setSearch('');
    setSearchInput('');
    setCurrentPage(0);
  }, []);


  // AG Grid column definitions
  const columnDefs: ColDef<TextLogEntry>[] = useMemo(() => [
    {
      headerName: 'Time',
      field: 'event_time',
      width: 175,
      sortable: true,
      sort: 'desc',
      valueFormatter: (params) => formatDateTime(params.value),
    },
    {
      headerName: 'Level',
      field: 'level',
      width: 90,
      sortable: true,
      cellRenderer: (params: ICellRendererParams<TextLogEntry>) => (
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getLevelColor(params.value)}`}>
          {params.value}
        </span>
      ),
    },
    {
      headerName: 'Logger',
      field: 'logger_name',
      width: 180,
      sortable: true,
      tooltipField: 'logger_name',
    },
    {
      headerName: 'Message',
      field: 'message',
      flex: 1,
      minWidth: 300,
      sortable: false,
      tooltipField: 'message',
    },
  ], []);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortingOrder: ['desc', 'asc'] as SortDirection[],
  }), []);

  const onSortChanged = useCallback((event: SortChangedEvent) => {
    const sortModel = event.api.getColumnState().find(c => c.sort);
    if (sortModel) {
      setSortField(sortModel.colId);
      setSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
    }
  }, []);

  const onRowClicked = useCallback((event: RowClickedEvent<TextLogEntry>) => {
    if (event.data) {
      setSelectedEntry(selectedEntry?.event_time === event.data.event_time &&
                       selectedEntry?.message === event.data.message ? null : event.data);
    }
  }, [selectedEntry]);

  // Handle click on chart to filter to that time bucket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChartClick = useCallback((data: any) => {
    const timeStr = data?.activeLabel;
    if (!timeStr) return;

    const clickedTime = parseServerTime(timeStr);
    if (isNaN(clickedTime.getTime())) return;

    let endTime: Date;
    switch (bucketSize) {
      case 'second':
        endTime = addSeconds(clickedTime, 1);
        break;
      case 'hour':
        endTime = addHours(clickedTime, 1);
        break;
      default:
        endTime = addMinutes(clickedTime, 1);
        break;
    }

    setTimeRange({ start: clickedTime, end: endTime });

    // If clicking on Errors & Warnings chart, also set the level filter
    if (chartTab === 'errors') {
      setFilters(prev => ({ ...prev, level: ['Error', 'Warning', 'Fatal'] }));
      setCurrentPage(0);
    }
  }, [bucketSize, setTimeRange, chartTab]);

  const totalPages = Math.ceil(totalCount / pageSize);
  const startRow = currentPage * pageSize + 1;
  const endRow = Math.min((currentPage + 1) * pageSize, totalCount);
  const activeFilterCount = Object.values(filters).filter(v => v.length > 0).length;

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <PageToolbar
        left={<>
          <ActivityFilterPanel
            filters={filters}
            onFilterChange={setFilter}
            onClearFilter={(field) => setFilter(field, [])}
            onClearAll={clearAllFilters}
            fetchDistinct={fetchDistinct}
            filterableFields={FILTERABLE_FIELDS}
          />
          <TimeRangeSelector />
          <ToolbarSearch value={searchInput} onChange={setSearchInput} placeholder="Search messages..." />
        </>}
        right={<div className="flex items-center gap-4 text-xs">
          <span className="text-gray-400">
            Total: <span className="text-white font-medium">{totalCount.toLocaleString()}</span> entries
          </span>
          {activeFilterCount > 0 && (
            <span className="text-blue-400">
              {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active
            </span>
          )}
        </div>}
      />

      {tableMissing ? (
        <EmptyState icon={FileText} title="Text log not available">
          {missingTableMessage('system.text_log')}
        </EmptyState>
      ) : (
        <>
        {error && (
          <div className="mx-1.5 mt-3 px-3 py-2 rounded text-xs bg-red-900/50 text-red-300 break-words">{error}</div>
        )}

        {/* Timeline Chart */}
        <div className="px-1.5 pt-3 pb-2 shrink-0">
          <div className="flex gap-1 border-b border-gray-700 mb-2 items-center">
            <button
              onClick={() => handleChartTabChange('count')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                chartTab === 'count'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <FileText className="w-3 h-3" />
              Text Log
            </button>
            <button
              onClick={() => handleChartTabChange('errors')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                chartTab === 'errors'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <AlertTriangle className="w-3 h-3" />
              Errors & Warnings
            </button>
            <div className="ml-auto flex items-center gap-1.5 pb-1">
              <select
                value={textLogChartType}
                onChange={(e) => setTextLogChartType(e.target.value as 'bar' | 'stacked-bar' | 'line' | 'stacked-line')}
                className="bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs"
              >
                <option value="bar">Bar</option>
                {chartTab === 'errors' && <option value="stacked-bar">Stacked Bar</option>}
                <option value="line">Line</option>
                {chartTab === 'errors' && <option value="stacked-line">Stacked Line</option>}
              </select>
            </div>
          </div>
          <div className="h-36 bg-gray-900 border border-gray-700 rounded relative cursor-pointer">
            {loading && timeSeries.length === 0 && (
              <div className="absolute inset-0 flex">
                <LoadingState />
              </div>
            )}
            <ResponsiveContainer key={`${textLogChartType}-${chartTab}`} width="100%" height="100%">
              {(textLogChartType === 'bar' || textLogChartType === 'stacked-bar') ? (
                <BarChart data={timeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
                  <XAxis
                    dataKey="time"
                    tickFormatter={(value) => {
                      const date = parseServerTime(value);
                      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                    }}
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={{ stroke: '#374151' }}
                    tickLine={{ stroke: '#374151' }}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={{ stroke: '#374151' }}
                    tickLine={{ stroke: '#374151' }}
                    width={50}
                    tickFormatter={(v) => v.toLocaleString()}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '4px',
                      fontSize: '11px',
                    }}
                    labelFormatter={(value) => parseServerTime(value).toLocaleString()}
                  />
                  {chartTab === 'count' && (
                    <Bar dataKey="count" name="Total" fill="#3b82f6" />
                  )}
                  {chartTab === 'errors' && textLogChartType === 'stacked-bar' && (
                    <>
                      <Bar dataKey="errors" name="Errors" stackId="a" fill="#ef4444" />
                      <Bar dataKey="warnings" name="Warnings" stackId="a" fill="#eab308" />
                    </>
                  )}
                  {chartTab === 'errors' && textLogChartType === 'bar' && (
                    <>
                      <Bar dataKey="errors" name="Errors" fill="#ef4444" />
                      <Bar dataKey="warnings" name="Warnings" fill="#eab308" />
                    </>
                  )}
                </BarChart>
              ) : (
                <AreaChart data={timeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
                  <defs>
                    <linearGradient id="color-total" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color-errors" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="color-warnings" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="time"
                    tickFormatter={(value) => {
                      const date = parseServerTime(value);
                      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                    }}
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={{ stroke: '#374151' }}
                    tickLine={{ stroke: '#374151' }}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={{ stroke: '#374151' }}
                    tickLine={{ stroke: '#374151' }}
                    width={50}
                    tickFormatter={(v) => v.toLocaleString()}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '4px',
                      fontSize: '11px',
                    }}
                    labelFormatter={(value) => parseServerTime(value).toLocaleString()}
                  />
                  {chartTab === 'count' && (
                    <Area type="monotone" dataKey="count" name="Total" stroke="#3b82f6" fillOpacity={1} fill="url(#color-total)" />
                  )}
                  {chartTab === 'errors' && textLogChartType === 'stacked-line' && (
                    <>
                      <Area type="monotone" dataKey="errors" name="Errors" stackId="a" stroke="#ef4444" fillOpacity={1} fill="url(#color-errors)" />
                      <Area type="monotone" dataKey="warnings" name="Warnings" stackId="a" stroke="#eab308" fillOpacity={1} fill="url(#color-warnings)" />
                    </>
                  )}
                  {chartTab === 'errors' && textLogChartType === 'line' && (
                    <>
                      <Area type="monotone" dataKey="errors" name="Errors" stroke="#ef4444" fillOpacity={1} fill="url(#color-errors)" />
                      <Area type="monotone" dataKey="warnings" name="Warnings" stroke="#eab308" fillOpacity={1} fill="url(#color-warnings)" />
                    </>
                  )}
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>

        {/* Tabs */}
        <PageTabs
          tabs={[{ id: 'entries', label: 'Log Entries', icon: FileText }]}
          active="entries"
          onChange={() => {}}
          right={
          <div className="flex items-center gap-4">
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">
                  {startRow.toLocaleString()}-{endRow.toLocaleString()} of {totalCount.toLocaleString()}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setCurrentPage(currentPage - 1)}
                    disabled={currentPage === 0}
                    className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Previous page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-gray-300 px-2">
                    {currentPage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(currentPage + 1)}
                    disabled={currentPage >= totalPages - 1}
                    className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Next page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
          }
        />

        {/* Log entries table - AG Grid */}
        <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
          <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
            <AgGridReact {...GRID_OVERLAYS}
              theme={gridTheme}
              rowData={entries}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              onSortChanged={onSortChanged}
              onRowClicked={onRowClicked}
              getRowId={(params) => `${params.data.event_time}-${params.data.message?.slice(0, 50)}`}
              rowSelection="single"
              suppressCellFocus={true}
              enableCellTextSelection={true}
              loading={loading}
              animateRows={false}
            />
          </div>
        </div>

        {/* Detail panel */}
        {selectedEntry && (
          <div className="border-t border-gray-700 bg-gray-800/50 p-4 shrink-0 max-h-[300px] overflow-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">Log Entry Details</h3>
              <button onClick={() => setSelectedEntry(null)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-4 mb-3 text-xs">
              <div>
                <div className="text-gray-500 uppercase">Time</div>
                <div className="text-gray-300 font-mono">{formatDateTime(selectedEntry.event_time)}</div>
              </div>
              <div>
                <div className="text-gray-500 uppercase">Level</div>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getLevelColor(selectedEntry.level)}`}>
                  {selectedEntry.level}
                </span>
              </div>
              <div>
                <div className="text-gray-500 uppercase">Logger</div>
                <div className="text-gray-300 font-mono">{selectedEntry.logger_name}</div>
              </div>
              <div>
                <div className="text-gray-500 uppercase">Thread</div>
                <div className="text-gray-300 font-mono">{selectedEntry.thread_name} ({selectedEntry.thread_id})</div>
              </div>
            </div>
            {selectedEntry.query_id && (
              <div className="mb-3 text-xs">
                <div className="text-gray-500 uppercase">Query ID</div>
                <div className="text-gray-300 font-mono">{selectedEntry.query_id}</div>
              </div>
            )}
            <div className="text-xs">
              <div className="text-gray-500 uppercase mb-1">Message</div>
              <pre className="bg-gray-900 p-3 rounded text-gray-200 whitespace-pre-wrap font-mono text-[11px] max-h-32 overflow-auto">
                {selectedEntry.message}
              </pre>
            </div>
            {selectedEntry.source_file && (
              <div className="mt-2 text-xs text-gray-500">
                Source: {selectedEntry.source_file}:{selectedEntry.source_line}
              </div>
            )}
          </div>
        )}
        </>
      )}
    </div>
  );
}
