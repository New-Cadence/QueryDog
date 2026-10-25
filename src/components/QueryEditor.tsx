import { useState, useEffect } from 'react';
import { Play, X, Loader2, Copy, Check, ChevronDown, ChevronRight, Clock, Table as TableIcon, AlertCircle, Activity, GitBranch } from 'lucide-react';
import { executeQuery, fetchExplainByType, fetchExplainJson, type ExplainType, type QueryResult } from '../services/api';
import { QueryPlanVisualizer } from './QueryPlanVisualizer';
import { formatNumber, formatDuration } from '../utils/formatters';
import { LoadingState } from './ui';

interface QueryEditorProps {
  initialQuery?: string;
  onClose: () => void;
}

type ExplainTab = 'plan' | 'indexes' | 'actions' | 'pipeline' | 'ast' | 'syntax' | 'estimate' | 'performance';

const EXPLAIN_TABS: { id: ExplainTab; label: string; description: string }[] = [
  { id: 'performance', label: 'Performance', description: 'Query performance metrics' },
  { id: 'plan', label: 'Plan', description: 'Basic execution plan' },
  { id: 'indexes', label: 'Indexes', description: 'Plan with index usage info' },
  { id: 'actions', label: 'Actions', description: 'Query execution actions' },
  { id: 'pipeline', label: 'Pipeline', description: 'Query execution pipeline' },
  { id: 'ast', label: 'AST', description: 'Abstract syntax tree' },
  { id: 'syntax', label: 'Syntax', description: 'Optimized query syntax' },
  { id: 'estimate', label: 'Estimate', description: 'Estimated rows/bytes' },
];

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function QueryEditor({ initialQuery = '', onClose }: QueryEditorProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<QueryResult | null>(null);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Explain state
  const [activeExplainTab, setActiveExplainTab] = useState<ExplainTab>('performance');
  const [explainResults, setExplainResults] = useState<Record<ExplainTab, string[] | null>>({
    performance: null,
    plan: null,
    indexes: null,
    actions: null,
    pipeline: null,
    ast: null,
    syntax: null,
    estimate: null,
  });
  const [explainLoading, setExplainLoading] = useState<Record<ExplainTab, boolean>>({
    performance: false,
    plan: false,
    indexes: false,
    actions: false,
    pipeline: false,
    ast: false,
    syntax: false,
    estimate: false,
  });
  const [explainErrors, setExplainErrors] = useState<Record<ExplainTab, string | null>>({
    performance: null,
    plan: null,
    indexes: null,
    actions: null,
    pipeline: null,
    ast: null,
    syntax: null,
    estimate: null,
  });

  const [showResults, setShowResults] = useState(true);
  const [showExplain, setShowExplain] = useState(true);

  // Visualizer state
  const [visualizerOpen, setVisualizerOpen] = useState(false);
  const [visualizerJsonPlan, setVisualizerJsonPlan] = useState<Record<string, unknown>[] | null>(null);
  const [visualizerLoading, setVisualizerLoading] = useState(false);

  // Auto-run explain when query changes and is valid
  useEffect(() => {
    if (initialQuery && initialQuery.trim()) {
      // Auto-load the performance tab with a small delay to ensure state is ready
      const timer = setTimeout(() => {
        setActiveExplainTab('performance');
      }, 100);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const handleExecute = async () => {
    if (!query.trim()) return;

    setExecuting(true);
    setError(null);
    setResults(null);

    // Reset explain results so they reload with the new query
    setExplainResults({
      performance: null,
      plan: null,
      indexes: null,
      actions: null,
      pipeline: null,
      ast: null,
      syntax: null,
      estimate: null,
    });
    setExplainErrors({
      performance: null,
      plan: null,
      indexes: null,
      actions: null,
      pipeline: null,
      ast: null,
      syntax: null,
      estimate: null,
    });

    try {
      const result = await executeQuery(query);
      setResults(result);
      // Auto-load the plan tab after query execution
      loadExplain('plan');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute query');
    } finally {
      setExecuting(false);
    }
  };

  const loadExplain = async (type: ExplainTab, forceReload = false) => {
    if (!query.trim()) return;
    // Skip loading for performance tab - it's populated from query results
    if (type === 'performance') return;
    if (!forceReload && (explainResults[type] !== null || explainLoading[type])) return; // Already loaded or loading

    setExplainLoading(prev => ({ ...prev, [type]: true }));
    setExplainErrors(prev => ({ ...prev, [type]: null }));

    try {
      const result = await fetchExplainByType(query, type as ExplainType);
      const lines = result.map(row => row.explain || row.plan || JSON.stringify(row));
      setExplainResults(prev => ({ ...prev, [type]: lines as string[] }));
    } catch (err) {
      setExplainErrors(prev => ({ ...prev, [type]: err instanceof Error ? err.message : 'Failed to run explain' }));
    } finally {
      setExplainLoading(prev => ({ ...prev, [type]: false }));
    }
  };

  const handleExplainTabChange = (tab: ExplainTab) => {
    setActiveExplainTab(tab);
    loadExplain(tab);
  };

  const openVisualizer = async () => {
    // If no query, just open the visualizer for manual paste
    if (!query.trim()) {
      setVisualizerJsonPlan(null);
      setVisualizerOpen(true);
      return;
    }

    setVisualizerLoading(true);
    try {
      // Fetch JSON plan with indexes
      const jsonPlan = await fetchExplainJson(query, true);
      setVisualizerJsonPlan(jsonPlan);
      setVisualizerOpen(true);
    } catch (err) {
      console.error('Failed to fetch JSON plan:', err);
      // Still open visualizer - user can paste JSON manually
      setVisualizerJsonPlan(null);
      setVisualizerOpen(true);
    } finally {
      setVisualizerLoading(false);
    }
  };

  const handleCopyQuery = async () => {
    await navigator.clipboard.writeText(query);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      handleExecute();
    }
  };

  // Get column names from results
  const columns = results?.data?.[0] ? Object.keys(results.data[0]) : [];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-[95vw] h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-3">
            <TableIcon className="w-5 h-5 text-blue-400" />
            <h2 className="text-sm font-semibold text-white">Query Editor</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Query Input */}
        <div className="p-4 border-b border-gray-700 shrink-0">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Auto-compute the selected explain tab when tabbing out
              if (query.trim()) {
                loadExplain(activeExplainTab, true);
              }
            }}
            placeholder="Enter your SQL query here..."
            className="w-full h-48 bg-gray-800 border border-gray-600 rounded p-3 text-sm font-mono text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
            spellCheck={false}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-2">
              <button
                onClick={handleExecute}
                disabled={executing || !query.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 rounded text-white text-sm font-medium"
              >
                {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Run Query
              </button>
              <button
                onClick={openVisualizer}
                disabled={visualizerLoading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded text-white text-sm font-medium"
                title="Visualize query plan (or paste JSON)"
              >
                {visualizerLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                Visualize
              </button>
            </div>
            <button
              onClick={handleCopyQuery}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Results and Explain Panels */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Results Panel */}
          <div className="flex-1 min-h-0 flex flex-col border-b border-gray-700 overflow-hidden">
            <button
              onClick={() => setShowResults(!showResults)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-300 text-xs font-medium hover:bg-gray-750 shrink-0"
            >
              {showResults ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Results
              {results && (
                <span className="text-gray-500 ml-2">
                  {results.rowCount} rows in {formatDuration(results.duration)}
                </span>
              )}
            </button>

            {showResults && (
              <div className="flex-1 overflow-hidden p-2">
                {error && (
                  <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {executing && (
                  <LoadingState label="Running query…" />
                )}

                {!executing && !error && !results && (
                  <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                    Run a query to see results
                  </div>
                )}

                {results && results.data.length > 0 && (
                  <div className="h-full overflow-auto border border-gray-700 rounded">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-800 sticky top-0 z-10">
                        <tr>
                          {columns.map((col) => (
                            <th key={col} className="px-2 py-1.5 text-left text-gray-400 font-medium border-b border-gray-700 whitespace-nowrap">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.data.map((row, idx) => (
                          <tr key={idx} className={`border-b border-gray-800 hover:bg-gray-800/50 ${idx % 2 === 0 ? 'bg-gray-900/30' : ''}`}>
                            {columns.map((col) => (
                              <td key={col} className="px-2 py-1 text-gray-300 font-mono whitespace-nowrap max-w-[300px] truncate" title={formatValue(row[col])}>
                                {formatValue(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {results && results.data.length === 0 && (
                  <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                    Query returned no results
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Explain Panel */}
          <div
            className={`flex flex-col overflow-hidden border-t border-gray-700 ${
              showExplain ? 'h-[30vh] min-h-[220px] max-h-[420px]' : ''
            }`}
          >
            <div className="flex items-center justify-between bg-gray-800 shrink-0">
              <button
                onClick={() => setShowExplain(!showExplain)}
                className="flex items-center gap-2 px-4 py-2 text-gray-300 text-xs font-medium hover:bg-gray-750"
              >
                {showExplain ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Query Planning
              </button>
              {showExplain && (
                <button
                  onClick={() => {
                    const content = activeExplainTab === 'performance'
                      ? (results ? `Duration: ${formatDuration(results.duration)}\nRows: ${formatNumber(results.rowCount)}` : '')
                      : (explainResults[activeExplainTab]?.join('\n') || '');
                    if (content) {
                      navigator.clipboard.writeText(content);
                    }
                  }}
                  className="p-2 mr-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                  title="Copy to clipboard"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {showExplain && (
              <div className="flex-1 overflow-hidden flex flex-col">
                {/* Explain Tabs */}
                <div className="flex border-b border-gray-700 px-2 shrink-0">
                  {EXPLAIN_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => handleExplainTabChange(tab.id)}
                      className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        activeExplainTab === tab.id
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                      title={tab.description}
                    >
                      {tab.label}
                      {explainLoading[tab.id] && <Loader2 className="w-3 h-3 ml-1 inline animate-spin" />}
                    </button>
                  ))}
                </div>

                {/* Explain Content */}
                <div className="flex-1 overflow-auto p-2">
                  {!query.trim() && (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                      Enter a query to see analysis
                    </div>
                  )}

                  {/* Performance Tab - Show metrics from query results */}
                  {query.trim() && activeExplainTab === 'performance' && (
                    <div>
                      {!results && !executing && (
                        <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm gap-2 p-6">
                          <Activity className="w-8 h-8 opacity-50" />
                          <p>Run the query to see performance metrics</p>
                        </div>
                      )}
                      {executing && (
                        <LoadingState label="Running query…" />
                      )}
                      {results && (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-400 mb-3">Query Performance</h3>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="bg-gray-800 p-2 rounded">
                              <div className="text-xs text-gray-400">Duration</div>
                              <div className="text-sm font-semibold text-white">{formatDuration(results.duration)}</div>
                            </div>
                            <div className="bg-gray-800 p-2 rounded">
                              <div className="text-xs text-gray-400">Rows Returned</div>
                              <div className="text-sm font-semibold text-white">{formatNumber(results.rowCount)}</div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {query.trim() && activeExplainTab !== 'performance' && explainLoading[activeExplainTab] && (
                    <LoadingState label="Running EXPLAIN…" />
                  )}

                  {query.trim() && activeExplainTab !== 'performance' && explainErrors[activeExplainTab] && (
                    <div className="p-3 bg-red-900/30 border border-red-800 rounded text-xs text-red-300">
                      {explainErrors[activeExplainTab]}
                    </div>
                  )}

                  {query.trim() && activeExplainTab !== 'performance' && explainResults[activeExplainTab] && (
                    <pre className="bg-gray-800 p-3 rounded text-xs text-green-300 overflow-auto whitespace-pre-wrap font-mono h-full">
                      {explainResults[activeExplainTab]?.join('\n')}
                    </pre>
                  )}

                  {query.trim() && activeExplainTab !== 'performance' && !explainLoading[activeExplainTab] && !explainErrors[activeExplainTab] && !explainResults[activeExplainTab] && (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                      Click a tab to load analysis
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-700 flex items-center gap-4 text-xs text-gray-500 shrink-0">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span>Results limited to 1000 rows</span>
          </div>
          <span>|</span>
          <span>Dangerous operations (DROP, DELETE, etc.) are blocked</span>
        </div>
      </div>

      {/* Query Plan Visualizer Modal */}
      {visualizerOpen && (
        <QueryPlanVisualizer
          planJson={visualizerJsonPlan as any}
          onClose={() => {
            setVisualizerOpen(false);
            setVisualizerJsonPlan(null);
          }}
        />
      )}
    </div>
  );
}
