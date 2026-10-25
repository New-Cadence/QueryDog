import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Server, Cpu, MemoryStick, CircleDollarSign, HardDrive, Hash, Gauge } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { formatBytes } from '../../utils/formatters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { StatCard, ToolbarSearch } from '../ui';
import { CostToolbar, ErrorBox, FilterCounts, InfoBox, Spinner } from './common';
import { gridDefaults, money, pct, rightAlign, useCost } from './costContext';
import { envSettings, storageTable, systemTable, type CostStatus } from './costApi';
import { BYTES_PER_TB } from './costBasis';
import { optionalRows, queryRows, useLiveQuery } from './useLiveQuery';
import { GRID_OVERLAYS } from '../gridOverlays';

interface NodeRow {
  host: string;
  cores: number;
  memory: number;
  // 7-day averages from the metric logs, 0..1 (null when not recorded)
  cpuUtil: number | null;
  memUtil: number | null;
  memPeak: number | null;
}

// Self-managed: node resources and 7-day utilisation from the system tables,
// so the user's per-node price can be judged against how busy the nodes are.
async function loadOss(status: CostStatus) {
  const [resources, maxThreads, cpuMem, bytes, queries] = await Promise.all([
    queryRows<{ host: string; cores: number; memory: number }>(`
      SELECT hostName() AS host, maxIf(value, metric = 'NumberOfCPUCores') AS cores, maxIf(value, metric = 'OSMemoryTotal') AS memory
      FROM ${systemTable(status, 'asynchronous_metrics')} GROUP BY host`),
    // OS metrics are Linux-only; max_threads defaults to the core count elsewhere
    queryRows<{ n: number }>("SELECT toUInt32OrZero(extract(value, '\\\\d+')) AS n FROM system.settings WHERE name = 'max_threads'"),
    optionalRows<{ host: string; cpu_cores_used: number; mem: number; mem_peak: number }>(`
      SELECT hostName() AS host,
        sum(ProfileEvent_OSCPUVirtualTimeMicroseconds) / 1e6 / greatest(dateDiff('second', min(event_time), max(event_time)), 1) AS cpu_cores_used,
        avg(CurrentMetric_MemoryTracking) AS mem, max(CurrentMetric_MemoryTracking) AS mem_peak
      FROM ${systemTable(status, 'metric_log')} WHERE event_date >= today() - 7 GROUP BY host`),
    queryRows<{ bytes: number }>(`SELECT sum(bytes_on_disk) AS bytes FROM ${storageTable(status, 'parts')} WHERE active`),
    optionalRows<{ q: number }>(`SELECT countIf(type = 'QueryFinish') AS q FROM ${systemTable(status, 'query_log')} WHERE event_date >= today() - 30`),
  ]);
  const fallbackCores = maxThreads[0]?.n || 0;
  const nodes: NodeRow[] = resources.map(r => {
    const cores = r.cores || fallbackCores;
    const u = cpuMem?.find(c => c.host === r.host);
    return {
      host: r.host, cores, memory: r.memory,
      cpuUtil: u && cores ? u.cpu_cores_used / cores : null,
      memUtil: u && r.memory ? u.mem / r.memory : null,
      memPeak: u ? u.mem_peak : null,
    };
  });
  return { nodes, bytes: bytes[0]?.bytes || 0, queries30d: queries?.[0]?.q ?? null };
}

const FIELDS: ClientFilterField<NodeRow>[] = [
  { field: 'utilisation', label: 'CPU utilisation', getValue: r => (r.cpuUtil === null ? 'unknown' : r.cpuUtil < 0.2 ? 'low (< 20%)' : r.cpuUtil < 0.6 ? 'moderate' : 'high (60%+)') },
];

export function OssOverviewTab() {
  const gridTheme = useGridTheme();
  const { status, settings, basis } = useCost();
  const env = envSettings(settings, status.environment);
  const { data, error, loading, slow } = useLiveQuery(`oss|${status.environment}`, () => loadOss(status));
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(nodes, FIELDS, r => r.host);

  const nodeCount = basis?.nodes ?? 1;
  const storageTb = (data?.bytes ?? 0) / BYTES_PER_TB;
  const monthly = env.oss.nodeMonthly * nodeCount + env.oss.storageTbMonth * storageTb + env.oss.fixedMonthly;
  const priced = monthly > 0;
  const avg = (k: 'cpuUtil' | 'memUtil') => {
    const v = filtered.map(n => n[k]).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const cpu = avg('cpuUtil');

  const cols = useMemo((): ColDef<NodeRow>[] => [
    { headerName: 'Host', field: 'host', flex: 1, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'CPU cores', field: 'cores', width: 100, cellStyle: rightAlign },
    { headerName: 'Memory', field: 'memory', width: 110, cellStyle: rightAlign, valueFormatter: p => (p.value ? formatBytes(p.value) : 'unknown') },
    { headerName: 'Avg CPU (7d)', field: 'cpuUtil', width: 115, cellStyle: rightAlign, valueFormatter: p => pct(p.value, 1) },
    { headerName: 'Avg memory (7d)', field: 'memUtil', width: 130, cellStyle: rightAlign, valueFormatter: p => pct(p.value, 1) },
    { headerName: 'Peak tracked memory', field: 'memPeak', width: 150, cellStyle: rightAlign, valueFormatter: p => (p.value === null ? '—' : formatBytes(p.value)) },
  ], []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={nodes} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search hosts..." width="w-48" />
        </>}
        right={<FilterCounts count={filtered.length} noun="nodes" active={activeCount} />}
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {error && <ErrorBox error={error} />}
        {!priced && <InfoBox>Open-source cost is what you pay for your servers. Enter a cost per node (and optionally storage and fixed costs) in Settings → Costs.</InfoBox>}
        {loading ? <Spinner label={slow ? 'Waiting for ClickHouse...' : 'Reading node resources...'} /> : data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3 shrink-0">
              <StatCard label="Monthly cost" icon={CircleDollarSign} value={priced ? money(monthly) : '—'} sub={priced ? `${money(monthly * 12)} per year` : 'set prices in Settings → Costs'} />
              <StatCard label="Nodes" icon={Server} value={nodeCount} sub={env.oss.nodeCountOverride ? 'override from Settings → Costs' : status.cluster ? `cluster ${status.cluster}` : 'from system.clusters'} />
              <StatCard label="CPU / memory" icon={Cpu} value={`${nodes.reduce((s, n) => s + n.cores, 0) || '?'} cores`} sub={nodes.some(n => n.memory) ? formatBytes(nodes.reduce((s, n) => s + n.memory, 0)) : 'memory unknown (non-Linux)'} />
              <StatCard label="Cost per TB stored" icon={HardDrive} value={priced && storageTb > 0 ? money(monthly / storageTb) : '—'} sub={`${formatBytes(data.bytes)} on disk`} />
              <StatCard label="Cost per million queries" icon={Hash} value={priced && data.queries30d ? money((monthly / data.queries30d) * 1e6) : '—'}
                sub={data.queries30d === null ? 'query_log not available' : `${data.queries30d.toLocaleString()} queries in 30 days`} />
              <StatCard label="Avg CPU (7d)" icon={Gauge} value={pct(cpu, 1)} tone={cpu !== null && cpu < 0.2 ? 'yellow' : 'default'} sub={cpu !== null && cpu < 0.2 ? 'low: consider fewer or smaller nodes' : 'from system.metric_log'} />
              <StatCard label="Avg memory (7d)" icon={MemoryStick} value={pct(avg('memUtil'), 1)} sub="tracked / total memory" />
            </div>
            <div className="h-80 bg-gray-900 border border-gray-700 rounded overflow-hidden shrink-0">
              <AgGridReact<NodeRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} defaultColDef={gridDefaults} suppressCellFocus />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
