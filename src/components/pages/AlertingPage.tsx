import { useState, useEffect, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import {
  Bell, BellRing, ListChecks, Siren, Send, X, CheckCircle2, Clock,
  ShieldAlert, Activity, Timer, VolumeX, AlertTriangle,
} from 'lucide-react';
import { useGridTheme, useIsLightMode } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { TimeRangeBar } from '../TimeRangeBar';
import { bucketFloor, bucketLabel, bucketTimes, useTimeWindow } from '../../hooks/useTimeWindow';
import { AlertsPage } from './AlertsPage';
import { ClientFolderNotice } from '../ClientFolderNotice';
import { PageToolbar, PageTabs, ToolbarHost, Panel, StatCard, Pill, ToolbarButton, ToolbarSearch, Field, EmptyState, LoadingState } from '../ui';
import { inputClass, CHART_COLORS } from '../uiTokens';
import {
  api, severityTone, statusTone, formatAgo, durationBetween, silenceFor, useEscape, POLL_MS, type Act, type AlertingState, type AlertRule, type Delivery, type Incident, type IncidentStatus, type Severity, type Silence,
} from '../alerting/model';
import { DeliveryRow } from '../alerting/widgets';
import { SilenceDialog } from '../checks/SilenceDialog';
import { formatDateTime } from '../../utils/formatters';
import { GRID_OVERLAYS } from '../gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

type AlertingTab = 'overview' | 'checks' | 'incidents' | 'silences';

// ==================== Page ====================

export function AlertingPage({ hasAlertsFolder }: { hasAlertsFolder: boolean }) {
  const [tab, setTab] = useState<AlertingTab>('overview');
  const [state, setState] = useState<AlertingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [openIncident, setOpenIncident] = useState<string | null>(null);
  const [silenceTarget, setSilenceTarget] = useState<string | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setState(await api<AlertingState>('GET', '/state'));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const act: Act = useCallback(async (fn, success) => {
    try {
      await fn();
      if (success) setToast({ ok: true, text: success });
      return true;
    } catch (e) {
      setToast({ ok: false, text: (e as Error).message });
      return false;
    } finally {
      await refresh();
    }
  }, [refresh]);

  if (!state) {
    return loadError
      ? <EmptyState icon={AlertTriangle} title="Could not load alerting state">{loadError}</EmptyState>
      : <LoadingState label="Loading alerting…" />;
  }

  const { rules, incidents, channels, silences } = state;
  const firing = incidents.filter(i => i.status === 'firing');

  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'checks' as const, label: 'Checks', icon: ListChecks },
    { id: 'incidents' as const, label: 'Incidents', icon: Siren, badge: firing.length ? <Pill tone="red">{firing.length}</Pill> : undefined },
    { id: 'silences' as const, label: 'Silences', icon: VolumeX, badge: silences.length ? <Pill tone="yellow">{silences.length}</Pill> : undefined },
  ];

  const tabActions = (
    <>
      {toast && (
        <span className={`text-xs flex items-center gap-1 ${toast.ok ? 'text-green-400' : 'text-red-400'}`}>
          {toast.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{toast.text}
        </span>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col">
      <ToolbarHost>
      <PageTabs tabs={tabs} active={tab} onChange={setTab} right={tabActions} />
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'checks' ? (
          hasAlertsFolder ? (
            <AlertsPage
              rules={rules}
              channels={channels}
              silences={silences}
              act={act}
              onChanged={refresh}
              onSilence={setSilenceTarget}
            />
          ) : (
            <ClientFolderNotice kind="monitoring" className="m-1.5 mt-3" />
          )
        ) : (
          <>
            {tab === 'overview' && <OverviewTab state={state} onOpen={setTab} onOpenIncident={setOpenIncident} />}
            {tab === 'incidents' && <IncidentsTab incidents={incidents} act={act} onOpenIncident={setOpenIncident} />}
            {tab === 'silences' && <SilencesTab silences={silences} act={act} onNew={() => setSilenceTarget(null)} />}
          </>
        )}
      </div>
      {openIncident && (
        <IncidentDrawer
          id={openIncident}
          summary={incidents.find(i => i.id === openIncident)}
          act={act}
          onClose={() => setOpenIncident(null)}
        />
      )}
      {silenceTarget !== undefined && (
        <SilenceEditor check={silenceTarget} rules={rules} act={act} onClose={() => setSilenceTarget(undefined)} />
      )}
      </ToolbarHost>
    </div>
  );
}

// ==================== Overview ====================

// Chart styling shared with the Observability query timeline: tight margins,
// small ticks and theme-aware colours, with the legend in the panel header.
const CHART_MARGIN = { top: 15, right: 15, left: 5, bottom: 5 };
const SEVERITY_SERIES = [
  { key: 'critical', color: CHART_COLORS[4] },
  { key: 'warning', color: CHART_COLORS[2] },
  { key: 'info', color: CHART_COLORS[0] },
];

function useChartColors() {
  const isLight = useIsLightMode();
  return useMemo(() => ({
    grid: isLight ? '#e5e7eb' : '#374151',
    tick: isLight ? '#6b7280' : '#9ca3af',
    tooltip: {
      backgroundColor: isLight ? '#ffffff' : '#1f2937',
      border: `1px solid ${isLight ? '#e5e7eb' : '#374151'}`,
      borderRadius: '4px',
      fontSize: '11px',
    },
  }), [isLight]);
}

function ChartLegend({ items }: { items: { key: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-3 text-[11px]">
      {items.map(i => (
        <div key={i.key} className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: i.color }} />
          <span className="text-gray-400">{i.key}</span>
        </div>
      ))}
    </div>
  );
}

function OverviewTab({ state, onOpen, onOpenIncident }: { state: AlertingState; onOpen: (t: AlertingTab) => void; onOpenIncident: (id: string) => void }) {
  const { rules, channels, silences } = state;
  const cc = useChartColors();
  const win = useTimeWindow('20160');
  const { filters, setFilter, clearAll, search, setSearch, filtered: incidents, activeCount } = useClientFilters(state.incidents, incidentFields, incidentSearchText);
  const inWindow = useMemo(() => incidents.filter(i => { const t = new Date(i.openedAt).getTime(); return t >= win.start && t <= win.end; }), [incidents, win.start, win.end]);
  const firing = incidents.filter(i => i.status === 'firing');
  const active = incidents.filter(i => i.status !== 'resolved');
  const resolved = inWindow.filter(i => i.status === 'resolved' && i.resolvedAt);
  const erroring = rules.filter(r => r.lastError);
  const mttr = resolved.length
    ? Math.round(resolved.reduce((s, i) => s + (new Date(i.resolvedAt!).getTime() - new Date(i.openedAt).getTime()), 0) / resolved.length / 60000)
    : null;

  const { perBucket, bucket } = useMemo(() => {
    const { times, bucket } = bucketTimes(win.start, win.end, win.bucket);
    const index = new Map(times.map((t, n) => [t, n]));
    const rows = times.map(t => ({ t, label: bucketLabel(t, bucket), critical: 0, warning: 0, info: 0, total: 0 }));
    for (const i of inWindow) {
      const row = rows[index.get(bucketFloor(new Date(i.openedAt).getTime(), bucket)) ?? -1];
      if (row) { row[i.severity] += 1; row.total += 1; }
    }
    return { perBucket: rows, bucket };
  }, [inWindow, win.start, win.end, win.bucket]);

  const noisiest = useMemo(() => {
    const counts = new Map<string, number>();
    inWindow.forEach(i => counts.set(i.check, (counts.get(i.check) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [inWindow]);

  const isLine = win.chartType === 'line' || win.chartType === 'stacked-line';
  const stacked = win.chartType === 'stacked-bar' || win.chartType === 'stacked-line';
  const incidentSeries = stacked ? SEVERITY_SERIES : [{ key: 'total', color: CHART_COLORS[0] }];
  const onChartClick = (e: { activeTooltipIndex?: number | string | null } | null) => {
    const row = perBucket[Number(e?.activeTooltipIndex)];
    if (row) win.zoomTo(row.t);
  };
  // Bucket charts key on the timestamp, since labels can repeat (the hour a DST change repeats)
  const labelOf = new Map(perBucket.map(b => [b.t, b.label]));
  const bucketLabelOf = (t: unknown) => labelOf.get(Number(t)) ?? String(t);
  const axes = (dataKey: string, width: number) => <>
    <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} />
    <XAxis dataKey={dataKey} tickFormatter={dataKey === 't' ? bucketLabelOf : undefined} minTickGap={20} tick={{ fontSize: 9, fill: cc.tick }} axisLine={{ stroke: cc.grid }} tickLine={{ stroke: cc.grid }} />
    <YAxis allowDecimals={false} width={width} tick={{ fontSize: 9, fill: cc.tick }} axisLine={{ stroke: cc.grid }} tickLine={{ stroke: cc.grid }} tickFormatter={v => v.toLocaleString()} />
  </>;

  return (
    <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
      <PageToolbar
        left={<>
          <ClientFilterPanel rows={state.incidents} fields={incidentFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <TimeRangeBar {...win.barProps} />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search checks, environments..." width="w-56" />
        </>}
        right={<>
          <span className="text-xs text-gray-400"><span className="text-white font-medium">{inWindow.length}</span> incident{inWindow.length === 1 ? '' : 's'} in range</span>
          {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filter{activeCount > 1 ? 's' : ''} active</span>}
        </>}
      />
      <div className="grid grid-cols-6 gap-3 shrink-0">
        <StatCard label="Firing now" icon={BellRing} value={firing.length} tone={firing.length ? 'red' : 'green'} />
        <StatCard label="Checks" icon={Bell} value={rules.length} />
        <StatCard label="Rule errors" icon={ShieldAlert} value={erroring.length} tone={erroring.length ? 'yellow' : 'default'} />
        <StatCard label="Active silences" icon={VolumeX} value={silences.length} tone={silences.length ? 'yellow' : 'default'} />
        <StatCard label="MTTR" icon={Timer} value={mttr === null ? '-' : `${mttr}m`} />
        <StatCard label="Channels" icon={Send} value={channels.filter(c => c.enabled).length} />
      </div>
      <Panel title="Incidents over time" className="h-64 shrink-0" bodyClassName={`p-0 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`} actions={<ChartLegend items={incidentSeries} />}>
        <ResponsiveContainer width="100%" height="100%">
          {isLine ? (
            <AreaChart data={perBucket} margin={CHART_MARGIN} onClick={onChartClick}>
              {axes('t', 30)}
              <Tooltip contentStyle={cc.tooltip} labelFormatter={bucketLabelOf} />
              {incidentSeries.map(sr => <Area key={sr.key} type="monotone" dataKey={sr.key} stackId={stacked ? 'a' : undefined} stroke={sr.color} fill={sr.color} fillOpacity={0.3} isAnimationActive={false} />)}
            </AreaChart>
          ) : (
            <BarChart data={perBucket} margin={CHART_MARGIN} onClick={onChartClick}>
              {axes('t', 30)}
              <Tooltip contentStyle={cc.tooltip} labelFormatter={bucketLabelOf} />
              {incidentSeries.map(sr => <Bar key={sr.key} dataKey={sr.key} stackId={stacked ? 'a' : undefined} fill={sr.color} fillOpacity={0.8} isAnimationActive={false} />)}
            </BarChart>
          )}
        </ResponsiveContainer>
      </Panel>
      <Panel title="Active incidents" icon={BellRing} actions={<ToolbarButton onClick={() => onOpen('incidents')}>View all</ToolbarButton>} bodyClassName="divide-y divide-gray-800">
        {active.length === 0 ? (
          <EmptyState compact icon={CheckCircle2} title="No active incidents" />
        ) : active.map(i => (
          <button key={i.id} onClick={() => onOpenIncident(i.id)} className="w-full px-3 py-2 flex items-center gap-3 hover:bg-gray-800/60 text-left">
            <BellRing className={`w-3.5 h-3.5 ${i.status === 'firing' ? 'text-red-400 animate-pulse' : 'text-yellow-400'}`} />
            <span className="text-xs font-mono text-white">{i.check}</span>
            <Pill tone={severityTone[i.severity]}>{i.severity}</Pill>
            <Pill tone={statusTone[i.status]}>{i.status}</Pill>
            {silenceFor(silences, i.check) && <Pill tone="yellow"><VolumeX className="w-3 h-3" />silenced</Pill>}
            <span className="ml-auto text-[11px] text-gray-500">{i.environment} · {i.rowCount} rows · started {formatAgo(i.openedAt)}</span>
          </button>
        ))}
      </Panel>
      <Panel title="Noisiest checks (in range)" bodyClassName="p-3 space-y-2 overflow-y-auto">
        {noisiest.length === 0 && <EmptyState compact title="No incidents in the selected range" />}
        {noisiest.map(([check, count]) => (
          <div key={check}>
            <div className="flex justify-between text-[11px]"><span className="font-mono text-gray-300 truncate">{check}</span><span className="text-gray-400">{count}</span></div>
            <div className="h-1.5 bg-gray-800 rounded mt-0.5"><div className="h-full bg-yellow-500 rounded" style={{ width: `${(count / noisiest[0][1]) * 100}%` }} /></div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ==================== Shared ====================

function RowsTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const cols = columns.length ? columns : Object.keys(rows[0] || {});
  return (
    <div className="overflow-auto max-h-64 border border-gray-700 rounded">
      <table className="text-[11px] font-mono w-full">
        <thead className="bg-gray-800 sticky top-0">
          <tr>{cols.map(c => <th key={c} className="text-left px-2 py-1 text-gray-200 font-semibold whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800">
              {cols.map(c => {
                const v = r[c];
                return <td key={c} className="px-2 py-0.5 text-gray-400 whitespace-nowrap max-w-[320px] truncate" title={String(v)}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ==================== Incidents ====================

const incidentFields: ClientFilterField<Incident>[] = [
  { field: 'status', label: 'Status' },
  { field: 'severity', label: 'Severity' },
  { field: 'check', label: 'Check' },
  { field: 'environment', label: 'Environment' },
];
const incidentSearchText = (i: Incident) => `${i.check} ${i.environment} ${i.acknowledgedBy || ''}`;

interface IncidentsContext { act: Act }

function IncidentActions({ incident, act }: { incident: Incident; act: Act }) {
  if (incident.status === 'resolved') return null;
  return (
    <div className="flex items-center gap-1">
      {incident.status === 'firing' && (
        <button onClick={e => { e.stopPropagation(); void act(() => api('POST', `/incidents/${incident.id}/acknowledge`, {}), 'Incident acknowledged'); }}
          className="px-1.5 py-0.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white text-[10px]">Acknowledge</button>
      )}
      <button onClick={e => { e.stopPropagation(); void act(() => api('POST', `/incidents/${incident.id}/resolve`, {}), 'Incident resolved'); }}
        className="px-1.5 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white text-[10px]">Resolve</button>
    </div>
  );
}

function IncidentsTab({ incidents, act, onOpenIncident }: { incidents: Incident[]; act: Act; onOpenIncident: (id: string) => void }) {
  const gridTheme = useGridTheme();
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(incidents, incidentFields, incidentSearchText);

  const cols = useMemo((): ColDef<Incident>[] => [
    {
      headerName: 'Status', field: 'status', width: 120,
      cellRenderer: (p: ICellRendererParams) => (
        <Pill tone={statusTone[p.value as IncidentStatus]}>
          {p.value === 'firing' ? <BellRing className="w-3 h-3" /> : p.value === 'acknowledged' ? <Clock className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
          {p.value}
        </Pill>
      ),
    },
    { headerName: 'Check', field: 'check', flex: 1, minWidth: 220, cellStyle: { color: '#f3f4f6' } },
    { headerName: 'Severity', field: 'severity', width: 95, cellRenderer: (p: ICellRendererParams) => <Pill tone={severityTone[p.value as Severity]}>{p.value}</Pill> },
    { headerName: 'Environment', field: 'environment', width: 120 },
    { headerName: 'Opened', field: 'openedAt', width: 175, sort: 'desc', valueFormatter: p => formatDateTime(p.value) },
    { headerName: 'Duration', width: 95, valueGetter: p => (p.data ? durationBetween(p.data.openedAt, p.data.resolvedAt) : '') },
    { headerName: 'Rows', field: 'rowCount', width: 70, type: 'rightAligned', cellStyle: { color: '#fbbf24' } },
    { headerName: 'Peak', field: 'peakRows', width: 70, type: 'rightAligned' },
    { headerName: 'Ack by', field: 'acknowledgedBy', width: 100 },
    { headerName: 'Resolved by', field: 'resolvedBy', width: 100 },
    {
      headerName: 'Actions', width: 160, sortable: false,
      cellRenderer: (p: ICellRendererParams<Incident, unknown, IncidentsContext>) => p.data && <div className="h-full flex items-center"><IncidentActions incident={p.data} act={p.context.act} /></div>,
    },
  ], []);

  const context: IncidentsContext = { act };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={incidents} fields={incidentFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search incidents..." />
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">{filtered.length} items</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
          </>
        }
      />
      <div className="flex-1 mx-1.5 mt-3 mb-4 bg-gray-900 border border-gray-700 rounded overflow-hidden">
        {incidents.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No incidents" />
        ) : (
          <AgGridReact<Incident> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} context={context} suppressCellFocus getRowId={p => p.data.id}
            onRowClicked={e => e.data && onOpenIncident(e.data.id)} rowStyle={{ cursor: 'pointer' }}
            defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }} />
        )}
      </div>
    </div>
  );
}

interface IncidentDetail extends Incident { columns: string[]; sample: Record<string, unknown>[]; deliveries: Delivery[] }

const timelineStyle: Record<string, { icon: typeof Bell; color: string }> = {
  opened: { icon: BellRing, color: 'text-red-400' },
  notified: { icon: Send, color: 'text-blue-400' },
  notify_failed: { icon: AlertTriangle, color: 'text-red-400' },
  suppressed: { icon: VolumeX, color: 'text-yellow-400' },
  acknowledged: { icon: Clock, color: 'text-yellow-400' },
  resolved: { icon: CheckCircle2, color: 'text-green-400' },
};

function IncidentDrawer({ id, summary, act, onClose }: { id: string; summary?: Incident; act: Act; onClose: () => void }) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  // Reload whenever the polled summary changes (new timeline entries, status, rows)
  const version = summary ? `${summary.status}-${summary.timeline.length}-${summary.lastSeenAt}` : '';
  useEffect(() => {
    let cancelled = false;
    api<IncidentDetail>('GET', `/incidents/${id}`)
      .then(d => { if (!cancelled) { setDetail(d); setError(null); } })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [id, version]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-gray-900 border-l border-gray-700 w-[640px] max-w-[95vw] h-full flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Siren className="w-4 h-4 text-blue-400 shrink-0" />
            <h2 className="text-sm font-semibold text-white font-mono truncate">{detail?.check || summary?.check || id}</h2>
            {detail && <Pill tone={statusTone[detail.status]}>{detail.status}</Pill>}
            {detail && <Pill tone={severityTone[detail.severity]}>{detail.severity}</Pill>}
          </div>
          <div className="flex items-center gap-2">
            {detail && <IncidentActions incident={detail} act={act} />}
            <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        </div>
        {error && <div className="p-3 text-xs text-red-400">{error}</div>}
        {!detail && !error && <LoadingState compact />}
        {detail && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="grid grid-cols-4 gap-2">
              <StatCard label="Rows now" value={detail.rowCount} tone="yellow" sub={`peak ${detail.peakRows}`} />
              <StatCard label="Duration" value={durationBetween(detail.openedAt, detail.resolvedAt)} sub={formatDateTime(detail.openedAt)} />
              <StatCard label="Environment" value={detail.environment} />
              <StatCard label="Last seen" value={formatAgo(detail.lastSeenAt)} />
            </div>
            <Panel title="Timeline" icon={Clock} bodyClassName="p-3">
              <ol className="space-y-2">
                {detail.timeline.map((t, i) => {
                  const s = timelineStyle[t.type] || { icon: Activity, color: 'text-gray-400' };
                  const Icon = s.icon;
                  return (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${s.color}`} />
                      <span className="text-gray-500 w-36 shrink-0">{formatDateTime(t.time)}</span>
                      <span className="text-gray-300">{t.message}</span>
                    </li>
                  );
                })}
              </ol>
            </Panel>
            <Panel title={`Latest result snapshot (${detail.sample.length} of ${detail.rowCount} rows)`} icon={ListChecks} bodyClassName="p-2">
              {detail.sample.length ? <RowsTable columns={detail.columns} rows={detail.sample} /> : <EmptyState compact title="No rows captured" />}
            </Panel>
            <Panel title="Deliveries" icon={Send} bodyClassName="divide-y divide-gray-800">
              {detail.deliveries.length === 0 ? (
                <EmptyState compact title="No notifications sent for this incident" />
              ) : detail.deliveries.map(d => <DeliveryRow key={d.id} d={d} />)}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== Silences ====================

const silenceFields: ClientFilterField<Silence>[] = [
  { field: 'check', label: 'Scope', getValue: s => s.check || 'all rules' },
];
const silenceSearchText = (s: Silence) => `${s.check || 'all rules'} ${s.reason}`;

function SilencesTab({ silences, act, onNew }: { silences: Silence[]; act: Act; onNew: () => void }) {
  const gridTheme = useGridTheme();
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(silences, silenceFields, silenceSearchText);

  const cols = useMemo((): ColDef<Silence>[] => [
    {
      headerName: 'Scope', field: 'check', flex: 1, minWidth: 220,
      cellRenderer: (p: ICellRendererParams<Silence>) => (p.value ? <span className="text-gray-100">{p.value}</span> : <Pill tone="yellow">all rules</Pill>),
    },
    { headerName: 'Reason', field: 'reason', flex: 1, minWidth: 200, tooltipField: 'reason' },
    { headerName: 'Until', field: 'until', width: 175, sort: 'asc', valueFormatter: p => formatDateTime(p.value) },
    { headerName: 'Remaining', width: 110, valueGetter: p => (p.data ? durationBetween(new Date().toISOString(), p.data.until) : '') },
    { headerName: 'Created', field: 'createdAt', width: 175, valueFormatter: p => formatDateTime(p.value) },
    {
      headerName: '', width: 90, sortable: false,
      cellRenderer: (p: ICellRendererParams<Silence, unknown, { act: Act }>) => p.data && (
        <button onClick={() => p.context.act(() => api('DELETE', `/silences/${p.data!.id}`), 'Silence removed')}
          className="px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-[10px]">Unsilence</button>
      ),
    },
  ], []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={silences} fields={silenceFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search silences..." />
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">{filtered.length} items</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
            <ToolbarButton icon={VolumeX} variant="primary" onClick={onNew}>New silence</ToolbarButton>
          </>
        }
      />
      <div className="flex-1 mx-1.5 mt-3 mb-4 bg-gray-900 border border-gray-700 rounded overflow-hidden flex flex-col">
        {silences.length === 0 ? (
          <EmptyState icon={VolumeX} title="No active silences" />
        ) : (
          <AgGridReact<Silence> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} context={{ act }} suppressCellFocus getRowId={p => p.data.id}
            tooltipShowDelay={300} defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }} />
        )}
      </div>
    </div>
  );
}

function SilenceEditor({ check, rules, act, onClose }: { check: string | null; rules: AlertRule[]; act: Act; onClose: () => void }) {
  const [scope, setScope] = useState<string>(check || '');
  return (
    <SilenceDialog
      note="Silenced checks still evaluate and open incidents, but send no notifications and are skipped by Run all."
      onClose={onClose}
      onSave={(until, reason) => act(() => api('POST', '/silences', { check: scope || null, until, reason }), `Silenced ${scope || 'all checks'}`)}
      scope={
        <Field label="Scope">
          <select value={scope} onChange={e => setScope(e.target.value)} className={inputClass}>
            <option value="">All checks (maintenance window)</option>
            {rules.map(r => <option key={r.check} value={r.check}>{r.check}</option>)}
          </select>
        </Field>
      }
    />
  );
}
