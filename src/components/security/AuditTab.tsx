import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { History, Loader2 } from 'lucide-react';
import { executeQuery } from '../../services/api';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { formatDateTime, parseServerTime } from '../../utils/formatters';
import { CHART_COLORS } from '../uiTokens';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { TimeRangeBar } from '../TimeRangeBar';
import { TimeSeriesChart } from '../TimeSeriesChart';
import { bucketFloor, bucketLabel, bucketTimes, useTimeWindow } from '../../hooks/useTimeWindow';
import { PageToolbar, ToolbarSearch, Panel, Pill, EmptyState, LoadingState } from '../ui';
import { ListCounts } from './common';
import { GRID_DEFAULT_COL_DEF } from './helpers';
import { systemTableExists, displayAddress } from './activity';
import { GRID_OVERLAYS } from '../gridOverlays';

interface AuditRow {
  event_time: string;
  user: string;
  query: string;
  status: 'OK' | 'Failed';
  exception: string;
  address: string;
  query_id: string;
  action: string;
  objectType: string;
  target: string;
}

const FIELDS: ClientFilterField<AuditRow>[] = [
  { field: 'user', label: 'Changed by' },
  { field: 'action', label: 'Statement' },
  { field: 'objectType', label: 'Object type' },
  { field: 'target', label: 'Target' },
  { field: 'status', label: 'Status' },
];

const searchText = (r: AuditRow) => `${r.user} ${r.query} ${r.target}`;

// Access-control DDL. query_kind covers GRANT/REVOKE; the rest are recognised
// from the statement text because CREATE USER and CREATE TABLE share a kind.
const OBJECT = '(USER|ROLE|ROW POLICY|POLICY|QUOTA|SETTINGS PROFILE|PROFILE|MASKING POLICY)';
const AUDIT_SQL = (start: number, end: number) => `
  SELECT event_time, user, query, if(type = 'QueryFinish', 'OK', 'Failed') AS status,
         exception, toString(address) AS address, query_id
  FROM system.query_log
  WHERE event_time >= fromUnixTimestamp(${Math.floor(start / 1000)}) AND event_time <= fromUnixTimestamp(${Math.ceil(end / 1000)})
    AND type != 'QueryStart'
    AND is_initial_query
    AND (query_kind IN ('Grant', 'Revoke')
      OR match(query, '(?i)^[[:space:]]*(CREATE|ALTER|DROP)[[:space:]]+${OBJECT.replace(/ /g, '[[:space:]]+')}[[:space:]]')
      OR match(query, '(?i)^[[:space:]]*SET[[:space:]]+DEFAULT[[:space:]]+ROLE'))
  ORDER BY event_time_microseconds DESC
  LIMIT 5000`;

const STATEMENT_RE = new RegExp(`^\\s*(GRANT|REVOKE|SET\\s+DEFAULT\\s+ROLE|(?:CREATE|ALTER|DROP)\\s+${OBJECT.replace(/ /g, '\\s+')})\\b`, 'i');

// Best-effort parse of what changed and for whom
function describe(query: string): Pick<AuditRow, 'action' | 'objectType' | 'target'> {
  const m = query.match(STATEMENT_RE);
  const action = (m?.[1] || query.split(/\s+/)[0]).toUpperCase().replace(/\s+/g, ' ');
  if (action === 'GRANT' || action === 'REVOKE') {
    const to = query.match(/\b(?:TO|FROM)\s+(.+?)(?:\s+WITH\s+|\s*$)/i)?.[1] || '';
    const isRole = !/\bON\b/i.test(query.split(/\b(?:TO|FROM)\b/i)[0]);
    return { action, objectType: isRole ? 'ROLE GRANT' : 'PRIVILEGE', target: to.replace(/`/g, '').trim() };
  }
  if (action === 'SET DEFAULT ROLE') {
    return { action, objectType: 'USER', target: (query.match(/\bTO\s+(.+)$/i)?.[1] || '').replace(/`/g, '').trim() };
  }
  const objectType = action.replace(/^(CREATE|ALTER|DROP) /, '');
  const rest = query.replace(STATEMENT_RE, '').replace(/^\s*(IF\s+(NOT\s+)?EXISTS\s+)?(OR\s+REPLACE\s+)?/i, '');
  const name = rest.match(/^\s*(`[^`]+`|\S+)/)?.[1]?.replace(/`/g, '') || '';
  return { action, objectType, target: name };
}

const AUDIT_SERIES = [{ key: 'OK', color: CHART_COLORS[0] }, { key: 'Failed', color: CHART_COLORS[4] }];

export function AuditTab() {
  const gridTheme = useGridTheme();
  const [available, setAvailable] = useState<boolean | null>(null);
  const win = useTimeWindow('43200');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: number, end: number) => {
    setLoading(true);
    setError(null);
    try {
      if (!(await systemTableExists('query_log'))) { setAvailable(false); return; }
      setAvailable(true);
      const r = await executeQuery(AUDIT_SQL(start, end), 5000);
      setRows(r.data.map(row => {
        const q = String(row.query);
        return { ...row, user: String(row.user), address: displayAddress(String(row.address)), ...describe(q) } as unknown as AuditRow;
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load query_log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(win.start, win.end); }, [load, win.start, win.end]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);

  const { timeline, bucket } = useMemo(() => {
    const { times, bucket } = bucketTimes(win.start, win.end, win.bucket);
    const index = new Map(times.map((t, i) => [t, i]));
    const out = times.map(t => ({ t, label: bucketLabel(t, bucket), OK: 0, Failed: 0 }));
    for (const r of filtered) {
      const row = out[index.get(bucketFloor(parseServerTime(r.event_time).getTime(), bucket)) ?? -1];
      if (row) row[r.status]++;
    }
    return { timeline: out, bucket };
  }, [filtered, win.start, win.end, win.bucket]);

  const columnDefs = useMemo((): ColDef<AuditRow>[] => [
    { headerName: 'Time', field: 'event_time', width: 175, valueFormatter: p => formatDateTime(p.value) },
    { headerName: 'Changed by', field: 'user', width: 120, cellStyle: { color: '#fcd34d' } },
    { headerName: 'Statement', field: 'action', width: 160, cellStyle: p => ({ color: p.value?.startsWith('DROP') || p.value === 'REVOKE' ? '#f87171' : '#86efac' }) },
    { headerName: 'Target', field: 'target', width: 150, cellStyle: { color: '#c4b5fd' } },
    {
      headerName: 'Status', field: 'status', width: 80,
      cellRenderer: (p: ICellRendererParams<AuditRow>) => <Pill tone={p.value === 'OK' ? 'green' : 'red'} title={p.data?.exception}>{p.value}</Pill>,
    },
    { headerName: 'SQL', field: 'query', flex: 1, minWidth: 300, tooltipField: 'query', cellStyle: { fontFamily: 'monospace', fontSize: 11 } },
    { headerName: 'Client', field: 'address', width: 120 },
  ], []);

  if (available === false) {
    return (
      <EmptyState icon={History} title="system.query_log is not enabled on this server">
        The access change history is read from the query log. Enable <span className="font-mono">&lt;query_log&gt;</span> in the server config (it is on by default in ClickHouse builds) and restart.
      </EmptyState>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <TimeRangeBar {...win.barProps} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search statements, users..." />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
          </>
        }
        right={<ListCounts count={filtered.length} noun="changes" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <div className="px-3 py-2 rounded text-xs bg-red-900/50 text-red-300 shrink-0">Error: {error}</div>}
        <Panel title={`Access changes per ${bucket}`} className="h-40 shrink-0" bodyClassName={`p-0 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`}>
          {filtered.length === 0 ? loading ? <LoadingState label="Loading access changes…" /> : <EmptyState icon={History} title="No access changes in this window" /> : (
            <TimeSeriesChart data={timeline} series={AUDIT_SERIES} chartType={win.chartType} totalLabel="Changes" onBucketClick={i => timeline[i] && win.zoomTo(timeline[i].t)} />
          )}
        </Panel>
        <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
          <AgGridReact<AuditRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={columnDefs} suppressCellFocus enableCellTextSelection
            defaultColDef={GRID_DEFAULT_COL_DEF} tooltipShowDelay={300} />
        </div>
      </div>
    </div>
  );
}
