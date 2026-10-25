// Small alerting widgets shared by the Alerting page, the Checks grid and
// the notification channels in Settings.
import type { ReactNode } from 'react';
import { HistoryBars } from '../checks/cells';
import { Bell, X, Send, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Pill } from '../ui';
import { formatDateTime } from '../../utils/formatters';
import { channelMeta, useEscape, type Delivery, type HistoryPoint } from './model';

export function Modal({ title, icon: Icon, width = 'w-[520px]', onClose, children, footer }: {
  title: string; icon: typeof Bell; width?: string; onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-900 border border-gray-700 rounded-lg ${width} max-w-[95vw] max-h-[90vh] flex flex-col`} onClick={e => e.stopPropagation()}>
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

export function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} className={`w-7 h-4 rounded-full relative transition-colors shrink-0 ${on ? 'bg-green-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
    </button>
  );
}

// Mini bar chart of the last evaluations: height = rows, red = fired, yellow = error.
export function Sparkline({ history }: { history: HistoryPoint[] }) {
  return <HistoryBars bars={history.map(p => ({
    time: p.time,
    value: p.rows,
    tone: p.error ? 'error' : p.fired ? 'fail' : 'ok',
    label: `${p.error ? `error: ${p.error}` : `${p.rows} rows`}${p.fired ? ' (firing)' : ''}`,
  }))} />;
}

export function DeliveryRow({ d, showCheck = false }: { d: Delivery; showCheck?: boolean }) {
  const Icon = channelMeta[d.channelType]?.icon || Send;
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
      {d.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
      <span className="text-gray-500 w-36 shrink-0">{formatDateTime(d.time)}</span>
      <Pill tone={d.event === 'firing' ? 'red' : d.event === 'resolved' ? 'green' : 'default'}>{d.event}</Pill>
      <Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <span className="text-gray-300 shrink-0">{d.channelName}</span>
      {showCheck && <span className="font-mono text-gray-400 truncate">{d.check}</span>}
      <span className={`ml-auto truncate ${d.ok ? 'text-gray-500' : 'text-red-400'}`} title={d.detail || ''}>{d.ok ? 'delivered' : d.detail}</span>
    </div>
  );
}
