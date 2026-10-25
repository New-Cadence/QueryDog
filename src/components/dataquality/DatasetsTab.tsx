// Per-table scorecard: quality score, rule results and dimension coverage for
// every monitored table, plus (optionally) the tables with no rules yet.
import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { Database, Play, Sparkles, X, Loader2 } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { EmptyState, LoadingState, PageToolbar, Panel, Pill, StatCard, ToolbarButton, ToolbarSearch } from '../ui';
import { formatNumber } from '../../utils/formatters';
import {
  buildDatasets, DIMENSIONS, formatAgo, formatPct, ruleState, ruleTarget, RULE_TYPES, scoreTone, severityTone,
  type CatalogTable, type Dataset, type DqActions, type Rule,
} from './model';
import { ComplianceBar, StatusPill } from './widgets';
import { GRID_OVERLAYS } from '../gridOverlays';

const datasetFields: ClientFilterField<Dataset>[] = [
  { field: 'database', label: 'Database' },
  { field: 'health', label: 'Health', getValue: d => (!d.monitored ? 'unmonitored' : d.fail ? 'failing' : d.error ? 'errors' : d.pass ? 'passing' : 'not run') },
  { field: 'dimensions', label: 'Covers dimension', getValue: d => d.dimensions },
];
const datasetSearch = (d: Dataset) => d.key;

interface GridContext { now: number }

export function DatasetsTab({ rules, catalog, selected, onSelect, actions }: {
  rules: Rule[];
  catalog: CatalogTable[] | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
  actions: DqActions;
}) {
  const gridTheme = useGridTheme();
  const [includeUnmonitored, setIncludeUnmonitored] = useState(false);
  const [now] = useState(() => Date.now());
  const datasets = useMemo(() => buildDatasets(rules, catalog, includeUnmonitored), [rules, catalog, includeUnmonitored]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(datasets, datasetFields, datasetSearch);
  const current = datasets.find(d => d.key === selected) || buildDatasets(rules, catalog, true).find(d => d.key === selected) || null;

  const cols = useMemo((): ColDef<Dataset>[] => [
    { headerName: 'Dataset', field: 'key', flex: 1, minWidth: 220, cellStyle: { color: '#f3f4f6' } },
    {
      headerName: 'Score', field: 'score', width: 175, sort: 'asc',
      cellRenderer: (p: ICellRendererParams<Dataset>) => (p.data?.monitored ? <ComplianceBar value={p.value as number | null} width="w-16" /> : <span className="text-gray-500">unmonitored</span>),
    },
    { headerName: 'Checks', width: 75, type: 'rightAligned', valueGetter: p => (p.data?.monitored ? p.data.rules.length : null), valueFormatter: p => (p.value === null ? '-' : String(p.value)) },
    { headerName: 'Pass', field: 'pass', width: 70, type: 'rightAligned', cellStyle: p => (p.value ? { color: '#4ade80' } : null) },
    { headerName: 'Fail', field: 'fail', width: 70, type: 'rightAligned', cellStyle: p => (p.value ? { color: '#f87171' } : null) },
    { headerName: 'Errors', field: 'error', width: 75, type: 'rightAligned', cellStyle: p => (p.value ? { color: '#fbbf24' } : null) },
    { headerName: 'Row compliance', field: 'compliance', width: 130, type: 'rightAligned', valueFormatter: p => formatPct(p.value, 2) },
    {
      headerName: 'Dimensions', width: 230, sortable: false, valueGetter: p => p.data?.dimensions.length ?? 0,
      cellRenderer: (p: ICellRendererParams<Dataset>) => (
        <div className="h-full flex items-center gap-0.5">
          {DIMENSIONS.slice(0, 6).map(d => (
            <span key={d} title={`${d}${p.data?.dimensions.includes(d) ? ' covered' : ' not covered'}`}
              className={`w-6 text-center text-[9px] rounded ${p.data?.dimensions.includes(d) ? 'bg-blue-900/50 text-blue-300' : 'bg-gray-800 text-gray-600'}`}>
              {d.slice(0, 3)}
            </span>
          ))}
        </div>
      ),
    },
    { headerName: 'Rows', field: 'totalRows', width: 85, type: 'rightAligned', valueFormatter: p => formatNumber(p.value) },
    { headerName: 'Last run', field: 'lastRun', width: 95, valueFormatter: p => formatAgo(p.value as string, (p.context as GridContext).now) },
  ], []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={datasets} fields={datasetFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search tables..." />
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={includeUnmonitored} onChange={e => setIncludeUnmonitored(e.target.checked)} />
              Show tables without checks
            </label>
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">{filtered.length} datasets</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
          </>
        }
      />
      <div className="flex-1 flex gap-3 mx-1.5 mt-3 mb-4 min-h-0">
        <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden flex flex-col">
          {datasets.length === 0 ? (
            includeUnmonitored && !catalog ? <LoadingState label="Loading tables…" /> : (
              <EmptyState icon={Database} title="No monitored datasets" />
            )
          ) : (
            <AgGridReact<Dataset> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} context={{ now }} suppressCellFocus getRowId={p => p.data.key}
              onRowClicked={e => e.data && onSelect(e.data.key)} rowStyle={{ cursor: 'pointer' }}
              getRowClass={p => (p.data?.key === selected ? 'ag-row-selected' : '')}
              defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }} />
          )}
        </div>
        {current && <DatasetPanel dataset={current} actions={actions} onClose={() => onSelect(null)} now={now} />}
      </div>
    </div>
  );
}

function DatasetPanel({ dataset: d, actions, onClose, now }: { dataset: Dataset; actions: DqActions; onClose: () => void; now: number }) {
  const running = d.rules.some(r => actions.isRunning(r.id));
  return (
    <Panel title={<span className="font-mono">{d.key}</span>} className="w-[460px] shrink-0" bodyClassName="p-3 overflow-y-auto space-y-3"
      actions={<button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>}>
      <div className="flex flex-wrap gap-1.5">
        <ToolbarButton icon={running ? Loader2 : Play} disabled={running || !d.rules.length}
          onClick={() => void actions.runRules({ database: d.database, table: d.table }, d.key)}>Run table</ToolbarButton>
        <ToolbarButton icon={Sparkles} onClick={actions.openRecommendations}>Suggested checks</ToolbarButton>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Score" value={formatPct(d.score, 0)} tone={scoreTone(d.score)} sub={`${d.pass} of ${d.pass + d.fail} passing`} />
        <StatCard label="Failing" value={d.fail} tone={d.fail ? 'red' : 'default'} sub={d.error ? `${d.error} errors` : d.never ? `${d.never} not run` : undefined} />
        <StatCard label="Rows" value={formatNumber(d.totalRows)} sub={d.lastRun ? `checked ${formatAgo(d.lastRun, now)}` : 'not checked'} />
      </div>
      <div>
        <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Coverage</div>
        <div className="flex flex-wrap gap-1">
          {DIMENSIONS.map(dim => <Pill key={dim} tone={d.dimensions.includes(dim) ? 'blue' : 'default'}>{dim}</Pill>)}
        </div>
      </div>
      <div>
        <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Checks ({d.rules.length})</div>
        {d.rules.length === 0 ? (
          <EmptyState compact title="No checks on this table" />
        ) : (
          <div className="divide-y divide-gray-800 border border-gray-800 rounded">
            {d.rules.map(r => {
              const Icon = RULE_TYPES[r.type].icon;
              return (
                <button key={r.id} onClick={() => actions.openRule(r.id)} className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-gray-800/60 text-left">
                  {actions.isRunning(r.id) ? <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0" /> : <Icon className="w-3 h-3 text-gray-500 shrink-0" />}
                  <span className="text-xs text-gray-200 truncate flex-1" title={r.name}>{r.name}</span>
                  {ruleTarget(r) && <span className="text-[10px] text-gray-500 font-mono truncate max-w-[90px]">{ruleTarget(r)}</span>}
                  <Pill tone={severityTone[r.severity]}>{r.severity[0].toUpperCase()}</Pill>
                  <StatusPill state={ruleState(r)} title={r.lastRun?.error || r.lastRun?.detail || undefined} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
