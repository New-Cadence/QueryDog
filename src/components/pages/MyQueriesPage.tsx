import { useState, useEffect, useCallback, useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, SelectionChangedEvent } from 'ag-grid-community';
import { RotateCcw, Activity, ListChecks, GitCompare, FileCode } from 'lucide-react';
import { QueryCompareModal } from '../QueryCompareModal';
import type { QueryLogEntry } from '../../types/queryLog';
import { useGridTheme } from '../../hooks/useTheme';
import { formatDuration } from '../../utils/formatters';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { EmptyState, PageTabs, PageToolbar, ToolbarHost, ToolbarSearch, type TabDef } from '../ui';
import { TestingOverview } from '../testing/TestingOverview';
import { QueryDetailsModal, type RunLogEntry } from '../testing/QueryDetailsModal';
import { TimeRangeBar } from '../TimeRangeBar';
import { useTimeWindow } from '../../hooks/useTimeWindow';
import { ClientFolderNotice } from '../ClientFolderNotice';
import { CHECK_ROW_SELECTION, CHECK_SELECTION_COLUMN, LAST_RUN_HIDDEN_COLUMNS, checkLeadColumns, lastRunColumns, runTargets, silenceFor, useSilences, type CheckRowHandlers, type Severity } from '../checks/model';
import { HistoryBars, RunChecksButton, SeverityPill, ResultMark } from '../checks/cells';
import { SilenceDialog } from '../checks/SilenceDialog';
import { GRID_OVERLAYS } from '../gridOverlays';
import { GridColumnSelector } from '../GridColumnSelector';
import { InTabsRight } from '../ui';
import { useHiddenColumns } from '../../hooks/useHiddenColumns';

ModuleRegistry.registerModules([AllCommunityModule]);

type TestingTab = 'overview' | 'checks';
const TESTING_TABS: TabDef<TestingTab>[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'checks', label: 'Checks', icon: ListChecks },
];

interface MyQuery {
  filename: string;
  title?: string;
  query: string;
  description?: string;
  severity?: Severity;
  category?: string;
  history?: { time: string; duration: number; rows: number | null; status?: RunStatus }[];
  // From -- warn_duration_ms: / -- fail_duration_ms: in the header
  warnDurationMs?: number | null;
  failDurationMs?: number | null;
  lastRunTime: string | null;
  // Last stored result (manual or scheduled run), so failures survive a reload
  lastStatus?: RunStatus | null;
  lastError?: string | null;
  lastDuration: number | null;
  lastRowCount: number | null;
  avgRunTime: number | null;
  avgRowCount: number | null;
  slowestRunTime: number | null;
  fastestRunTime: number | null;
  runCount: number;
}

const querySearchText = (q: MyQuery) => `${q.title ?? ''}\n${q.filename}\n${q.query}`;

// ok, warn (over warn_duration_ms), fail (over fail_duration_ms) or error
type RunStatus = 'ok' | 'warn' | 'fail' | 'error';
const STATUS_LABEL: Record<RunStatus, string> = { ok: 'Passed', warn: 'Slow', fail: 'Too slow', error: 'Error' };

// Result of the latest run: this session's if it ran here, else the stored one
type RunResult = { status: RunStatus; error?: string };
const storedResult = (q: MyQuery): RunResult | null =>
  q.lastStatus ? { status: q.lastStatus, error: q.lastError || undefined } : null;

export function MyQueriesPage() {
  const gridTheme = useGridTheme();
  const [queries, setQueries] = useState<MyQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningQuery, setRunningQuery] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ filename: string; rowCount: number; duration: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<MyQuery | null>(null);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [runAllProgress, setRunAllProgress] = useState<{ current: number; total: number } | null>(null);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [runLogLoading, setRunLogLoading] = useState(false);
  const [queryStatus, setQueryStatus] = useState<Record<string, RunResult>>({});
  const [selectedQueries, setSelectedQueries] = useState<MyQuery[]>([]);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [compareEntries, setCompareEntries] = useState<QueryLogEntry[]>([]);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedQuery) {
        setSelectedQuery(null);
        setRunLog([]);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedQuery]);

  // Fetch run log when modal opens
  useEffect(() => {
    if (!selectedQuery) {
      setRunLog([]);
      return;
    }
    setRunLogLoading(true);
    fetch(`/api/my-queries/run-log/${encodeURIComponent(selectedQuery.filename)}`)
      .then(res => res.json())
      .then(data => setRunLog(data.runLog || []))
      .catch(() => setRunLog([]))
      .finally(() => setRunLogLoading(false));
  }, [selectedQuery]);

  const fetchQueries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/my-queries');
      if (!res.ok) throw new Error('Failed to fetch queries');
      const data = await res.json();
      setQueries(data.queries || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoadMessage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueries();
  }, [fetchQueries]);

  const [tab, setTab] = useState<TestingTab>('overview');
  const { silences, silence, unsilence } = useSilences('testing');
  const [silenceTarget, setSilenceTarget] = useState<MyQuery | null>(null);
  const silenceOf = useCallback((q: MyQuery) => silenceFor(silences, q.filename), [silences]);

  // Experiment and last-run filters plus free-text search, like the other list screens
  const filterFields = useMemo((): ClientFilterField<MyQuery>[] => [
    { field: 'category', label: 'Category', getValue: q => q.category || 'Uncategorised' },
    { field: 'severity', label: 'Severity', getValue: q => q.severity || 'info' },
    { field: 'silenced', label: 'Silenced', getValue: q => (silenceOf(q) ? 'Silenced' : 'Not silenced') },
    {
      field: 'status',
      label: 'Last Run',
      getValue: (q) => {
        const status = queryStatus[q.filename] ?? storedResult(q);
        if (status) return STATUS_LABEL[status.status];
        return 'Never run';
      },
    },
  ], [queryStatus, silenceOf]);
  const queryFilters = useClientFilters(queries, filterFields, querySearchText);
  // Window and grouping for the Overview's runs-over-time chart
  const win = useTimeWindow('1440');
  const filteredQueries = queryFilters.filtered;

  const runQuery = useCallback(async (query: MyQuery, skipRefresh = false) => {
    setRunningQuery(query.filename);
    if (!skipRefresh) {
      setLastResult(null);
      setError(null);
    }
    try {
      const res = await fetch('/api/my-queries/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: query.filename, query: query.query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to run query');

      // Update just the affected row instead of refetching all data
      if (data.stats) {
        setQueries(prev => prev.map(q =>
          q.filename === query.filename
            ? { ...q, ...data.stats }
            : q
        ));
      }

      if (!skipRefresh) {
        setLastResult({
          filename: query.filename,
          rowCount: data.rowCount,
          duration: data.duration,
        });
      }
      const status: RunStatus = data.status || 'ok';
      setQueryStatus(prev => ({ ...prev, [query.filename]: { status, error: data.detail || undefined } }));
      return { status, duration: data.duration, rowCount: data.rowCount };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (!skipRefresh) {
        setError(errorMsg);
      }
      setQueryStatus(prev => ({ ...prev, [query.filename]: { status: 'error', error: errorMsg } }));
      return { status: 'error' as const, error: errorMsg };
    } finally {
      setRunningQuery(null);
    }
  }, []);

  const resetStats = useCallback(async () => {
    try {
      const res = await fetch('/api/my-queries/stats', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to reset stats');
      setLastResult(null);
      setLoadMessage('All run statistics have been reset');
      await fetchQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [fetchQueries]);

  const runAllQueries = useCallback(async () => {
    const targets = runTargets(selectedQueries, filteredQueries, q => !!silenceOf(q));
    if (runningAll || targets.length === 0) return;
    setRunningAll(true);
    setError(null);
    setLastResult(null);
    setLoadMessage(null);
    const total = targets.length;
    const counts: Record<RunStatus, number> = { ok: 0, warn: 0, fail: 0, error: 0 };

    for (let i = 0; i < targets.length; i++) {
      setRunAllProgress({ current: i + 1, total });
      const result = await runQuery(targets[i], true);
      counts[result.status]++;
    }

    setRunAllProgress(null);
    setRunningAll(false);
    // No need to fetchQueries - each runQuery already updates its row
    setLoadMessage(`Completed ${total} queries: ${counts.ok} passed, ${counts.warn} slow, ${counts.fail} too slow, ${counts.error} errors`);
  }, [runningAll, selectedQueries, filteredQueries, silenceOf, runQuery]);

  const StatusRenderer = useCallback((params: ICellRendererParams<MyQuery>) => {
    const status = params.data ? queryStatus[params.data.filename] ?? storedResult(params.data) : null;
    if (!status) return <ResultMark result="none" />;
    if (status.status === 'ok') return <ResultMark result="pass" title="Last run passed" />;
    if (status.status === 'error') return <ResultMark result="error" title={status.error || 'Query failed'} />;
    return <ResultMark result={status.status} title={status.error || STATUS_LABEL[status.status]} />;
  }, [queryStatus]);

  const handleCloseModal = useCallback(() => {
    setSelectedQuery(null);
    setRunLog([]);
  }, []);

  const handleAnalyseQuery = useCallback(() => {
    if (!selectedQuery) return;
    // Use the global function exposed by App.tsx to open the query editor
    const openQueryEditor = (window as unknown as { openQueryEditor?: (query: string) => void }).openQueryEditor;
    if (openQueryEditor) {
      openQueryEditor(selectedQuery.query);
      handleCloseModal();
    }
  }, [selectedQuery, handleCloseModal]);

  // Handle row selection for comparison
  const onSelectionChanged = useCallback((event: SelectionChangedEvent<MyQuery>) => {
    const selectedRows = event.api.getSelectedRows();
    setSelectedQueries(selectedRows);
  }, []);

  // Fetch latest run logs for selected queries to compare
  const handleCompareQueries = useCallback(async () => {
    if (selectedQueries.length < 2) return;

    try {
      setLoading(true);
      // Fetch latest run log for each selected query
      const runLogPromises = selectedQueries.slice(0, 10).map(q =>
        fetch(`/api/my-queries/run-log/${encodeURIComponent(q.filename)}`)
          .then(res => res.json())
          .then(data => ({
            query: q,
            runLog: data.runLog || []
          }))
      );

      const results = await Promise.all(runLogPromises);

      // Convert to QueryLogEntry format - use latest run from each query
      const entries: QueryLogEntry[] = results
        .filter(r => r.runLog.length > 0 && r.runLog[0].queryLog)
        .map(r => {
          const latestRun = r.runLog[0];
          const queryLog = latestRun.queryLog!;
          return {
            query_id: queryLog.query_id,
            query: r.query.query,
            query_duration_ms: queryLog.query_duration_ms,
            read_rows: queryLog.read_rows,
            read_bytes: queryLog.read_bytes,
            result_rows: queryLog.result_rows,
            result_bytes: queryLog.result_bytes,
            memory_usage: queryLog.memory_usage,
            ProfileEvents: queryLog.ProfileEvents || {},
            Settings: {},
          };
        });

      if (entries.length < 2) {
        setError('Not enough queries with run history to compare. Please run the queries first.');
        return;
      }

      setCompareEntries(entries);
      setCompareModalOpen(true);
    } catch {
      setError('Failed to fetch run logs for comparison');
    } finally {
      setLoading(false);
    }
  }, [selectedQueries]);

  // Comparator for time columns (sorts by numeric millisecond value)
  const timeComparator = useCallback((valueA: number | null, valueB: number | null) => {
    // Handle null values
    if (valueA === null && valueB === null) return 0;
    if (valueA === null) return -1;
    if (valueB === null) return 1;
    return valueA - valueB;
  }, []);

  const checkHandlers = useMemo((): CheckRowHandlers<MyQuery> => ({
    onView: q => setSelectedQuery(q),
    onRun: q => void runQuery(q),
    isRunning: q => runningQuery === q.filename,
    runBlocked: runningQuery !== null || runningAll,
    silenceOf,
    onSilence: q => setSilenceTarget(q),
    onUnsilence: sil => void unsilence(sil.id),
  }), [runQuery, runningQuery, runningAll, silenceOf, unsilence]);

  const columnDefs = useMemo((): ColDef<MyQuery>[] => {
    const timeCol = (headerName: string, field: keyof MyQuery, width = 85): ColDef<MyQuery> => ({
      headerName, field, width, sortable: true, comparator: timeComparator,
      valueFormatter: (params) => formatDuration(params.value), cellStyle: { textAlign: 'right', color: '#86efac' },
    });
    return [
      ...checkLeadColumns(checkHandlers),
      { headerName: 'Title', colId: 'title', width: 280, sortable: true, cellStyle: { color: '#f3f4f6' },
        valueGetter: p => p.data?.title || p.data?.filename.replace(/\.sql$/, '') || '', tooltipValueGetter: p => p.data?.description || '' },
      // Default sort lives here: a grid initialState would drop the column pinning
      { headerName: 'File', field: 'filename', width: 240, sortable: true, sort: 'asc', cellStyle: { color: '#93c5fd' } },
      { headerName: 'Category', colId: 'category', width: 140, sortable: true, valueGetter: p => p.data?.category || '' },
      { headerName: 'Severity', colId: 'severity', width: 95, sortable: true, valueGetter: p => p.data?.severity || 'info',
        cellRenderer: (p: ICellRendererParams<MyQuery>) => <SeverityPill severity={p.value as Severity} /> },
      ...lastRunColumns<MyQuery>(q => q.lastRunTime),
      {
        headerName: 'History', colId: 'history', width: 135, sortable: false,
        cellRenderer: (p: ICellRendererParams<MyQuery>) => (
          <div className="h-full flex items-center">
            <HistoryBars bars={(p.data?.history || []).map(h => ({
              time: h.time, value: h.duration, tone: h.status ?? 'ok',
              label: h.status === 'error' ? 'error' : `${h.status === 'warn' || h.status === 'fail' ? `${STATUS_LABEL[h.status].toLowerCase()}, ` : ''}${formatDuration(h.duration)}, ${h.rows ?? 0} rows`,
            }))} />
          </div>
        ),
      },
      timeCol('Last Time', 'lastDuration'),
      { headerName: 'Last Rows', field: 'lastRowCount', width: 85, sortable: true, cellStyle: { textAlign: 'right', color: '#86efac' },
        valueFormatter: (params) => params.value != null ? params.value.toLocaleString() : '-' },
      timeCol('Avg Time', 'avgRunTime'),
      timeCol('Fastest', 'fastestRunTime', 80),
      timeCol('Slowest', 'slowestRunTime', 80),
      timeCol('Warn At', 'warnDurationMs', 80),
      timeCol('Fail At', 'failDurationMs', 80),
      { headerName: 'Runs', field: 'runCount', width: 60, sortable: true, cellStyle: { textAlign: 'right', color: '#86efac' } },
      {
        headerName: 'Description', colId: 'description', flex: 1, minWidth: 220, sortable: false,
        // Falls back to the query itself, minus its header comments
        valueGetter: p => p.data?.description || (p.data?.query || '').replace(/^(--[^\n]*\n)+/, '').replace(/\s+/g, ' ').slice(0, 200),
        cellStyle: p => ({ color: p.data?.description ? '#d1d5db' : '#6b7280' }),
        tooltipValueGetter: p => p.data?.description || p.data?.query || '',
      },
      // Always visible at the right edge, like the row actions on the left
      { headerName: 'Status', colId: 'status', width: 80, sortable: false, pinned: 'right', lockPinned: true, cellRenderer: StatusRenderer },
    ];
  }, [checkHandlers, StatusRenderer, timeComparator]);

  // Columns the viewer chose to hide (Configure columns)
  const columnPrefs = useHiddenColumns('performance-checks', LAST_RUN_HIDDEN_COLUMNS);
  const shownColumnDefs = useMemo(() => columnPrefs.applyHidden(columnDefs), [columnPrefs, columnDefs]);

  const NoQueriesOverlay = useCallback(() => (
    queries.length === 0
      ? <EmptyState compact icon={FileCode} title="No queries" />
      : <EmptyState compact icon={FileCode} title="No queries match the filters" />
  ), [queries.length]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    suppressAutoSize: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  const failed = useMemo(() => Object.fromEntries(
    queries
      .map(q => [q.filename, queryStatus[q.filename] ?? storedResult(q)] as const)
      .filter(([, st]) => st && (st.status === 'fail' || st.status === 'error'))
      .map(([f, st]) => [f, st!.error || 'Query failed']),
  ), [queries, queryStatus]);

  return (
    <div className="h-full flex flex-col">
      <ToolbarHost>
      <PageTabs tabs={TESTING_TABS} active={tab} onChange={setTab} />
      {/* Filter bar, shared by the Overview and Checks tabs */}
      <PageToolbar
        left={<>
          <ClientFilterPanel
            rows={queries}
            fields={filterFields}
            filters={queryFilters.filters}
            onChange={queryFilters.setFilter}
            onClearAll={queryFilters.clearAll}
          />
          {tab === 'overview' && <TimeRangeBar {...win.barProps} />}
          <ToolbarSearch value={queryFilters.search} onChange={queryFilters.setSearch} placeholder="Search filename or query..." />
        </>}
        right={<>
          <span className="text-xs text-gray-400">
            <span className="text-white font-medium">{filteredQueries.length}</span>
            {filteredQueries.length !== queries.length && ` of ${queries.length}`} {queries.length === 1 ? 'query' : 'queries'}
          </span>
          {queryFilters.activeCount > 0 && (
            <span className="text-xs text-blue-400">
              {queryFilters.activeCount} filter{queryFilters.activeCount > 1 ? 's' : ''} active
            </span>
          )}
          {tab === 'checks' && <>
          {selectedQueries.length >= 2 ? (
            <button
              onClick={handleCompareQueries}
              className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs"
            >
              <GitCompare className="w-3.5 h-3.5" />
              Compare ({Math.min(selectedQueries.length, 10)})
            </button>
          ) : null}
          <RunChecksButton selected={selectedQueries.length} running={runningAll} progress={runAllProgress}
            disabled={loading || runningQuery !== null} onClick={runAllQueries} />
          <button
            onClick={resetStats}
            disabled={loading || runningAll || runningQuery !== null}
            className="flex items-center gap-1.5 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          </>}
        </>}
      />

      <ClientFolderNotice kind="performance" onlyProblems className="mx-1.5 mt-3" />

      {tab === 'overview' ? (
        <TestingOverview queries={filteredQueries} win={win} onZoom={win.zoomTo} failed={failed} silenced={q => !!silenceOf(q)} onView={setSelectedQuery} onOpenChecks={() => setTab('checks')} />
      ) : (<>

      {/* Status Bar */}
      {(error || lastResult || loadMessage) && <div className={`mx-1.5 mt-1.5 px-3 py-2 rounded text-xs ${
        error ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300'
      }`}>
        {error ? (
          <div className="break-words whitespace-pre-wrap">Error: {error}</div>
        ) : lastResult ? (
          <span>
            Ran <strong>{lastResult.filename}</strong>: {lastResult.rowCount} rows in {formatDuration(lastResult.duration)}
          </span>
        ) : loadMessage ? (
          <span>{loadMessage}</span>
        ) : null}
      </div>}

      {/* Grid */}
      <div className="flex-1 mx-1.5 mb-4 mt-3 bg-gray-900 border border-gray-700 rounded overflow-hidden">
        <InTabsRight><GridColumnSelector columns={columnDefs} hidden={columnPrefs.hidden} onToggle={columnPrefs.toggle} /></InTabsRight>
        <AgGridReact<MyQuery> {...GRID_OVERLAYS}
          theme={gridTheme}
          rowData={filteredQueries}
          columnDefs={shownColumnDefs}
          defaultColDef={defaultColDef}
          loading={loading}
          animateRows={false}
          suppressCellFocus={true}
          enableCellTextSelection={true}
          tooltipShowDelay={300}
          tooltipInteraction={true}
          suppressColumnVirtualisation={true}
          noRowsOverlayComponent={NoQueriesOverlay}
          getRowId={(params) => params.data.filename}
          rowSelection={CHECK_ROW_SELECTION}
          selectionColumnDef={CHECK_SELECTION_COLUMN}
          onSelectionChanged={onSelectionChanged}
        />
      </div>
      </>)}
      </ToolbarHost>

      {selectedQuery && (
        <QueryDetailsModal query={selectedQuery} runLog={runLog} runLogLoading={runLogLoading} onClose={handleCloseModal}
          onAnalyse={handleAnalyseQuery} onRun={() => void runQuery(selectedQuery)} runDisabled={runningQuery !== null} />
      )}

      {/* Query Compare Modal */}
      {compareModalOpen && compareEntries.length > 0 && (
        <QueryCompareModal
          entries={compareEntries}
          onClose={() => {
            setCompareModalOpen(false);
            setCompareEntries([]);
          }}
        />
      )}

      {silenceTarget && (
        <SilenceDialog
          title={`Silence ${silenceTarget.filename}`}
          note="A silenced query is skipped by Run all until the silence ends. You can still run it on its own."
          onClose={() => setSilenceTarget(null)}
          onSave={async (until, reason) => {
            try { await silence(silenceTarget.filename, until, reason); return true; }
            catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
          }}
        />
      )}
    </div>
  );
}
