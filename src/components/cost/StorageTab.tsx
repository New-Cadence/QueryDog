import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { HardDrive, TrendingUp, Database, Archive, CircleDollarSign, Percent } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { formatBytes, formatNumber } from '../../utils/formatters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { Panel, StatCard, ToolbarSearch } from '../ui';
import { CostToolbar, ErrorBox, FilterCounts, InfoBox, Spinner } from './common';
import { axisTick, gridDefaults, money, rightAlign, tooltipStyle, useCost } from './costContext';
import { storageTable, systemTable, type CostStatus } from './costApi';
import { BYTES_PER_TB } from './costBasis';
import { addDays, todayUtc } from './usage';
import { optionalRows, queryRows, useLiveQuery } from './useLiveQuery';
import { GRID_OVERLAYS } from '../gridOverlays';

interface TableStorage {
  database: string;
  table: string;
  engine: string;
  rows: number;
  bytes: number;
  compressed: number;
  uncompressed: number;
  parts: number;
  last_modified: string;
  has_ttl: boolean;
  ratio: number;
}

interface GrowthRow { day: string; database: string; added: number; removed: number }

const SYSTEM_DBS = ['system', 'INFORMATION_SCHEMA', 'information_schema'];

async function loadStorage(status: CostStatus) {
  const [tables, ttl, growth] = await Promise.all([
    queryRows<Omit<TableStorage, 'has_ttl' | 'ratio'>>(`
      SELECT database, table, any(engine) AS engine, sum(rows) AS rows, sum(bytes_on_disk) AS bytes,
        sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed,
        count() AS parts, toString(max(modification_time)) AS last_modified
      FROM ${storageTable(status, 'parts')}
      WHERE active
      GROUP BY database, table`),
    queryRows<{ database: string; table: string; has_ttl: number }>(`
      SELECT DISTINCT database, name AS table, positionCaseInsensitive(create_table_query, ' TTL ') > 0 AS has_ttl
      FROM ${storageTable(status, 'tables')}
      WHERE engine LIKE '%MergeTree%'`),
    // Net bytes written per day: new, merged, mutated and replicated parts minus removed parts
    optionalRows<GrowthRow>(`
      SELECT toString(event_date) AS day, database,
        sumIf(size_in_bytes, event_type IN ('NewPart', 'MergeParts', 'MutatePart', 'DownloadPart')) AS added,
        sumIf(size_in_bytes, event_type = 'RemovePart') AS removed
      FROM ${systemTable(status, 'part_log')}
      WHERE event_date >= today() - 89
      GROUP BY day, database
      ORDER BY day`),
  ]);
  const ttlSet = new Set(ttl.filter(t => Number(t.has_ttl)).map(t => `${t.database}.${t.table}`));
  return {
    tables: tables.map(t => ({ ...t, has_ttl: ttlSet.has(`${t.database}.${t.table}`), ratio: t.compressed ? t.uncompressed / t.compressed : 0 })),
    growth,
  };
}

const FIELDS: ClientFilterField<TableStorage>[] = [
  { field: 'database', label: 'Database' },
  { field: 'engine', label: 'Engine' },
  { field: 'kind', label: 'Kind', getValue: r => (SYSTEM_DBS.includes(r.database) ? 'system tables' : 'user tables') },
  { field: 'has_ttl', label: 'TTL', getValue: r => (r.has_ttl ? 'has TTL' : 'no TTL') },
  { field: 'compression', label: 'Compression', getValue: r => (r.ratio < 2 ? 'poor (< 2x)' : r.ratio < 5 ? 'fair (2-5x)' : 'good (5x+)') },
];
const searchText = (r: TableStorage) => `${r.database}.${r.table} ${r.engine}`;

const HORIZONS = [3, 6, 12];

// Stored data by table, compression, and a storage growth forecast from
// system.part_log priced at the environment's $/TB-month.
export function StorageTab() {
  const gridTheme = useGridTheme();
  const { status, basis } = useCost();
  const { data, error, loading, slow } = useLiveQuery(`storage|${status.environment}`, () => loadStorage(status));
  const tables = useMemo(() => data?.tables ?? [], [data]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(tables, FIELDS, searchText);
  const rate = basis?.storageTbMonth ?? 0;

  const totalBytes = filtered.reduce((s, t) => s + t.bytes, 0);
  const totalUncompressed = filtered.reduce((s, t) => s + t.uncompressed, 0);
  const totalCompressed = filtered.reduce((s, t) => s + t.compressed, 0);
  const monthlyCost = (totalBytes / BYTES_PER_TB) * rate;

  // Growth uses the databases left after filtering so it matches the table list
  const growth = useMemo(() => {
    if (!data?.growth) return null;
    const dbs = new Set(filtered.map(t => t.database));
    const net = new Map<string, number>();
    for (const g of data.growth) if (dbs.has(g.database)) net.set(g.day, (net.get(g.day) || 0) + g.added - g.removed);
    const today = todayUtc();
    const first = data.growth.length ? data.growth[0].day : today;
    const days: string[] = [];
    for (let d = first; d <= today; d = addDays(d, 1)) days.push(d);
    // Walk back from the current size so history ends exactly at today's total
    const history: { date: string; size: number | null; projected: number | null }[] = [];
    let size = totalBytes;
    for (let i = days.length - 1; i >= 0; i--) {
      history.unshift({ date: days[i], size, projected: null });
      size -= net.get(days[i]) || 0;
    }
    const recent = days.slice(-30);
    const daily = recent.reduce((s, d) => s + (net.get(d) || 0), 0) / Math.max(1, recent.length);
    const projection = [];
    for (let k = 7; k <= 365; k += 7) projection.push({ date: addDays(today, k), size: null, projected: Math.max(0, totalBytes + daily * k) });
    if (history.length) history[history.length - 1].projected = totalBytes;
    return { daily, observedDays: days.length, series: [...history, ...projection] };
  }, [data, filtered, totalBytes]);

  const cols = useMemo((): ColDef<TableStorage>[] => [
    { headerName: 'Database', field: 'database', width: 140, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Table', field: 'table', flex: 1, minWidth: 180, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Engine', field: 'engine', width: 150 },
    { headerName: 'Rows', field: 'rows', width: 95, cellStyle: rightAlign, valueFormatter: p => formatNumber(p.value) },
    { headerName: 'On disk', field: 'bytes', width: 100, sort: 'desc', cellStyle: rightAlign, valueFormatter: p => formatBytes(p.value) },
    { headerName: 'Uncompressed', field: 'uncompressed', width: 115, cellStyle: rightAlign, valueFormatter: p => formatBytes(p.value) },
    { headerName: 'Ratio', field: 'ratio', width: 75, cellStyle: p => ({ ...rightAlign, color: p.value < 2 ? '#f87171' : p.value < 5 ? '#fbbf24' : '#86efac' }), valueFormatter: p => `${Number(p.value).toFixed(1)}x` },
    { headerName: 'Parts', field: 'parts', width: 70, cellStyle: rightAlign },
    { headerName: 'TTL', field: 'has_ttl', width: 65, valueFormatter: p => (p.value ? 'yes' : '—') },
    { headerName: '$ / month', colId: 'monthly', width: 95, cellStyle: { ...rightAlign, color: '#86efac' }, valueGetter: p => ((p.data?.bytes || 0) / BYTES_PER_TB) * rate, valueFormatter: p => money(p.value, 2) },
    { headerName: 'Last write', field: 'last_modified', width: 150 },
  ], [rate]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={tables} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search tables..." width="w-48" />
        </>}
        right={<FilterCounts count={filtered.length} noun="tables" active={activeCount} />}
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <ErrorBox error={error} />}
        {loading ? <Spinner label={slow ? 'Waiting for the service to answer (an idle Cloud service can take up to a minute to wake)...' : 'Reading system.parts...'} /> : (
          <>
            {rate === 0 && <InfoBox>No storage price set for this environment: add a $/TB-month price in Settings → Costs to cost the data.</InfoBox>}
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
              <StatCard label="Stored on disk" icon={HardDrive} value={formatBytes(totalBytes)} sub={`${formatNumber(filtered.reduce((s, t) => s + t.rows, 0))} rows`} />
              <StatCard label="Compression" icon={Percent} value={totalCompressed ? `${(totalUncompressed / totalCompressed).toFixed(1)}x` : '—'} sub={`${formatBytes(totalUncompressed)} uncompressed`} />
              <StatCard label="Storage cost" icon={CircleDollarSign} value={money(monthlyCost, 2)} sub={`per month at $${rate.toFixed(2)}/TB`} />
              <StatCard label="Daily growth" icon={TrendingUp} value={growth ? `${growth.daily >= 0 ? '+' : ''}${formatBytes(Math.abs(growth.daily))}` : '—'}
                sub={growth ? `average over ${Math.min(30, growth.observedDays)} days of part_log` : 'system.part_log not available'} tone={growth && growth.daily < 0 ? 'green' : 'default'} />
              {HORIZONS.slice(1).map(m => {
                const bytes = growth ? Math.max(0, totalBytes + growth.daily * m * 30.4) : null;
                return <StatCard key={m} label={`In ${m} months`} icon={m === 12 ? Archive : Database} value={bytes === null ? '—' : formatBytes(bytes)}
                  sub={bytes === null ? undefined : `${money((bytes / BYTES_PER_TB) * rate, 2)}/month`} />;
              })}
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 shrink-0">
              <Panel title="Storage history and 12-month projection" icon={TrendingUp} className="xl:col-span-3 h-72" bodyClassName="p-2">
                {!growth ? <div className="h-full flex items-center justify-center text-xs text-gray-500">Enable system.part_log to track storage growth.</div> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={growth.series}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis dataKey="date" tick={axisTick} stroke="#4b5563" minTickGap={30} />
                      <YAxis tick={axisTick} stroke="#4b5563" tickFormatter={v => formatBytes(v)} width={70} />
                      <Tooltip contentStyle={tooltipStyle} formatter={v => formatBytes(Number(v))} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area dataKey="size" name="Stored" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
                      <Line dataKey="projected" name="Projected (linear)" stroke="#f59e0b" strokeDasharray="5 4" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </Panel>
              <Panel title="Projection" icon={Archive} bodyClassName="p-0">
                <table className="w-full text-xs">
                  <thead><tr className="text-[11px] text-gray-500"><th className="text-left px-3 py-1.5">Horizon</th><th className="text-right px-2">Size</th><th className="text-right px-3">$ / month</th></tr></thead>
                  <tbody>
                    {[0, ...HORIZONS].map(m => {
                      const bytes = growth ? Math.max(0, totalBytes + growth.daily * m * 30.4) : m === 0 ? totalBytes : null;
                      return (
                        <tr key={m} className="border-t border-gray-800">
                          <td className="px-3 py-1.5 text-gray-300">{m === 0 ? 'Today' : `${m} months`}</td>
                          <td className="text-right px-2 text-gray-200">{bytes === null ? '—' : formatBytes(bytes)}</td>
                          <td className="text-right px-3 text-green-300">{bytes === null ? '—' : money((bytes / BYTES_PER_TB) * rate, 2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="px-3 py-2 text-[10px] text-gray-500">
                  Linear projection of the average daily net bytes written (new, merged and replicated parts minus removed parts). TTLs and deletes that have not run yet are not anticipated.
                </p>
              </Panel>
            </div>
            <div className="h-96 bg-gray-900 border border-gray-700 rounded overflow-hidden shrink-0">
              <AgGridReact<TableStorage> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} defaultColDef={gridDefaults} suppressCellFocus />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
