import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Download, HardDrive, Users, UsersRound } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { formatBytes, formatNumber } from '../../utils/formatters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { Panel, Pill, ToolbarButton, ToolbarSearch, EmptyState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { CostToolbar, ErrorBox, FilterCounts, InfoBox, Spinner } from './common';
import { axisTick, downloadCsv, gridDefaults, money, pct, rightAlign, tooltipStyle, useCost } from './costContext';
import { storageTable, type CostStatus } from './costApi';
import { BYTES_PER_TB, type CostBasis } from './costBasis';
import { optionalRows, queryRows, useLiveQuery } from './useLiveQuery';
import { databaseComputeSql, internalUsersNote, userComputeSql, type DatabaseCompute, type UserCompute, type Window } from './workload';
import { CostRangeSelector } from './CostTimeline';
import { rangeLabel } from './costRange';
import { sumGroups } from './usage';
import type { CloudData } from './useCloudData';
import { GRID_OVERLAYS } from '../gridOverlays';


interface ShowbackRow {
  type: 'database' | 'user';
  name: string;
  bytes: number | null;
  queries: number;
  cpu_s: number;
  storageShare: number | null;
  computeShare: number;
  storageCost: number | null;
  computeCost: number | null;
  total: number | null;
}

async function loadAttribution(status: CostStatus, window: Window) {
  const [storage, byDb, byUser] = await Promise.all([
    queryRows<{ database: string; bytes: number }>(`SELECT database, sum(bytes_on_disk) AS bytes FROM ${storageTable(status, 'parts')} WHERE active GROUP BY database`),
    optionalRows<DatabaseCompute>(databaseComputeSql(status, window)),
    optionalRows<UserCompute>(userComputeSql(status, window)),
  ]);
  return { storage, byDb, byUser };
}

function buildRows(data: Awaited<ReturnType<typeof loadAttribution>>, basis: CostBasis | null): ShowbackRow[] {
  const totalBytes = data.storage.reduce((s, d) => s + d.bytes, 0);
  const dbCpu = (data.byDb || []).reduce((s, d) => s + d.cpu_s, 0);
  const userCpu = (data.byUser || []).reduce((s, d) => s + d.cpu_s, 0);
  const compute = basis?.computeMonthly ?? null;
  // Cloud bills the warehouse's storage directly; otherwise price bytes at $/TB
  const storageCostOf = (bytes: number) =>
    basis?.storageMonthly != null ? (totalBytes ? (bytes / totalBytes) * basis.storageMonthly : 0) : (bytes / BYTES_PER_TB) * (basis?.storageTbMonth ?? 0);

  const dbNames = new Set([...data.storage.map(d => d.database), ...(data.byDb || []).map(d => d.database)]);
  const dbRows = [...dbNames].map((name): ShowbackRow => {
    const bytes = data.storage.find(d => d.database === name)?.bytes ?? 0;
    const c = data.byDb?.find(d => d.database === name);
    const computeShare = dbCpu ? (c?.cpu_s ?? 0) / dbCpu : 0;
    const storageCost = storageCostOf(bytes);
    const computeCost = compute === null ? null : computeShare * compute;
    return {
      type: 'database', name: name || '(no database)', bytes, queries: c?.queries ?? 0, cpu_s: c?.cpu_s ?? 0,
      storageShare: totalBytes ? bytes / totalBytes : 0, computeShare, storageCost, computeCost,
      total: computeCost === null ? storageCost : storageCost + computeCost,
    };
  });
  const userRows = (data.byUser || []).map((u): ShowbackRow => {
    const computeShare = userCpu ? u.cpu_s / userCpu : 0;
    const computeCost = compute === null ? null : computeShare * compute;
    return { type: 'user', name: u.user, bytes: null, queries: u.queries, cpu_s: u.cpu_s, storageShare: null, computeShare, storageCost: null, computeCost, total: computeCost };
  });
  return [...dbRows, ...userRows];
}

const FIELDS: ClientFilterField<ShowbackRow>[] = [
  { field: 'type', label: 'Allocated to' },
  { field: 'name', label: 'Database / user' },
];
const searchText = (r: ShowbackRow) => `${r.type} ${r.name}`;

// Billed Cloud spend over the selected range split across the teams defined in
// Settings > Cost allocation, with unmapped services as "Unallocated".
function TeamAllocation({ cloud }: { cloud: CloudData }) {
  const { settings, view } = useCost();
  const { from, to } = view.range;
  const rows = useMemo(() => {
    const teams = settings.teams ?? [];
    const inRange = cloud.rows.filter(r => r.date >= from && r.date <= to);
    const owner = new Map(teams.flatMap(t => t.services.map(s => [s, t.name] as const)));
    const groups = new Map<string, typeof inRange>();
    for (const r of inRange) {
      const team = (r.serviceId && owner.get(r.serviceId)) || 'Unallocated';
      groups.set(team, [...(groups.get(team) || []), r]);
    }
    const all = sumGroups(inRange).total;
    return [...teams.map(t => t.name), 'Unallocated']
      .map(name => {
        const t = sumGroups(groups.get(name) || []);
        const services = name === 'Unallocated'
          ? new Set((groups.get(name) || []).map(r => r.service)).size
          : teams.find(x => x.name === name)?.services.length ?? 0;
        return { name, services, compute: t.Compute, storage: t.Storage + t.Backup, total: t.total, share: all ? t.total / all : 0 };
      })
      .filter(r => r.name !== 'Unallocated' || r.total > 0);
  }, [cloud.rows, settings.teams, from, to]);

  return (
    <Panel title={`Cost by team (${rangeLabel(view.range).toLowerCase()})`} icon={UsersRound} bodyClassName="p-0">
      {!settings.teams?.length ? (
        <EmptyState compact title="No teams defined" />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] text-gray-500 border-b border-gray-700">
              <th className="px-3 py-1.5 font-medium">Team</th>
              <th className="px-3 py-1.5 font-medium text-right">Services</th>
              <th className="px-3 py-1.5 font-medium text-right">Compute</th>
              <th className="px-3 py-1.5 font-medium text-right">Storage</th>
              <th className="px-3 py-1.5 font-medium text-right">Total</th>
              <th className="px-3 py-1.5 font-medium text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name} className="border-b border-gray-800 last:border-0">
                <td className={`px-3 py-1.5 ${r.name === 'Unallocated' ? 'text-gray-500 italic' : 'text-gray-100'}`}>{r.name}</td>
                <td className="px-3 py-1.5 text-right text-gray-400">{r.services}</td>
                <td className="px-3 py-1.5 text-right text-blue-300">{money(r.compute, 2)}</td>
                <td className="px-3 py-1.5 text-right text-green-300">{money(r.storage, 2)}</td>
                <td className="px-3 py-1.5 text-right text-amber-300 font-semibold">{money(r.total, 2)}</td>
                <td className="px-3 py-1.5 text-right text-gray-400">{pct(r.share, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// With the Cloud API connected, billed spend split by team. Otherwise a live
// showback from system tables.
export function AttributionTab({ cloud }: { cloud?: CloudData }) {
  if (!cloud) return <LiveAllocation />;
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar left={<CostRangeSelector datesOnly />} />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <TeamAllocation cloud={cloud} />
      </div>
    </div>
  );
}

// Showback: each database's storage plus its share of compute, and each
// user's share of compute, over the selected range. Exportable as CSV.
function LiveAllocation() {
  const gridTheme = useGridTheme();
  const { status, basis, view } = useCost();
  const { from, to } = view.range;
  const period = rangeLabel(view.range);
  const { data, error, loading, slow } = useLiveQuery(`attribution|${status.environment}|${from}|${to}`, () => loadAttribution(status, { from, to }));
  const rows = useMemo(() => (data ? buildRows(data, basis) : []), [data, basis]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);

  const dbChart = filtered.filter(r => r.type === 'database').sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 12)
    .map(r => ({ name: r.name, Storage: r.storageCost ?? 0, Compute: r.computeCost ?? 0 }));
  const userChart = filtered.filter(r => r.type === 'user').slice(0, 12).map(r => ({ name: r.name, Compute: r.computeCost ?? r.cpu_s }));

  const cols = useMemo((): ColDef<ShowbackRow>[] => [
    { headerName: 'Allocated to', field: 'type', width: 110, cellRenderer: (p: { value: string }) => <Pill tone={p.value === 'database' ? 'green' : 'blue'}>{p.value}</Pill> },
    { headerName: 'Name', field: 'name', flex: 1, minWidth: 180, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Stored', field: 'bytes', width: 100, cellStyle: rightAlign, valueFormatter: p => (p.value === null ? '' : formatBytes(p.value)) },
    { headerName: 'Storage share', field: 'storageShare', width: 110, cellStyle: rightAlign, valueFormatter: p => (p.value === null ? '' : pct(p.value, 1)) },
    { headerName: 'Queries', headerTooltip: period, field: 'queries', width: 110, cellStyle: rightAlign, valueFormatter: p => formatNumber(p.value) },
    { headerName: 'CPU s', field: 'cpu_s', width: 90, cellStyle: rightAlign, valueFormatter: p => Number(p.value).toFixed(1) },
    { headerName: 'Compute share', field: 'computeShare', width: 115, cellStyle: { ...rightAlign, color: '#93c5fd' }, valueFormatter: p => pct(p.value, 1) },
    { headerName: 'Storage $/mo', field: 'storageCost', width: 110, cellStyle: { ...rightAlign, color: '#86efac' }, valueFormatter: p => (p.value === null ? '' : money(p.value, 2)) },
    { headerName: 'Compute $/mo', field: 'computeCost', width: 115, cellStyle: { ...rightAlign, color: '#93c5fd' }, valueFormatter: p => money(p.value, 2) },
    { headerName: 'Total $/mo', field: 'total', width: 105, sort: 'desc', cellStyle: { ...rightAlign, color: '#fbbf24', fontWeight: 600 }, valueFormatter: p => money(p.value, 2) },
  ], [period]);

  const exportCsv = () => downloadCsv(`cost-allocation-${status.environment}.csv`,
    ['allocated_to', 'name', 'stored_bytes', 'storage_share', 'queries', 'cpu_seconds', 'compute_share', 'storage_usd_month', 'compute_usd_month', 'total_usd_month'],
    filtered.map(r => [r.type, r.name, r.bytes, r.storageShare?.toFixed(5), r.queries, r.cpu_s.toFixed(3), r.computeShare.toFixed(5), r.storageCost?.toFixed(2), r.computeCost?.toFixed(2), r.total?.toFixed(2)]));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <CostRangeSelector datesOnly />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search databases or users..." width="w-56" />
        </>}
        right={<>
          <FilterCounts count={filtered.length} noun="rows" active={activeCount} />
          <ToolbarButton icon={Download} onClick={exportCsv} disabled={!filtered.length}>Export CSV</ToolbarButton>
        </>}
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <ErrorBox error={error} />}
        {loading ? <Spinner label={slow ? 'Waiting for the service to answer (an idle Cloud service can take up to a minute to wake)...' : 'Reading system.parts and system.query_log...'} /> : (
          <>
            <p className="text-[11px] text-gray-500 shrink-0">
              Live allocation: storage by bytes on disk today, compute by CPU time over {period.toLowerCase()} ({basis?.label ?? 'loading cost basis'}).
              Queries touching several databases split their CPU evenly. {internalUsersNote(status)}Users own no storage, so user rows carry compute only.
            </p>
            {data && !data.byUser && <InfoBox>system.query_log is not available: compute cannot be allocated, only storage.</InfoBox>}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 h-64 shrink-0">
              <Panel title="Cost by database ($/month)" icon={HardDrive} bodyClassName="p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dbChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="name" tick={axisTick} stroke="#4b5563" interval={0} angle={-15} textAnchor="end" height={40} />
                    <YAxis tick={axisTick} stroke="#4b5563" tickFormatter={v => `$${v}`} width={50} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => money(Number(v), 2)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Storage" stackId="a" fill={CHART_COLORS[1]} />
                    <Bar dataKey="Compute" stackId="a" fill={CHART_COLORS[0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Panel>
              <Panel title={basis?.computeMonthly != null ? 'Compute by user ($/month)' : 'Compute by user (CPU seconds)'} icon={Users} bodyClassName="p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={userChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="name" tick={axisTick} stroke="#4b5563" interval={0} angle={-15} textAnchor="end" height={40} />
                    <YAxis tick={axisTick} stroke="#4b5563" width={50} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => (basis?.computeMonthly != null ? money(Number(v), 2) : `${Number(v).toFixed(1)} s`)} />
                    <Bar dataKey="Compute" fill={CHART_COLORS[0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Panel>
            </div>
            <div className="h-[26rem] bg-gray-900 border border-gray-700 rounded overflow-hidden shrink-0">
              <AgGridReact<ShowbackRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} defaultColDef={gridDefaults} suppressCellFocus getRowId={p => `${p.data.type}:${p.data.name}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
