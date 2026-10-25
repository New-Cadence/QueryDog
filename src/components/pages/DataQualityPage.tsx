// Data Quality: configure rules on tables (not null, unique, accepted values,
// patterns, ranges, freshness, row counts, references, custom SQL), run them
// on demand or from the backend scheduler, and track compliance per dataset.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import { Activity, ShieldCheck, Database, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ClientFolderNotice } from '../ClientFolderNotice';
import { EmptyState, LoadingState, PageTabs, Pill, ToolbarHost } from '../ui';
import {
  api, datasetKey, POLL_MS, useCatalog,
  type DqActions, type DqState,
} from '../dataquality/model';
import { OverviewTab } from '../dataquality/OverviewTab';
import { RulesTab } from '../dataquality/RulesTab';
import { DatasetsTab } from '../dataquality/DatasetsTab';
import { RuleDrawer, RunDrawer } from '../dataquality/Details';

ModuleRegistry.registerModules([AllCommunityModule]);

type DqTab = 'overview' | 'rules' | 'datasets';
interface RunSummaryResponse { passed: number; failed: number; errors: number; runs: unknown[] }

export function DataQualityPage() {
  const [tab, setTab] = useState<DqTab>('overview');
  const [state, setState] = useState<DqState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [dataset, setDataset] = useState<string | null>(null);
  // Checks being run from this page (the server reports its own runs in state.running)
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const { tables: catalog } = useCatalog(state?.environment || '');

  const refresh = useCallback(async () => {
    try {
      setState(await api<DqState>('GET', '/state'));
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
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const act = useCallback<DqActions['act']>(async (fn, success) => {
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

  const rules = useMemo(() => state?.rules || [], [state]);

  const runRules = useCallback<DqActions['runRules']>(async (target, label) => {
    const ids = target.ids || rules.filter(r => r.database === target.database && (!target.table || r.table === target.table)).map(r => r.id);
    if (!ids.length) return;
    setBusy(prev => new Set([...prev, ...ids]));
    await act(async () => {
      const res = await api<RunSummaryResponse>('POST', '/run', { ids });
      const text = `${label}: ${res.passed} passed, ${res.failed} failed${res.errors ? `, ${res.errors} errors` : ''}`;
      if (res.errors && !res.passed && !res.failed) throw new Error(text);
      setToast({ ok: !res.failed && !res.errors, text });
    });
    setBusy(prev => { const next = new Set(prev); ids.forEach(id => next.delete(id)); return next; });
  }, [rules, act]);


  const actions: DqActions = useMemo(() => ({
    act,
    runRules,
    openRule: id => { setOpenRunId(null); setOpenRuleId(id); },
    openRun: id => setOpenRunId(id),
    openRecommendations: () => (window as unknown as { navigateToMode?: (mode: string) => void }).navigateToMode?.('recommendations'),
    openDataset: (database, table) => { setOpenRuleId(null); setOpenRunId(null); setDataset(datasetKey(database, table)); setTab('datasets'); },
    isRunning: id => busy.has(id) || Boolean(state?.running.includes(id)),
  }), [act, runRules, busy, state]);

  if (!state) {
    return loadError
      ? <EmptyState icon={AlertTriangle} title="Could not load data quality state">{loadError}</EmptyState>
      : <LoadingState label="Loading data quality…" />;
  }

  const failing = rules.filter(r => r.lastRun?.status === 'fail').length;
  const openRule = openRuleId ? rules.find(r => r.id === openRuleId) : undefined;
  // Refetch run history whenever a newer run lands or rules are added/removed

  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'rules' as const, label: 'Checks', icon: ShieldCheck, badge: failing ? <Pill tone="red">{failing}</Pill> : <span className="text-[10px] text-gray-500">{rules.length}</span> },
    { id: 'datasets' as const, label: 'Datasets', icon: Database },
  ];

  const toolbar = (
    <>
      {toast && (
        <span className={`text-xs flex items-center gap-1 max-w-[420px] truncate ${toast.ok ? 'text-green-400' : 'text-red-400'}`} title={toast.text}>
          {toast.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}{toast.text}
        </span>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col">
      <ToolbarHost>
      <PageTabs tabs={tabs} active={tab} onChange={setTab} right={toolbar} />
      <ClientFolderNotice kind="dataquality" errors={state.fileErrors} onlyProblems className="mx-1.5 mt-2" />
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'overview' && <OverviewTab state={state} actions={actions} onOpenTab={setTab} />}
        {tab === 'rules' && <RulesTab rules={rules} actions={actions} />}
        {tab === 'datasets' && <DatasetsTab rules={rules} catalog={catalog} selected={dataset} onSelect={setDataset} actions={actions} />}
      </div>
      </ToolbarHost>
      {openRule && <RuleDrawer rule={openRule} actions={actions} onClose={() => setOpenRuleId(null)} />}
      {openRunId && <RunDrawer id={openRunId} actions={actions} onClose={() => setOpenRunId(null)} />}
    </div>
  );
}
