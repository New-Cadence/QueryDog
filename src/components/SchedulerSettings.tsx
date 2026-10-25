// Read-only view of the backend scheduler under Settings > Scheduler: what
// querydog.yml configures, when each job last ran and runs next per
// environment, and the scheduler's log. Configure it in querydog.yml.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ListChecks, ScrollText, AlertTriangle, PlayCircle, Loader2 } from 'lucide-react';
import { Panel, Pill, LoadingState, EmptyState, ToolbarButton } from './ui';
import { formatDateTime } from '../utils/formatters';

interface JobConfig { enabled: boolean; every: string; include: string[]; exclude: string[] }
interface JobStatus {
  job: string;
  enabled: boolean;
  every: string;
  last: { startedAt: string; finishedAt: string; ok: boolean; summary: string } | null;
  nextAt: string | null;
}
interface LogEntry { id: number; time: string; level: 'info' | 'warn' | 'error'; environment: string | null; kind: string | null; message: string }
interface SchedulerStatus {
  enabled: boolean;
  configured: boolean;
  environments: string[];
  jobs: Record<string, JobConfig>;
  warnings: string[];
  running: { environment: string; job: string; startedAt: string } | null;
  // Set while a Run now pass is in progress
  runAllStartedAt?: string | null;
  jobsByEnvironment?: { environment: string; jobs: JobStatus[] }[];
  log: LogEntry[];
}

const POLL_MS = 15000;
// Faster while a Run now pass is in progress, to follow it
const POLL_RUNNING_MS = 3000;
const JOB_LABELS: Record<string, string> = {
  monitoring: 'Monitoring checks',
  dataquality: 'Data quality checks',
  performance: 'Performance queries',
  recommendations: 'Recommendations',
};
const levelTone = { info: 'default', warn: 'yellow', error: 'red' } as const;

const EXAMPLE = `scheduler:
  enabled: true
  environments: all            # or a list of environment names
  jobs:
    monitoring:      { every: 5m }
    dataquality:     { every: 1h }
    performance:     { every: 6h }
    recommendations: { every: 6h, exclude: ["documentation"] }`;

export function SchedulerSettings() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduler');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const runningAll = !!status?.runAllStartedAt;
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), runningAll ? POLL_RUNNING_MS : POLL_MS);
    return () => clearInterval(t);
  }, [load, runningAll]);

  const [starting, setStarting] = useState(false);
  const runNow = async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/scheduler/run', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (!status) {
    return error
      ? <div className="m-3 px-3 py-2 rounded text-xs bg-red-900/40 border border-red-800 text-red-300">Could not load the scheduler: {error}</div>
      : <LoadingState label="Loading scheduler…" />;
  }

  return (
    <div className="px-1.5 py-3 space-y-3 max-w-6xl">
      <Panel title="Configuration" icon={CalendarClock} bodyClassName="p-3 space-y-3"
        actions={
          <ToolbarButton icon={runningAll || starting ? Loader2 : PlayCircle} variant="primary" disabled={runningAll || starting || !status.environments.length}
            onClick={() => void runNow()} title="Run every job for every scheduled environment now, without waiting for the schedule">
            {runningAll ? 'Running…' : 'Run now'}
          </ToolbarButton>
        }>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
          <Pill tone={status.enabled ? 'green' : 'default'}>{status.enabled ? 'running' : 'off'}</Pill>
          {status.enabled && <span>against {status.environments.length ? status.environments.join(', ') : 'no environments'}</span>}
          {status.running && <span className="text-blue-400">· now running {JOB_LABELS[status.running.job] ?? status.running.job} on {status.running.environment}</span>}
        </div>
        {status.warnings.map(w => (
          <div key={w} className="flex items-center gap-2 text-xs text-yellow-300"><AlertTriangle className="w-3.5 h-3.5" />{w}</div>
        ))}
        {!status.configured ? (
          <div className="text-xs text-gray-400 space-y-2">
            <p>The scheduler is not configured. Add a <code className="text-gray-300">scheduler:</code> section to querydog.yml, for example:</p>
            <pre className="bg-gray-950 border border-gray-700 rounded p-2 text-[11px] text-gray-300 overflow-x-auto">{EXAMPLE}</pre>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-gray-500 border-b border-gray-700">
                <th className="py-1.5 pr-3 font-medium">Job</th>
                <th className="py-1.5 pr-3 font-medium">Every</th>
                <th className="py-1.5 pr-3 font-medium">Include</th>
                <th className="py-1.5 font-medium">Exclude</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.jobs).map(([job, cfg]) => (
                <tr key={job} className="border-b border-gray-800 last:border-0">
                  <td className="py-1.5 pr-3 text-gray-200">{JOB_LABELS[job] ?? job}{!cfg.enabled && <span className="ml-2"><Pill>off</Pill></span>}</td>
                  <td className="py-1.5 pr-3 text-gray-300">{cfg.enabled ? cfg.every : '-'}</td>
                  <td className="py-1.5 pr-3 text-gray-400 font-mono">{cfg.include.join(', ') || 'all'}</td>
                  <td className="py-1.5 text-gray-400 font-mono">{cfg.exclude.join(', ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[10px] text-gray-500">Read-only: change the schedule in querydog.yml. It is re-read on every scheduler tick.</p>
      </Panel>

      {status.enabled && !!status.jobsByEnvironment?.length && (
        <Panel title="Jobs by environment" icon={ListChecks} bodyClassName="p-0">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-gray-500 border-b border-gray-700">
                <th className="px-3 py-1.5 font-medium">Environment</th>
                <th className="px-3 py-1.5 font-medium">Job</th>
                <th className="px-3 py-1.5 font-medium">Last run</th>
                <th className="px-3 py-1.5 font-medium">Result</th>
                <th className="px-3 py-1.5 font-medium">Next run</th>
              </tr>
            </thead>
            <tbody>
              {status.jobsByEnvironment.flatMap(({ environment, jobs }) => jobs.filter(j => j.enabled).map(j => (
                <tr key={`${environment}|${j.job}`} className="border-b border-gray-800 last:border-0">
                  <td className="px-3 py-1.5 text-gray-200">{environment}</td>
                  <td className="px-3 py-1.5 text-gray-300">{JOB_LABELS[j.job] ?? j.job}</td>
                  <td className="px-3 py-1.5 text-gray-400">{j.last ? formatDateTime(j.last.startedAt) : 'not yet'}</td>
                  <td className="px-3 py-1.5">{j.last ? <span className={j.last.ok ? 'text-gray-300' : 'text-yellow-300'}>{j.last.summary}</span> : <span className="text-gray-600">-</span>}</td>
                  <td className="px-3 py-1.5 text-gray-400">{j.nextAt ? formatDateTime(j.nextAt) : '-'}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Log" icon={ScrollText} bodyClassName="p-0 max-h-[28rem] overflow-y-auto">
        {status.log.length === 0 ? <EmptyState compact title="Nothing logged yet" /> : (
          <table className="w-full text-xs">
            <tbody>
              {status.log.map(l => (
                <tr key={l.id} className="border-b border-gray-800 last:border-0 align-top">
                  <td className="px-3 py-1 text-gray-500 whitespace-nowrap font-mono">{formatDateTime(l.time)}</td>
                  <td className="px-2 py-1"><Pill tone={levelTone[l.level]}>{l.level}</Pill></td>
                  <td className="px-2 py-1 text-gray-400 whitespace-nowrap">{[l.environment, l.kind && (JOB_LABELS[l.kind] ?? l.kind)].filter(Boolean).join(' · ')}</td>
                  <td className="px-3 py-1 text-gray-200">{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
