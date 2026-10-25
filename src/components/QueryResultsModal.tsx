import { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import { X, Loader2, Play, Copy, Check } from 'lucide-react';
import { useGridTheme } from '../hooks/useTheme';
import { formatDuration } from '../utils/formatters';
import { GRID_OVERLAYS } from './gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface QueryRunResult {
  data: Record<string, unknown>[];
  rowCount: number;
  duration: number;
  queryId?: string;
}

interface QueryResultsModalProps {
  filename: string;
  query: string;
  description?: string;
  runEndpoint: string; // e.g. '/api/alerts/run' or '/api/my-queries/run'
  initialResult?: QueryRunResult | null;
  onClose: () => void;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function QueryResultsModal({
  filename,
  query,
  description,
  runEndpoint,
  initialResult,
  onClose,
}: QueryResultsModalProps) {
  const gridTheme = useGridTheme();
  const [result, setResult] = useState<QueryRunResult | null>(initialResult ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryCopied, setQueryCopied] = useState(false);
  const [queryExpanded, setQueryExpanded] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const runQuery = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to run query');
      setResult({
        data: data.data || [],
        rowCount: data.rowCount ?? (data.data?.length ?? 0),
        duration: data.duration ?? 0,
        queryId: data.queryId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialResult) {
      void runQuery();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columnDefs = useMemo<ColDef[]>(() => {
    const row = result?.data?.[0];
    if (!row) return [];
    return Object.keys(row).map((key) => ({
      headerName: key,
      field: key,
      sortable: true,
      resizable: true,
      tooltipValueGetter: (p) => formatCell(p.value),
      valueFormatter: (p) => formatCell(p.value),
      cellStyle: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    }));
  }, [result]);

  const defaultColDef = useMemo<ColDef>(() => ({
    flex: 1,
    minWidth: 120,
    resizable: true,
    sortable: true,
  }), []);

  const handleCopyQuery = async () => {
    await navigator.clipboard.writeText(query);
    setQueryCopied(true);
    setTimeout(() => setQueryCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-[1400px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white">Run Result</h2>
            <p className="text-xs text-gray-400 font-mono">{filename}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={runQuery}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? 'Running...' : 'Re-run'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Description */}
        {description && (
          <div className="px-3 py-2 border-b border-gray-700 bg-gray-900/60 shrink-0">
            <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto">
              {description}
            </pre>
          </div>
        )}

        {/* Query (collapsible) */}
        <div className="px-3 py-2 border-b border-gray-700 bg-gray-900/40 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setQueryExpanded(v => !v)}
                className="text-xs text-gray-400 hover:text-white"
              >
                {queryExpanded ? '▼' : '▶'} Query
              </button>
              <button
                onClick={handleCopyQuery}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                title="Copy query"
              >
                {queryCopied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {queryCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          {queryExpanded && (
            <pre className="bg-gray-800 p-3 rounded text-xs text-blue-400 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono">
              {query}
            </pre>
          )}
        </div>

        {/* Stats bar */}
        <div className="px-3 py-2 border-b border-gray-700 bg-gray-900/40 shrink-0 flex items-center gap-4 text-xs">
          {loading && !result && (
            <span className="flex items-center gap-1.5 text-gray-300">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running…
            </span>
          )}
          {result && (
            <>
              <span className="text-gray-400">
                Rows: <span className="text-white font-semibold">{result.rowCount.toLocaleString()}</span>
              </span>
              <span className="text-gray-400">
                Duration: <span className="text-green-400 font-semibold">{formatDuration(result.duration)}</span>
              </span>
              {result.queryId && (
                <span className="text-gray-400 font-mono">
                  Query ID: <span className="text-blue-400">{result.queryId.substring(0, 16)}…</span>
                </span>
              )}
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-2 bg-red-900/40 text-red-300 text-xs border-b border-red-800 shrink-0 whitespace-pre-wrap break-words">
            Error: {error}
          </div>
        )}

        {/* Results grid */}
        <div className="flex-1 overflow-hidden p-3">
          {result && result.data.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">
              No rows returned.
            </div>
          ) : (
            <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
              <AgGridReact {...GRID_OVERLAYS}
                theme={gridTheme}
                rowData={result?.data ?? []}
                columnDefs={columnDefs}
                defaultColDef={defaultColDef}
                animateRows={false}
                suppressCellFocus={true}
                enableCellTextSelection={true}
                tooltipShowDelay={300}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
