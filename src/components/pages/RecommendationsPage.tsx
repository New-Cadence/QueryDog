import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, RowClickedEvent, SelectionChangedEvent } from 'ag-grid-community';
import { AlertTriangle, BellOff, CheckCheck, CircleDollarSign, FileDown, FileText, Lightbulb, Loader2, RefreshCw, RotateCcw, Siren, XCircle } from 'lucide-react';
import { RECOMMENDATION_PROVIDERS, type Recommendation, type RecommendationCategory } from '../../recommendations';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { EmptyState, LoadingState, PageTabs, PageToolbar, Pill, StatCard, ToolbarButton, ToolbarSearch } from '../ui';
import { formatDateTime } from '../../utils/formatters';
import { CATEGORY_META, SEVERITY_RANK, SEVERITY_TONE, STATUS_TONE, formatMoney } from '../recommendations/meta';
import {
  effectiveStatus, fetchRecommendations, runRecommendations, setStatus, updateRecommendationStatus,
  type ProviderRun, type StoredRecommendations, type TriageStatus, type TriageStore,
} from '../recommendations/triage';
import { RecommendationDetail, type TriageAction } from '../recommendations/RecommendationDetail';
import { TriageModal } from '../recommendations/TriageModal';
import { exportCsv, exportMarkdown } from '../recommendations/export';
import type { RecommendationRow } from '../recommendations/types';
import { GRID_OVERLAYS } from '../gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

// Picks up results of scheduled runs while the page is open
const POLL_MS = 60_000;

type View = 'active' | 'snoozed' | 'dismissed' | 'resolved' | 'all';

const VIEW_STATUSES: Record<View, TriageStatus[] | null> = {
  active: ['open', 'acknowledged'],
  snoozed: ['snoozed'],
  dismissed: ['dismissed'],
  resolved: ['resolved'],
  all: null,
};

const FILTER_FIELDS: ClientFilterField<RecommendationRow>[] = [
  { field: 'category', label: 'Category', getValue: r => CATEGORY_META[r.category].label },
  { field: 'severity', label: 'Severity' },
  { field: 'status', label: 'Status' },
  { field: 'target', label: 'Target' },
];

const searchText = (r: RecommendationRow) => `${r.title} ${r.detail} ${r.target ?? ''} ${r.impact ?? ''} ${r.id}`;

function SeverityCell({ data }: ICellRendererParams<RecommendationRow>) {
  return data ? <Pill tone={SEVERITY_TONE[data.severity]}>{data.severity}</Pill> : null;
}

function CategoryCell({ data }: ICellRendererParams<RecommendationRow>) {
  if (!data) return null;
  const meta = CATEGORY_META[data.category];
  const Icon = meta.icon;
  return (
    <span className={`flex items-center gap-1.5 ${meta.text}`}>
      <Icon className="w-3.5 h-3.5" />
      {meta.label}
    </span>
  );
}

function StatusCell({ data }: ICellRendererParams<RecommendationRow>) {
  if (!data) return null;
  const title = data.status === 'snoozed' ? `Until ${data.snoozeUntil}` : data.status === 'dismissed' ? data.reason : undefined;
  return <Pill tone={STATUS_TONE[data.status]} title={title}>{data.status}</Pill>;
}

const COLUMNS: ColDef<RecommendationRow>[] = [
  {
    field: 'severity', headerName: 'Severity', width: 100, cellRenderer: SeverityCell,
    comparator: (a: Recommendation['severity'], b: Recommendation['severity']) => SEVERITY_RANK[a] - SEVERITY_RANK[b],
  },
  { field: 'category', headerName: 'Category', width: 140, cellRenderer: CategoryCell },
  { field: 'title', headerName: 'Title', flex: 2, minWidth: 260, tooltipField: 'title' },
  { field: 'target', headerName: 'Target', flex: 1, minWidth: 160, tooltipField: 'target' },
  { field: 'impact', headerName: 'Impact', flex: 1, minWidth: 160, tooltipField: 'impact' },
  {
    field: 'estimatedMonthlySaving', headerName: 'Saving / month', width: 125, type: 'rightAligned',
    valueFormatter: p => (p.value ? formatMoney(p.value) : ''),
  },
  { field: 'status', headerName: 'Status', width: 115, cellRenderer: StatusCell },
  { field: 'firstSeen', headerName: 'First seen', width: 175, valueFormatter: p => formatDateTime(p.value) },
];

export function RecommendationsPage() {
  const gridTheme = useGridTheme();
  const gridRef = useRef<AgGridReact<RecommendationRow>>(null);
  const [envName, setEnvName] = useState('');
  const [store, setStore] = useState<TriageStore>({});
  const [runs, setRuns] = useState<Partial<Record<RecommendationCategory, ProviderRun>>>({});
  // Starts true so the first paint shows the spinner, not the empty state
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('active');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<{ mode: 'snooze' | 'dismiss'; ids: string[] } | null>(null);

  // Everything shown comes from the database: the stored recommendations and
  // how each provider did on the last server run
  const apply = useCallback((data: StoredRecommendations) => {
    setEnvName(data.environment);
    setStore(data.store);
    setRuns(data.lastRun?.details?.providers ?? {});
    setLastRun(data.lastRun ? new Date(data.lastRun.finishedAt) : null);
    setError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await fetchRecommendations());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setRuns(Object.fromEntries(RECOMMENDATION_PROVIDERS.map(p => [p.category, { state: 'running' }])));
    try {
      apply(await runRecommendations());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void load();
    } finally {
      setRunning(false);
    }
  }, [apply, load]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Show the change straight away, save it, and reload if saving fails
  const changeStatus = useCallback((ids: string[], status: TriageStatus, extra: { snoozeUntil?: string; reason?: string } = {}) => {
    setStore(prev => setStatus(prev, ids, status, extra));
    updateRecommendationStatus(ids, status, extra).catch(e => {
      setError(e instanceof Error ? e.message : String(e));
      void load();
    });
  }, [load]);

  const allRows = useMemo<RecommendationRow[]>(() =>
    Object.values(store)
      .map(e => ({ ...e.rec, status: effectiveStatus(e), firstSeen: e.firstSeen, lastSeen: e.lastSeen, snoozeUntil: e.snoozeUntil, reason: e.reason }))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.estimatedMonthlySaving || 0) - (a.estimatedMonthlySaving || 0)),
  [store]);

  const viewCounts = useMemo(() => {
    const counts = {} as Record<View, number>;
    for (const v of Object.keys(VIEW_STATUSES) as View[]) {
      const statuses = VIEW_STATUSES[v];
      counts[v] = statuses ? allRows.filter(r => statuses.includes(r.status)).length : allRows.length;
    }
    return counts;
  }, [allRows]);

  const viewRows = useMemo(() => {
    const statuses = VIEW_STATUSES[view];
    return statuses ? allRows.filter(r => statuses.includes(r.status)) : allRows;
  }, [allRows, view]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(viewRows, FILTER_FIELDS, searchText);

  const stats = useMemo(() => {
    const byCategory: Partial<Record<RecommendationCategory, number>> = {};
    let urgent = 0;
    let savings = 0;
    for (const r of filtered) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      if (r.severity === 'critical' || r.severity === 'high') urgent++;
      savings += r.estimatedMonthlySaving || 0;
    }
    return { byCategory, urgent, critical: filtered.filter(r => r.severity === 'critical').length, savings };
  }, [filtered]);

  const detailRow = detailId ? allRows.find(r => r.id === detailId) : undefined;

  const applyAction = useCallback((action: TriageAction, ids: string[]) => {
    if (!ids.length) return;
    if (action === 'snooze' || action === 'dismiss') {
      setModal({ mode: action, ids });
      return;
    }
    changeStatus(ids, action === 'acknowledge' ? 'acknowledged' : 'open');
    gridRef.current?.api?.deselectAll();
  }, [changeStatus]);

  const confirmModal = (value: string) => {
    if (!modal) return;
    if (modal.mode === 'snooze') changeStatus(modal.ids, 'snoozed', { snoozeUntil: value });
    else changeStatus(modal.ids, 'dismissed', { reason: value });
    setModal(null);
    gridRef.current?.api?.deselectAll();
  };

  const toggleCategory = (c: RecommendationCategory) => {
    const label = CATEGORY_META[c].label;
    const current = filters.category || [];
    setFilter('category', current.includes(label) ? current.filter(v => v !== label) : [...current, label]);
  };

  const onSelectionChanged = useCallback((e: SelectionChangedEvent<RecommendationRow>) => {
    setSelectedIds(e.api.getSelectedRows().map(r => r.id));
  }, []);

  const onRowClicked = useCallback((e: RowClickedEvent<RecommendationRow>) => {
    if (e.data) setDetailId(e.data.id);
  }, []);

  const failed = RECOMMENDATION_PROVIDERS.filter(p => runs[p.category]?.state === 'error').length;
  const tabs = (Object.keys(VIEW_STATUSES) as View[]).map(id => ({
    id,
    label: id === 'active' ? 'Open' : id[0].toUpperCase() + id.slice(1),
    badge: <span className="text-[10px] text-gray-500">{viewCounts[id]}</span>,
  }));

  return (
    <div className="h-full flex flex-col">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={viewRows} fields={FILTER_FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search recommendations..." />
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">
              <span className="text-white font-medium">{filtered.length.toLocaleString()}</span> items
            </span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filter{activeCount > 1 ? 's' : ''} active</span>}
            <span className="text-[11px] text-gray-500 ml-2">
              {running ? 'Running...' : lastRun ? `Last run ${formatDateTime(lastRun.toISOString())}` : 'Not run since the server started'}
            </span>
            <ToolbarButton icon={FileText} onClick={() => exportMarkdown(filtered, envName)} disabled={!filtered.length} title="Export the filtered list as a Markdown report">
              Markdown
            </ToolbarButton>
            <ToolbarButton icon={FileDown} onClick={() => exportCsv(filtered)} disabled={!filtered.length} title="Export the filtered list as CSV">
              CSV
            </ToolbarButton>
            <ToolbarButton icon={running ? Loader2 : RefreshCw} onClick={() => void runNow()} disabled={running} variant="primary"
              title="Run every recommendation check now on the server and store the results">
              Run now
            </ToolbarButton>
          </>
        }
      />
      <PageTabs
        tabs={tabs}
        active={view}
        onChange={setView}
        right={selectedIds.length > 0 && (
          <>
            <span className="text-xs text-gray-400">{selectedIds.length} selected</span>
            <ToolbarButton icon={CheckCheck} onClick={() => applyAction('acknowledge', selectedIds)}>Acknowledge</ToolbarButton>
            <ToolbarButton icon={BellOff} onClick={() => applyAction('snooze', selectedIds)}>Snooze</ToolbarButton>
            <ToolbarButton icon={XCircle} onClick={() => applyAction('dismiss', selectedIds)}>Dismiss</ToolbarButton>
            <ToolbarButton icon={RotateCcw} onClick={() => applyAction('reopen', selectedIds)}>Reopen</ToolbarButton>
          </>
        )}
      />

      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <div className="px-3 py-1.5 rounded text-xs bg-red-900/40 border border-red-800 text-red-300 shrink-0">{error}</div>}
        <div className="grid grid-cols-3 gap-3 shrink-0">
          <StatCard label={view === 'active' ? 'Open' : 'Recommendations'} value={filtered.length.toLocaleString()} icon={Lightbulb} sub={`${allRows.length} tracked in total`} />
          <StatCard label="Critical / High" value={stats.urgent.toLocaleString()} icon={Siren} tone={stats.urgent ? 'red' : 'default'} sub={`${stats.critical} critical`} />
          <StatCard
            label="Potential savings"
            value={stats.savings ? `${formatMoney(stats.savings)}/mo` : '-'}
            icon={CircleDollarSign}
            tone={stats.savings ? 'green' : 'default'}
            sub="Sum of estimated monthly savings"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {RECOMMENDATION_PROVIDERS.map(p => {
            const meta = CATEGORY_META[p.category];
            const Icon = meta.icon;
            const run = runs[p.category];
            const selected = filters.category?.includes(meta.label);
            return (
              <button
                key={p.category}
                onClick={() => toggleCategory(p.category)}
                title={run?.state === 'error' ? `${p.label} failed: ${run.error}` : run?.ms !== undefined ? `${p.label}: ${run.count} found in ${run.ms}ms` : p.label}
                className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                  selected ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-900 hover:bg-gray-800'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${meta.text}`} />
                <span className="text-gray-300">{p.label}</span>
                {run?.state === 'running' ? (
                  <Loader2 className="w-3 h-3 text-gray-500 animate-spin" />
                ) : run?.state === 'error' ? (
                  <span className="flex items-center gap-0.5 text-red-400"><AlertTriangle className="w-3 h-3" />error</span>
                ) : (
                  <span className="text-white font-medium">{stats.byCategory[p.category] || 0}</span>
                )}
              </button>
            );
          })}
          {failed > 0 && <span className="text-[11px] text-red-400 ml-1">{failed} provider{failed > 1 ? 's' : ''} failed (hover for details)</span>}
        </div>

        <div className="flex-1 min-h-0 flex gap-3">
          <div className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded overflow-hidden">
            {loading || (allRows.length === 0 && running) ? (
              <LoadingState label={running ? 'Running recommendation checks…' : 'Loading recommendations…'} />
            ) : allRows.length === 0 ? (
              <EmptyState icon={Lightbulb} title="No recommendations" />
            ) : (
              <AgGridReact<RecommendationRow> {...GRID_OVERLAYS}
                ref={gridRef}
                theme={gridTheme}
                rowData={filtered}
                columnDefs={COLUMNS}
                defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }}
                getRowId={p => p.data.id}
                rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false }}
                onSelectionChanged={onSelectionChanged}
                onRowClicked={onRowClicked}
                rowHeight={30}
                headerHeight={32}
                tooltipShowDelay={500}
                noRowsOverlayComponentParams={{ title: 'No recommendations match the filters' }}
              />
            )}
          </div>
          {detailRow && (
            <RecommendationDetail
              row={detailRow}
              onAction={action => applyAction(action, [detailRow.id])}
              onClose={() => setDetailId(null)}
            />
          )}
        </div>
      </div>

      {modal && (
        <TriageModal
          mode={modal.mode}
          count={modal.ids.length}
          onConfirm={confirmModal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
