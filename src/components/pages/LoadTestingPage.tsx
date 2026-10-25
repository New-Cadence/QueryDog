import { useState, useEffect, useMemo, useCallback } from 'react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import { Play, Square, Activity, History, Trash2, GitCompare, TrendingUp } from 'lucide-react';
import { PageToolbar, PageTabs, PreviewBanner, ToolbarButton, ToolbarSearch } from '../ui';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import {
  DEFAULT_SCENARIO, MAX_HISTORY, SAMPLE_QUERIES, SOURCE_LABEL, builtInScenarios, defaultMix, loadHistory, loadSavedScenarios, mergeMix,
  saveHistory, saveSavedScenarios,
} from '../loadtesting/model';
import type { Calibration, PoolQuery, QueryResult, RunSummary, SavedScenario, Scenario } from '../loadtesting/model';
import { buildRunQueries } from '../loadtesting/engine';
import type { CapacitySettings } from '../loadtesting/engine';
import { calibrate, fetchSavedQueries, type CalibrationResult } from '../loadtesting/calibration';
import { useCapacityFinder, useLoadRun } from '../loadtesting/useSimulation';
import { ScenarioPanel } from '../loadtesting/ScenarioPanel';
import { LiveDashboard } from '../loadtesting/LiveDashboard';
import { HistoryView } from '../loadtesting/HistoryView';
import { CompareView } from '../loadtesting/CompareView';
import { CapacityView } from '../loadtesting/CapacityView';
import { formatDate } from '../../utils/formatters';

ModuleRegistry.registerModules([AllCommunityModule]);

type LoadTab = 'run' | 'capacity' | 'history' | 'compare';

const RESULT_FIELDS: ClientFilterField<QueryResult>[] = [
  { field: 'slo', label: 'SLO', getValue: r => (r.slo === 'none' ? 'no SLO' : r.slo) },
  { field: 'source', label: 'Baseline source', getValue: r => SOURCE_LABEL[r.source].label },
  { field: 'errors', label: 'Errors', getValue: r => (r.errors > 0 ? 'with errors' : 'no errors') },
];
const resultSearch = (r: QueryResult) => `${r.name} ${r.sql}`;

const HISTORY_FIELDS: ClientFilterField<RunSummary>[] = [
  { field: 'scenario', label: 'Scenario' },
  { field: 'pattern', label: 'Pattern' },
  { field: 'passed', label: 'Result', getValue: r => (r.passed ? 'PASS' : 'FAIL') },
  { field: 'status', label: 'Status' },
  { field: 'startedAt', label: 'Date', getValue: r => formatDate(r.startedAt) },
];
const historySearch = (r: RunSummary) => `${r.scenario} ${r.pattern} ${r.breaches.join(' ')}`;

const NO_RESULTS: QueryResult[] = [];
const NO_CALIBRATION: Record<string, Calibration> = {};
const SQL_SEP = '\u0001';

export function LoadTestingPage() {
  const [tab, setTab] = useState<LoadTab>('run');
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [pool, setPool] = useState<PoolQuery[] | null>(null);
  const [poolNote, setPoolNote] = useState('Loading saved queries…');
  const [saved, setSaved] = useState<SavedScenario[]>(loadSavedScenarios);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [history, setHistory] = useState<RunSummary[]>(loadHistory);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [capSettings, setCapSettings] = useState<CapacitySettings>({ startVus: 10, stepVus: 10, maxVus: 500, stepSec: 10 });

  const onFinish = useCallback((s: RunSummary) => setHistory(h => [s, ...h].slice(0, MAX_HISTORY)), []);
  const run = useLoadRun(onFinish);
  const finder = useCapacityFinder();
  const busy = run.running || finder.running;

  // The query pool: saved .sql files, or labelled samples when there are none
  useEffect(() => {
    let cancelled = false;
    fetchSavedQueries()
      .catch(() => [] as PoolQuery[])
      .then(list => {
        if (cancelled) return;
        const usable = list.length ? list : SAMPLE_QUERIES;
        setPool(usable);
        setPoolNote(list.length ? `${list.length} saved queries from the queries folder.` : 'No saved .sql files found, so sample queries are shown.');
        setScenario(s => ({ ...s, mix: s.mix.length ? mergeMix(s.mix, usable) : defaultMix(usable) }));
      });
    return () => { cancelled = true; };
  }, []);

  // Calibrate whenever the set of query texts changes (not on weight/SLO edits)
  const [calNonce, setCalNonce] = useState(0);
  const sqlsJoined = [...new Set(scenario.mix.map(m => m.sql))].sort().join(SQL_SEP);
  const sqls = useMemo(() => (sqlsJoined ? sqlsJoined.split(SQL_SEP) : []), [sqlsJoined]);
  const calKey = `${calNonce}:${sqlsJoined}`;
  const [cal, setCal] = useState<(CalibrationResult & { key: string }) | null>(null);
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    calibrate(sqls, pool).then(r => { if (!cancelled) setCal({ ...r, key: `${calNonce}:${sqls.join(SQL_SEP)}` }); });
    return () => { cancelled = true; };
  }, [sqls, pool, calNonce]);
  const calibrating = !pool || cal?.key !== calKey;
  const calibration = cal?.bySql ?? NO_CALIBRATION;

  useEffect(() => { saveHistory(history); }, [history]);
  useEffect(() => { saveSavedScenarios(saved); }, [saved]);

  // ---------- Scenario library ----------
  const library = useMemo(() => [...builtInScenarios(pool ?? []), ...saved], [pool, saved]);
  const current = library.find(s => s.id === currentId) ?? null;
  const resolved = (s: SavedScenario): Scenario => ({ ...structuredClone(s.scenario), mix: mergeMix(s.scenario.mix, pool ?? []) });
  const dirty = !!current && JSON.stringify(resolved(current)) !== JSON.stringify(scenario);

  const loadScenario = (id: string) => {
    const s = library.find(x => x.id === id);
    if (!s) return;
    setScenario(resolved(s));
    setCurrentId(id);
  };
  const describe = (s: Scenario) => `${s.pattern}, ${s.virtualUsers} VUs, ${s.durationSec}s, ${s.mix.filter(m => m.enabled).length} queries`;
  const saveAsNew = (s: Scenario) => {
    const id = `s-${Date.now()}`;
    setSaved(prev => [...prev, { id, builtIn: false, description: describe(s), scenario: structuredClone(s) }]);
    setScenario(s);
    setCurrentId(id);
  };
  const saveScenario = () => {
    if (current && !current.builtIn) {
      setSaved(prev => prev.map(x => (x.id === current.id ? { ...x, description: describe(scenario), scenario: structuredClone(scenario) } : x)));
    } else {
      saveAsNew(scenario);
    }
  };
  const duplicateScenario = () => saveAsNew({ ...scenario, name: `${scenario.name} (copy)` });
  const deleteScenario = () => {
    if (!current || current.builtIn || !window.confirm(`Delete saved scenario "${current.scenario.name}"?`)) return;
    setSaved(prev => prev.filter(x => x.id !== current.id));
    setCurrentId(null);
  };

  // ---------- Runs ----------
  const runQueries = useMemo(() => buildRunQueries(scenario, calibration), [scenario, calibration]);
  const canStart = !busy && !calibrating && runQueries.length > 0;
  const startRun = () => { if (canStart) run.start(scenario, runQueries); };
  const startFinder = () => { if (canStart) finder.start(scenario, runQueries, capSettings); };

  const results = useClientFilters(run.view?.results ?? NO_RESULTS, RESULT_FIELDS, resultSearch);
  const runs = useClientFilters(history, HISTORY_FIELDS, historySearch);

  const toggleSelected = useCallback((id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const compared = useMemo(
    () => history.filter(r => selected.has(r.id)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [history, selected],
  );
  const deleteRuns = (ids: Set<string>) => {
    setHistory(h => h.filter(r => !ids.has(r.id)));
    setSelected(new Set());
  };

  const startTitle = calibrating ? 'Calibrating query baselines…' : !runQueries.length ? 'Enable at least one query' : undefined;
  const filtersActive = (n: number) => n > 0 && <span className="text-xs text-blue-400">{n} filter{n === 1 ? '' : 's'} active</span>;

  const toolbar = (() => {
    switch (tab) {
      case 'run':
        return {
          left: (
            <>
              <ClientFilterPanel rows={run.view?.results ?? NO_RESULTS} fields={RESULT_FIELDS} filters={results.filters} onChange={results.setFilter} onClearAll={results.clearAll} />
              <ToolbarSearch value={results.search} onChange={results.setSearch} placeholder="Search queries..." />
              {run.running && (
                <span className="flex items-center gap-2 text-xs text-green-400 truncate">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Simulating <strong>{run.view?.scenario.name}</strong> · {run.view?.t}s / {run.view?.scenario.durationSec}s
                </span>
              )}
            </>
          ),
          right: (
            <>
              <span className="text-xs text-gray-400">{results.filtered.length} queries</span>
              {filtersActive(results.activeCount)}
              {run.running
                ? <ToolbarButton icon={Square} variant="danger" onClick={run.stop}>Stop</ToolbarButton>
                : <ToolbarButton icon={Play} variant="primary" onClick={startRun} disabled={!canStart} title={startTitle}>Start test</ToolbarButton>}
            </>
          ),
        };
      case 'capacity':
        return {
          left: <span className="text-xs text-gray-400">Find the highest concurrency <span className="text-white font-medium">{scenario.name}</span> sustains within its thresholds (simulated)</span>,
          right: finder.running
            ? <ToolbarButton icon={Square} variant="danger" onClick={finder.stop}>Stop</ToolbarButton>
            : <ToolbarButton icon={TrendingUp} variant="primary" onClick={startFinder} disabled={!canStart} title={startTitle}>Find max VUs</ToolbarButton>,
        };
      case 'history':
        return {
          left: (
            <>
              <ClientFilterPanel rows={history} fields={HISTORY_FIELDS} filters={runs.filters} onChange={runs.setFilter} onClearAll={runs.clearAll} />
              <ToolbarSearch value={runs.search} onChange={runs.setSearch} placeholder="Search runs..." />
            </>
          ),
          right: (
            <>
              <span className="text-xs text-gray-400">{runs.filtered.length} runs</span>
              {filtersActive(runs.activeCount)}
              <ToolbarButton icon={GitCompare} variant="primary" onClick={() => setTab('compare')} disabled={compared.length < 2}
                title="Tick two or more runs to compare">Compare ({compared.length})</ToolbarButton>
              <ToolbarButton icon={Trash2} onClick={() => deleteRuns(selected)} disabled={!selected.size}>Delete selected</ToolbarButton>
              <ToolbarButton icon={Trash2} variant="danger" disabled={!history.length}
                onClick={() => { if (window.confirm('Delete all run history?')) deleteRuns(new Set(history.map(r => r.id))); }}>Clear all</ToolbarButton>
            </>
          ),
        };
      case 'compare':
        return {
          left: <span className="text-xs text-gray-400">Comparing {compared.length} runs</span>,
          right: <ToolbarButton onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear selection</ToolbarButton>,
        };
    }
  })();

  const pulse = <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />;

  return (
    <div className="h-full flex flex-col">
      <PageToolbar left={toolbar.left} right={toolbar.right} />
      <PageTabs
        tabs={[
          { id: 'run', label: 'Test Run', icon: Activity, badge: run.running ? pulse : undefined },
          { id: 'capacity', label: 'Capacity Finder', icon: TrendingUp, badge: finder.running ? pulse : undefined },
          { id: 'history', label: 'History', icon: History, badge: <span className="text-[10px] text-gray-500">{history.length}</span> },
          { id: 'compare', label: 'Compare', icon: GitCompare, badge: compared.length ? <span className="text-[10px] text-gray-500">{compared.length}</span> : undefined },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <PreviewBanner>
          Simulation: load is generated in your browser and no queries are sent to ClickHouse during a run. Each query's baseline latency is
          calibrated from real data where available (system.query_log, then QueryDog run stats); slowdown under load comes from a simple queueing model.
        </PreviewBanner>

        {tab === 'history' && <HistoryView rows={runs.filtered} selected={selected} onToggle={toggleSelected} />}
        {tab === 'compare' && <CompareView runs={compared} />}
        {(tab === 'run' || tab === 'capacity') && (
          <div className="flex-1 flex gap-3 overflow-hidden">
            <ScenarioPanel
              scenario={scenario} onChange={setScenario} disabled={busy || !pool}
              calibration={calibration} calibrating={calibrating} calibrationNote={cal?.queryLogError ?? null}
              onRecalibrate={() => setCalNonce(n => n + 1)} poolNote={poolNote}
              library={library} currentId={currentId} dirty={dirty}
              onLoad={loadScenario} onSave={saveScenario} onDuplicate={duplicateScenario} onDelete={deleteScenario}
            />
            {tab === 'run'
              ? <LiveDashboard view={run.view} running={run.running} summary={run.summary} visible={results.filtered} />
              : <CapacityView scenario={scenario} settings={capSettings} onSettings={setCapSettings} steps={finder.steps} outcome={finder.outcome} running={finder.running} />}
          </div>
        )}
      </div>
    </div>
  );
}
