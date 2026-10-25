import { useQueryStore } from '../stores/queryStore';
import type { BucketSize } from '../types/queryLog';
import type { ChartAggregation, ChartType } from '../stores/queryStore';
import { toDateTimeLocalValue } from '../utils/formatters';
import { TimeRangeBar, TimeRangeBarSelect, type Choice } from './TimeRangeBar';

type QuickId = '15' | '60' | '360' | '1440';
const QUICK_RANGES: Choice<QuickId>[] = [
  { value: '15', label: '15m' },
  { value: '60', label: '1h' },
  { value: '360', label: '6h' },
  { value: '1440', label: '24h' },
];
const BUCKETS: Choice<BucketSize>[] = [
  { value: 'second', label: 'Second' },
  { value: 'minute', label: 'Minute' },
  { value: 'hour', label: 'Hour' },
];

const AGGREGATION_LABELS: Record<ChartAggregation, string> = {
  avg: 'Average',
  sum: 'Sum',
  min: 'Min',
  max: 'Max',
};

interface TimeRangeSelectorProps {
  usePartLogMetric?: boolean;
}

export function TimeRangeSelector({ usePartLogMetric = false }: TimeRangeSelectorProps) {
  const { timeRange, setTimeRange, setRelativeTimeRange, relativeTimeMinutes, bucketSize, setBucketSize, chartType, setChartType, chartMetric, partLogChartMetric, chartAggregation, setChartAggregation } = useQueryStore();

  // When Count metric is selected, allow line and stacked but not scatter
  // Use partLogChartMetric when on the Part Log page
  const effectiveMetric = usePartLogMetric ? partLogChartMetric : chartMetric;
  const isCountMetric = effectiveMetric === 'count';
  const effectiveChartType = isCountMetric && chartType === 'scatter' ? 'line' : chartType;

  const quick = relativeTimeMinutes === null ? null : String(relativeTimeMinutes) as QuickId;
  const showBucket = effectiveChartType !== 'scatter';
  // Stacked types split by query kind for every metric; scatter plots individual queries
  const chartTypes: Choice<ChartType>[] = [
    { value: 'bar', label: 'Bar' },
    { value: 'stacked-bar', label: 'Stacked Bar' },
    { value: 'line', label: 'Line' },
    { value: 'stacked-line', label: 'Stacked Line' },
    ...(!isCountMetric ? [{ value: 'scatter' as const, label: 'Scatter' }] : []),
  ];

  return (
    <TimeRangeBar
      from={toDateTimeLocalValue(timeRange.start)}
      to={toDateTimeLocalValue(timeRange.end)}
      onChange={(from, to) => {
        const start = new Date(from);
        const end = new Date(to);
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) setTimeRange({ start, end });
      }}
      quickRanges={QUICK_RANGES}
      activeQuick={quick}
      onQuick={id => setRelativeTimeRange(Number(id))}
      chartType={effectiveChartType}
      chartTypes={chartTypes}
      onChartType={setChartType}
      bucket={showBucket ? bucketSize : undefined}
      buckets={BUCKETS}
      onBucket={setBucketSize}
      extra={showBucket && !isCountMetric && (
        <TimeRangeBarSelect label="Aggregation" value={chartAggregation} onChange={setChartAggregation}
          choices={(Object.keys(AGGREGATION_LABELS) as ChartAggregation[]).map(a => ({ value: a, label: AGGREGATION_LABELS[a] }))} />
      )}
    />
  );
}
