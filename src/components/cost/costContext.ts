// Shared state and formatting helpers for the Cost tabs.
import { createContext, useContext } from 'react';
import type { CostSettings, CostStatus } from './costApi';
import type { CostBasis } from './costBasis';
import type { CostView } from './costRange';

export interface CostContextValue {
  status: CostStatus;
  settings: CostSettings;
  updateSettings: (next: CostSettings) => void;
  // null while loading; reloaded when settings change
  basis: CostBasis | null;
  // Date range, chart type and bucket chosen in the toolbar (CostRangeSelector)
  view: CostView;
  setView: (next: CostView) => void;
  // Today in UTC (billing days are UTC), fixed for the life of the page
  today: string;
}

export const CostContext = createContext<CostContextValue | null>(null);

export function useCost(): CostContextValue {
  const ctx = useContext(CostContext);
  if (!ctx) throw new Error('useCost must be used inside CostPage');
  return ctx;
}

export function money(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = digits ?? (Math.abs(v) < 10 ? 2 : 0);
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const tooltipStyle = { backgroundColor: '#1f2937', border: '1px solid #374151', fontSize: 11 };
export const axisTick = { fill: '#9ca3af', fontSize: 10 };
export const gridDefaults = { resizable: true, sortable: true, suppressMovable: true };
export const rightAlign = { textAlign: 'right' } as const;
