// The time range strip from the Observability screens (From / To, quick
// ranges, chart type, bucket), shared by every page that charts over time.
// Values are passed in the input's own string format: 'YYYY-MM-DDTHH:mm:ss'
// for datetime-local or 'YYYY-MM-DD' for date.
import type { ReactNode } from 'react';
import type { Choice } from './uiTokens';

export type { Choice };

const selectClass = 'bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs';


export function TimeRangeBar<Q extends string, C extends string, B extends string>({
  from,
  to,
  onChange,
  inputType = 'datetime-local',
  min,
  max,
  quickRanges,
  activeQuick,
  onQuick,
  chartType,
  chartTypes,
  onChartType,
  bucket,
  buckets,
  onBucket,
  bucketTitle,
  extra,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  inputType?: 'datetime-local' | 'date';
  min?: string;
  max?: string;
  quickRanges: Choice<Q>[];
  activeQuick: Q | null;
  onQuick: (id: Q) => void;
  chartType?: C;
  chartTypes?: Choice<C>[];
  onChartType?: (type: C) => void;
  bucket?: B;
  buckets?: Choice<B>[];
  onBucket?: (bucket: B) => void;
  bucketTitle?: string;
  // Extra controls after the bucket, in the same divided style (e.g. aggregation)
  extra?: ReactNode;
}) {
  const step = inputType === 'datetime-local' ? 1 : undefined;
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex items-center gap-1">
        <label className="text-gray-400">From:</label>
        <input type={inputType} step={step} min={min} max={max} value={from} onChange={e => e.target.value && onChange(e.target.value, to)} className={selectClass} />
      </div>
      <div className="flex items-center gap-1">
        <label className="text-gray-400">To:</label>
        <input type={inputType} step={step} min={min} max={max} value={to} onChange={e => e.target.value && onChange(from, e.target.value)} className={selectClass} />
      </div>
      <div className="flex gap-1 ml-2">
        {quickRanges.map(q => (
          <button
            key={q.value}
            title={q.title}
            onClick={() => onQuick(q.value)}
            className={`px-1.5 py-0.5 rounded whitespace-nowrap ${activeQuick === q.value ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
          >
            {q.label}
          </button>
        ))}
      </div>
      {chartTypes && chartType !== undefined && onChartType && (
        <div className="flex items-center gap-1 ml-2 border-l border-gray-600 pl-2">
          <label className="text-gray-400">Type:</label>
          <select value={chartType} onChange={e => onChartType(e.target.value as C)} className={selectClass}>
            {chartTypes.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      )}
      {buckets && bucket !== undefined && onBucket && (
        <div className="flex items-center gap-1 ml-2 border-l border-gray-600 pl-2" title={bucketTitle}>
          <label className="text-gray-400">Bucket:</label>
          <select value={bucket} onChange={e => onBucket(e.target.value as B)} className={selectClass}>
            {buckets.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
      )}
      {extra}
    </div>
  );
}

// Divided label + select, for controls passed as `extra`
export function TimeRangeBarSelect<T extends string>({ label, value, choices, onChange }: { label: string; value: T; choices: Choice<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1 ml-2 border-l border-gray-600 pl-2">
      <label className="text-gray-400">{label}:</label>
      <select value={value} onChange={e => onChange(e.target.value as T)} className={selectClass}>
        {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </div>
  );
}
