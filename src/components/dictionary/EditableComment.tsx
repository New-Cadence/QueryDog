import { useState } from 'react';
import { Pencil, Loader2 } from 'lucide-react';
import { inputClass } from '../uiTokens';

// A COMMENT shown as text with an edit pencil; editing swaps in a textarea.
// `onSave` rejects with the ClickHouse error (e.g. missing ALTER grant),
// which is shown inline and keeps the editor open.
export function EditableComment({
  value,
  onSave,
  placeholder = 'No description',
  disabled,
  className = 'text-xs',
}: {
  value: string;
  onSave: (comment: string) => Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save comment');
    } finally {
      setSaving(false);
    }
  };

  if (draft === null) {
    return (
      <div className={`group flex items-start gap-1.5 ${className}`}>
        <span className={value ? 'text-gray-300' : 'text-gray-600 italic'}>{value || placeholder}</span>
        {!disabled && (
          <button onClick={() => setDraft(value)} title="Edit description" className="text-gray-500 hover:text-blue-400 shrink-0 mt-0.5">
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <textarea
        autoFocus
        rows={3}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); setError(null); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
        className={inputClass}
        placeholder="Describe what this contains..."
      />
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
          {saving && <Loader2 className="w-3 h-3 animate-spin" />} Save
        </button>
        <button onClick={() => { setDraft(null); setError(null); }} className="px-2 py-0.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300">
          Cancel
        </button>
        <span className="text-[10px] text-gray-500">Ctrl/Cmd+Enter to save</span>
      </div>
      {error && <div className="text-[11px] text-red-400 break-words">{error}</div>}
    </div>
  );
}
