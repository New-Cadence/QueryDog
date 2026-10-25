import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  NotebookPen, Plus, PlayCircle, Trash2, Code2, Type, Loader2, Copy, FileText, Download, Upload, Pencil, SlidersHorizontal,
  ChevronDown, Check, CloudOff,
} from 'lucide-react';
import { PageToolbar, ToolbarButton, ToolbarSearch, EmptyState, LoadingState } from '../ui';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { CellView } from '../notebooks/CellView';
import { TemplatePicker } from '../notebooks/TemplatePicker';
import { TEMPLATES, notebookFromTemplate, sampleNotebook, type NotebookTemplate } from '../notebooks/templates';
import * as api from '../notebooks/api';
import {
  newCell, resolveSql, stripSemicolon, chartAxes, dependentCells, summarize, toSqlScript, downloadFile, fileSlug, parseImportedNotebook, uid,
  type CellType, type Notebook, type NotebookCell, type NotebookSummary,
} from '../notebooks/model';
import { formatDate } from '../../utils/formatters';

// Notebooks used to live in the browser; they are moved to the server once.
const LEGACY_STORAGE_KEY = 'missioncontrol_notebooks';
const SAVE_DEBOUNCE_MS = 800;

async function migrateLocalNotebooks() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const nb of parsed as Notebook[]) {
        if (!nb || !Array.isArray(nb.cells)) continue;
        const id = /^[A-Za-z0-9_-]{1,64}$/.test(nb.id) ? nb.id : uid();
        await api.saveNotebook({ ...nb, id });
      }
    }
  } catch (err) {
    // Keep the key so nothing is lost; the next visit retries
    console.warn('Notebook migration failed', err);
    return;
  }
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

const CELL_TYPE_LABEL: Record<CellType, string> = { sql: 'SQL', markdown: 'Text', param: 'Parameter' };
const templateTitle = (id: string | null) => TEMPLATES.find(t => t.id === id)?.title || (id ? id : 'Blank / custom');

function updatedBucket(iso: string) {
  const age = Date.now() - new Date(iso).getTime();
  if (age < 86_400_000) return 'Last 24 hours';
  if (age < 7 * 86_400_000) return 'Last 7 days';
  if (age < 30 * 86_400_000) return 'Last 30 days';
  return 'Older';
}

const FILTER_FIELDS: ClientFilterField<NotebookSummary>[] = [
  { field: 'template', label: 'Template', getValue: s => templateTitle(s.template) },
  { field: 'cellTypes', label: 'Contains', getValue: s => s.cellTypes.map(t => CELL_TYPE_LABEL[t]) },
  { field: 'updatedAt', label: 'Updated', getValue: s => updatedBucket(s.updatedAt) },
];
const searchText = (s: NotebookSummary) => `${s.title} ${templateTitle(s.template)}`;

export function NotebooksPage() {
  const [summaries, setSummaries] = useState<NotebookSummary[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Notebook>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [runningAll, setRunningAll] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // The ref is the source of truth for loaded notebooks so async work (Run all,
  // parameter re-runs) always reads the latest cells, not a render's snapshot.
  const loadedRef = useRef<Record<string, Notebook>>({});
  const dirty = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSaves = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const ids = [...dirty.current];
    dirty.current.clear();
    if (!ids.length) return;
    setSaveState('saving');
    try {
      await Promise.all(ids.map(id => loadedRef.current[id] && api.saveNotebook(loadedRef.current[id])));
      setSaveState(dirty.current.size ? 'saving' : 'saved');
    } catch {
      ids.forEach(id => dirty.current.add(id));
      setSaveState('error');
    }
  }, []);

  const setNotebookState = useCallback((nb: Notebook) => {
    loadedRef.current = { ...loadedRef.current, [nb.id]: nb };
    setLoaded(loadedRef.current);
  }, []);

  const mutate = useCallback((id: string, fn: (nb: Notebook) => Notebook) => {
    const current = loadedRef.current[id];
    if (!current) return;
    setNotebookState({ ...fn(current), updatedAt: new Date().toISOString() });
    dirty.current.add(id);
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSaves, SAVE_DEBOUNCE_MS);
  }, [flushSaves, setNotebookState]);

  const updateCell = useCallback((nbId: string, cellId: string, patch: Partial<NotebookCell> | ((c: NotebookCell) => Partial<NotebookCell>)) => {
    mutate(nbId, nb => ({ ...nb, cells: nb.cells.map(c => (c.id === cellId ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)) }));
  }, [mutate]);

  // First load: migrate browser notebooks, list, and seed a sample if empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await migrateLocalNotebooks();
        let list = await api.listNotebooks();
        if (!list.length) {
          // Fixed id keeps this idempotent if the effect runs twice
          const sample = { ...sampleNotebook(), id: 'getting-started' };
          await api.saveNotebook(sample);
          list = [summarize(sample)];
        }
        if (cancelled) return;
        setSummaries(list);
        setActiveId(list[0].id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load notebooks');
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch the active notebook the first time it is opened
  useEffect(() => {
    if (!activeId || loadedRef.current[activeId]) return;
    api.getNotebook(activeId)
      .then(setNotebookState)
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load notebook'));
  }, [activeId, setNotebookState]);

  // Save anything pending when leaving the page
  useEffect(() => () => { flushSaves(); }, [flushSaves]);

  const showNotice = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  const notebook = activeId ? loaded[activeId] : undefined;

  // ---------- Running ----------

  const runCell = useCallback(async (nbId: string, cellId: string) => {
    const nb = loadedRef.current[nbId];
    const cell = nb?.cells.find(c => c.id === cellId);
    if (!nb || !cell || cell.type !== 'sql') return;
    setRunning(prev => new Set(prev).add(cellId));
    try {
      const sql = resolveSql(stripSemicolon(cell.source), nb.cells);
      const r = await api.runQuery(sql);
      updateCell(nbId, cellId, c => ({
        result: { data: r.data, rowCount: r.rowCount, truncated: r.truncated, duration: r.duration, queryId: r.queryId, ranAt: new Date().toISOString() },
        error: null,
        ...chartAxes(c, r.data),
      }));
      api.fetchQueryStats(r.queryId).then(stats => updateCell(nbId, cellId, c =>
        (c.result?.queryId === r.queryId ? { result: { ...c.result, stats } } : {})));
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Query failed';
      const missingLog = message.match(/Unknown table expression identifier 'system\.(\w+_log)'/);
      if (missingLog) message += `\n\nsystem.${missingLog[1]} is not enabled on this server, so this cell can't run here.`;
      updateCell(nbId, cellId, { error: message, result: null });
    } finally {
      setRunning(prev => { const next = new Set(prev); next.delete(cellId); return next; });
    }
  }, [updateCell]);

  const runCells = useCallback(async (nbId: string, cellIds: string[], busyKey: string) => {
    setRunningAll(busyKey);
    for (const id of cellIds) await runCell(nbId, id);
    setRunningAll(null);
  }, [runCell]);

  const runAll = () => {
    if (!notebook) return;
    runCells(notebook.id, notebook.cells.filter(c => c.type === 'sql').map(c => c.id), notebook.id);
  };

  // Re-run every SQL cell that (transitively) uses a parameter
  const applyParam = (cell: NotebookCell) => {
    if (!notebook) return;
    const latest = loadedRef.current[notebook.id];
    runCells(notebook.id, dependentCells(cell.name, latest.cells).map(c => c.id), cell.id);
  };

  // ---------- Cell editing ----------

  const addCell = (type: CellType, afterIndex?: number) => {
    if (!notebook) return;
    mutate(notebook.id, nb => {
      const cells = [...nb.cells];
      cells.splice(afterIndex === undefined ? cells.length : afterIndex + 1, 0, newCell(type, cells));
      return { ...nb, cells };
    });
  };

  const moveCell = (index: number, delta: number) => {
    if (!notebook) return;
    mutate(notebook.id, nb => {
      const cells = [...nb.cells];
      const target = index + delta;
      if (target < 0 || target >= cells.length) return nb;
      [cells[index], cells[target]] = [cells[target], cells[index]];
      return { ...nb, cells };
    });
  };

  // Renaming rewrites {{old}} references in the other SQL cells
  const renameCell = (cellId: string, name: string) => {
    if (!notebook) return false;
    const cell = notebook.cells.find(c => c.id === cellId);
    if (!cell || notebook.cells.some(c => c.id !== cellId && c.name === name)) return false;
    const pattern = new RegExp(`\\{\\{\\s*${cell.name}\\s*\\}\\}`, 'g');
    mutate(notebook.id, nb => ({
      ...nb,
      cells: nb.cells.map(c => {
        if (c.id === cellId) return { ...c, name };
        return c.type === 'sql' ? { ...c, source: c.source.replace(pattern, `{{${name}}}`) } : c;
      }),
    }));
    return true;
  };

  // ---------- Notebook lifecycle ----------

  const addNotebook = async (nb: Notebook) => {
    try {
      const created = await api.createNotebook(nb);
      setNotebookState(created);
      setSummaries(prev => [summarize(created), ...prev]);
      setActiveId(created.id);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to create notebook');
    }
  };

  const createFromTemplate = (template: NotebookTemplate | null) => {
    setShowPicker(false);
    addNotebook(notebookFromTemplate(template));
  };

  const duplicateNotebook = () => {
    if (!notebook) return;
    addNotebook({ ...notebook, id: uid(), title: `${notebook.title} (copy)`, cells: notebook.cells.map(c => ({ ...c, id: uid() })) });
  };

  const removeNotebook = async () => {
    if (!notebook || !window.confirm(`Delete "${notebook.title}"? This can't be undone.`)) return;
    try {
      dirty.current.delete(notebook.id);
      await api.deleteNotebook(notebook.id);
      const rest = { ...loadedRef.current };
      delete rest[notebook.id];
      loadedRef.current = rest;
      setLoaded(rest);
      const remaining = summaries.filter(s => s.id !== notebook.id);
      setSummaries(remaining);
      setActiveId(remaining[0]?.id || null);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to delete notebook');
    }
  };

  const importNotebook = async (file: File) => {
    try {
      await addNotebook(parseImportedNotebook(await file.text()));
    } catch (err) {
      showNotice(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const exportJson = () => {
    if (!notebook) return;
    downloadFile(`${fileSlug(notebook.title)}.notebook.json`, JSON.stringify(notebook, null, 2), 'application/json');
  };

  const copySqlScript = async () => {
    if (!notebook) return;
    try {
      await navigator.clipboard.writeText(toSqlScript(notebook));
      showNotice('SQL script copied to clipboard');
    } catch {
      showNotice('Clipboard unavailable');
    }
  };

  // ---------- List + filters ----------

  // Loaded notebooks reflect unsaved edits (title, cell count) immediately
  const listRows = useMemo(() => summaries.map(s => (loaded[s.id] ? summarize(loaded[s.id]) : s)), [summaries, loaded]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(listRows, FILTER_FIELDS, searchText);

  const cellCounts = useMemo(() => {
    const counts: Record<CellType, number> = { sql: 0, markdown: 0, param: 0 };
    notebook?.cells.forEach(c => { counts[c.type]++; });
    return counts;
  }, [notebook]);
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    notebook?.cells.forEach(c => counts.set(c.name, (counts.get(c.name) || 0) + 1));
    return counts;
  }, [notebook]);
  const references = notebook?.cells.filter(c => c.type !== 'markdown') || [];

  return (
    <div className="h-full flex flex-col">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={listRows} fields={FILTER_FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search notebooks..." width="w-56" />
            {notebook && (
              editingTitle ? (
                <input
                  autoFocus
                  value={notebook.title}
                  onChange={e => mutate(notebook.id, nb => ({ ...nb, title: e.target.value }))}
                  onBlur={() => setEditingTitle(false)}
                  onKeyDown={e => (e.key === 'Enter' || e.key === 'Escape') && setEditingTitle(false)}
                  className="bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-xs text-white w-72"
                />
              ) : (
                <button onClick={() => setEditingTitle(true)} className="flex items-center gap-1.5 text-xs font-semibold text-white hover:text-blue-400 truncate">
                  {notebook.title || 'Untitled notebook'}
                  <Pencil className="w-3 h-3 text-gray-500" />
                </button>
              )
            )}
          </>
        }
        right={
          <>
            {notice && <span className="text-xs text-blue-400">{notice}</span>}
            <SaveIndicator state={saveState} onRetry={flushSaves} />
            <span className="text-xs text-gray-400">{filtered.length} notebooks</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
            <ToolbarButton icon={runningAll === notebook?.id ? Loader2 : PlayCircle} variant="primary" onClick={runAll} disabled={!notebook || !!runningAll}>Run all</ToolbarButton>
            <ExportMenu disabled={!notebook} onJson={exportJson} onCopySql={copySqlScript}
              onDownloadSql={() => notebook && downloadFile(`${fileSlug(notebook.title)}.sql`, toSqlScript(notebook), 'text/plain')} />
            <ToolbarButton icon={Upload} onClick={() => importRef.current?.click()} title="Import a notebook .json file">Import</ToolbarButton>
            <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importNotebook(f); }} />
            <ToolbarButton icon={Copy} onClick={duplicateNotebook} disabled={!notebook}>Duplicate</ToolbarButton>
            <ToolbarButton icon={Trash2} onClick={removeNotebook} disabled={!notebook} title="Delete notebook">Delete</ToolbarButton>
          </>
        }
      />
      <div className="flex-1 flex overflow-hidden px-1.5 pt-3 pb-4 gap-3">
        {/* Notebook list */}
        <div className="w-60 shrink-0 bg-gray-900 border border-gray-700 rounded-lg flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
            <span className="flex items-center gap-2 text-xs font-semibold text-gray-200"><NotebookPen className="w-3.5 h-3.5 text-blue-400" />Notebooks</span>
            <button onClick={() => setShowPicker(true)} className="text-gray-400 hover:text-white" title="New notebook"><Plus className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.map(nb => (
              <button
                key={nb.id}
                onClick={() => { flushSaves(); setActiveId(nb.id); }}
                className={`w-full text-left px-3 py-2 border-b border-gray-800 transition-colors ${nb.id === activeId ? 'bg-blue-600/20 border-l-2 border-l-blue-500' : 'hover:bg-gray-800'}`}
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="w-3 h-3 text-gray-500 shrink-0" />
                  <span className="text-xs text-white truncate">{nb.title || 'Untitled notebook'}</span>
                </div>
                <div className="text-[10px] text-gray-500 pl-4.5 mt-0.5">{nb.cellCount} cells · {formatDate(nb.updatedAt)}</div>
              </button>
            ))}
            {!initialising && filtered.length === 0 && (
              <EmptyState compact title={summaries.length ? 'No notebooks match the filters' : 'No notebooks'} />
            )}
          </div>
          {references.length > 0 && (
            <div className="border-t border-gray-700 p-2">
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">References</div>
              <div className="flex flex-wrap gap-1">
                {references.map(c => (
                  <code key={c.id} title={c.type === 'param' ? 'Parameter (inserted as a literal)' : 'SQL cell (inlined as a subquery)'}
                    className={`text-[10px] px-1 py-px rounded bg-gray-800 border border-gray-700 ${c.type === 'param' ? 'text-yellow-300' : 'text-blue-300'}`}>
                    {`{{${c.name}}}`}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Cells */}
        <div className="flex-1 overflow-y-auto pr-1">
          {loadError ? (
            <EmptyState icon={CloudOff} title="Couldn't load notebooks">{loadError}</EmptyState>
          ) : initialising || (activeId && !notebook) ? (
            <LoadingState label="Loading notebook…" />
          ) : !notebook ? (
            <EmptyState icon={NotebookPen} title="No notebook selected">
              <button onClick={() => setShowPicker(true)} className="text-blue-400 hover:underline">Create a notebook</button>
            </EmptyState>
          ) : (
            <div className="max-w-6xl mx-auto space-y-1">
              <div className="text-[11px] text-gray-500 px-1 pb-1">
                {cellCounts.sql} SQL · {cellCounts.param} parameter · {cellCounts.markdown} text cells
              </div>
              {notebook.cells.map((cell, index) => (
                <div key={cell.id}>
                  <CellView
                    cell={cell}
                    index={index}
                    total={notebook.cells.length}
                    running={running.has(cell.id) || runningAll === cell.id}
                    duplicateName={(nameCounts.get(cell.name) || 0) > 1}
                    onChange={patch => updateCell(notebook.id, cell.id, patch)}
                    onRename={name => renameCell(cell.id, name)}
                    onRun={() => (cell.type === 'param' ? applyParam(cell) : runCell(notebook.id, cell.id))}
                    onMove={delta => moveCell(index, delta)}
                    onDelete={() => mutate(notebook.id, nb => ({ ...nb, cells: nb.cells.filter(c => c.id !== cell.id) }))}
                    resolveSql={() => resolveSql(stripSemicolon(cell.source), loadedRef.current[notebook.id].cells)}
                  />
                  <AddCellDivider onAdd={type => addCell(type, index)} />
                </div>
              ))}
              {notebook.cells.length === 0 && <AddCellDivider onAdd={type => addCell(type)} alwaysVisible />}
            </div>
          )}
        </div>
      </div>
      {showPicker && <TemplatePicker onPick={createFromTemplate} onClose={() => setShowPicker(false)} />}
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: 'saved' | 'saving' | 'error'; onRetry: () => void }) {
  if (state === 'saving') return <span className="text-[11px] text-gray-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving</span>;
  if (state === 'error') return <button onClick={onRetry} className="text-[11px] text-red-400 hover:text-red-300">Save failed, retry</button>;
  return <span className="text-[11px] text-gray-500 flex items-center gap-1"><Check className="w-3 h-3" />Saved</span>;
}

function ExportMenu({ disabled, onJson, onCopySql, onDownloadSql }: { disabled: boolean; onJson: () => void; onCopySql: () => void; onDownloadSql: () => void }) {
  const [open, setOpen] = useState(false);
  const item = (label: string, action: () => void) => (
    <button onClick={() => { setOpen(false); action(); }} className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 hover:text-white">{label}</button>
  );
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-50">
        <Download className="w-3.5 h-3.5" />Export<ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[200px] py-1">
            {item('Download notebook (.json)', onJson)}
            {item('Copy as SQL script', onCopySql)}
            {item('Download SQL script (.sql)', onDownloadSql)}
          </div>
        </>
      )}
    </div>
  );
}

function AddCellDivider({ onAdd, alwaysVisible }: { onAdd: (type: CellType) => void; alwaysVisible?: boolean }) {
  const btn = (type: CellType, Icon: typeof Code2, label: string) => (
    <button onClick={() => onAdd(type)} className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-600 bg-gray-800 text-[11px] text-gray-300 hover:text-white hover:border-blue-500">
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
  return (
    <div className={`flex items-center gap-2 py-1 ${alwaysVisible ? '' : 'opacity-0 hover:opacity-100'} transition-opacity`}>
      <div className="flex-1 h-px bg-gray-700" />
      {btn('sql', Code2, 'SQL')}
      {btn('markdown', Type, 'Text')}
      {btn('param', SlidersHorizontal, 'Parameter')}
      <div className="flex-1 h-px bg-gray-700" />
    </div>
  );
}
