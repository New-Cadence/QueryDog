// Cells and small widgets shared by the SQL check runner grids.
import type { ICellRendererParams } from 'ag-grid-community';
import { AlertTriangle, Check, Clock, Eye, Loader2, Minus, Play, PlayCircle, Timer, VolumeX, X } from 'lucide-react';
import { Pill, ToolbarButton } from '../ui';
import type { CheckCellParams, Severity } from './model';
import { formatDateTime } from '../../utils/formatters';

const iconButton = 'p-1 rounded hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed';
const cellBox = 'h-full flex items-center justify-center';

type CellProps<T> = ICellRendererParams<T> & CheckCellParams<T>;

// Last result as a plain tick / cross (no pill), shared by every check grid
export type ResultKind = 'pass' | 'warn' | 'fail' | 'error' | 'pending' | 'none';
const RESULT_MARK: Record<ResultKind, { icon: typeof Check; className: string; label: string }> = {
  pass: { icon: Check, className: 'text-green-400', label: 'Passed' },
  // A performance query slower than its warn_duration_ms
  warn: { icon: Timer, className: 'text-yellow-400', label: 'Slow' },
  fail: { icon: X, className: 'text-red-400', label: 'Failed' },
  error: { icon: AlertTriangle, className: 'text-yellow-400', label: 'Error' },
  pending: { icon: Clock, className: 'text-yellow-400', label: 'Pending' },
  none: { icon: Minus, className: 'text-gray-600', label: 'Not run yet' },
};

export function ResultMark({ result, title }: { result: ResultKind; title?: string }) {
  const { icon: Icon, className, label } = RESULT_MARK[result];
  return (
    <span title={title ?? label} aria-label={title ?? label} className={`inline-flex items-center ${className}`}>
      <Icon className="w-4 h-4" strokeWidth={2.5} />
    </span>
  );
}

export function ViewCell<T>({ data, handlers }: CellProps<T>) {
  if (!data) return null;
  return (
    <div className={cellBox}>
      <button className={iconButton} title="View details" onClick={e => { e.stopPropagation(); handlers.onView(data); }}>
        <Eye className="w-3.5 h-3.5 text-blue-400" />
      </button>
    </div>
  );
}

export function SilenceCell<T>({ data, handlers }: CellProps<T>) {
  if (!data) return null;
  const silence = handlers.silenceOf(data);
  return (
    <div className={cellBox}>
      {silence ? (
        <button className={iconButton} onClick={e => { e.stopPropagation(); handlers.onUnsilence(silence); }}
          title={`Silenced until ${new Date(silence.until).toLocaleString()}${silence.reason ? ` (${silence.reason})` : ''}. Click to unsilence.`}>
          <VolumeX className="w-3.5 h-3.5 text-yellow-400" />
        </button>
      ) : (
        <button className={iconButton} title="Silence" onClick={e => { e.stopPropagation(); handlers.onSilence(data); }}>
          <VolumeX className="w-3.5 h-3.5 text-gray-500 hover:text-gray-200" />
        </button>
      )}
    </div>
  );
}

export function RunCell<T>({ data, handlers }: CellProps<T>) {
  if (!data) return null;
  const running = handlers.isRunning(data);
  return (
    <div className={cellBox}>
      <button className={iconButton} title="Run now" disabled={running || handlers.runBlocked}
        onClick={e => { e.stopPropagation(); handlers.onRun(data); }}>
        {running ? <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" /> : <Play className="w-3.5 h-3.5 text-green-400" />}
      </button>
    </div>
  );
}

const SEVERITY_TONE = { critical: 'red', warning: 'yellow', info: 'blue' } as const;

export function SeverityPill({ severity }: { severity: Severity | null | undefined }) {
  return severity ? <Pill tone={SEVERITY_TONE[severity]}>{severity}</Pill> : null;
}

// "Run all", or "Run selected (N)" while rows are ticked
export function RunChecksButton({ selected, running, progress, disabled, onClick }: {
  selected: number;
  running: boolean;
  progress?: { current: number; total: number } | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  const label = running
    ? (progress ? `${progress.current}/${progress.total}` : 'Running…')
    : selected ? `Run selected (${selected})` : 'Run all';
  return (
    <ToolbarButton icon={running ? Loader2 : PlayCircle} variant="primary" disabled={disabled || running} onClick={onClick}
      title={selected ? 'Run the ticked checks' : 'Run every check shown, except silenced ones'}>
      {label}
    </ToolbarButton>
  );
}

export interface HistoryBar {
  time: string;
  // Bar height relative to the tallest bar; null draws a stub
  value: number | null;
  tone: 'ok' | 'warn' | 'fail' | 'error';
  label: string;
}

const BAR_FILL = { ok: '#22c55e', warn: '#facc15', fail: '#ef4444', error: '#f97316' };

// The last 30 runs as small bars: green ok, yellow slow, red failing, orange error
export function HistoryBars({ bars, width = 120, height = 18 }: { bars: HistoryBar[]; width?: number; height?: number }) {
  const shown = bars.slice(-30);
  if (!shown.length) return <span className="text-[10px] text-gray-600">no runs</span>;
  const max = Math.max(1, ...shown.map(b => b.value ?? 0));
  const bw = width / 30;
  return (
    <svg width={width} height={height} className="block">
      {shown.map((b, i) => {
        const h = b.tone === 'error' ? height : Math.max(6, ((b.value ?? 0) / max) * height);
        return (
          <rect key={b.time + i} x={i * bw} y={height - h} width={Math.max(bw - 1, 1)} height={h} fill={BAR_FILL[b.tone]}>
            <title>{`${formatDateTime(b.time)}: ${b.label}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
