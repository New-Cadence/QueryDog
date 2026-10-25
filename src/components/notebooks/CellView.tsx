import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronUp, ChevronDown, Code2, Trash2, Play, Loader2, Pencil, Check, Eye, EyeOff, SlidersHorizontal, RefreshCw, ListTree, X,
} from 'lucide-react';
import { fetchExplainByType } from '../../services/api';
import { inputClass } from '../uiTokens';
import { runQuery } from './api';
import { CellOutput } from './CellOutput';
import { Markdown } from './Markdown';
import { CELL_NAME_PATTERN, type NotebookCell, type ParamKind } from './model';

export interface CellViewProps {
  cell: NotebookCell;
  index: number;
  total: number;
  running: boolean;
  duplicateName: boolean;
  onChange: (patch: Partial<NotebookCell>) => void;
  onRename: (name: string) => boolean; // false when the name is taken
  onRun: () => void; // SQL: run the cell; parameter: re-run its dependents
  onMove: (delta: number) => void;
  onDelete: () => void;
  resolveSql: () => string;
}

export function CellView(props: CellViewProps) {
  if (props.cell.type === 'markdown') return <MarkdownCell {...props} />;
  if (props.cell.type === 'param') return <ParamCell {...props} />;
  return <SqlCell {...props} />;
}

function IconBtn({ children, onClick, title, disabled, active }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; active?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className={`p-1 rounded hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent ${active ? 'text-blue-400' : 'text-gray-400'}`}>
      {children}
    </button>
  );
}

function CellControls({ index, total, onMove, onDelete }: Pick<CellViewProps, 'index' | 'total' | 'onMove' | 'onDelete'>) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover/cell:opacity-100 transition-opacity">
      <IconBtn title="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp className="w-3.5 h-3.5" /></IconBtn>
      <IconBtn title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}><ChevronDown className="w-3.5 h-3.5" /></IconBtn>
      <IconBtn title="Delete cell" onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /></IconBtn>
    </div>
  );
}

// Textarea that grows with its content. Measured in a layout effect so the
// height is fixed before paint (no flicker or scroll jump while typing).
function AutoTextarea({ value, onChange, onSubmit, className, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  className: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd } = el;
      onChange(value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd));
      requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2));
    }
  };

  return (
    <textarea ref={ref} value={value} autoFocus={autoFocus} spellCheck={false} rows={1}
      onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} className={className} />
  );
}

// Cell name input: edited locally and committed on blur / Enter so references
// in other cells are rewritten once, and a clash with another name is refused.
// Rendered with key={cell.name} so the draft resets when the name changes.
function NameInput({ cell, onRename, duplicateName }: Pick<CellViewProps, 'cell' | 'onRename' | 'duplicateName'>) {
  const [draft, setDraft] = useState(cell.name);
  const [rejected, setRejected] = useState(false);
  const commit = () => {
    if (!draft || draft === cell.name) { setDraft(cell.name); return; }
    const ok = onRename(draft);
    setRejected(!ok);
    if (!ok) setDraft(cell.name);
  };
  const warn = rejected || duplicateName;
  return (
    <input
      value={draft}
      onChange={e => { setDraft(e.target.value.replace(CELL_NAME_PATTERN, '_')); setRejected(false); }}
      onBlur={commit}
      onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
      className={`bg-transparent text-xs font-mono w-48 focus:outline-none focus:bg-gray-800 rounded px-1 ${warn ? 'text-yellow-400' : 'text-white'}`}
      title={rejected ? 'That name is already used by another cell' : duplicateName ? 'Another cell has the same name; {{references}} use the first one' : `Reference with {{${cell.name}}}`}
    />
  );
}

function MarkdownCell({ cell, index, total, onChange, onMove, onDelete }: CellViewProps) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="group/cell relative rounded-lg border border-transparent hover:border-gray-700 px-4 py-3">
      <div className="absolute top-1 right-1 flex items-center gap-1">
        <IconBtn title={editing ? 'Done (Shift+Enter)' : 'Edit'} onClick={() => setEditing(!editing)}>
          {editing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
        </IconBtn>
        <CellControls index={index} total={total} onMove={onMove} onDelete={onDelete} />
      </div>
      {editing ? (
        <AutoTextarea autoFocus value={cell.source} onChange={source => onChange({ source })} onSubmit={() => setEditing(false)}
          className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs font-mono text-gray-200 resize-none focus:outline-none focus:border-blue-500" />
      ) : (
        <div onDoubleClick={() => setEditing(true)} className="cursor-text min-h-[1.5rem]">
          {cell.source.trim() ? <Markdown source={cell.source} /> : <span className="text-xs text-gray-600">Empty text cell, double-click to edit</span>}
        </div>
      )}
    </div>
  );
}

const PARAM_KINDS: { id: ParamKind; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'date', label: 'Date' },
  { id: 'dropdown', label: 'Dropdown' },
];

function ParamCell({ cell, index, total, running, duplicateName, onChange, onRename, onRun, onMove, onDelete }: CellViewProps) {
  const [configuring, setConfiguring] = useState(false);
  const [queryOptions, setQueryOptions] = useState<string[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const kind = cell.paramKind || 'text';

  const optionsSql = kind === 'dropdown' ? cell.optionsSql?.trim() : '';
  const loadOptions = useCallback(() => {
    if (!optionsSql) return;
    runQuery(optionsSql, 1000)
      .then(r => { setQueryOptions(r.data.map(row => String(Object.values(row)[0] ?? ''))); setOptionsError(null); })
      .catch(err => setOptionsError(err instanceof Error ? err.message : 'Failed to load options'));
  }, [optionsSql]);
  // Debounced so editing the options query doesn't fire a query per keystroke
  useEffect(() => {
    const t = setTimeout(loadOptions, 400);
    return () => clearTimeout(t);
  }, [loadOptions]);

  const options = [...new Set([...((optionsSql && queryOptions) || cell.options || []), ...(cell.source ? [cell.source] : [])])];
  // Dropdown and date changes apply immediately; text/number apply on Enter or Apply.
  const setAndRun = (source: string) => { onChange({ source }); onRun(); };

  return (
    <div className="group/cell bg-gray-900 border border-gray-700 rounded-lg">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <SlidersHorizontal className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
        <NameInput key={cell.name} cell={cell} onRename={onRename} duplicateName={duplicateName} />
        <div className="w-64">
          {kind === 'dropdown' ? (
            <select value={cell.source} onChange={e => setAndRun(e.target.value)} className={inputClass}>
              {!cell.source && <option value="">Choose...</option>}
              {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'}
              value={cell.source}
              onChange={e => (kind === 'date' ? setAndRun(e.target.value) : onChange({ source: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && onRun()}
              className={inputClass}
            />
          )}
        </div>
        <button onClick={onRun} disabled={running} title="Re-run every cell that uses this parameter (Enter)"
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-60">
          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Apply
        </button>
        {optionsError && <span className="text-[11px] text-red-400 truncate" title={optionsError}>Options query failed</span>}
        <div className="ml-auto flex items-center gap-1">
          <span className="text-[10px] text-gray-500">{PARAM_KINDS.find(k => k.id === kind)?.label} parameter</span>
          <IconBtn title="Configure parameter" active={configuring} onClick={() => setConfiguring(!configuring)}><Pencil className="w-3.5 h-3.5" /></IconBtn>
          <CellControls index={index} total={total} onMove={onMove} onDelete={onDelete} />
        </div>
      </div>
      {configuring && (
        <div className="border-t border-gray-700 px-3 py-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-start text-[11px] text-gray-400">
          <span className="pt-1">Type</span>
          <div className="flex gap-1">
            {PARAM_KINDS.map(k => (
              <button key={k.id} onClick={() => onChange({ paramKind: k.id })}
                className={`px-2 py-0.5 rounded border ${kind === k.id ? 'border-blue-500 text-blue-300 bg-blue-900/40' : 'border-gray-600 text-gray-400 hover:text-gray-200'}`}>
                {k.label}
              </button>
            ))}
          </div>
          {kind === 'dropdown' && (
            <>
              <span className="pt-1">Options</span>
              <input value={(cell.options || []).join(', ')} placeholder="Comma separated, e.g. Select, Insert"
                onChange={e => onChange({ options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className={inputClass} />
              <span className="pt-1">Options query</span>
              <div className="flex gap-1 items-start">
                <textarea value={cell.optionsSql || ''} rows={2} spellCheck={false} placeholder="Optional: first column of this query supplies the options"
                  onChange={e => onChange({ optionsSql: e.target.value })} className={`${inputClass} font-mono resize-y`} />
                <IconBtn title="Reload options" onClick={loadOptions}><RefreshCw className="w-3.5 h-3.5" /></IconBtn>
              </div>
            </>
          )}
          <span />
          <span className="text-[10px] text-gray-500">
            Use as <code className="text-blue-300">{`{{${cell.name}}}`}</code>. {kind === 'number' ? 'Inserted as a bare number.' : 'Inserted as a quoted SQL string literal.'}
          </span>
        </div>
      )}
    </div>
  );
}

function SqlCell({ cell, index, total, running, duplicateName, onChange, onRename, onRun, onMove, onDelete, resolveSql }: CellViewProps) {
  const [explain, setExplain] = useState<{ loading: boolean; lines?: string[]; error?: string } | null>(null);

  const toggleExplain = () => {
    if (explain) { setExplain(null); return; }
    setExplain({ loading: true });
    try {
      fetchExplainByType(resolveSql(), 'indexes')
        .then(rows => setExplain({ loading: false, lines: rows.map(r => String(r.explain ?? Object.values(r)[0] ?? '')) }))
        .catch(err => setExplain({ loading: false, error: err instanceof Error ? err.message : 'Explain failed' }));
    } catch (err) {
      setExplain({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="group/cell bg-gray-900 border border-gray-700 rounded-lg overflow-hidden focus-within:border-blue-600">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700 bg-gray-800/50">
        <button onClick={onRun} disabled={running} title="Run cell (Shift+Enter)"
          className="flex items-center justify-center w-6 h-6 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3 h-3" />}
        </button>
        <span className="text-[10px] text-gray-500 font-mono">[{index + 1}]</span>
        <Code2 className="w-3 h-3 text-blue-400" />
        <NameInput key={cell.name} cell={cell} onRename={onRename} duplicateName={duplicateName} />
        <div className="ml-auto flex items-center gap-1">
          <IconBtn title="EXPLAIN indexes = 1 for the resolved SQL" active={!!explain} onClick={toggleExplain}><ListTree className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title={cell.collapsed ? 'Show SQL' : 'Hide SQL'} onClick={() => onChange({ collapsed: !cell.collapsed })}>
            {cell.collapsed ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </IconBtn>
          <CellControls index={index} total={total} onMove={onMove} onDelete={onDelete} />
        </div>
      </div>
      {!cell.collapsed && (
        <AutoTextarea value={cell.source} onChange={source => onChange({ source })} onSubmit={onRun}
          className="w-full bg-gray-950 p-3 text-xs font-mono text-green-300 resize-none focus:outline-none block min-h-[60px] whitespace-pre overflow-x-auto" />
      )}
      {explain && (
        <div className="border-t border-gray-700 bg-gray-950">
          <div className="flex items-center justify-between px-3 py-1 text-[11px] text-gray-400 bg-gray-800/30">
            <span className="flex items-center gap-1.5"><ListTree className="w-3 h-3 text-blue-400" />EXPLAIN indexes = 1</span>
            <button onClick={() => setExplain(null)} className="text-gray-500 hover:text-white"><X className="w-3 h-3" /></button>
          </div>
          {explain.loading && <div className="px-3 py-2 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" />Explaining...</div>}
          {explain.error && <div className="px-3 py-2 text-xs text-red-300 whitespace-pre-wrap">{explain.error}</div>}
          {explain.lines && <pre className="px-3 py-2 text-[11px] font-mono text-gray-300 overflow-x-auto max-h-80">{explain.lines.join('\n')}</pre>}
        </div>
      )}
      {cell.error && <div className="px-3 py-2 text-xs bg-red-900/50 text-red-300 whitespace-pre-wrap border-t border-gray-700">Error: {cell.error}</div>}
      {cell.result && <CellOutput cell={cell} onChange={onChange} />}
    </div>
  );
}
