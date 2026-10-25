import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { CheckCircle2, XCircle, History } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { formatNumber, formatDateTime } from '../../utils/formatters';
import { Pill, EmptyState } from '../ui';
import { fmtMs } from './model';
import type { RunSummary } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

export function HistoryView({ rows, selected, onToggle }: {
  rows: RunSummary[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const gridTheme = useGridTheme();
  const gridRef = useRef<AgGridReact<RunSummary>>(null);
  // ag-grid's context is initial-only, so hand it a ref. Column defs stay stable
  // (keeping the user's sort) and only the checkbox cells re-render on change.
  const selection = useRef({ selected, onToggle });
  useEffect(() => {
    selection.current = { selected, onToggle };
    gridRef.current?.api?.refreshCells({ columns: ['select'], force: true });
  }, [selected, onToggle]);

  const columns = useMemo((): ColDef<RunSummary>[] => [
    {
      headerName: '', colId: 'select', width: 44, sortable: false, resizable: false,
      cellRenderer: (p: { data?: RunSummary; context: typeof selection }) => p.data && (
        <input type="checkbox" checked={p.context.current.selected.has(p.data.id)} onChange={() => p.context.current.onToggle(p.data!.id)} title="Select for comparison" />
      ),
    },
    {
      headerName: 'Result', field: 'passed', width: 90,
      cellRenderer: (p: { value: boolean }) => (p.value ? <Pill tone="green"><CheckCircle2 className="w-3 h-3" />PASS</Pill> : <Pill tone="red"><XCircle className="w-3 h-3" />FAIL</Pill>),
    },
    { headerName: 'Status', field: 'status', width: 100, cellStyle: p => ({ color: p.value === 'stopped' ? '#fbbf24' : '#9ca3af' }) },
    { headerName: 'Scenario', field: 'scenario', flex: 1, minWidth: 180, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Pattern', field: 'pattern', width: 90 },
    { headerName: 'Started', field: 'startedAt', width: 175, valueFormatter: p => formatDateTime(p.value), sort: 'desc' },
    { headerName: 'Duration', field: 'durationSec', width: 90, type: 'numericColumn', valueFormatter: p => `${p.value}s` },
    { headerName: 'Peak VUs', field: 'peakVus', width: 90, type: 'numericColumn' },
    { headerName: 'Queries', field: 'totalQueries', width: 100, type: 'numericColumn', valueFormatter: p => formatNumber(p.value) },
    { headerName: 'Avg QPS', field: 'avgQps', width: 90, type: 'numericColumn', cellStyle: { color: '#93c5fd' } },
    { headerName: 'p50', field: 'p50', width: 80, type: 'numericColumn', valueFormatter: p => fmtMs(p.value), cellStyle: { color: '#86efac' } },
    {
      headerName: 'p95', field: 'p95', width: 80, type: 'numericColumn', valueFormatter: p => fmtMs(p.value),
      cellStyle: p => ({ color: p.data && p.value > p.data.p95ThresholdMs ? '#f87171' : '#86efac' }),
    },
    { headerName: 'p99', field: 'p99', width: 80, type: 'numericColumn', valueFormatter: p => fmtMs(p.value), cellStyle: { color: '#fbbf24' } },
    {
      headerName: 'Errors', field: 'errorPct', width: 80, type: 'numericColumn', valueFormatter: p => `${p.value}%`,
      cellStyle: p => ({ color: p.data && p.value > p.data.errorThresholdPct ? '#f87171' : '#9ca3af' }),
    },
    {
      headerName: 'Breaches', colId: 'breaches', width: 90, type: 'numericColumn', valueGetter: p => p.data?.breaches.length ?? 0,
      tooltipValueGetter: p => p.data?.breaches.join('\n') || undefined, cellStyle: p => ({ color: p.value ? '#f87171' : '#9ca3af' }),
    },
  ], []);

  return (
    <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
      {rows.length === 0 ? (
        <EmptyState icon={History} title="No runs" />
      ) : (
        <AgGridReact<RunSummary> {...GRID_OVERLAYS} ref={gridRef} theme={gridTheme} rowData={rows} context={selection} columnDefs={columns} suppressCellFocus tooltipShowDelay={300}
          getRowId={p => p.data.id} defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }} />
      )}
    </div>
  );
}
