import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, SelectionChangedEvent } from 'ag-grid-community';
import { Play, RotateCcw, Eye, X, Copy, Check, ExternalLink, BarChart2, GitCompare, Bell, VolumeX } from 'lucide-react';
import { QueryCompareModal } from '../QueryCompareModal';
import { QueryResultsModal } from '../QueryResultsModal';
import type { QueryLogEntry } from '../../types/queryLog';
import { formatBytes, formatDateTime, formatDuration } from '../../utils/formatters';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { EmptyState, PageToolbar, ToolbarSearch, LoadingState, Pill } from '../ui';
import { ClientFolderNotice } from '../ClientFolderNotice';
import {
  api, channelMeta, silenceFor, type Act, type AlertRule, type Channel, type Silence, type Severity, type EvalState,
} from '../alerting/model';
import { Sparkline } from '../alerting/widgets';
import { CHECK_ROW_SELECTION, CHECK_SELECTION_COLUMN, LAST_RUN_HIDDEN_COLUMNS, checkLeadColumns, lastRunColumns, runTargets, type CheckRowHandlers } from '../checks/model';
import { RunChecksButton, SeverityPill, ResultMark } from '../checks/cells';
import { GRID_OVERLAYS } from '../gridOverlays';
import { GridColumnSelector } from '../GridColumnSelector';
import { InTabsRight } from '../ui';
import { useHiddenColumns } from '../../hooks/useHiddenColumns';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Alert {
  filename: string;
  title?: string;
  query: string;
  description?: string;
  category?: string;
  lastRunTime: string | null;
  lastDuration: number | null;
  lastRowCount: number | null;
  avgRunTime: number | null;
  slowestRunTime: number | null;
  fastestRunTime: number | null;
  runCount: number;
}

interface QueryLogInfo {
  query_id: string;
  type: string;
  query_duration_ms: number;
  read_rows: number;
  read_bytes: number;
  result_rows: number;
  result_bytes: number;
  memory_usage: number;
  ProfileEvents: Record<string, number>;
}

interface RunLogEntry {
  queryId: string;
  runTime: string;
  duration: number;
  rowCount: number;
  readRows: number | null;
  readBytes: number | null;
  queryLog: QueryLogInfo | null;
}

// Each .sql check carries its alerting rule (severity, condition,
// channels, ...), keyed by filename. Cells read rules from the grid context.
interface ChecksContext {
  rules: Map<string, AlertRule>;
  channels: Channel[];
  silences: Silence[];
  act: Act;
  onSilence: (check: string) => void;
}

const ruleOf = (p: { data?: Alert; context: ChecksContext }) => (p.data ? p.context.rules.get(p.data.filename) : undefined);

interface AlertsPageProps {
  rules: AlertRule[];
  channels: Channel[];
  silences: Silence[];
  act: Act;
  onChanged: () => void;
  onSilence: (check: string) => void;
}

const alertSearchText = (a: Alert) => `${a.title ?? ''}\n${a.filename}\n${a.query}\n${a.description ?? ''}`;

// Checks and their rules are loaded from the client folder in the repo, so
// this grid is read-only: run, inspect, compare and silence only.
export function AlertsPage({ rules, channels, silences, act, onChanged, onSilence }: AlertsPageProps) {
  const gridTheme = useGridTheme();
  const rulesByCheck = useMemo(() => new Map(rules.map(r => [r.check, r])), [rules]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAlert, setRunningAlert] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ filename: string; rowCount: number; duration: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [queryCopied, setQueryCopied] = useState(false);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [runAllProgress, setRunAllProgress] = useState<{ current: number; total: number } | null>(null);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [runLogLoading, setRunLogLoading] = useState(false);
  const [selectedAlerts, setSelectedAlerts] = useState<Alert[]>([]);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [compareEntries, setCompareEntries] = useState<QueryLogEntry[]>([]);
  const [resultsAlert, setResultsAlert] = useState<Alert | null>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedAlert) {
        setSelectedAlert(null);
        setQueryCopied(false);
        setRunLog([]);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedAlert]);

  useEffect(() => {
    if (!selectedAlert) {
      setRunLog([]);
      return;
    }
    setRunLogLoading(true);
    fetch(`/api/alerts/run-log/${encodeURIComponent(selectedAlert.filename)}`)
      .then(res => res.json())
      .then(data => setRunLog(data.runLog || []))
      .catch(() => setRunLog([]))
      .finally(() => setRunLogLoading(false));
  }, [selectedAlert]);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/alerts');
      if (!res.ok) throw new Error('Failed to fetch alerts');
      const data = await res.json();
      setAlerts(data.alerts || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoadMessage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  // Reload the file list when checks are created or deleted
  const checkSet = rules.map(r => r.check).join();
  const reloadQuietly = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts');
      if (res.ok) setAlerts((await res.json()).alerts || []);
    } catch {
      // keep the current list; the next change will retry
    }
  }, []);
  const firstCheckSet = useRef(checkSet);
  useEffect(() => {
    if (checkSet !== firstCheckSet.current) void reloadQuietly();
  }, [checkSet, reloadQuietly]);

  const filterFields = useMemo((): ClientFilterField<Alert>[] => {
    const rule = (a: Alert) => rulesByCheck.get(a.filename);
    return [
      { field: 'state', label: 'Last result', getValue: a => rule(a)?.lastResult?.state || 'not evaluated' },
      { field: 'severity', label: 'Severity', getValue: a => rule(a)?.severity },
      { field: 'category', label: 'Category', getValue: a => rule(a)?.category || a.category || 'Uncategorised' },
      { field: 'channels', label: 'Channel', getValue: a => {
        const ids = rule(a)?.channels || [];
        return ids.length ? ids.map(id => channels.find(c => c.id === id)?.name || id) : ['none'];
      } },
      { field: 'custom', label: 'Source', getValue: a => (rule(a)?.custom ? 'custom' : 'bundled') },
      { field: 'documented', label: 'Description', getValue: a => (a.description ? 'Has description' : 'No description') },
    ];
  }, [rulesByCheck, channels]);

  const alertFilters = useClientFilters(alerts, filterFields, alertSearchText);
  const filteredAlerts = alertFilters.filtered;

  const runAlert = useCallback(async (alert: Alert, skipRefresh = false) => {
    setRunningAlert(alert.filename);
    if (!skipRefresh) {
      setLastResult(null);
      setError(null);
    }
    try {
      // Evaluating the rule records the run (timings, run log) and opens or
      // resolves incidents, so a manual run behaves exactly like a scheduled one.
      const data = await api<{ lastResult: { rowCount: number | null; duration: number } | null; lastError: string | null }>(
        'POST', `/rules/${encodeURIComponent(alert.filename)}/evaluate`);
      if (data.lastError) throw new Error(data.lastError);
      const rowCount = data.lastResult?.rowCount ?? 0;
      const duration = data.lastResult?.duration ?? 0;

      if (!skipRefresh) {
        setLastResult({ filename: alert.filename, rowCount, duration });
        await reloadQuietly();
        onChanged();
      }
      return { success: true, duration, rowCount };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (!skipRefresh) setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setRunningAlert(null);
    }
  }, [reloadQuietly, onChanged]);

  const resetStats = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts/stats', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to reset stats');
      setLastResult(null);
      setLoadMessage('All run statistics have been reset');
      await fetchAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [fetchAlerts]);

  const runAllAlerts = useCallback(async () => {
    const targets = runTargets(selectedAlerts, filteredAlerts, a => !!silenceFor(silences, a.filename));
    if (runningAll || targets.length === 0) return;
    setRunningAll(true);
    setError(null);
    setLastResult(null);
    setLoadMessage(null);
    const total = targets.length;
    let firingCount = 0;
    let failCount = 0;

    for (let i = 0; i < targets.length; i++) {
      setRunAllProgress({ current: i + 1, total });
      const result = await runAlert(targets[i], true);
      if (!result.success) {
        failCount++;
      } else if ((result.rowCount ?? 0) > 0) {
        firingCount++;
      }
    }

    setRunAllProgress(null);
    setRunningAll(false);
    await reloadQuietly();
    onChanged();
    setLoadMessage(`Completed: ${firingCount} firing, ${failCount} errors out of ${total} alerts`);
  }, [runningAll, selectedAlerts, filteredAlerts, silences, runAlert, reloadQuietly, onChanged]);

  const handleCopyQuery = useCallback(async () => {
    if (!selectedAlert) return;
    await navigator.clipboard.writeText(selectedAlert.query);
    setQueryCopied(true);
    setTimeout(() => setQueryCopied(false), 2000);
  }, [selectedAlert]);

  const handleCloseModal = useCallback(() => {
    setSelectedAlert(null);
    setQueryCopied(false);
    setRunLog([]);
  }, []);

  const handleAnalyseQuery = useCallback(() => {
    if (!selectedAlert) return;
    const openQueryEditor = (window as unknown as { openQueryEditor?: (query: string) => void }).openQueryEditor;
    if (openQueryEditor) {
      openQueryEditor(selectedAlert.query);
      handleCloseModal();
    }
  }, [selectedAlert, handleCloseModal]);

  const onSelectionChanged = useCallback((event: SelectionChangedEvent<Alert>) => {
    const selectedRows = event.api.getSelectedRows();
    setSelectedAlerts(selectedRows);
  }, []);

  const handleCompareAlerts = useCallback(async () => {
    if (selectedAlerts.length < 2) return;

    try {
      setLoading(true);
      const runLogPromises = selectedAlerts.slice(0, 10).map(a =>
        fetch(`/api/alerts/run-log/${encodeURIComponent(a.filename)}`)
          .then(res => res.json())
          .then(data => ({ alert: a, runLog: data.runLog || [] }))
      );

      const results = await Promise.all(runLogPromises);
      const entries: QueryLogEntry[] = results
        .filter(r => r.runLog.length > 0 && r.runLog[0].queryLog)
        .map(r => {
          const latestRun = r.runLog[0];
          const queryLog = latestRun.queryLog!;
          return {
            query_id: queryLog.query_id,
            query: r.alert.query,
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
        setError('Not enough alerts with run history to compare. Please run them first.');
        return;
      }

      setCompareEntries(entries);
      setCompareModalOpen(true);
    } catch {
      setError('Failed to fetch run logs for comparison');
    } finally {
      setLoading(false);
    }
  }, [selectedAlerts]);

  const timeComparator = useCallback((valueA: number | null, valueB: number | null) => {
    if (valueA === null && valueB === null) return 0;
    if (valueA === null) return -1;
    if (valueB === null) return 1;
    return valueA - valueB;
  }, []);

  const checkHandlers = useMemo((): CheckRowHandlers<Alert> => ({
    onView: a => setSelectedAlert(a),
    onRun: a => void runAlert(a),
    isRunning: a => runningAlert === a.filename,
    runBlocked: runningAlert !== null || runningAll,
    silenceOf: a => silenceFor(silences, a.filename) ?? null,
    onSilence: a => onSilence(a.filename),
    onUnsilence: sil => void act(() => api('DELETE', `/silences/${encodeURIComponent(sil.id)}`), `Unsilenced ${sil.check || 'all checks'}`),
  }), [runAlert, runningAlert, runningAll, silences, onSilence, act]);

  const columnDefs = useMemo((): ColDef<Alert>[] => {
    return [
      ...checkLeadColumns(checkHandlers),
      {
        headerName: 'Title',
        colId: 'title',
        width: 300,
        sortable: true,
        valueGetter: (p) => p.data?.title || p.data?.filename.replace(/\.sql$/, '') || '',
        tooltipValueGetter: (params) => params.data?.description || '',
        cellRenderer: (p: ICellRendererParams<Alert, string, ChecksContext>) => {
          const r = ruleOf(p);
          return (
            <span className="flex items-center gap-1.5 text-gray-100">
              <span className="truncate">{p.value}</span>
              {r?.custom && <Pill tone="blue">custom</Pill>}
              {p.data && silenceFor(p.context.silences, p.data.filename) && <span title="Silenced"><VolumeX className="w-3 h-3 text-yellow-400 shrink-0" /></span>}
            </span>
          );
        },
      },
      // Default sort lives here: a grid initialState would drop the column pinning
      { headerName: 'File', field: 'filename', width: 240, sortable: true, sort: 'asc', cellStyle: { color: '#93c5fd' } },
      { headerName: 'Category', colId: 'category', width: 130, valueGetter: (p) => ruleOf(p as never)?.category || p.data?.category || '' },
      {
        headerName: 'Severity',
        colId: 'severity',
        width: 95,
        valueGetter: (p) => ruleOf(p as never)?.severity ?? '',
        cellRenderer: (p: ICellRendererParams) => <SeverityPill severity={p.value as Severity} />,
      },
      ...lastRunColumns<Alert>(a => a.lastRunTime, { cellStyle: { color: '#fca5a5' } }),
      {
        headerName: 'History',
        colId: 'history',
        width: 140,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Alert, unknown, ChecksContext>) => {
          const r = ruleOf(p);
          return r && <div className="h-full flex items-center"><Sparkline history={r.history} /></div>;
        },
      },
      {
        headerName: 'Condition',
        colId: 'condition',
        width: 100,
        valueGetter: (p) => {
          const r = ruleOf(p as never);
          return r ? `rows ${r.operator} ${r.threshold}` : '';
        },
        cellStyle: { color: '#93c5fd' },
      },
      {
        headerName: 'For',
        colId: 'forMinutes',
        width: 60,
        valueGetter: (p) => ruleOf(p as never)?.forMinutes ?? null,
        valueFormatter: (p) => (p.value == null ? '' : p.value ? `${p.value}m` : 'now'),
      },
      {
        headerName: 'Notify',
        colId: 'channels',
        width: 100,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Alert, unknown, ChecksContext>) => {
          const ids = ruleOf(p)?.channels || [];
          return (
            <div className="flex items-center gap-1 h-full">
              {ids.map(id => {
                const c = p.context.channels.find(ch => ch.id === id);
                if (!c) return null;
                const Icon = channelMeta[c.type].icon;
                return <span key={id} title={c.name} className={c.enabled ? 'text-gray-400' : 'text-gray-600'}><Icon className="w-3.5 h-3.5" /></span>;
              })}
              {!ids.length && <span className="text-gray-600 text-[11px]">none</span>}
            </div>
          );
        },
      },
      {
        headerName: 'Last Time',
        field: 'lastDuration',
        width: 90,
        sortable: true,
        valueFormatter: (params) => formatDuration(params.value),
        comparator: timeComparator,
        cellStyle: { textAlign: 'right', color: '#86efac' },
      },
      {
        headerName: 'Avg Time',
        field: 'avgRunTime',
        width: 90,
        sortable: true,
        valueFormatter: (params) => formatDuration(params.value),
        comparator: timeComparator,
        cellStyle: { textAlign: 'right', color: '#86efac' },
      },
      {
        headerName: 'Runs',
        field: 'runCount',
        width: 60,
        sortable: true,
        cellStyle: { textAlign: 'right', color: '#86efac' },
      },
      {
        headerName: 'Description',
        field: 'description',
        flex: 1,
        minWidth: 250,
        sortable: false,
        cellStyle: { color: '#d1d5db' },
        tooltipValueGetter: (params) => (params.value as string) || '',
        valueFormatter: (params) => {
          const d = (params.value as string) ?? '';
          if (!d) return '';
          const oneLine = d.replace(/\s+/g, ' ').trim();
          return oneLine.length > 140 ? oneLine.substring(0, 140) + '...' : oneLine;
        },
      },
      {
        headerName: 'Last Error',
        colId: 'lastError',
        width: 200,
        valueGetter: (p) => ruleOf(p as never)?.lastError ?? '',
        tooltipValueGetter: (p) => (p.value as string) || '',
        cellStyle: { color: '#f87171' },
      },
      // Always visible at the right edge, like the row actions on the left
      {
        headerName: 'Status',
        colId: 'state',
        width: 110,
        pinned: 'right',
        lockPinned: true,
        valueGetter: (p) => ruleOf(p as never)?.lastResult?.state ?? '',
        cellRenderer: (p: ICellRendererParams<Alert, unknown, ChecksContext>) => {
          const res = ruleOf(p)?.lastResult;
          if (!res) return <ResultMark result="none" title="Not evaluated yet" />;
          return (
            <span className="flex items-center gap-1.5">
              <ResultMark result={({ ok: 'pass', firing: 'fail', pending: 'pending', error: 'error' } as const)[res.state as EvalState]} title={res.state} />
              {res.rowCount !== null && <span className="text-gray-400">{res.rowCount} rows</span>}
            </span>
          );
        },
      },
    ];
  }, [checkHandlers, timeComparator]);

  const gridContext: ChecksContext = { rules: rulesByCheck, channels, silences, act, onSilence };
  // Columns the viewer chose to hide (Configure columns)
  const columnPrefs = useHiddenColumns('monitoring-checks', LAST_RUN_HIDDEN_COLUMNS);
  const shownColumnDefs = useMemo(() => columnPrefs.applyHidden(columnDefs), [columnPrefs, columnDefs]);

  // Rule cells read from the grid context, so force a redraw when rules, silences or channels change
  const gridRef = useRef<AgGridReact<Alert>>(null);
  useEffect(() => { gridRef.current?.api?.refreshCells({ force: true }); }, [rules, silences, channels]);

  const NoAlertsOverlay = useCallback(() => (
    alerts.length === 0
      ? <EmptyState compact icon={Bell} title="No monitoring checks" />
      : <EmptyState compact icon={Bell} title="No checks match the filters" />
  ), [alerts.length]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    suppressAutoSize: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <PageToolbar
        left={<>
          <ClientFilterPanel
            rows={alerts}
            fields={filterFields}
            filters={alertFilters.filters}
            onChange={alertFilters.setFilter}
            onClearAll={alertFilters.clearAll}
          />
          <ToolbarSearch value={alertFilters.search} onChange={alertFilters.setSearch} placeholder="Search filename, query or description..." />
        </>}
        right={<>
          <span className="text-xs text-gray-400">
            <span className="text-white font-medium">{filteredAlerts.length}</span>
            {filteredAlerts.length !== alerts.length && ` of ${alerts.length}`} {alerts.length === 1 ? 'check' : 'checks'}
          </span>
          {alertFilters.activeCount > 0 && (
            <span className="text-xs text-blue-400">
              {alertFilters.activeCount} filter{alertFilters.activeCount > 1 ? 's' : ''} active
            </span>
          )}
          {selectedAlerts.length >= 2 ? (
            <button
              onClick={handleCompareAlerts}
              className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs"
            >
              <GitCompare className="w-3.5 h-3.5" />
              Compare ({Math.min(selectedAlerts.length, 10)})
            </button>
          ) : null}
          <RunChecksButton selected={selectedAlerts.length} running={runningAll} progress={runAllProgress}
            disabled={loading || runningAlert !== null} onClick={runAllAlerts} />
          <button
            onClick={resetStats}
            disabled={loading || runningAll || runningAlert !== null}
            className="flex items-center gap-1.5 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </>}
      />

      <ClientFolderNotice kind="monitoring" onlyProblems className="mx-1.5 mt-3" />
      <ClientFolderNotice kind="alerts" onlyProblems className="mx-1.5 mt-1.5" />

      <InTabsRight><GridColumnSelector columns={columnDefs} hidden={columnPrefs.hidden} onToggle={columnPrefs.toggle} /></InTabsRight>

      {/* Status Bar */}
      {(error || lastResult || loadMessage) && <div className={`mx-1.5 mt-1.5 px-3 py-2 rounded text-xs ${
        error ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300'
      }`}>
        {error ? (
          <div className="break-words whitespace-pre-wrap">Error: {error}</div>
        ) : lastResult ? (
          <span>
            Ran <strong>{lastResult.filename}</strong>: {lastResult.rowCount} rows in {formatDuration(lastResult.duration)}
            {lastResult.rowCount > 0 && <span className="ml-2 text-orange-300">— FIRING</span>}
          </span>
        ) : loadMessage ? (
          <span>{loadMessage}</span>
        ) : null}
      </div>}

      {/* Grid */}
      <div className="flex-1 mx-1.5 mb-4 mt-3 bg-gray-900 border border-gray-700 rounded overflow-hidden">
        <AgGridReact<Alert> {...GRID_OVERLAYS}
          ref={gridRef}
          context={gridContext}
          theme={gridTheme}
          rowData={filteredAlerts}
          columnDefs={shownColumnDefs}
          defaultColDef={defaultColDef}
          loading={loading}
          animateRows={false}
          suppressCellFocus={true}
          enableCellTextSelection={true}
          tooltipShowDelay={300}
          tooltipInteraction={true}
          suppressColumnVirtualisation={true}
          noRowsOverlayComponent={NoAlertsOverlay}
          getRowId={(params) => params.data.filename}
          rowSelection={CHECK_ROW_SELECTION}
          selectionColumnDef={CHECK_SELECTION_COLUMN}
          onSelectionChanged={onSelectionChanged}
        />
      </div>

      {/* Alert Details Modal */}
      {selectedAlert && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[1350px] max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Alert Details</h2>
                <p className="text-xs text-gray-400 font-mono">{selectedAlert.filename}</p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Description */}
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-gray-400 mb-1">Description</h3>
                {selectedAlert.description ? (
                  <pre className="bg-gray-800 p-3 rounded text-xs text-gray-200 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
                    {selectedAlert.description}
                  </pre>
                ) : (
                  <EmptyState compact title="No description" />
                )}
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-gray-400">Query</h3>
                    <button
                      onClick={handleCopyQuery}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                      title="Copy query"
                    >
                      {queryCopied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      {queryCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAnalyseQuery}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Analyse Query
                    </button>
                  </div>
                </div>
                <pre className="bg-gray-800 p-3 rounded text-xs text-blue-400 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                  {selectedAlert.query}
                </pre>
              </div>

              {/* Run Statistics */}
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-gray-400 mb-2">Run Statistics</h3>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Total Runs</div>
                    <div className="text-sm font-semibold text-white">{selectedAlert.runCount}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Last Run</div>
                    <div className="text-sm font-semibold text-white">{formatDateTime(selectedAlert.lastRunTime)}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Last Duration</div>
                    <div className="text-sm font-semibold text-blue-400">{formatDuration(selectedAlert.lastDuration)}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Last Rows</div>
                    <div className="text-sm font-semibold text-blue-400">{selectedAlert.lastRowCount?.toLocaleString() ?? '-'}</div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Average Time</div>
                    <div className="text-sm font-semibold text-green-400">{formatDuration(selectedAlert.avgRunTime)}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Fastest Time</div>
                    <div className="text-sm font-semibold text-green-400">{formatDuration(selectedAlert.fastestRunTime)}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Slowest Time</div>
                    <div className="text-sm font-semibold text-red-400">{formatDuration(selectedAlert.slowestRunTime)}</div>
                  </div>
                  <div className="bg-gray-800 p-2 rounded">
                    <div className="text-xs text-gray-400">Avg Row Count</div>
                    <div className="text-sm font-semibold text-cyan-400">-</div>
                  </div>
                </div>
              </div>

              {/* Run Log */}
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-gray-400 mb-2">Run Log</h3>
                {runLogLoading ? (
                  <LoadingState label="Loading run log…" compact />
                ) : runLog.length === 0 ? (
                  <EmptyState compact title="No runs recorded" />
                ) : (
                  <div className="bg-gray-800 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-700 text-gray-300">
                          <th className="px-2 py-1.5 text-left font-medium">Query ID</th>
                          <th className="px-2 py-1.5 text-left font-medium">Run Time</th>
                          <th className="px-2 py-1.5 text-right font-medium">Duration</th>
                          <th className="px-2 py-1.5 text-right font-medium">Rows</th>
                          <th className="px-2 py-1.5 text-right font-medium">Read Rows</th>
                          <th className="px-2 py-1.5 text-right font-medium">Read Bytes</th>
                          <th className="px-2 py-1.5 text-right font-medium">Memory</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runLog.map((entry, idx) => (
                          <tr key={entry.queryId || idx} className="border-t border-gray-700 hover:bg-gray-750">
                            <td className="px-2 py-1.5 font-mono text-[10px]" title={entry.queryId}>
                              {entry.queryId ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => {
                                      const navigateToQueryId = (window as unknown as { navigateToQueryId?: (queryId: string) => void }).navigateToQueryId;
                                      if (navigateToQueryId) {
                                        handleCloseModal();
                                        navigateToQueryId(entry.queryId);
                                      }
                                    }}
                                    className="text-blue-400 hover:text-blue-300 hover:underline"
                                  >
                                    {entry.queryId.substring(0, 16) + '...'}
                                  </button>
                                  <button
                                    onClick={() => navigator.clipboard.writeText(entry.queryId)}
                                    className="text-gray-500 hover:text-gray-300 p-0.5"
                                    title="Copy query ID"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : '-'}
                            </td>
                            <td className="px-2 py-1.5 text-gray-300">{formatDateTime(entry.runTime)}</td>
                            <td className="px-2 py-1.5 text-right text-green-400">{formatDuration(entry.duration)}</td>
                            <td className="px-2 py-1.5 text-right text-gray-300">{entry.rowCount?.toLocaleString() ?? '-'}</td>
                            <td className="px-2 py-1.5 text-right text-gray-300">
                              {(entry.readRows ?? entry.queryLog?.read_rows)?.toLocaleString() ?? '-'}
                            </td>
                            <td className="px-2 py-1.5 text-right text-gray-300">
                              {formatBytes(entry.readBytes ?? entry.queryLog?.read_bytes)}
                            </td>
                            <td className="px-2 py-1.5 text-right text-gray-300">
                              {formatBytes(entry.queryLog?.memory_usage)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2">
                {runLog.filter(e => e.queryId).length > 0 && (
                  <button
                    onClick={() => {
                      const queryIds = runLog.filter(e => e.queryId).map(e => e.queryId);
                      const navigateToQueryIds = (window as unknown as { navigateToQueryIds?: (queryIds: string[]) => void }).navigateToQueryIds;
                      if (navigateToQueryIds) {
                        handleCloseModal();
                        navigateToQueryIds(queryIds);
                      }
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-white text-xs"
                  >
                    <BarChart2 className="w-3.5 h-3.5" />
                    Analyse Results ({runLog.filter(e => e.queryId).length})
                  </button>
                )}
                <button
                  onClick={() => {
                    setResultsAlert(selectedAlert);
                    handleCloseModal();
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-white text-xs"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Run and view results
                </button>
                <button
                  onClick={() => {
                    runAlert(selectedAlert);
                    handleCloseModal();
                  }}
                  disabled={runningAlert !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-3.5 h-3.5" />
                  Run Alert
                </button>
              </div>
            </div>
          </div>
        </div>
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

      {/* Run + Results Modal */}
      {resultsAlert && (
        <QueryResultsModal
          filename={resultsAlert.filename}
          query={resultsAlert.query}
          description={resultsAlert.description}
          runEndpoint="/api/alerts/run"
          onClose={() => setResultsAlert(null)}
        />
      )}
    </div>
  );
}
