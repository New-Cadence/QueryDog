import { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { CircleDollarSign, TrendingUp, Wallet, CalendarDays, Coins, Server, PieChart as PieIcon, Star, Layers } from 'lucide-react';
import { useClientFilters } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { Panel, StatCard, ToolbarSearch, EmptyState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { CostToolbar, ErrorBox, FilterCounts, Spinner } from './common';
import { money, pct, tooltipStyle, useCost } from './costContext';
import { envSettings } from './costApi';
import { CostRangeSelector, CostTimelineChart, type CostSplit } from './CostTimeline';
import { rangeDays, rangeLabel } from './costRange';
import { addDays, byService, forecastMonth, METRIC_GROUPS, sumGroups, USAGE_FILTER_FIELDS, usageSearchText } from './usage';
import type { CloudData } from './useCloudData';

export function CloudOverviewTab({ data }: { data: CloudData }) {
  const { status, settings, view } = useCost();
  const { from, to } = view.range;
  const budget = envSettings(settings, status.environment).budget;
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(data.rows, USAGE_FILTER_FIELDS, usageSearchText);
  // The chart's By Category / By Service tabs also choose the breakdown below it
  const [split, setSplit] = useState<CostSplit>('category');

  const inPeriod = useMemo(() => filtered.filter(r => r.date >= from && r.date <= to), [filtered, from, to]);
  const totals = sumGroups(inPeriod);
  const services = useMemo(() => byService(inPeriod), [inPeriod]);
  // Month figures are always about the current month, whatever range is selected
  const forecast = useMemo(() => forecastMonth(filtered, data.to, budget), [filtered, data.to, budget]);

  // Same window one period earlier, for the change figure
  const days = rangeDays(view.range);
  const prevFrom = addDays(from, -days);
  const previous = filtered.filter(r => r.date >= prevFrom && r.date < from).reduce((s, r) => s + r.total, 0);
  const hasPrevious = prevFrom >= data.from;
  const change = hasPrevious && previous > 0 ? totals.total / previous - 1 : null;
  // Still fetching a window that doesn't cover the selected range yet
  const pending = data.loading && (data.from > from || !data.rows.length);

  const credits = data.org?.credits;
  const orgDaily = forecastMonth(data.rows, data.to, null).dailyRate;
  const runwayDays = credits && orgDaily > 0 ? credits.totalRemaining / orgDaily : null;

  const breakdown = METRIC_GROUPS.map((g, i) => ({ name: g, value: totals[g], color: CHART_COLORS[i] })).filter(b => b.value > 0);
  const budgetTone = !budget ? 'default' : forecast.forecast > budget ? 'red' : forecast.forecast > budget * 0.8 ? 'yellow' : 'green';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={data.rows} fields={USAGE_FILTER_FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <CostRangeSelector />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search services..." width="w-48" />
        </>}
        right={<FilterCounts count={inPeriod.length} noun="usage records" active={activeCount} />}
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {data.error && <ErrorBox error={data.error} />}
        {pending ? <Spinner label="Loading billing data from the ClickHouse Cloud API…" /> : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
              <StatCard label="Month to date" icon={Wallet} value={money(forecast.monthToDate)} sub={`${forecast.dayOfMonth} of ${forecast.daysInMonth} days (UTC)`} />
              <StatCard label="Month-end forecast" icon={TrendingUp} value={money(forecast.forecast)} tone={budgetTone}
                sub={budget ? `${pct(forecast.forecast / budget)} of ${money(budget)} budget` : `at ${money(forecast.dailyRate)}/day (7-day avg)`} />
              <StatCard label={rangeLabel(view.range)} icon={CircleDollarSign} value={money(totals.total)}
                tone={change === null ? 'default' : change > 0.1 ? 'yellow' : 'green'}
                sub={change === null ? 'no earlier period to compare' : `${change >= 0 ? '+' : ''}${pct(change)} vs previous ${days} days`} />
              <StatCard label="Daily average" icon={CalendarDays} value={money(totals.total / days)} sub={`${money((totals.total / days) * 30.4)} / month run-rate`} />
              <StatCard label="Credits remaining" icon={Coins} value={credits ? money(credits.totalRemaining) : '—'}
                tone={runwayDays !== null && runwayDays < 30 ? 'red' : 'default'}
                sub={credits ? (runwayDays !== null ? `~${Math.round(runwayDays)} days at current org spend` : `${credits.balances.length} balance(s)`) : 'not available for this key'} />
              <StatCard label="Largest driver" icon={PieIcon} value={breakdown.length ? [...breakdown].sort((a, b) => b.value - a.value)[0].name : '—'}
                sub={breakdown.length && totals.total > 0 ? `${pct([...breakdown].sort((a, b) => b.value - a.value)[0].value / totals.total)} of spend` : undefined} />
            </div>

            <CostTimelineChart rows={filtered} split={split} onSplitChange={setSplit} />

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
              <Panel title="Breakdown" icon={PieIcon} className="h-72" bodyClassName="p-2">
                {breakdown.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={breakdown} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="80%" paddingAngle={2} stroke="none">
                        {breakdown.map(b => <Cell key={b.name} fill={b.color} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={v => money(Number(v), 2)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <EmptyState compact title="No spend in this period" />}
              </Panel>
            {split === 'category' ? (
            <Panel title="Spend by category" icon={Layers} className="xl:col-span-2" bodyClassName="divide-y divide-gray-800">
              {breakdown.length === 0 && <EmptyState compact title="No usage in this period" />}
              {[...breakdown].sort((a, b) => b.value - a.value).map((b, _i, sorted) => (
                <div key={b.name} className="px-3 py-2 flex items-center gap-3">
                  <div className="w-64 min-w-0 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded shrink-0" style={{ backgroundColor: b.color }} />
                    <span className="text-xs text-gray-200 truncate">{b.name}</span>
                  </div>
                  <div className="flex-1 h-2 rounded overflow-hidden bg-gray-800">
                    <div className="h-full" style={{ width: `${(b.value / (sorted[0].value || 1)) * 100}%`, backgroundColor: b.color }} />
                  </div>
                  <span className="w-24 text-right text-xs font-mono text-gray-200">{money(b.value, 2)}</span>
                  <span className="w-14 text-right text-[11px] text-gray-500">{pct(totals.total ? b.value / totals.total : 0)}</span>
                </div>
              ))}
            </Panel>
            ) : (
            <Panel title="Spend by service" icon={Server} className="xl:col-span-2" bodyClassName="divide-y divide-gray-800">
              {services.length === 0 && <EmptyState compact title="No usage in this period" />}
              {services.map(s => (
                <div key={s.service} className={`px-3 py-2 flex items-center gap-3 ${s.own ? 'bg-blue-900/20' : ''}`}>
                  <div className="w-64 min-w-0 flex items-center gap-1.5">
                    {s.own && <Star className="w-3 h-3 text-blue-400 shrink-0" aria-label="This environment's service" />}
                    <span className={`text-xs truncate ${s.own ? 'text-blue-300 font-semibold' : 'text-gray-200'}`} title={s.service}>{s.service}</span>
                  </div>
                  <div className="flex-1 flex h-2 rounded overflow-hidden bg-gray-800">
                    {METRIC_GROUPS.map((g, i) => s[g] > 0 && (
                      <div key={g} title={`${g}: ${money(s[g], 2)}`} style={{ width: `${(s[g] / (services[0].total || 1)) * 100}%`, backgroundColor: CHART_COLORS[i] }} />
                    ))}
                  </div>
                  <span className="w-24 text-right text-xs font-mono text-gray-200">{money(s.total, 2)}</span>
                  <span className="w-14 text-right text-[11px] text-gray-500">{pct(totals.total ? s.total / totals.total : 0)}</span>
                </div>
              ))}
            </Panel>
            )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
