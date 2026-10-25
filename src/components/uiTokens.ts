// Shared style tokens for the Convoy pages (kept separate from ui.tsx
// so that file only exports components).

export const inputClass =
  'w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500';

// Chart palette shared by all recharts usage in the new modes.
export const CHART_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#64748b'];

// An option in a select or button group (TimeRangeBar quick ranges, types, buckets)
export interface Choice<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export type ChartKind = 'stacked-bar' | 'bar' | 'stacked-line' | 'line';

export const CHART_TYPE_CHOICES: Choice<ChartKind>[] = [
  { value: 'stacked-bar', label: 'Stacked Bar' },
  { value: 'bar', label: 'Bar' },
  { value: 'stacked-line', label: 'Stacked Line' },
  { value: 'line', label: 'Line' },
];
