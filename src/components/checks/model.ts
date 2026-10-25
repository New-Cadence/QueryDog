// Shared pieces of the SQL check runners (Monitoring checks, Testing queries,
// Data Quality checks): severity, silences, grid selection and the leading
// view / silence / run columns, so the three grids behave the same.
import { useCallback, useEffect, useState } from 'react';
import type { ColDef, RowSelectionOptions, SelectionColumnDef } from 'ag-grid-community';
import { RunCell, SilenceCell, ViewCell } from './cells';
import { formatDateTime, parseServerTime } from '../../utils/formatters';

export type Severity = 'critical' | 'warning' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
export const severityTone: Record<Severity, 'red' | 'yellow' | 'blue'> = { critical: 'red', warning: 'yellow', info: 'blue' };
export const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface CheckSilence { id: string; check: string | null; until: string; reason: string }

export const SILENCE_PRESETS = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '4h', minutes: 240 },
  { label: '24h', minutes: 1440 },
];

// Checkboxes in the first column; clicking a row does not select it
export const CHECK_ROW_SELECTION: RowSelectionOptions = { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false };
export const CHECK_SELECTION_COLUMN: SelectionColumnDef = { width: 40, pinned: 'left', resizable: false };

export interface CheckRowHandlers<T> {
  onView: (row: T) => void;
  onRun: (row: T) => void;
  isRunning: (row: T) => boolean;
  // Another run is in progress, so row runs are disabled
  runBlocked?: boolean;
  silenceOf: (row: T) => CheckSilence | null;
  onSilence: (row: T) => void;
  onUnsilence: (silence: CheckSilence) => void;
}

export type CheckCellParams<T> = { handlers: CheckRowHandlers<T> };

// View detail, silence and run, pinned next to the checkbox
export function checkLeadColumns<T>(handlers: CheckRowHandlers<T>): ColDef<T>[] {
  const base = { headerName: '', sortable: false, resizable: false, suppressMovable: true, pinned: 'left' as const, cellStyle: { padding: 0 }, cellRendererParams: { handlers } };
  return [
    { ...base, colId: 'view', width: 30, cellRenderer: ViewCell },
    { ...base, colId: 'silence', width: 30, cellRenderer: SilenceCell },
    { ...base, colId: 'run', width: 30, cellRenderer: RunCell },
  ];
}

// Rows to run: the ticked ones, else everything shown that isn't silenced
// Last Run as a relative time ("2m ago") plus the full timestamp, which
// starts hidden and can be switched on from the column picker
export const LAST_RUN_HIDDEN_COLUMNS = ['lastRunActual'];

export function formatRunAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const t = parseServerTime(value).getTime();
  if (Number.isNaN(t)) return 'never';
  const secs = Math.round((now - t) / 1000);
  if (secs < 60) return secs <= 1 ? 'just now' : `${secs} seconds ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

// `nowOf` lets a grid that re-renders on a clock pass its own "now"
export function lastRunColumns<T>(
  time: (row: T) => string | null | undefined,
  extra: ColDef<T> = {},
  nowOf: (context: unknown) => number = () => Date.now(),
): ColDef<T>[] {
  const valueGetter = (p: { data?: T }) => (p.data ? time(p.data) ?? null : null);
  return [
    {
      headerName: 'Last Run', colId: 'lastRunFriendly', width: 120, sortable: true, ...extra, valueGetter,
      valueFormatter: p => formatRunAgo(p.value as string | null, nowOf(p.context)),
      tooltipValueGetter: p => (p.value ? formatDateTime(p.value as string) : 'Not run yet'),
    },
    {
      headerName: 'Last Run Actual', colId: 'lastRunActual', width: 175, sortable: true, ...extra, valueGetter,
      valueFormatter: p => formatDateTime(p.value as string | null),
    },
  ];
}

export function runTargets<T>(selected: T[], shown: T[], isSilenced: (row: T) => boolean): T[] {
  return selected.length ? selected : shown.filter(r => !isSilenced(r));
}

// Silences for the Testing and Data Quality runners (server/extensions/silences.js)
export function useSilences(area: 'testing' | 'dataquality') {
  const [silences, setSilences] = useState<CheckSilence[]>([]);
  const load = useCallback(async () => {
    const res = await fetch(`/api/silences/${area}`);
    if (res.ok) setSilences(await res.json());
  }, [area]);

  useEffect(() => {
    let live = true;
    fetch(`/api/silences/${area}`).then(r => (r.ok ? r.json() : [])).then(list => live && setSilences(list)).catch(() => {});
    return () => { live = false; };
  }, [area]);

  const silence = useCallback(async (check: string, until: string, reason: string) => {
    const res = await fetch(`/api/silences/${area}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check, until, reason }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await load();
  }, [area, load]);

  const unsilence = useCallback(async (id: string) => {
    await fetch(`/api/silences/${area}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await load();
  }, [area, load]);

  return { silences, silence, unsilence };
}

export const silenceFor = (silences: CheckSilence[], check: string) => silences.find(s => s.check === check || s.check === null) || null;
