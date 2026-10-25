// Silence one check (or, in Monitoring, every check) until a time, with a reason.
import { useState, type ReactNode } from 'react';
import { VolumeX } from 'lucide-react';
import { Field, ToolbarButton } from '../ui';
import { inputClass } from '../uiTokens';
import { toDateTimeLocalValue } from '../../utils/formatters';
import { Modal } from '../alerting/widgets';
import { SILENCE_PRESETS } from './model';

export function SilenceDialog({ title = 'New silence', scope, note, onSave, onClose }: {
  title?: string;
  // Extra fields above the time, e.g. Monitoring's check / all-checks picker
  scope?: ReactNode;
  note: string;
  onSave: (until: string, reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [until, setUntil] = useState(() => toDateTimeLocalValue(new Date(Date.now() + 3600000)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const ok = await onSave(new Date(until).toISOString(), reason);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal title={title} icon={VolumeX} width="w-[460px]" onClose={onClose}
      footer={<><ToolbarButton onClick={onClose}>Cancel</ToolbarButton><ToolbarButton icon={VolumeX} variant="primary" onClick={save} disabled={!until || saving}>Silence</ToolbarButton></>}>
      {scope}
      <Field label="Silence until">
        <div className="flex gap-1">
          <input type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} className={inputClass} />
          {SILENCE_PRESETS.map(p => (
            <button key={p.label} onClick={() => setUntil(toDateTimeLocalValue(new Date(Date.now() + p.minutes * 60000)))}
              className="px-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-[11px]">{p.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Reason">
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Planned upgrade to 26.8" className={inputClass} />
      </Field>
      <p className="text-[11px] text-gray-500">{note}</p>
    </Modal>
  );
}
