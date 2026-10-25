// Slide-over details: one rule (history chart, latest failing rows, SQL, runs)
// and one run (result, failing-row sample, the SQL that ran).
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ShieldCheck, Play, ListChecks, Loader2 } from 'lucide-react';
import { Panel, Pill, StatCard, ToolbarButton, LoadingState, EmptyState } from '../ui';
import { formatDateTime, formatDuration, formatNumber, formatDayMonth, formatTime } from '../../utils/formatters';
import {
  describeParams, useFetched, formatPct, isBinaryRule, ruleState, ruleTarget, RULE_TYPES, scoreTone, severityTone,
  type DqActions, type Rule, type Run,
} from './model';
import { Drawer, ErrorBox, SampleTable, SqlBlock, StatusPill } from './widgets';

const statusColor = { pass: '#22c55e', fail: '#ef4444', error: '#f59e0b' } as const;

export function RuleDrawer({ rule, actions, onClose }: { rule: Rule; actions: DqActions; onClose: () => void }) {
  const { data: runs, error } = useFetched<Run[]>(`/rules/${rule.id}/history`, rule.lastRun?.id || 'none');
  const running = actions.isRunning(rule.id);
  const last = rule.lastRun;
  const binary = isBinaryRule(rule);
  const withSample = runs?.find(r => r.sample?.length);
  const chart = (runs || []).slice().reverse().map(r => ({
    time: `${formatDayMonth(r.time)} ${formatTime(r.time, { seconds: false })}`,
    compliance: r.compliance,
    status: r.status,
    failing: r.failing,
  }));
  const meta = RULE_TYPES[rule.type];

  return (
    <Drawer title={rule.name} icon={ShieldCheck} onClose={onClose}
      pills={<><StatusPill state={ruleState(rule)} /><Pill tone={severityTone[rule.severity]}>{rule.severity}</Pill></>}
      actions={
        <>
          <ToolbarButton icon={running ? Loader2 : Play} disabled={running} onClick={() => void actions.runRules({ ids: [rule.id] }, rule.name)}>Run now</ToolbarButton>
        </>
      }>
      <div className="text-xs text-gray-400 space-y-1">
        <div>
          <span className="text-gray-300">{meta.label}</span> on{' '}
          <button className="font-mono text-blue-400 hover:underline" onClick={() => actions.openDataset(rule.database, rule.table)}>{rule.database}.{rule.table}</button>
          {ruleTarget(rule) && <span className="font-mono text-gray-300">.{ruleTarget(rule)}</span>}: {describeParams(rule)}
        </div>
        {rule.where && <div>Filter: <code className="text-gray-300">{rule.where}</code></div>}
        {rule.description && <div className="text-gray-500">{rule.description}</div>}
      </div>
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Compliance" value={formatPct(last?.compliance, 2)} tone={scoreTone(last?.compliance ?? null)} sub={binary ? 'pass/fail check' : `allowed failures ${rule.threshold}%`} />
        <StatCard label={binary ? 'Result' : 'Failing rows'} value={binary ? (last?.status ?? '-') : formatNumber(last?.failing)} tone={last?.failing ? 'red' : 'default'}
          sub={binary ? last?.detail || undefined : `of ${formatNumber(last?.total)} rows`} title={last?.detail || undefined} />
        <StatCard label="Last run" value={last ? formatDuration(last.duration) : '-'} sub={last ? `${formatDateTime(last.time)} · ${last.trigger}` : 'never run'} />
        <StatCard label="Pass rate" value={rule.history.length ? formatPct((rule.history.filter(h => h.status === 'pass').length / rule.history.length) * 100, 0) : '-'}
          sub={`last ${rule.history.length} runs`} />
      </div>
      {last?.error && <ErrorBox>{last.error}</ErrorBox>}

      <Panel title="Compliance history" className="h-56" bodyClassName="p-2">
        {!runs && !error ? <LoadingState label="Loading history…" /> : chart.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-gray-500">Run the check to start its history.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="time" tick={{ fill: '#9ca3af', fontSize: 10 }} stroke="#4b5563" minTickGap={30} />
              <YAxis domain={['auto', 100]} tick={{ fill: '#9ca3af', fontSize: 10 }} stroke="#4b5563" tickFormatter={v => `${+Number(v).toFixed(2)}%`} width={56} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', fontSize: 11 }}
                formatter={(v, _n, item) => [item.payload.status === 'error' ? 'error' : `${formatPct(v as number, 3)} (${item.payload.status}, ${formatNumber(item.payload.failing)} failing)`, 'compliance']} />
              <Line type="monotone" dataKey="compliance" stroke="#3b82f6" isAnimationActive={false} connectNulls
                dot={(props) => {
                  const { cx, cy, payload, index } = props as { cx?: number; cy?: number; payload: { status: keyof typeof statusColor }; index: number };
                  if (cx === undefined || cy === undefined || cy === null) return <g key={index} />;
                  return <circle key={index} cx={cx} cy={cy} r={3} fill={statusColor[payload.status]} stroke="none" />;
                }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {withSample && (
        <Panel title={`Failing rows (sample from ${formatDateTime(withSample.time)})`} bodyClassName="p-2">
          <SampleTable columns={withSample.sampleColumns} rows={withSample.sample} />
        </Panel>
      )}
      {runs?.[0]?.sql && (
        <Panel title="Check SQL" bodyClassName="p-2"><SqlBlock sql={runs[0].sql} /></Panel>
      )}

      <Panel title="Runs" bodyClassName="p-0">
        {error && <div className="p-3"><ErrorBox>{error}</ErrorBox></div>}
        {!runs && !error && <LoadingState compact label="Loading runs…" />}
        {runs && runs.length === 0 && <EmptyState compact title="No runs in this environment" />}
        {runs && runs.length > 0 && (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-gray-800 sticky top-0 text-gray-300">
                <tr>{['Time', 'Status', 'Failing', 'Rows', 'Compliance', 'Took', 'Trigger', 'Detail'].map(h => <th key={h} className="text-left font-semibold px-2 py-1">{h}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} onClick={() => actions.openRun(r.id)} className="border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer text-gray-400">
                    <td className="px-2 py-1 whitespace-nowrap">{formatDateTime(r.time)}</td>
                    <td className="px-2 py-1"><StatusPill state={r.status} /></td>
                    <td className={`px-2 py-1 text-right ${r.failing ? 'text-red-400' : ''}`}>{formatNumber(r.failing)}</td>
                    <td className="px-2 py-1 text-right">{binary ? '-' : formatNumber(r.total)}</td>
                    <td className="px-2 py-1 text-right">{formatPct(r.compliance, 2)}</td>
                    <td className="px-2 py-1 text-right">{formatDuration(r.duration)}</td>
                    <td className="px-2 py-1">{r.trigger}</td>
                    <td className="px-2 py-1 truncate max-w-[220px]" title={r.error || r.detail || ''}>{r.error || r.detail || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Drawer>
  );
}

interface RunDetail extends Run { rule: Rule | null }

export function RunDrawer({ id, actions, onClose }: { id: string; actions: DqActions; onClose: () => void }) {
  const { data: run, error } = useFetched<RunDetail>(`/runs/${id}`, id);
  const binary = run?.rule ? isBinaryRule(run.rule) : false;
  return (
    <Drawer title={run?.rule?.name || 'Run'} icon={ListChecks} onClose={onClose}
      pills={run && <><StatusPill state={run.status} /><Pill>{run.trigger}</Pill><Pill>{run.environment}</Pill></>}
      actions={run?.rule && <ToolbarButton icon={ShieldCheck} onClick={() => actions.openRule(run.ruleId)}>Open check</ToolbarButton>}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {!run && !error && <LoadingState label="Loading run…" />}
      {run && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <StatCard label="Compliance" value={formatPct(run.compliance, 3)} tone={scoreTone(run.compliance)} />
            <StatCard label={binary ? 'Result' : 'Failing rows'} value={binary ? run.status : formatNumber(run.failing)} tone={run.failing ? 'red' : 'default'}
              sub={binary ? undefined : `of ${formatNumber(run.total)} rows`} />
            <StatCard label="Duration" value={formatDuration(run.duration)} />
            <StatCard label="Time" value={formatDateTime(run.time)} />
          </div>
          {run.detail && <div className="text-xs text-gray-300">{run.detail}</div>}
          {run.error && <ErrorBox>{run.error}</ErrorBox>}
          {run.sampleError && <ErrorBox>Sample query failed: {run.sampleError}</ErrorBox>}
          {run.sample.length > 0 && (
            <Panel title={`Failing rows (first ${run.sample.length})`} bodyClassName="p-2">
              <SampleTable columns={run.sampleColumns} rows={run.sample} />
            </Panel>
          )}
          {run.sampleTrimmed && <div className="text-[11px] text-gray-500">The failing-row sample is only kept for the newest runs of each check.</div>}
          {run.sql && <Panel title="Check SQL" bodyClassName="p-2"><SqlBlock sql={run.sql} /></Panel>}
          {run.queryId && <div className="text-[11px] text-gray-500 font-mono">query_id {run.queryId}</div>}
        </>
      )}
    </Drawer>
  );
}
