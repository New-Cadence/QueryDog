import { useMemo } from 'react';
import { BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { PiggyBank, TrendingUp, Wallet, CalendarClock, AlertTriangle, CheckCircle2, CalendarDays } from 'lucide-react';
import { Panel, StatCard } from '../ui';
import { CostToolbar, InfoBox, Spinner } from './common';
import { axisTick, money, pct, tooltipStyle, useCost } from './costContext';
import { envSettings } from './costApi';
import { addDays, flatMonthForecast, forecastMonth, todayUtc, type MonthForecast, type UsageRow } from './usage';
import { formatMonthYear } from '../../utils/formatters';

// Monthly budget for the environment: forecast vs budget, the projected
// overspend date and warning thresholds. Cloud uses billed usage; open source
// uses the configured monthly cost. The budget is set under Settings > Budget.
export function BudgetTab({ rows, loadedFrom, loading, ossMonthly }: { rows?: UsageRow[]; loadedFrom?: string; loading?: boolean; ossMonthly?: number | null }) {
  const { status, settings } = useCost();
  const env = envSettings(settings, status.environment);
  const today = todayUtc();
  const isCloud = status.deployment === 'cloud';

  const scoped = useMemo(() => (rows || []).filter(r => env.budgetScope === 'organization' || r.own), [rows, env.budgetScope]);
  const forecast: MonthForecast | null = isCloud
    ? forecastMonth(scoped, today, env.budget)
    : ossMonthly ? flatMonthForecast(ossMonthly, today, env.budget) : null;

  const budget = env.budget;
  const ratio = budget && forecast ? forecast.forecast / budget : null;
  const state = !budget || !forecast ? 'unset'
    : forecast.monthToDate > budget ? 'over'
      : ratio! > 1 ? 'forecast-over'
        : ratio! * 100 >= env.warnPct ? 'warn' : 'ok';
  const remainingDays = forecast ? forecast.daysInMonth - forecast.dayOfMonth + 1 : 0;
  const history = isCloud && forecast ? monthlyHistory(scoped, loadedFrom ?? today, forecast) : [];
  const allowance = budget && forecast ? Math.max(0, budget - forecast.monthToDate) / remainingDays : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        right={isCloud && (
          <span className="text-[11px] text-gray-400">Budget covers {env.budgetScope === 'organization' ? 'the whole organisation' : "this environment's service"}</span>
        )}
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {!forecast && <InfoBox>Set node prices in Settings → Costs to forecast this environment's monthly cost.</InfoBox>}
        {isCloud && !status.serviceId && env.budgetScope === 'service' && (
          <InfoBox>cloud_api.service_id is not set for this environment, so no service is marked as its own. Set the budget to cover the whole organisation in Settings › Budget, or add service_id.</InfoBox>
        )}
        {forecast && (
          <>
            <BudgetBanner state={state} forecast={forecast} budget={budget} warnPct={env.warnPct} />
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
              <StatCard label="Monthly budget" icon={PiggyBank} value={money(budget)} sub={budget ? `warn at ${env.warnPct}%` : 'not set'} />
              <StatCard label="Month to date" icon={Wallet} value={money(forecast.monthToDate)} sub={budget ? `${pct(forecast.monthToDate / budget)} of budget` : `${forecast.dayOfMonth} of ${forecast.daysInMonth} days`} />
              <StatCard label="Month-end forecast" icon={TrendingUp} value={money(forecast.forecast)}
                tone={state === 'ok' ? 'green' : state === 'warn' ? 'yellow' : state === 'unset' ? 'default' : 'red'}
                sub={ratio !== null ? `${pct(ratio)} of budget` : undefined} />
              <StatCard label={budget && forecast.forecast > budget ? 'Projected overspend' : 'Headroom'} icon={AlertTriangle}
                value={budget ? money(Math.abs(budget - forecast.forecast)) : '—'} tone={budget && forecast.forecast > budget ? 'red' : 'default'} />
              <StatCard label="Overspend date" icon={CalendarClock} value={forecast.overspendDate ?? (budget ? 'none this month' : '—')}
                tone={forecast.overspendDate ? 'red' : 'default'} />
              <StatCard label="Daily allowance" icon={CalendarDays} value={allowance === null ? '—' : money(allowance)}
                sub={`spending ${money(forecast.dailyRate)}/day now`} tone={allowance !== null && forecast.dailyRate > allowance ? 'yellow' : 'default'} />
            </div>
            <div className="grid grid-cols-1 gap-3">
              <Panel title={`Cumulative spend, ${forecast.month}`} className="h-80" bodyClassName="p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={forecast.series}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" tick={axisTick} stroke="#4b5563" tickFormatter={d => d.slice(8)} />
                    <YAxis tick={axisTick} stroke="#4b5563" tickFormatter={v => money(Number(v))} width={60} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => money(Number(v), 2)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line dataKey="actual" name="Actual" stroke="#3b82f6" strokeWidth={2} dot={false} connectNulls={false} />
                    <Line dataKey="projected" name="Forecast" stroke="#3b82f6" strokeDasharray="5 4" strokeWidth={2} dot={false} />
                    {budget && <ReferenceLine y={budget} ifOverflow="extendDomain" stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Budget', fill: '#f87171', fontSize: 10, position: 'insideTopLeft' }} />}
                    {budget && <ReferenceLine y={(budget * env.warnPct) / 100} ifOverflow="extendDomain" stroke="#f59e0b" strokeDasharray="2 4" label={{ value: `${env.warnPct}%`, fill: '#fbbf24', fontSize: 10, position: 'insideBottomLeft' }} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>
            </div>
            {isCloud && (
              <Panel title="Monthly actuals" className="shrink-0" bodyClassName="p-0">
                {loading && history.length < 2 ? <Spinner label="Loading billing history…" /> : (
                  <div className="grid grid-cols-1 xl:grid-cols-4">
                    <div className="xl:col-span-3 h-64 p-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={history} margin={{ top: 10, right: 10, left: 5, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                          <XAxis dataKey="label" tick={axisTick} stroke="#4b5563" />
                          <YAxis tick={axisTick} stroke="#4b5563" tickFormatter={v => money(Number(v))} width={60} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [money(Number(v), 2), n]} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar dataKey="actual" name="Actual" stackId="m" fill="#3b82f6" isAnimationActive={false} />
                          <Bar dataKey="forecastRest" name="Forecast (rest of month)" stackId="m" fill="#3b82f6" fillOpacity={0.35} isAnimationActive={false} />
                          {budget && <ReferenceLine y={budget} ifOverflow="extendDomain" stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Budget', fill: '#f87171', fontSize: 10, position: 'insideTopLeft' }} />}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <table className="text-xs self-start w-full">
                      <thead>
                        <tr className="text-[11px] text-gray-500 border-b border-gray-800">
                          <th className="text-left font-normal px-3 py-1.5">Month</th>
                          <th className="text-right font-normal px-2">Actual</th>
                          <th className="text-right font-normal px-3">{budget ? 'of budget' : ''}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...history].reverse().map(m => (
                          <tr key={m.month} className="border-b border-gray-800/60">
                            <td className="px-3 py-1.5 text-gray-300" title={m.partial ? 'Billing data starts part-way through this month' : undefined}>
                              {m.label}{m.partial ? ' *' : ''}{m.current ? ' (to date)' : ''}
                            </td>
                            <td className="px-2 text-right font-mono text-gray-200">{money(m.actual, 2)}</td>
                            <td className={`px-3 text-right ${budget && m.actual + m.forecastRest > budget ? 'text-red-400' : 'text-gray-400'}`}>
                              {budget ? pct((m.actual + m.forecastRest) / budget) : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface MonthActual { month: string; label: string; actual: number; forecastRest: number; current: boolean; partial: boolean }

// Billed spend per calendar month over the loaded window, plus the current
// month's forecast remainder; a month that starts before the data is partial.
function monthlyHistory(rows: UsageRow[], loadedFrom: string, forecast: MonthForecast): MonthActual[] {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.date.slice(0, 7), (totals.get(r.date.slice(0, 7)) || 0) + r.total);
  const months: MonthActual[] = [];
  for (let m = loadedFrom.slice(0, 7); m <= forecast.month; m = addDays(`${m}-28`, 7).slice(0, 7)) {
    const actual = totals.get(m) || 0;
    const current = m === forecast.month;
    months.push({
      month: m,
      label: formatMonthYear(`${m}-01`),
      actual,
      forecastRest: current ? Math.max(0, forecast.forecast - actual) : 0,
      current,
      partial: `${m}-01` < loadedFrom,
    });
  }
  return months;
}

function BudgetBanner({ state, forecast, budget, warnPct }: { state: string; forecast: MonthForecast; budget: number | null; warnPct: number }) {
  if (state === 'unset') return <InfoBox>No budget set. Enter a monthly budget to track the forecast against it.</InfoBox>;
  const styles: Record<string, string> = {
    ok: 'bg-green-900/30 border-green-800 text-green-300',
    warn: 'bg-yellow-900/40 border-yellow-800 text-yellow-300',
    'forecast-over': 'bg-red-900/40 border-red-800 text-red-300',
    over: 'bg-red-900/50 border-red-700 text-red-200',
  };
  const text: Record<string, string> = {
    ok: `On track: forecast ${money(forecast.forecast)} is within the ${money(budget)} budget.`,
    warn: `At risk: forecast ${money(forecast.forecast)} has passed ${warnPct}% of the ${money(budget)} budget.`,
    'forecast-over': `Forecast to exceed the ${money(budget)} budget on ${forecast.overspendDate} (month-end ${money(forecast.forecast)}).`,
    over: `Over budget: ${money(forecast.monthToDate)} spent this month against ${money(budget)}.`,
  };
  const Icon = state === 'ok' ? CheckCircle2 : AlertTriangle;
  return <div className={`px-3 py-2 rounded text-xs border flex items-center gap-2 shrink-0 ${styles[state]}`}><Icon className="w-3.5 h-3.5" />{text[state]}</div>;
}
