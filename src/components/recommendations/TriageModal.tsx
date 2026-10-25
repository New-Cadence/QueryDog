import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Field, ToolbarButton } from '../ui';
import { inputClass } from '../uiTokens';
import { today } from './triage';

const DISMISS_REASONS = ['Accepted risk', 'False positive', "Won't fix", 'Handled elsewhere'];

const addDays = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

// Asks for the snooze date or dismissal reason before changing status.
export function TriageModal({
  mode,
  count,
  onConfirm,
  onClose,
}: {
  mode: 'snooze' | 'dismiss';
  count: number;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(mode === 'snooze' ? addDays(7) : DISMISS_REASONS[0]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valid = mode === 'snooze' ? value > today() : value.trim() !== '';
  const noun = `${count} recommendation${count === 1 ? '' : 's'}`;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-[380px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">{mode === 'snooze' ? `Snooze ${noun}` : `Dismiss ${noun}`}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {mode === 'snooze' ? (
            <>
              <Field label="Snooze until" hint="Reopens automatically after this date">
                <input type="date" value={value} min={addDays(1)} onChange={e => setValue(e.target.value)} className={inputClass} />
              </Field>
              <div className="flex gap-1.5">
                {[1, 7, 30, 90].map(d => (
                  <button key={d} onClick={() => setValue(addDays(d))} className="px-2 py-0.5 rounded text-[11px] bg-gray-800 border border-gray-600 text-gray-300 hover:bg-gray-700">
                    {d}d
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Field label="Reason">
                <input value={value} onChange={e => setValue(e.target.value)} className={inputClass} autoFocus />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {DISMISS_REASONS.map(r => (
                  <button key={r} onClick={() => setValue(r)} className="px-2 py-0.5 rounded text-[11px] bg-gray-800 border border-gray-600 text-gray-300 hover:bg-gray-700">
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <ToolbarButton onClick={onClose}>Cancel</ToolbarButton>
          <ToolbarButton variant="primary" disabled={!valid} onClick={() => onConfirm(value.trim())}>
            {mode === 'snooze' ? 'Snooze' : 'Dismiss'}
          </ToolbarButton>
        </div>
      </div>
    </div>
  );
}
