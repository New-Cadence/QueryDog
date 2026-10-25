import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ComposedChart, Line, Area, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Activity, GitMerge, Cpu, HardDrive, Layers, Database } from 'lucide-react';
import {
  fetchMetricLogTimeSeries,
  fetchAsyncMetricLogTimeSeries,
  getUserFriendlyError,
  type MetricLogTimeSeriesPoint,
} from '../../services/api';
import { parseServerTime, toDateTimeLocalValue } from '../../utils/formatters';
import { LoadingState } from '../ui';

type DashboardSource = 'queries' | 'merges' | 'memory' | 'io' | 'threadpool' | 'caches';

// ==================== METRIC DEFINITIONS ====================

// Queries - query execution and connections (metric_log)
const QUERIES_METRICS = [
  'CurrentMetric_Query',
  'CurrentMetric_SelectQuery',
  'CurrentMetric_InsertQuery',
  'ProfileEvent_SelectQuery',
  'ProfileEvent_InsertQuery',
  'ProfileEvent_FailedSelectQuery',
  'ProfileEvent_FailedInsertQuery',
  'CurrentMetric_HTTPConnection',
  'CurrentMetric_TCPConnection',
  'ProfileEvent_QueryTimeMicroseconds',
  'ProfileEvent_SelectQueryTimeMicroseconds',
  'ProfileEvent_InsertQueryTimeMicroseconds',
];

// Merges & Parts - merge/mutation activity and part counts (metric_log)
const MERGES_METRICS = [
  'CurrentMetric_Merge',
  'CurrentMetric_PartMutation',
  'ProfileEvent_MergedRows',
  'ProfileEvent_MergedUncompressedBytes',
  'ProfileEvent_MergesTimeMilliseconds',
  'ProfileEvent_InsertedRows',
  'ProfileEvent_InsertedBytes',
  'CurrentMetric_PartsActive',
  'CurrentMetric_PartsCompact',
  'CurrentMetric_PartsWide',
  'CurrentMetric_PartsTemporary',
  'CurrentMetric_TotalRowsOfMergeTreeTables',
  'CurrentMetric_TotalBytesOfMergeTreeTables',
  'CurrentMetric_TotalPartsOfMergeTreeTables',
  'CurrentMetric_DiskSpaceReservedForMerge',
];

// Memory - tracked memory from metric_log
const MEMORY_METRICS = [
  'CurrentMetric_MemoryTracking',
  'CurrentMetric_MergesMutationsMemoryTracking',
];

// Memory - OS and allocator metrics from async_metric_log
const MEMORY_ASYNC_METRICS = [
  'MemoryResident',
  'TrackedMemory',
  'QueriesMemoryUsage',
  'QueriesPeakMemoryUsage',
  'OSMemoryTotal',
  'OSMemoryAvailable',
  'jemalloc.resident',
  'jemalloc.allocated',
  'jemalloc.active',
  'jemalloc.mapped',
  'MemoryResidentMax',
  'MemoryVirtual',
  'MemoryShared',
  'OSMemoryCached',
  'OSMemoryBuffers',
  'jemalloc.metadata',
  'MemoryCode',
  'MemoryDataAndStack',
  'MemoryResidentWithoutPageCache',
  'OSMemoryFreePlusCached',
  'OSMemoryFreeWithoutCached',
];

// IO - disk and network operations (metric_log)
const IO_METRICS = [
  'CurrentMetric_Read',
  'CurrentMetric_Write',
  'ProfileEvent_OSReadBytes',
  'ProfileEvent_OSWriteBytes',
  'ProfileEvent_OSReadChars',
  'ProfileEvent_OSWriteChars',
  'ProfileEvent_ReadBufferFromFileDescriptorRead',
  'ProfileEvent_ReadBufferFromFileDescriptorReadBytes',
  'ProfileEvent_WriteBufferFromFileDescriptorWrite',
  'ProfileEvent_WriteBufferFromFileDescriptorWriteBytes',
  'ProfileEvent_ReadCompressedBytes',
  'ProfileEvent_CompressedReadBufferBytes',
  'ProfileEvent_FileOpen',
  'ProfileEvent_NetworkSendBytes',
  'ProfileEvent_NetworkReceiveBytes',
];

// Thread pool metrics - paired Size + Task (metric_log)
const THREAD_POOL_METRICS = [
  'CurrentMetric_BackgroundMergesAndMutationsPoolSize',
  'CurrentMetric_BackgroundMergesAndMutationsPoolTask',
  'CurrentMetric_BackgroundFetchesPoolSize',
  'CurrentMetric_BackgroundFetchesPoolTask',
  'CurrentMetric_BackgroundMovePoolSize',
  'CurrentMetric_BackgroundMovePoolTask',
  'CurrentMetric_BackgroundSchedulePoolSize',
  'CurrentMetric_BackgroundSchedulePoolTask',
  'CurrentMetric_BackgroundCommonPoolSize',
  'CurrentMetric_BackgroundCommonPoolTask',
  'CurrentMetric_BackgroundBufferFlushSchedulePoolSize',
  'CurrentMetric_BackgroundBufferFlushSchedulePoolTask',
  'CurrentMetric_BackgroundDistributedSchedulePoolSize',
  'CurrentMetric_BackgroundDistributedSchedulePoolTask',
  'CurrentMetric_BackgroundMessageBrokerSchedulePoolSize',
  'CurrentMetric_BackgroundMessageBrokerSchedulePoolTask',
  'CurrentMetric_IOThreadPoolSize',
  'CurrentMetric_IOThreadPoolTask',
];

// Cache metrics - cache sizes and counts (metric_log)
const CACHE_METRICS = [
  'CurrentMetric_MarkCacheBytes',
  'CurrentMetric_MarkCacheFiles',
  'CurrentMetric_UncompressedCacheBytes',
  'CurrentMetric_UncompressedCacheCells',
  'CurrentMetric_PrimaryIndexCacheBytes',
  'CurrentMetric_PrimaryIndexCacheFiles',
  'CurrentMetric_QueryCacheBytes',
  'CurrentMetric_QueryCacheEntries',
  'CurrentMetric_IndexMarkCacheBytes',
  'CurrentMetric_IndexMarkCacheFiles',
  'CurrentMetric_IndexUncompressedCacheBytes',
  'CurrentMetric_IndexUncompressedCacheCells',
  'CurrentMetric_FilesystemCacheSize',
  'CurrentMetric_FilesystemCacheElements',
  'CurrentMetric_PageCacheBytes',
  'CurrentMetric_PageCacheCells',
  'CurrentMetric_CompiledExpressionCacheBytes',
  'CurrentMetric_CompiledExpressionCacheCount',
  'CurrentMetric_DNSAddressesCacheBytes',
  'CurrentMetric_MMapCacheCells',
];

// Thread pool pairs for combined Size/Task charts
const THREAD_POOL_PAIRS = [
  { name: 'Background Merge & Mutation Pool', size: 'CurrentMetric_BackgroundMergesAndMutationsPoolSize', task: 'CurrentMetric_BackgroundMergesAndMutationsPoolTask' },
  { name: 'Background Fetch Pool', size: 'CurrentMetric_BackgroundFetchesPoolSize', task: 'CurrentMetric_BackgroundFetchesPoolTask' },
  { name: 'Background Move Pool', size: 'CurrentMetric_BackgroundMovePoolSize', task: 'CurrentMetric_BackgroundMovePoolTask' },
  { name: 'Background Schedule Pool', size: 'CurrentMetric_BackgroundSchedulePoolSize', task: 'CurrentMetric_BackgroundSchedulePoolTask' },
  { name: 'Background Common Pool', size: 'CurrentMetric_BackgroundCommonPoolSize', task: 'CurrentMetric_BackgroundCommonPoolTask' },
  { name: 'Buffer Flush Pool', size: 'CurrentMetric_BackgroundBufferFlushSchedulePoolSize', task: 'CurrentMetric_BackgroundBufferFlushSchedulePoolTask' },
  { name: 'Distributed Schedule Pool', size: 'CurrentMetric_BackgroundDistributedSchedulePoolSize', task: 'CurrentMetric_BackgroundDistributedSchedulePoolTask' },
  { name: 'Message Broker Pool', size: 'CurrentMetric_BackgroundMessageBrokerSchedulePoolSize', task: 'CurrentMetric_BackgroundMessageBrokerSchedulePoolTask' },
  { name: 'IO Thread Pool', size: 'CurrentMetric_IOThreadPoolSize', task: 'CurrentMetric_IOThreadPoolTask' },
];

// Map source to its metric_log metrics
function getMetricsForSource(source: DashboardSource): string[] {
  switch (source) {
    case 'queries': return QUERIES_METRICS;
    case 'merges': return MERGES_METRICS;
    case 'memory': return MEMORY_METRICS;
    case 'io': return IO_METRICS;
    case 'threadpool': return THREAD_POOL_METRICS;
    case 'caches': return CACHE_METRICS;
  }
}

// ==================== UTILITY FUNCTIONS ====================

function formatValue(value: number | string | null | undefined): string {
  if (value == null) return '0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (Math.abs(num) >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
  if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'K';
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toFixed(2);
}

function formatMetricName(name: string): string {
  if (name.startsWith('ProfileEvent_')) {
    const base = name.replace(/^ProfileEvent_/, '').replace(/([A-Z])/g, ' $1').trim();
    return `Total ${base}`;
  }
  if (name.startsWith('CurrentMetric_')) {
    return name.replace(/^CurrentMetric_/, '').replace(/([A-Z])/g, ' $1').trim();
  }
  return name
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

function getMetricColor(index: number): string {
  const colors = [
    '#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa',
    '#fb923c', '#22d3ee', '#f87171', '#4ade80', '#c084fc',
  ];
  return colors[index % colors.length];
}

function formatForInput(date: Date): string {
  return toDateTimeLocalValue(date);
}

function formatTimeAxis(time: string): string {
  const d = parseServerTime(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ==================== CHART COMPONENTS ====================

// Each chart plots one gauge-like metric (or a pool's size and tasks), so the
// useful views are line, area and bar
type MetricChartKind = 'line' | 'area' | 'bar';
const METRIC_CHART_KINDS: { value: MetricChartKind; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
];

function metricSeries(kind: MetricChartKind, dataKey: string, color: string, name?: string) {
  if (kind === 'bar') return <Bar key={dataKey} dataKey={dataKey} fill={color} fillOpacity={0.8} isAnimationActive={false} name={name} />;
  if (kind === 'area') return <Area key={dataKey} type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.25} strokeWidth={1.5} dot={false} isAnimationActive={false} name={name} />;
  return <Line key={dataKey} type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} name={name} />;
}

interface MetricChartProps {
  kind: MetricChartKind;
  metric: string;
  data: MetricLogTimeSeriesPoint[];
  colorIndex: number;
}

function MetricChart({ kind, metric, data, colorIndex }: MetricChartProps) {
  const color = getMetricColor(colorIndex);
  const displayName = formatMetricName(metric);
  const latestValue = data.length > 0 ? Number(data[data.length - 1][metric]) || 0 : 0;

  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400 truncate flex-1" title={metric}>
          {displayName}
        </div>
        <div className="text-sm font-mono ml-2" style={{ color }}>
          {formatValue(latestValue)}
        </div>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={{ stroke: '#374151' }}
              tickLine={false}
              tickFormatter={formatTimeAxis}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 9, fill: '#6b7280' }}
              tickFormatter={formatValue}
              axisLine={{ stroke: '#374151' }}
              tickLine={false}
              width={45}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px', fontSize: '11px' }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value: number | string) => [formatValue(value), displayName]}
              labelFormatter={(label) => parseServerTime(label).toLocaleTimeString()}
            />
            {metricSeries(kind, metric, color)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface PoolChartProps {
  kind: MetricChartKind;
  poolName: string;
  sizeMetric: string;
  taskMetric: string;
  data: MetricLogTimeSeriesPoint[];
  colorIndex: number;
}

function PoolChart({ kind, poolName, sizeMetric, taskMetric, data, colorIndex }: PoolChartProps) {
  const sizeColor = getMetricColor(colorIndex * 2);
  const taskColor = getMetricColor(colorIndex * 2 + 1);
  const latestSize = data.length > 0 ? Number(data[data.length - 1][sizeMetric]) || 0 : 0;
  const latestTask = data.length > 0 ? Number(data[data.length - 1][taskMetric]) || 0 : 0;

  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400 truncate flex-1" title={poolName}>{poolName}</div>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span style={{ color: sizeColor }}>Size: {formatValue(latestSize)}</span>
          <span style={{ color: taskColor }}>Tasks: {formatValue(latestTask)}</span>
        </div>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={{ stroke: '#374151' }}
              tickLine={false}
              tickFormatter={formatTimeAxis}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 9, fill: '#6b7280' }}
              tickFormatter={formatValue}
              axisLine={{ stroke: '#374151' }}
              tickLine={false}
              width={45}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px', fontSize: '11px' }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value: number | string, name: string) => [
                formatValue(value),
                name.includes('Size') ? 'Pool Size' : 'Active Tasks',
              ]}
              labelFormatter={(label) => parseServerTime(label).toLocaleTimeString()}
            />
            <Legend
              verticalAlign="top"
              height={20}
              formatter={(value) => (
                <span className="text-xs">
                  {value.includes('Size') ? 'Pool Size' : 'Active Tasks'}
                </span>
              )}
            />
            {metricSeries(kind, sizeMetric, sizeColor, 'Size')}
            {metricSeries(kind, taskMetric, taskColor, 'Tasks')}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ==================== SOURCE TABS ====================

const SOURCE_TABS: { id: DashboardSource; label: string; icon: typeof Activity }[] = [
  { id: 'queries', label: 'Queries', icon: Activity },
  { id: 'merges', label: 'Merges', icon: GitMerge },
  { id: 'memory', label: 'Memory', icon: Cpu },
  { id: 'io', label: 'IO', icon: HardDrive },
  { id: 'threadpool', label: 'Thread Pool', icon: Layers },
  { id: 'caches', label: 'Caches', icon: Database },
];

// ==================== MAIN COMPONENT ====================

interface DashboardTabProps {
  filterBarContainer?: HTMLDivElement | null;
}

export function DashboardTab({ filterBarContainer }: DashboardTabProps) {
  const [activeSource, setActiveSource] = useState<DashboardSource>('queries');
  const [startTime, setStartTime] = useState<Date>(() => new Date(Date.now() - 60 * 60 * 1000));
  const [endTime, setEndTime] = useState<Date>(() => new Date());
  const [relativeMinutes, setRelativeMinutes] = useState<number | null>(60);
  const [bucketSize, setBucketSize] = useState<'second' | 'minute' | 'hour'>('minute');
  const [chartKind, setChartKind] = useState<MetricChartKind>('line');
  const [metricData, setMetricData] = useState<MetricLogTimeSeriesPoint[]>([]);
  const [asyncData, setAsyncData] = useState<MetricLogTimeSeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load saved time range from localStorage
  useEffect(() => {
    const savedTimeRange = localStorage.getItem('dashboardTimeRange');
    if (savedTimeRange) {
      const parsed = parseInt(savedTimeRange, 10);
      if ([15, 60, 360, 1440].includes(parsed)) {
        setRelativeMinutes(parsed);
        const now = new Date();
        setStartTime(new Date(now.getTime() - parsed * 60 * 1000));
        setEndTime(now);
      }
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    let start: Date, end: Date;
    if (relativeMinutes !== null) {
      end = new Date();
      start = new Date(end.getTime() - relativeMinutes * 60 * 1000);
    } else {
      start = startTime;
      end = endTime;
    }

    try {
      const metrics = getMetricsForSource(activeSource);

      if (activeSource === 'memory') {
        const [metricResult, asyncResult] = await Promise.all([
          fetchMetricLogTimeSeries(start, end, bucketSize, metrics),
          fetchAsyncMetricLogTimeSeries(start, end, bucketSize, MEMORY_ASYNC_METRICS),
        ]);
        setMetricData(metricResult);
        setAsyncData(asyncResult);
      } else {
        const result = await fetchMetricLogTimeSeries(start, end, bucketSize, metrics);
        setMetricData(result);
        setAsyncData([]);
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      // Maps a missing system.metric_log to "not enabled on this server" guidance
      setError(getUserFriendlyError(err instanceof Error ? err.message : 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  }, [activeSource, relativeMinutes, startTime, endTime, bucketSize]);

  // Load data when source or time range changes
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const setQuickRange = (minutes: number) => {
    const now = new Date();
    setStartTime(new Date(now.getTime() - minutes * 60 * 1000));
    setEndTime(now);
    setRelativeMinutes(minutes);
    localStorage.setItem('dashboardTimeRange', String(minutes));
  };

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStart = new Date(e.target.value);
    if (!isNaN(newStart.getTime())) {
      setStartTime(newStart);
      setRelativeMinutes(null);
    }
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnd = new Date(e.target.value);
    if (!isNaN(newEnd.getTime())) {
      setEndTime(newEnd);
      setRelativeMinutes(null);
    }
  };

  const hasData = activeSource === 'memory'
    ? metricData.length > 0 || asyncData.length > 0
    : metricData.length > 0;

  const metricsCount = activeSource === 'memory'
    ? MEMORY_METRICS.length + MEMORY_ASYNC_METRICS.length
    : getMetricsForSource(activeSource).length;

  const filterBarContent = filterBarContainer ? createPortal(
    <>
      <div className="flex items-center gap-2 text-xs">
        <div className="flex items-center gap-1">
          <label className="text-gray-400">From:</label>
          <input
            type="datetime-local"
            step="1"
            value={formatForInput(startTime)}
            onChange={handleStartChange}
            className="bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-gray-400">To:</label>
          <input
            type="datetime-local"
            step="1"
            value={formatForInput(endTime)}
            onChange={handleEndChange}
            className="bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs"
          />
        </div>
        <div className="flex gap-1 ml-1">
          {[
            { minutes: 15, label: '15m' },
            { minutes: 60, label: '1h' },
            { minutes: 360, label: '6h' },
            { minutes: 1440, label: '24h' },
          ].map(({ minutes, label }) => (
            <button
              key={minutes}
              onClick={() => setQuickRange(minutes)}
              className={`px-1.5 py-0.5 rounded text-xs ${
                relativeMinutes === minutes
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2 border-l border-gray-600 pl-2">
          <label className="text-gray-400">Bucket:</label>
          <select
            value={bucketSize}
            onChange={(e) => setBucketSize(e.target.value as 'second' | 'minute' | 'hour')}
            className="bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs"
          >
            <option value="second">Second</option>
            <option value="minute">Minute</option>
            <option value="hour">Hour</option>
          </select>
        </div>
        <div className="flex items-center gap-1 ml-2 border-l border-gray-600 pl-2">
          <label className="text-gray-400">Type:</label>
          <select
            value={chartKind}
            onChange={(e) => setChartKind(e.target.value as MetricChartKind)}
            className="bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs"
          >
            {METRIC_CHART_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">
          {metricsCount} metrics
        </span>
      </div>
    </>,
    filterBarContainer,
  ) : null;

  if (error) {
    return (
      <>
        {filterBarContent}
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="text-red-400 text-sm mb-2 max-w-lg">{error}</div>
            <button onClick={loadData} className="text-xs text-blue-400 hover:text-blue-300">
              Retry
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {filterBarContent}
      {/* Source tabs */}
      <div className="bg-gray-900/30 border-b border-gray-700 px-1.5 py-1 flex items-center gap-1 shrink-0">
        {SOURCE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveSource(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
              activeSource === id
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800'
            }`}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Charts Grid */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading && !hasData ? (
          <LoadingState label="Loading dashboard…" />
        ) : !hasData ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-gray-400 text-sm">
              No data available. Make sure {activeSource === 'memory' ? 'metric_log and asynchronous_metric_log are' : 'metric_log is'} enabled.
            </div>
          </div>
        ) : activeSource === 'threadpool' ? (
          <div className="grid grid-cols-3 gap-3">
            {THREAD_POOL_PAIRS.map((pool, index) => (
              <PoolChart
                kind={chartKind}
                key={pool.name}
                poolName={pool.name}
                sizeMetric={pool.size}
                taskMetric={pool.task}
                data={metricData}
                colorIndex={index}
              />
            ))}
          </div>
        ) : activeSource === 'memory' ? (
          <div className="grid grid-cols-3 gap-3">
            {MEMORY_METRICS.map((metric, index) => (
              <MetricChart kind={chartKind} key={metric} metric={metric} data={metricData} colorIndex={index} />
            ))}
            {MEMORY_ASYNC_METRICS.map((metric, index) => (
              <MetricChart kind={chartKind} key={metric} metric={metric} data={asyncData} colorIndex={MEMORY_METRICS.length + index} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {getMetricsForSource(activeSource).map((metric, index) => (
              <MetricChart kind={chartKind} key={metric} metric={metric} data={metricData} colorIndex={index} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
