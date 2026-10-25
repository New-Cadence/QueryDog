// Data Quality checks grid, laid out like the other SQL check runners
// (see ../checks): view, silence and run per row, Run all / Run selected.
import { useCallback, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams, SelectionChangedEvent } from 'ag-grid-community';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { EmptyState, PageToolbar, Pill, ToolbarSearch } from '../ui';
import { formatNumber } from '../../utils/formatters';
import {
  isBinaryRule, ruleState, ruleFields, ruleSearchText,
  type DqActions, type Rule, type Severity,
} from './model';
import { ComplianceBar, StatusPill } from './widgets';
import { CHECK_ROW_SELECTION, CHECK_SELECTION_COLUMN, LAST_RUN_HIDDEN_COLUMNS, checkLeadColumns, lastRunColumns, runTargets, silenceFor, useSilences, type CheckRowHandlers } from '../checks/model';
import { HistoryBars, RunChecksButton, SeverityPill } from '../checks/cells';
import { SilenceDialog } from '../checks/SilenceDialog';
import { GRID_OVERLAYS } from '../gridOverlays';
import { GridColumnSelector } from '../GridColumnSelector';
import { InTabsRight } from '../ui';
import { useHiddenColumns } from '../../hooks/useHiddenColumns';

interface GridContext { actions: DqActions; now: number }

export function RulesTab({ rules, actions }: { rules: Rule[]; actions: DqActions }) {
  const gridTheme = useGridTheme();
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rules, ruleFields, ruleSearchText);
  const [selected, setSelected] = useState<string[]>([]);
  const [now] = useState(() => Date.now());
  const { silences, silence, unsilence } = useSilences('dataquality');
  const [silenceTarget, setSilenceTarget] = useState<Rule | null>(null);

  const silenceOf = useCallback((r: Rule) => silenceFor(silences, r.id), [silences]);
  const checkHandlers = useMemo((): CheckRowHandlers<Rule> => ({
    onView: r => actions.openRule(r.id),
    onRun: r => void actions.runRules({ ids: [r.id] }, r.name),
    isRunning: r => actions.isRunning(r.id),
    silenceOf,
    onSilence: r => setSilenceTarget(r),
    onUnsilence: sil => void unsilence(sil.id),
  }), [actions, silenceOf, unsilence]);

  const cols = useMemo((): ColDef<Rule>[] => [
    ...checkLeadColumns(checkHandlers),
    // Title from the file's `-- title:` header (served as the rule name)
    { headerName: 'Title', field: 'name', sort: 'asc', width: 280, cellStyle: { color: '#f3f4f6' }, tooltipValueGetter: p => p.data?.description || p.data?.name },
    { headerName: 'File', colId: 'file', width: 240, valueGetter: p => p.data?.file || (p.data ? `${p.data.id}.sql` : ''), cellStyle: { color: '#93c5fd' } },
    { headerName: 'Category', colId: 'category', width: 130, valueGetter: p => p.data?.category || '' },
    {
      headerName: 'Severity', field: 'severity', width: 95,
      cellRenderer: (p: ICellRendererParams<Rule>) => <SeverityPill severity={p.value as Severity} />,
    },
    ...lastRunColumns<Rule>(r => r.lastRun?.time, {}, c => (c as GridContext).now),
    {
      headerName: 'History', width: 135, sortable: false,
      cellRenderer: (p: ICellRendererParams<Rule>) => (
        <div className="h-full flex items-center">
          <HistoryBars bars={(p.data?.history || []).map(h => ({
            time: h.time,
            value: h.status === 'pass' ? 1 : Math.max(1, h.failing ?? 1),
            tone: h.status === 'error' ? 'error' : h.status === 'fail' ? 'fail' : 'ok',
            label: h.status === 'error' ? 'error' : `${h.status}${h.failing ? `, ${formatNumber(h.failing)} failing` : ''}`,
          }))} />
        </div>
      ),
    },
    { headerName: 'Dataset', width: 200, valueGetter: p => (p.data ? `${p.data.database}.${p.data.table}` : '') },
    {
      headerName: 'Compliance', width: 160, valueGetter: p => p.data?.lastRun?.compliance ?? null,
      cellRenderer: (p: ICellRendererParams<Rule>) => <ComplianceBar value={p.value as number | null} />,
    },
    {
      headerName: 'Failing', width: 90, type: 'rightAligned', valueGetter: p => p.data?.lastRun?.failing ?? null,
      valueFormatter: p => formatNumber(p.value), cellStyle: p => (p.value ? { color: '#f87171' } : null),
    },
    { headerName: 'Rows', width: 85, type: 'rightAligned', valueGetter: p => (p.data && !isBinaryRule(p.data) ? p.data.lastRun?.total ?? null : null), valueFormatter: p => formatNumber(p.value) },
    { headerName: 'Runs', width: 65, type: 'rightAligned', valueGetter: p => p.data?.history.length ?? 0 },
    { headerName: 'Description', field: 'description', flex: 1, minWidth: 220, cellStyle: { color: '#d1d5db' }, tooltipField: 'description' },
    // Always visible at the right edge, like the row actions on the left
    {
      headerName: 'Status', colId: 'status', width: 100, pinned: 'right', lockPinned: true, valueGetter: p => (p.data ? ruleState(p.data) : ''),
      cellRenderer: (p: ICellRendererParams<Rule, unknown, GridContext>) => p.data && (
        p.context.actions.isRunning(p.data.id)
          ? <Pill tone="blue"><Loader2 className="w-3 h-3 animate-spin" />running</Pill>
          : <StatusPill state={ruleState(p.data)} title={p.data.lastRun?.error || p.data.lastRun?.detail || undefined} />
      ),
    },
  ], [checkHandlers]);

  // Columns the viewer chose to hide (Configure columns)
  const columnPrefs = useHiddenColumns('dataquality-checks', LAST_RUN_HIDDEN_COLUMNS);
  const shownCols = useMemo(() => columnPrefs.applyHidden(cols), [columnPrefs, cols]);

  const context: GridContext = { actions, now };
  const [running, setRunning] = useState(false);
  // The ticked checks, else every check shown that isn't silenced
  const runChecks = async () => {
    const targets = runTargets(rules.filter(r => selected.includes(r.id)), filtered, r => !!silenceOf(r));
    if (!targets.length) return;
    setRunning(true);
    await actions.runRules({ ids: targets.map(r => r.id) }, `${targets.length} checks`);
    setRunning(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={rules} fields={ruleFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search checks..." />
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">{filtered.length} checks</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
            <RunChecksButton selected={selected.length} running={running} onClick={() => void runChecks()} disabled={!filtered.length} />
          </>
        }
      />
      <InTabsRight><GridColumnSelector columns={cols} hidden={columnPrefs.hidden} onToggle={columnPrefs.toggle} /></InTabsRight>
      <div className="flex-1 mx-1.5 mt-3 mb-4 bg-gray-900 border border-gray-700 rounded overflow-hidden flex flex-col">
        {rules.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No data quality checks" />
        ) : (
          <AgGridReact<Rule> {...GRID_OVERLAYS}
            theme={gridTheme} rowData={filtered} columnDefs={shownCols} context={context} suppressCellFocus getRowId={p => p.data.id}
            rowSelection={CHECK_ROW_SELECTION}
            selectionColumnDef={CHECK_SELECTION_COLUMN}
            onSelectionChanged={(e: SelectionChangedEvent<Rule>) => setSelected(e.api.getSelectedRows().map(r => r.id))}
            tooltipShowDelay={300} defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }}
          />
        )}
      </div>
      {silenceTarget && (
        <SilenceDialog
          title={`Silence ${silenceTarget.name}`}
          note="A silenced check is skipped by Run all until the silence ends. You can still run it on its own."
          onClose={() => setSilenceTarget(null)}
          onSave={(until, reason) => actions.act(() => silence(silenceTarget.id, until, reason), `Silenced ${silenceTarget.name}`)}
        />
      )}
    </div>
  );
}
