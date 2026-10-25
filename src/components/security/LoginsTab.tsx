import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { LogIn, ShieldAlert, Users, Globe, UserX, Loader2 } from 'lucide-react';
import { executeQuery } from '../../services/api';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { formatDateTime, formatNumber, parseServerTime } from '../../utils/formatters';
import { CHART_COLORS } from '../uiTokens';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { TimeRangeBar } from '../TimeRangeBar';
import { TimeSeriesChart } from '../TimeSeriesChart';
import { bucketFloor, bucketLabel, bucketTimes, useTimeWindow, type WindowBucket } from '../../hooks/useTimeWindow';
import { PageToolbar, ToolbarSearch, Panel, StatCard, EmptyState, LoadingState } from '../ui';
import { ListCounts } from './common';
import { GRID_DEFAULT_COL_DEF } from './helpers';
import { systemTableExists, loadLoginStats, displayAddress, INACTIVE_DAYS, type LoginStats } from './activity';
import type { SecurityData } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

const LOGIN_SERIES = [{ key: 'Success', color: CHART_COLORS[1] }, { key: 'Failure', color: CHART_COLORS[4] }];
const INTERVAL: Record<WindowBucket, string> = { minute: '1 MINUTE', hour: '1 HOUR', day: '1 DAY' };

// One row per time bucket x outcome x user x client, so every view on this tab
// is derived from the same filtered rows
interface SessionRow {
  t: string;
  outcome: 'Success' | 'Failure';
  user: string;
  address: string;
  interface: string;
  reason: string;
  events: number;
}

const FIELDS: ClientFilterField<SessionRow>[] = [
  { field: 'outcome', label: 'Outcome' },
  { field: 'user', label: 'User' },
  { field: 'address', label: 'Client address' },
  { field: 'interface', label: 'Interface' },
];

const searchText = (r: SessionRow) => `${r.user} ${r.address} ${r.interface} ${r.reason}`;

async function loadSessionRows(start: number, end: number, bucket: WindowBucket): Promise<SessionRow[]> {
  const query = (reason: string) => `
    SELECT toStartOfInterval(event_time, INTERVAL ${INTERVAL[bucket]}) AS t,
           if(type = 'LoginSuccess', 'Success', 'Failure') AS outcome,
           ifNull(user, '') AS user,
           toString(client_address) AS address,
           toString(interface) AS interface,
           ${reason} AS reason,
           count() AS events
    FROM system.session_log
    WHERE event_time >= fromUnixTimestamp(${Math.floor(start / 1000)}) AND event_time <= fromUnixTimestamp(${Math.ceil(end / 1000)})
      AND type IN ('LoginSuccess', 'LoginFailure')
    GROUP BY t, outcome, user, address, interface
    ORDER BY t
    LIMIT 100000`;
  // failure_reason only exists on newer versions
  const r = await executeQuery(query('any(failure_reason)'), 100000).catch(() => executeQuery(query("''"), 100000));
  return r.data.map(row => ({ ...row, address: displayAddress(String(row.address)), events: Number(row.events) })) as unknown as SessionRow[];
}

interface FailureRow { user: string; address: string; interfaces: string; failures: number; last: string; reason: string }
interface UserActivityRow { user: string; status: string; lastLogin: string | null; daysSince: number | null; logins: number; failures: number }

export function LoginsTab({ data }: { data: SecurityData }) {
  const gridTheme = useGridTheme();
  const [available, setAvailable] = useState<boolean | null>(null);
  const win = useTimeWindow('10080');
  // Coarsened automatically when the range has too many buckets
  const bucket = bucketTimes(win.start, win.end, win.bucket).bucket;
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [stats, setStats] = useState<LoginStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: number, end: number, b: WindowBucket) => {
    setLoading(true);
    setError(null);
    try {
      if (!(await systemTableExists('session_log'))) { setAvailable(false); return; }
      setAvailable(true);
      const [r, s] = await Promise.all([loadSessionRows(start, end, b), loadLoginStats()]);
      setRows(r);
      setStats(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session_log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(win.start, win.end, bucket); }, [load, win.start, win.end, bucket]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);

  // Every bucket in the range, so gaps show as empty rather than being skipped
  const timeline = useMemo(() => {
    const { times } = bucketTimes(win.start, win.end, bucket);
    const index = new Map(times.map((t, i) => [t, i]));
    const out = times.map(t => ({ t, label: bucketLabel(t, bucket), Success: 0, Failure: 0 }));
    for (const r of filtered) {
      const row = out[index.get(bucketFloor(parseServerTime(r.t).getTime(), bucket)) ?? -1];
      if (row) row[r.outcome] += r.events;
    }
    return out;
  }, [filtered, win.start, win.end, bucket]);
  const hasEvents = timeline.some(t => t.Success || t.Failure);

  const failures = useMemo((): FailureRow[] => {
    const byKey = new Map<string, FailureRow & { ifaces: Set<string> }>();
    for (const r of filtered) {
      if (r.outcome !== 'Failure') continue;
      const key = `${r.user}|${r.address}`;
      const f = byKey.get(key) || { user: r.user, address: r.address, interfaces: '', failures: 0, last: r.t, reason: r.reason, ifaces: new Set<string>() };
      f.failures += r.events;
      f.ifaces.add(r.interface);
      if (r.t > f.last) f.last = r.t;
      byKey.set(key, f);
    }
    return [...byKey.values()].map(({ ifaces, ...f }) => ({ ...f, interfaces: [...ifaces].join(', ') })).sort((a, b) => b.failures - a.failures);
  }, [filtered]);

  // Filters other than User narrow the users list to users seen in the matching events
  const narrowed = activeCount - (filters.user ? 1 : 0) > 0 || !!search.trim();
  const userRows = useMemo((): UserActivityRow[] => {
    const last = new Map(stats?.lastLogins.map(l => [l.user, l]) || []);
    const seen = new Map<string, { logins: number; failures: number }>();
    for (const r of filtered) {
      const s = seen.get(r.user) || { logins: 0, failures: 0 };
      if (r.outcome === 'Success') s.logins += r.events; else s.failures += r.events;
      seen.set(r.user, s);
    }
    const covered = stats?.daysCovered ?? 0;
    return data.users
      .filter(u => (narrowed ? seen.has(u.name) : !filters.user || filters.user.includes(u.name)))
      .map(u => {
        const l = last.get(u.name);
        const inactive = l ? l.days_since >= INACTIVE_DAYS : covered >= INACTIVE_DAYS;
        return {
          user: u.name,
          status: inactive ? `Inactive (${INACTIVE_DAYS}d+)` : l ? 'Active' : 'No login recorded',
          lastLogin: l?.last_login ?? null,
          daysSince: l?.days_since ?? null,
          logins: seen.get(u.name)?.logins ?? 0,
          failures: seen.get(u.name)?.failures ?? 0,
        };
      });
  }, [data, stats, filtered, narrowed, filters.user]);

  const failureCols = useMemo((): ColDef<FailureRow>[] => [
    { headerName: 'User tried', field: 'user', width: 130, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Client', field: 'address', width: 140, cellStyle: { color: '#93c5fd' } },
    { headerName: 'Interface', field: 'interfaces', width: 90 },
    { headerName: 'Failures', field: 'failures', width: 90, type: 'rightAligned', sort: 'desc', cellStyle: { color: '#f87171' } },
    { headerName: 'Last failure', field: 'last', width: 175, valueFormatter: p => formatDateTime(p.value) },
    { headerName: 'Reason', field: 'reason', flex: 1, minWidth: 160, tooltipField: 'reason' },
  ], []);

  const userCols = useMemo((): ColDef<UserActivityRow>[] => [
    { headerName: 'User', field: 'user', width: 130, cellStyle: { color: '#f3f4f6', fontWeight: 600 } },
    { headerName: 'Status', field: 'status', width: 140, cellStyle: p => ({ color: p.value === 'Active' ? '#86efac' : p.value?.startsWith('Inactive') ? '#fbbf24' : '#9ca3af' }) },
    { headerName: 'Last login', field: 'lastLogin', width: 175, valueFormatter: p => formatDateTime(p.value) },
    { headerName: 'Days ago', field: 'daysSince', width: 90, type: 'rightAligned', valueFormatter: p => (p.value === null ? '-' : String(p.value)) },
    { headerName: 'Logins', field: 'logins', width: 80, type: 'rightAligned', valueFormatter: p => formatNumber(p.value) },
    { headerName: 'Failures', field: 'failures', width: 80, type: 'rightAligned', valueFormatter: p => formatNumber(p.value), cellStyle: p => ({ color: p.value ? '#f87171' : '#9ca3af' }) },
  ], []);

  if (available === false) {
    return (
      <EmptyState icon={LogIn} title="system.session_log is not enabled on this server">
        Login history needs the session log. Add the following to the server config and restart ClickHouse:
        <pre className="mt-2 text-left font-mono text-[11px] text-gray-400 bg-gray-950 border border-gray-800 rounded p-2">
          {'<session_log>\n  <database>system</database>\n  <table>session_log</table>\n  <flush_interval_milliseconds>7500</flush_interval_milliseconds>\n</session_log>'}
        </pre>
        The table is created on the first login after the restart.
      </EmptyState>
    );
  }

  const totalOk = filtered.reduce((s, r) => s + (r.outcome === 'Success' ? r.events : 0), 0);
  const totalFail = filtered.reduce((s, r) => s + (r.outcome === 'Failure' ? r.events : 0), 0);


  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <TimeRangeBar {...win.barProps} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search users, clients, reasons..." />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
          </>
        }
        right={<ListCounts count={totalOk + totalFail} noun="login events" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <div className="px-3 py-2 rounded text-xs bg-red-900/50 text-red-300 shrink-0">Error: {error}</div>}
        <div className="grid grid-cols-5 gap-3 shrink-0">
          <StatCard label="Successful logins" value={formatNumber(totalOk)} icon={LogIn} tone="green" />
          <StatCard label="Failed logins" value={formatNumber(totalFail)} icon={ShieldAlert} tone={totalFail > 0 ? 'red' : 'default'}
            sub={totalOk + totalFail > 0 ? `${((totalFail / (totalOk + totalFail)) * 100).toFixed(1)}% failure rate` : undefined} />
          <StatCard label="Users seen" value={new Set(filtered.filter(r => r.outcome === 'Success').map(r => r.user)).size} icon={Users} />
          <StatCard label="Client addresses" value={new Set(filtered.map(r => r.address)).size} icon={Globe} />
          <StatCard label={`Inactive ${INACTIVE_DAYS}d+`} value={userRows.filter(u => u.status.startsWith('Inactive')).length} icon={UserX}
            sub={stats && stats.daysCovered < INACTIVE_DAYS ? `log only covers ${stats.daysCovered} days` : 'users without a recent login'} />
        </div>
        <Panel title={`Logins per ${bucket}`} className="h-48 shrink-0" bodyClassName={`p-0 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`}>
          {!hasEvents ? loading ? <LoadingState label="Loading logins…" /> : <EmptyState icon={LogIn} title="No login events in this window" /> : (
            <TimeSeriesChart data={timeline} series={LOGIN_SERIES} chartType={win.chartType} totalLabel="Logins" onBucketClick={i => timeline[i] && win.zoomTo(timeline[i].t)} />
          )}
        </Panel>
        <div className="flex-1 grid grid-cols-2 gap-3 overflow-hidden">
          <Panel title={`Failures by user and client (${failures.length})`} icon={ShieldAlert} bodyClassName="">
            <AgGridReact<FailureRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={failures} columnDefs={failureCols} suppressCellFocus enableCellTextSelection defaultColDef={GRID_DEFAULT_COL_DEF} />
          </Panel>
          <Panel title={`Last login per user (${userRows.length})`} icon={Users} bodyClassName="">
            <AgGridReact<UserActivityRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={userRows} columnDefs={userCols} suppressCellFocus enableCellTextSelection defaultColDef={GRID_DEFAULT_COL_DEF} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
