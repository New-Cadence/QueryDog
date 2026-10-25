import { useMemo, useCallback } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useQueryStore } from '../stores/queryStore';
import type { ChartAggregation, PartLogStackedTimeSeriesPoint } from '../stores/queryStore';
import { Activity, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { useIsLightMode } from '../hooks/useTheme';
import { formatDuration, parseServerTime } from '../utils/formatters';
import { LoadingState } from './ui';

function useChartColors() {
  const isLight = useIsLightMode();
  return useMemo(() => ({
    grid: isLight ? '#e5e7eb' : '#374151',
    tick: isLight ? '#6b7280' : '#9ca3af',
    tooltipBg: isLight ? '#ffffff' : '#1f2937',
    tooltipBorder: isLight ? '#e5e7eb' : '#374151',
  }), [isLight]);
}

const AGGREGATION_LABELS: Record<ChartAggregation, string> = {
  avg: 'Avg',
  sum: 'Sum',
  min: 'Min',
  max: 'Max',
};

// Colors for stacked chart by event type - blue/green scheme like queries
const EVENT_TYPE_COLORS: Record<keyof Omit<PartLogStackedTimeSeriesPoint, 'time'>, string> = {
  NewPart: '#10b981',      // Green (like Select)
  MergeParts: '#60a5fa',   // Light Blue (like Insert)
  DownloadPart: '#34d399', // Light Green
  RemovePart: '#3b82f6',   // Blue
  MutatePart: '#06b6d4',   // Cyan
  Other: '#9ca3af',        // Gray (like Other)
};

function getChartConfig(metric: 'count' | 'duration', aggregation: ChartAggregation) {

  if (metric === 'count') {
    return {
      dataKey: 'count',
      label: 'Events',
      color: '#10b981',
      formatter: (v: number) => v.toLocaleString(),
    };
  }

  return {
    dataKey: `${aggregation}_duration`,
    label: `${AGGREGATION_LABELS[aggregation]} Duration`,
    color: '#3b82f6',
    formatter: formatDuration,
  };
}

export function PartLogTimelineChart() {
  const cc = useChartColors();
  const { partLogTimeSeries, partLogStackedTimeSeries, bucketSize, partLogLoading, chartAggregation, chartType, setTimeRange, partLogChartMetric, setPartLogChartMetric } = useQueryStore();

  const config = useMemo(() => getChartConfig(partLogChartMetric, chartAggregation), [partLogChartMetric, chartAggregation]);

  // For non-Count metrics, don't allow stacked charts (they only make sense for count by event type)
  const effectiveChartType = partLogChartMetric !== 'count' && (chartType === 'stacked-bar' || chartType === 'stacked-line')
    ? 'bar'
    : chartType;

  // Handle click on chart to filter to that time bucket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChartClick = useCallback((data: any) => {
    const timeStr = data?.activeLabel;
    if (!timeStr) return;

    const clickedTime = parseServerTime(timeStr);
    if (isNaN(clickedTime.getTime())) return;

    // Set both start and end to the same clicked time
    setTimeRange({ start: clickedTime, end: clickedTime });
  }, [setTimeRange]);

  const formatTime = (time: string) => {
    const date = parseServerTime(time);
    switch (bucketSize) {
      case 'second':
        return format(date, 'HH:mm:ss');
      case 'hour':
        return format(date, 'dd-MMM HH:mm');
      default:
        return format(date, 'HH:mm');
    }
  };

  const tabs: { metric: 'count' | 'duration'; label: string; icon: typeof Activity }[] = [
    { metric: 'count', label: 'Count', icon: Activity },
    { metric: 'duration', label: 'Duration', icon: Clock },
  ];

  const eventTypes: (keyof Omit<PartLogStackedTimeSeriesPoint, 'time'>)[] = ['NewPart', 'MergeParts', 'DownloadPart', 'RemovePart', 'MutatePart', 'Other'];

  const renderTabs = () => (
    <div className="flex gap-1 border-b border-gray-700 mb-2 items-center">
      {tabs.map(({ metric, label, icon: Icon }) => (
        <button
          key={metric}
          onClick={() => setPartLogChartMetric(metric)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
            partLogChartMetric === metric
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          <Icon className="w-3 h-3" />
          {label}
        </button>
      ))}
    </div>
  );

  if (partLogLoading && partLogTimeSeries.length === 0) {
    return (
      <div>
        {renderTabs()}
        <div className="h-72 bg-gray-900 border border-gray-700 rounded flex">
          <LoadingState />
        </div>
      </div>
    );
  }

  // Render stacked bar chart
  if (effectiveChartType === 'stacked-bar') {
    return (
      <div>
        {renderTabs()}
        <div className="h-72 bg-gray-900 border border-gray-700 rounded cursor-pointer">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={partLogStackedTimeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
                width={50}
                tickFormatter={(v) => v.toLocaleString()}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: cc.tooltipBg,
                  border: `1px solid ${cc.tooltipBorder}`,
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
                cursor={{ fill: 'transparent' }}
                labelFormatter={formatTime}
              />
              {eventTypes.map((eventType) => (
                <Bar
                  key={eventType}
                  dataKey={eventType}
                  stackId="events"
                  fill={EVENT_TYPE_COLORS[eventType]}
                  fillOpacity={0.8}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 mt-2 justify-center text-xs">
          {eventTypes.map((eventType) => (
            <div key={eventType} className="flex items-center gap-1">
              <div className="w-3 h-3 rounded" style={{ backgroundColor: EVENT_TYPE_COLORS[eventType] }} />
              <span className="text-gray-400">{eventType}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Render stacked line (area) chart
  if (effectiveChartType === 'stacked-line') {
    return (
      <div>
        {renderTabs()}
        <div className="h-72 bg-gray-900 border border-gray-700 rounded cursor-pointer">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={partLogStackedTimeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
              <defs>
                {eventTypes.map((eventType) => (
                  <linearGradient key={eventType} id={`partLog-stacked-${eventType}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={EVENT_TYPE_COLORS[eventType]} stopOpacity={0.8} />
                    <stop offset="95%" stopColor={EVENT_TYPE_COLORS[eventType]} stopOpacity={0.3} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
                width={50}
                tickFormatter={(v) => v.toLocaleString()}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: cc.tooltipBg,
                  border: `1px solid ${cc.tooltipBorder}`,
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
                labelFormatter={formatTime}
              />
              {eventTypes.map((eventType) => (
                <Area
                  key={eventType}
                  type="monotone"
                  dataKey={eventType}
                  stackId="events"
                  stroke={EVENT_TYPE_COLORS[eventType]}
                  strokeWidth={1}
                  fillOpacity={1}
                  fill={`url(#partLog-stacked-${eventType})`}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 mt-2 justify-center text-xs">
          {eventTypes.map((eventType) => (
            <div key={eventType} className="flex items-center gap-1">
              <div className="w-3 h-3 rounded" style={{ backgroundColor: EVENT_TYPE_COLORS[eventType] }} />
              <span className="text-gray-400">{eventType}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Render regular bar chart
  if (effectiveChartType === 'bar') {
    return (
      <div>
        {renderTabs()}
        <div className="h-72 bg-gray-900 border border-gray-700 rounded cursor-pointer">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={partLogTimeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: cc.tick }}
                axisLine={{ stroke: cc.grid }}
                tickLine={{ stroke: cc.grid }}
                width={50}
                tickFormatter={config.formatter}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: cc.tooltipBg,
                  border: `1px solid ${cc.tooltipBorder}`,
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
                cursor={{ fill: 'transparent' }}
                labelFormatter={formatTime}
                formatter={(value) => [config.formatter(Number(value)), config.label]}
              />
              <Bar
                dataKey={config.dataKey}
                fill={config.color}
                fillOpacity={0.8}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // Render line (area) chart (default)
  return (
    <div>
      {renderTabs()}
      <div className="h-72 bg-gray-900 border border-gray-700 rounded cursor-pointer">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={partLogTimeSeries} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={handleChartClick}>
            <defs>
              <linearGradient id={`partLog-${partLogChartMetric}-${chartAggregation}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={config.color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={config.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} vertical={false} />
            <XAxis
              dataKey="time"
              tickFormatter={formatTime}
              tick={{ fontSize: 9, fill: cc.tick }}
              axisLine={{ stroke: cc.grid }}
              tickLine={{ stroke: cc.grid }}
            />
            <YAxis
              tick={{ fontSize: 9, fill: cc.tick }}
              axisLine={{ stroke: cc.grid }}
              tickLine={{ stroke: cc.grid }}
              width={50}
              tickFormatter={config.formatter}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: cc.tooltipBg,
                border: `1px solid ${cc.tooltipBorder}`,
                borderRadius: '4px',
                fontSize: '11px',
              }}
              labelFormatter={formatTime}
              formatter={(value) => [config.formatter(Number(value)), config.label]}
            />
            <Area
              type="monotone"
              dataKey={config.dataKey}
              stroke={config.color}
              strokeWidth={1.5}
              fillOpacity={1}
              fill={`url(#partLog-${partLogChartMetric}-${chartAggregation})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
