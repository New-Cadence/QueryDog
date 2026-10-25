// State for a TimeRangeBar over a date-time window with minute / hour / day
// buckets, plus helpers to bucket timestamps. Used by pages that chart events
// they already hold in memory (incidents, logins, evaluations...).
import { useState } from 'react';
import { CHART_TYPE_CHOICES, type ChartKind, type Choice } from '../components/uiTokens';
import { toDateTimeLocalValue, formatDayMonth } from '../utils/formatters';

export type WindowBucket = 'minute' | 'hour' | 'day';

export const WINDOW_QUICK: Choice<string>[] = [
  { value: '60', label: '1h' },
  { value: '360', label: '6h' },
  { value: '1440', label: '24h' },
  { value: '10080', label: '7d' },
  { value: '20160', label: '14d' },
  { value: '43200', label: '30d' },
];

const BUCKETS: Choice<WindowBucket>[] = [
  { value: 'minute', label: 'Minute' },
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
];

const BUCKET_MS: Record<WindowBucket, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const MAX_BUCKETS = 1500;

// A sensible starting bucket for the default window. After that the bucket is
// only changed by the user (or by zooming into a bar); picking another range
// keeps it, and bucketTimes() falls back to a coarser one if it would be too fine.
export function autoBucket(minutes: number): WindowBucket {
  return minutes <= 360 ? 'minute' : minutes <= 10080 ? 'hour' : 'day';
}

export interface TimeWindow {
  start: number;
  end: number;
  quick: string | null;
  bucket: WindowBucket;
  chartType: ChartKind;
}

export function useTimeWindow(defaultQuick = '1440', quickRanges = WINDOW_QUICK) {
  const [w, setW] = useState<TimeWindow>(() => {
    const end = Date.now();
    const minutes = Number(defaultQuick);
    return { start: end - minutes * 60_000, end, quick: defaultQuick, bucket: autoBucket(minutes), chartType: 'stacked-bar' };
  });

  const barProps = {
    from: toDateTimeLocalValue(new Date(w.start)),
    to: toDateTimeLocalValue(new Date(w.end)),
    onChange: (from: string, to: string) => {
      const start = new Date(from).getTime();
      const end = new Date(to).getTime();
      if (Number.isNaN(start) || Number.isNaN(end)) return;
      setW(prev => ({ ...prev, start: Math.min(start, end), end: Math.max(start, end), quick: null }));
    },
    quickRanges,
    activeQuick: w.quick,
    onQuick: (id: string) => {
      const end = Date.now();
      const minutes = Number(id);
      setW(prev => ({ ...prev, start: end - minutes * 60_000, end, quick: id }));
    },
    chartType: w.chartType,
    chartTypes: CHART_TYPE_CHOICES,
    onChartType: (chartType: ChartKind) => setW(prev => ({ ...prev, chartType })),
    bucket: w.bucket,
    buckets: BUCKETS,
    onBucket: (bucket: WindowBucket) => setW(prev => ({ ...prev, bucket })),
  };

  // Zoom into one bucket of the chart, a step finer
  const zoomTo = (bucketStart: number) => {
    if (w.bucket === 'minute') return;
    setW(prev => ({
      ...prev,
      start: bucketStart,
      end: nextBucket(bucketStart, prev.bucket) - 1000,
      quick: null,
      bucket: prev.bucket === 'day' ? 'hour' : 'minute',
    }));
  };

  return { ...w, barProps, zoomTo };
}

// Start of the bucket containing `ms`, in local time
export function bucketFloor(ms: number, bucket: WindowBucket): number {
  const d = new Date(ms);
  if (bucket === 'day') d.setHours(0, 0, 0, 0);
  else if (bucket === 'hour') d.setMinutes(0, 0, 0);
  else d.setSeconds(0, 0);
  return d.getTime();
}

// Every bucket start in [start, end]; falls back to a coarser bucket when there would be too many
export function bucketTimes(start: number, end: number, bucket: WindowBucket): { times: number[]; bucket: WindowBucket } {
  let b = bucket;
  while (b !== 'day' && (end - start) / BUCKET_MS[b] > MAX_BUCKETS) b = b === 'minute' ? 'hour' : 'day';
  const times: number[] = [];
  for (let t = bucketFloor(start, b); t <= end; t = nextBucket(t, b)) times.push(t);
  return { times, bucket: b };
}

// Start of the following bucket; days step by calendar day so DST days stay whole
function nextBucket(t: number, bucket: WindowBucket): number {
  if (bucket !== 'day') return t + BUCKET_MS[bucket];
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function bucketLabel(ms: number, bucket: WindowBucket): string {
  const d = new Date(ms);
  if (bucket === 'day') return formatDayMonth(d);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return bucket === 'hour' && d.getHours() === 0 ? `${formatDayMonth(d)} ${time}` : time;
}
