// Small widgets shared by the Data Quality tabs.
import type { ReactNode } from 'react';
import { X, Copy, type LucideIcon } from 'lucide-react';
import { formatPct, useEscape, type RuleState } from './model';
import { ResultMark } from '../checks/cells';

export function Modal({ title, icon: Icon, width = 'w-[560px]', onClose, children, footer }: {
  title: string; icon: LucideIcon; width?: string; onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-900 border border-gray-700 rounded-lg ${width} max-w-[95vw] max-h-[92vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b border-gray-700">
          <div className="flex items-center gap-2 min-w-0"><Icon className="w-4 h-4 text-blue-400 shrink-0" /><h2 className="text-sm font-semibold text-white truncate">{title}</h2></div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">{children}</div>
        <div className="flex justify-end gap-2 p-3 border-t border-gray-700">{footer}</div>
      </div>
    </div>
  );
}

// Right-hand slide-over used for rule and run details.
export function Drawer({ title, icon: Icon, pills, actions, onClose, children }: {
  title: string; icon: LucideIcon; pills?: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-gray-900 border-l border-gray-700 w-[760px] max-w-[95vw] h-full flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-blue-400 shrink-0" />
            <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
            {pills}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {actions}
            <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button onClick={e => { e.stopPropagation(); onClick(); }} title={title}
      className={`relative w-7 h-4 rounded-full transition-colors shrink-0 ${on ? 'bg-green-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
    </button>
  );
}

const stateLabel: Record<RuleState, string> = { pass: 'Passed', fail: 'Failed', error: 'Error', never: 'Not run yet' };

// Shown as a tick / cross like the other check grids
export function StatusPill({ state, title }: { state: RuleState; title?: string }) {
  return <ResultMark result={state === 'never' ? 'none' : state} title={title ?? stateLabel[state]} />;
}

// Inline compliance bar with the percentage beside it.
export function ComplianceBar({ value, width = 'w-20' }: { value: number | null | undefined; width?: string }) {
  if (value === null || value === undefined) return <span className="text-gray-500">-</span>;
  const color = value >= 99.5 ? 'bg-green-500' : value >= 95 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-1.5 ${width} bg-gray-800 rounded overflow-hidden inline-block`}>
        <span className={`block h-full ${color}`} style={{ width: `${Math.max(2, value)}%` }} />
      </span>
      <span className="text-gray-300 tabular-nums">{formatPct(value, 2)}</span>
    </span>
  );
}

export function SampleTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const cols = columns.length ? columns : Object.keys(rows[0] || {});
  return (
    <div className="overflow-auto max-h-72 border border-gray-700 rounded">
      <table className="text-[11px] font-mono w-full">
        <thead className="bg-gray-800 sticky top-0">
          <tr>{cols.map(c => <th key={c} className="text-left px-2 py-1 text-gray-200 font-semibold whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800">
              {cols.map(c => {
                const v = r[c];
                const text = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                return <td key={c} className={`px-2 py-0.5 whitespace-nowrap max-w-[320px] truncate ${v === null ? 'text-gray-600 italic' : 'text-gray-400'}`} title={text}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SqlBlock({ sql, label }: { sql: string; label?: string }) {
  return (
    <div className="relative">
      {label && <div className="text-[11px] text-gray-400 mb-1">{label}</div>}
      <pre className="text-[11px] font-mono text-gray-300 bg-gray-950 border border-gray-700 rounded p-2 overflow-auto max-h-56 whitespace-pre-wrap">{sql}</pre>
      <button onClick={() => void navigator.clipboard?.writeText(sql)} title="Copy SQL"
        className="absolute right-1.5 bottom-1.5 p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800">
        <Copy className="w-3 h-3" />
      </button>
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="text-xs text-red-400 bg-red-900/30 border border-red-800 rounded px-2 py-1.5 whitespace-pre-wrap break-words">{children}</div>;
}
