import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { Gauge, Users, Zap, Timer, AlertTriangle, TrendingUp } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { Panel, StatCard, EmptyState, Field } from '../ui';
import { CHART_COLORS, inputClass } from '../uiTokens';
import { fmtMs } from './model';
import type { Scenario } from './model';
import type { CapacitySettings, CapacityStep } from './engine';
import type { CapacityOutcome } from './useSimulation';
import { axisStroke, axisTick, gridStroke, legendStyle, tooltipStyle } from './chartStyle';

export function CapacityView({ scenario, settings, onSettings, steps, outcome, running }: {
  scenario: Scenario;
  settings: CapacitySettings;
  onSettings: (s: CapacitySettings) => void;
  steps: CapacityStep[];
  outcome: CapacityOutcome | null;
  running: boolean;
}) {
  const set = (k: keyof CapacitySettings, v: string) => onSettings({ ...settings, [k]: Math.max(1, Number(v) || 1) });
  const best = outcome?.sustainable;
  const last = steps[steps.length - 1];

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden min-w-0">
      <Panel title="Capacity finder settings" icon={TrendingUp} className="shrink-0">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Start VUs"><input type="number" min={1} value={settings.startVus} disabled={running} onChange={e => set('startVus', e.target.value)} className={inputClass} /></Field>
          <Field label="Step (+VUs)"><input type="number" min={1} value={settings.stepVus} disabled={running} onChange={e => set('stepVus', e.target.value)} className={inputClass} /></Field>
          <Field label="Stop at VUs"><input type="number" min={1} value={settings.maxVus} disabled={running} onChange={e => set('maxVus', e.target.value)} className={inputClass} /></Field>
          <Field label="Simulated seconds per step"><input type="number" min={1} value={settings.stepSec} disabled={running} onChange={e => set('stepSec', e.target.value)} className={inputClass} /></Field>
        </div>
        <div className="text-[10px] text-gray-500 mt-2">
          Uses the scenario's query mix, think time, QPS cap, simulated capacity, pass criteria and per-query SLOs. Each step holds a constant VU count;
          the search stops at the first step that breaches. Steps are simulated faster than real time.
          {' '}Note the QPS cap limits throughput, so raise it if the search never breaches.
        </div>
      </Panel>

      <div className="grid grid-cols-5 gap-3 shrink-0">
        <StatCard label="Max sustainable VUs" icon={Users} tone={best ? 'green' : 'default'}
          value={best ? best.vus : outcome ? 'none' : running ? '…' : '—'}
          sub={outcome ? (outcome.breaking ? `breaks at ${outcome.breaking.vus} VUs` : `no breach up to ${last?.vus} VUs`) : running ? `testing ${last?.vus ?? settings.startVus} VUs` : 'not run'} />
        <StatCard label="Throughput there" icon={Zap} tone="blue" value={best ? `${formatNumber(best.qps)} qps` : '—'} />
        <StatCard label="p95 there" icon={Timer} value={best ? fmtMs(best.p95) : '—'} sub={`threshold ${fmtMs(scenario.p95ThresholdMs)}`} />
        <StatCard label="Errors there" icon={AlertTriangle} value={best ? `${best.errorPct}%` : '—'} sub={`limit ${scenario.errorThresholdPct}%`} />
        <StatCard label="Steps" icon={Gauge} value={steps.length} sub={running ? 'searching' : outcome ? 'finished' : steps.length ? 'stopped' : ''} />
      </div>

      {outcome?.breaking && (
        <div className="shrink-0 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          <span className="text-gray-300">Breaking point at {outcome.breaking.vus} VUs: </span>{outcome.breaking.breaches.join(' · ')}
        </div>
      )}

      {steps.length === 0 ? (
        <Panel className="flex-1">
          <EmptyState icon={TrendingUp} title="Press Find max VUs to search for the concurrency limit">
            Virtual users are stepped up until p95 latency, the error rate or a per-query SLO breaches. This is a browser simulation calibrated from
            recorded query latencies; it does not load ClickHouse.
          </EmptyState>
        </Panel>
      ) : (
        <Panel title="Latency and throughput by virtual users (simulated)" icon={Gauge} className="flex-1" bodyClassName="p-2">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={steps}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="vus" type="number" domain={['dataMin', 'dataMax']} tick={axisTick} stroke={axisStroke} name="VUs" />
              <YAxis yAxisId="ms" tick={axisTick} stroke={axisStroke} unit="ms" />
              <YAxis yAxisId="qps" orientation="right" tick={axisTick} stroke={axisStroke} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={v => `${v} VUs`} />
              <Legend wrapperStyle={legendStyle} />
              <Area yAxisId="qps" type="monotone" dataKey="qps" name="QPS" stroke={CHART_COLORS[0]} fill={CHART_COLORS[0]} fillOpacity={0.15} isAnimationActive={false} />
              <Line yAxisId="ms" type="monotone" dataKey="p50" name="p50" stroke={CHART_COLORS[1]} dot={false} isAnimationActive={false} />
              <Line yAxisId="ms" type="monotone" dataKey="p95" name="p95" stroke={CHART_COLORS[2]} dot={{ r: 2 }} isAnimationActive={false} />
              <ReferenceLine yAxisId="ms" y={scenario.p95ThresholdMs} stroke={CHART_COLORS[4]} strokeDasharray="4 4" label={{ value: 'p95 threshold', fill: '#9ca3af', fontSize: 10, position: 'insideTopLeft' }} />
              {best && <ReferenceLine yAxisId="ms" x={best.vus} stroke={CHART_COLORS[5]} strokeDasharray="4 4" label={{ value: `max ${best.vus} VUs`, fill: '#9ca3af', fontSize: 10, position: 'insideTopRight' }} />}
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      )}
    </div>
  );
}
