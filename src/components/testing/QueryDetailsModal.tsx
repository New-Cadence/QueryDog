// Details of one Query Performance query: the SQL, run statistics, the run
// log and a Trends chart of the logged runs' durations over time.
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart2, Check, Copy, ExternalLink, FileCode, LineChart as LineChartIcon, ListChecks, Play, Sigma, X } from 'lucide-react';
import { EmptyState, LoadingState, PageTabs, type TabDef } from '../ui';
import { ResultMark, SeverityPill, type ResultKind } from '../checks/cells';
import type { Severity } from '../checks/model';
import { formatBytes, formatDateTime, formatDuration } from '../../utils/formatters';
import { useIsLightMode } from '../../hooks/useTheme';
import { CHART_COLORS } from '../uiTokens';

type RunStatus = 'ok' | 'warn' | 'fail' | 'error';

interface QueryLogInfo {
  query_id: string;
  type: string;
  query_duration_ms: number;
  read_rows: number;
  read_bytes: number;
  result_rows: number;
  result_bytes: number;
  memory_usage: number;
  ProfileEvents: Record<string, number>;
}

export interface RunLogEntry {
  queryId: string;
  runTime: string;
  duration: number;
  rowCount: number;
  readRows: number | null;
  readBytes: number | null;
  status?: RunStatus;
  error?: string | null;
  trigger?: string | null;
  queryLog: QueryLogInfo | null;
}

export interface DetailsQuery {
  filename: string;
  title?: string;
  query: string;
  category?: string;
  severity?: Severity;
  warnDurationMs?: number | null;
  failDurationMs?: number | null;
  runCount: number;
  lastRunTime: string | null;
  lastDuration: number | null;
  lastRowCount: number | null;
  avgRunTime: number | null;
  avgRowCount: number | null;
  slowestRunTime: number | null;
  fastestRunTime: number | null;
}

type DetailsTab = 'query' | 'statistics' | 'log' | 'trends';
const TABS: TabDef<DetailsTab>[] = [
  { id: 'query', label: 'Query', icon: FileCode },
  { id: 'statistics', label: 'Statistics', icon: Sigma },
  { id: 'log', label: 'Run Log', icon: ListChecks },
  { id: 'trends', label: 'Trends', icon: LineChartIcon },
];

const RESULT_OF: Record<RunStatus, ResultKind> = { ok: 'pass', warn: 'warn', fail: 'fail', error: 'error' };

const navigateTo = <K extends string>(name: K) =>
  (window as unknown as Record<K, ((arg: never) => void) | undefined>)[name];

function Stat({ label, value, className = 'text-white' }: { label: string; value: string; className?: string }) {
  return (
    <div className="bg-gray-800 p-3 rounded">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-base font-semibold ${className}`}>{value}</div>
    </div>
  );
}

export function QueryDetailsModal({ query, runLog, runLogLoading, onClose, onAnalyse, onRun, runDisabled }: {
  query: DetailsQuery;
  runLog: RunLogEntry[];
  runLogLoading: boolean;
  onClose: () => void;
  onAnalyse: () => void;
  onRun: () => void;
  runDisabled: boolean;
}) {
  const [tab, setTab] = useState<DetailsTab>('query');
  const [copied, setCopied] = useState(false);
  const loggedIds = runLog.filter(e => e.queryId).map(e => e.queryId);

  const copyQuery = async () => {
    await navigator.clipboard.writeText(query.query);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-[1500px] max-w-[95vw] h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 border-b border-gray-700">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white truncate">{query.title || query.filename.replace(/\.sql$/, '')}</h2>
              {query.category && <span className="px-2 py-0.5 text-[10px] bg-blue-900/50 text-blue-300 rounded">{query.category}</span>}
              <SeverityPill severity={query.severity || 'info'} />
            </div>
            <p className="text-xs text-gray-400 font-mono">{query.filename}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <PageTabs nested tabs={TABS} active={tab} onChange={setTab} />

        <div className="flex-1 overflow-auto p-3">
          {tab === 'query' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-end gap-2 mb-2">
                <button onClick={() => void copyQuery()} title="Copy query"
                  className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors">
                  {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={onAnalyse} className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white">
                  <ExternalLink className="w-3 h-3" />
                  Analyse Query
                </button>
              </div>
              <pre className="flex-1 bg-gray-800 p-3 rounded text-xs text-blue-400 overflow-auto whitespace-pre-wrap break-words font-mono">
                {query.query}
              </pre>
            </div>
          )}

          {tab === 'statistics' && (
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Total Runs" value={String(query.runCount)} />
              <Stat label="Last Run" value={formatDateTime(query.lastRunTime)} />
              <Stat label="Last Duration" value={formatDuration(query.lastDuration)} className="text-blue-400" />
              <Stat label="Last Rows" value={query.lastRowCount?.toLocaleString() ?? '-'} className="text-blue-400" />
              <Stat label="Average Time" value={formatDuration(query.avgRunTime)} className="text-green-400" />
              <Stat label="Fastest Time" value={formatDuration(query.fastestRunTime)} className="text-green-400" />
              <Stat label="Slowest Time" value={formatDuration(query.slowestRunTime)} className="text-red-400" />
              <Stat label="Average Rows" value={query.avgRowCount?.toLocaleString() ?? '-'} className="text-cyan-400" />
              <Stat label="Warn At" value={formatDuration(query.warnDurationMs)} className="text-yellow-400" />
              <Stat label="Fail At" value={formatDuration(query.failDurationMs)} className="text-red-400" />
            </div>
          )}

          {tab === 'log' && (runLogLoading ? (
            <LoadingState label="Loading run log…" compact />
          ) : runLog.length === 0 ? (
            <EmptyState compact title="No runs recorded" />
          ) : (
            <RunLogTable runLog={runLog} onClose={onClose} />
          ))}

          {tab === 'trends' && (runLogLoading ? (
            <LoadingState label="Loading run log…" compact />
          ) : runLog.length === 0 ? (
            <EmptyState compact title="No runs recorded" />
          ) : (
            <TrendsChart runLog={runLog} warnMs={query.warnDurationMs} failMs={query.failDurationMs} />
          ))}
        </div>

        <div className="flex justify-end gap-2 p-3 border-t border-gray-700">
          {loggedIds.length > 0 && (
            <button
              onClick={() => {
                const open = navigateTo('navigateToQueryIds');
                if (open) {
                  onClose();
                  open(loggedIds as never);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-white text-xs"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              Analyse Results ({loggedIds.length})
            </button>
          )}
          <button
            onClick={() => { onRun(); onClose(); }}
            disabled={runDisabled}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5" />
            Run Query
          </button>
        </div>
      </div>
    </div>
  );
}

function RunLogTable({ runLog, onClose }: { runLog: RunLogEntry[]; onClose: () => void }) {
  return (
    <div className="bg-gray-800 rounded overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-700 text-gray-300">
            <th className="px-2 py-1.5 text-left font-medium">Query ID</th>
            <th className="px-2 py-1.5 text-left font-medium">Run Time</th>
            <th className="px-2 py-1.5 text-left font-medium">Trigger</th>
            <th className="px-2 py-1.5 text-right font-medium">Duration</th>
            <th className="px-2 py-1.5 text-right font-medium">Rows</th>
            <th className="px-2 py-1.5 text-right font-medium">Read Rows</th>
            <th className="px-2 py-1.5 text-right font-medium">Read Bytes</th>
            <th className="px-2 py-1.5 text-right font-medium">Memory</th>
            <th className="px-2 py-1.5 text-center font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {runLog.map((entry, idx) => (
            <tr key={entry.queryId || idx} className="border-t border-gray-700 hover:bg-gray-750">
              <td className="px-2 py-1.5 font-mono text-[10px]" title={entry.queryId}>
                {entry.queryId ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        const open = navigateTo('navigateToQueryId');
                        if (open) {
                          onClose();
                          open(entry.queryId as never);
                        }
                      }}
                      className="text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      {entry.queryId.substring(0, 16) + '...'}
                    </button>
                    <button onClick={() => navigator.clipboard.writeText(entry.queryId)} className="text-gray-500 hover:text-gray-300 p-0.5" title="Copy query ID">
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                ) : '-'}
              </td>
              <td className="px-2 py-1.5 text-gray-300">{formatDateTime(entry.runTime)}</td>
              <td className="px-2 py-1.5 text-gray-400 capitalize">{entry.trigger || '-'}</td>
              <td className="px-2 py-1.5 text-right text-green-400">{formatDuration(entry.duration)}</td>
              <td className="px-2 py-1.5 text-right text-gray-300">{entry.rowCount?.toLocaleString() ?? '-'}</td>
              <td className="px-2 py-1.5 text-right text-gray-300">{(entry.readRows ?? entry.queryLog?.read_rows)?.toLocaleString() ?? '-'}</td>
              <td className="px-2 py-1.5 text-right text-gray-300">{formatBytes(entry.readBytes ?? entry.queryLog?.read_bytes)}</td>
              <td className="px-2 py-1.5 text-right text-gray-300">{formatBytes(entry.queryLog?.memory_usage)}</td>
              <td className="px-2 py-1.5 text-center">
                {entry.status ? <ResultMark result={RESULT_OF[entry.status]} title={entry.error || undefined} /> : <ResultMark result="none" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Duration of every logged run against its run time. The warn and fail limits
// are drawn when they fall within the runs' range, so a query far under its
// limits still shows its trend. Errored runs are left out (their time is not a
// query duration).
function TrendsChart({ runLog, warnMs, failMs }: { runLog: RunLogEntry[]; warnMs?: number | null; failMs?: number | null }) {
  const isLight = useIsLightMode();
  const grid = isLight ? '#e5e7eb' : '#374151';
  const tick = isLight ? '#6b7280' : '#9ca3af';
  const points = useMemo(() => runLog
    .filter(e => e.status !== 'error' && e.duration != null)
    .map(e => ({ t: new Date(e.runTime).getTime(), duration: e.duration }))
    .sort((a, b) => a.t - b.t), [runLog]);
  if (!points.length) return <EmptyState compact title="No successful runs to chart" />;

  return (
    <div className="h-full min-h-80 flex flex-col">
      <div className="text-xs text-gray-400 mb-2">
        Duration of the last {points.length} runs
        {warnMs != null && <span className="ml-3 text-yellow-400">warn at {formatDuration(warnMs)}</span>}
        {failMs != null && <span className="ml-3 text-red-400">fail at {formatDuration(failMs)}</span>}
      </div>
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={t => formatDateTime(new Date(Number(t)).toISOString())}
              minTickGap={40} tick={{ fontSize: 10, fill: tick }} stroke={grid} />
            <YAxis width={60} domain={[0, 'auto']} tickFormatter={v => formatDuration(Number(v))} tick={{ fontSize: 10, fill: tick }} stroke={grid} />
            <Tooltip contentStyle={{ backgroundColor: isLight ? '#fff' : '#1f2937', border: `1px solid ${grid}`, fontSize: 11 }}
              labelFormatter={t => formatDateTime(new Date(Number(t)).toISOString())}
              formatter={v => [formatDuration(Number(v)), 'Duration']} />
            {warnMs != null && <ReferenceLine y={warnMs} stroke="#facc15" strokeDasharray="4 4" label={{ value: `Warn ${formatDuration(warnMs)}`, fill: '#facc15', fontSize: 10, position: 'insideTopRight' }} />}
            {failMs != null && <ReferenceLine y={failMs} stroke="#ef4444" strokeDasharray="4 4" label={{ value: `Fail ${formatDuration(failMs)}`, fill: '#ef4444', fontSize: 10, position: 'insideTopRight' }} />}
            <Line dataKey="duration" stroke={CHART_COLORS[0]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
