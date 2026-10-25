import { useEffect } from 'react';
import { X, FilePlus2, HeartPulse, Timer, HardDrive, TableProperties, ArrowDownToLine, type LucideIcon } from 'lucide-react';
import { TEMPLATES, type NotebookTemplate } from './templates';

const ICONS: Record<string, LucideIcon> = {
  'cluster-health': HeartPulse,
  'slow-queries': Timer,
  storage: HardDrive,
  'table-deep-dive': TableProperties,
  'insert-throughput': ArrowDownToLine,
};

export function TemplatePicker({ onPick, onClose }: { onPick: (template: NotebookTemplate | null) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const card = (key: string, Icon: LucideIcon, title: string, description: string, onClick: () => void) => (
    <button key={key} onClick={onClick}
      className="text-left p-3 rounded-lg border border-gray-700 bg-gray-800/40 hover:border-blue-500 hover:bg-gray-800 transition-colors">
      <div className="flex items-center gap-2 text-sm font-semibold text-white"><Icon className="w-4 h-4 text-blue-400" />{title}</div>
      <p className="text-xs text-gray-400 mt-1">{description}</p>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">New notebook</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[70vh] overflow-y-auto">
          {card('blank', FilePlus2, 'Blank notebook', 'Start from an empty text cell and a SQL cell.', () => onPick(null))}
          {TEMPLATES.map(t => card(t.id, ICONS[t.id] || FilePlus2, t.title, t.description, () => onPick(t)))}
        </div>
        <div className="px-4 pb-3 text-[11px] text-gray-500">
          Templates query ClickHouse system tables. Cells based on <code>system.query_log</code>, <code>part_log</code> or <code>asynchronous_insert_log</code> need those logs enabled on the server.
        </div>
      </div>
    </div>
  );
}
