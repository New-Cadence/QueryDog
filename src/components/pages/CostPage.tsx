import { useCallback, useEffect, useState } from 'react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import {
  CircleDollarSign, Table2, PiggyBank, HardDrive, Users, KeyRound, } from 'lucide-react';
import { PageTabs, ToolbarHost, type TabDef } from '../ui';
import { fetchCostSettings, fetchCostStatus, saveCostSettings, type CostSettings, type CostStatus } from '../cost/costApi';
import { loadCostBasis, type CostBasis } from '../cost/costBasis';
import { CostContext, errorMessage } from '../cost/costContext';
import { ErrorBox, Spinner } from '../cost/common';
import { CloudSetupTab } from '../cost/CloudSetupTab';
import { useCloudData } from '../cost/useCloudData';
import { presetRange, rangeDays, type CostView } from '../cost/costRange';
import { addDays, todayUtc } from '../cost/usage';
import { CloudOverviewTab } from '../cost/CloudOverviewTab';
import { CloudUsageTab } from '../cost/CloudUsageTab';
import { BudgetTab } from '../cost/BudgetTab';
import { StorageTab } from '../cost/StorageTab';
import { AttributionTab } from '../cost/AttributionTab';
import { OssOverviewTab } from '../cost/OssOverviewTab';

ModuleRegistry.registerModules([AllCommunityModule]);

type CostTab = 'overview' | 'setup' | 'usage' | 'budget' | 'storage' | 'attribution';

const TAB_DEFS: Record<CostTab, TabDef<CostTab>> = {
  overview: { id: 'overview', label: 'Overview', icon: CircleDollarSign },
  setup: { id: 'setup', label: 'Connect billing', icon: KeyRound },
  usage: { id: 'usage', label: 'Usage', icon: Table2 },
  budget: { id: 'budget', label: 'Budget', icon: PiggyBank },
  storage: { id: 'storage', label: 'Storage', icon: HardDrive },
  attribution: { id: 'attribution', label: 'Cost Allocation', icon: Users },
};

function tabsFor(status: CostStatus): CostTab[] {
  if (status.deployment === 'oss') return ['overview', 'budget', 'storage', 'attribution'];
  if (!status.cloudApiConfigured) return ['setup', 'storage', 'attribution'];
  return ['overview', 'usage', 'budget', 'storage', 'attribution'];
}

export function CostPage() {
  const [status, setStatus] = useState<CostStatus | null>(null);
  const [settings, setSettings] = useState<CostSettings | null>(null);
  const [basis, setBasis] = useState<CostBasis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CostTab | null>(null);
  const [today] = useState(todayUtc);
  const [view, setView] = useState<CostView>(() => ({ range: presetRange('30', today), chartType: 'stacked-bar', bucket: 'day' }));

  useEffect(() => {
    Promise.all([fetchCostStatus(), fetchCostSettings()])
      .then(([s, cfg]) => { setStatus(s); setSettings(cfg); })
      .catch(err => setError(errorMessage(err)));
  }, []);

  // The cost basis (what compute / storage cost per month) depends on the prices
  useEffect(() => {
    if (!status || !settings) return;
    let cancelled = false;
    loadCostBasis(status, settings)
      .then(b => !cancelled && setBasis(b))
      .catch(err => !cancelled && setBasis({ computeMonthly: null, storageMonthly: null, storageTbMonth: 0, source: 'unpriced', label: errorMessage(err) }));
    return () => { cancelled = true; };
  }, [status, settings]);

  const updateSettings = useCallback((next: CostSettings) => {
    setSettings(next);
    saveCostSettings(next).catch(err => setError(errorMessage(err)));
  }, []);

  // Load one range-length before the range too, for the "vs previous period" figure
  const rangeFrom = addDays(view.range.from, -rangeDays(view.range));
  // The Budget tab shows the last six calendar months against the budget
  const historyFrom = `${addDays(`${today.slice(0, 7)}-01`, -150).slice(0, 7)}-01`;
  const neededFrom = tab === 'budget' && historyFrom < rangeFrom ? historyFrom : rangeFrom;
  const cloud = useCloudData(!!status && status.deployment === 'cloud' && status.cloudApiConfigured, status?.serviceId ?? null, today, neededFrom);

  if (error && !status) return <div className="p-3"><ErrorBox error={error} /></div>;
  if (!status || !settings) return <Spinner />;

  const tabs = tabsFor(status);
  const active = tab && tabs.includes(tab) ? tab : tabs[0];
  const isCloudApi = status.deployment === 'cloud' && status.cloudApiConfigured;
  const ossMonthly = basis && status.deployment === 'oss' && basis.computeMonthly !== null
    ? basis.computeMonthly + (basis.storageMonthly ?? 0) + (basis.fixedMonthly ?? 0)
    : null;

  return (
    <CostContext.Provider value={{ status, settings, updateSettings, basis, view, setView, today }}>
      <div className="h-full flex flex-col">
        <ToolbarHost>
        <PageTabs
          tabs={tabs.map(t => TAB_DEFS[t])}
          active={active}
          onChange={setTab}
        />
        {error && <div className="px-1.5 pt-2"><ErrorBox error={error} /></div>}
        <div className="flex-1 flex flex-col overflow-hidden">
          {active === 'overview' && (isCloudApi ? <CloudOverviewTab data={cloud} /> : <OssOverviewTab />)}
          {active === 'setup' && <CloudSetupTab status={status} />}
          {active === 'usage' && <CloudUsageTab data={cloud} />}
          {active === 'budget' && <BudgetTab rows={isCloudApi ? cloud.rows : undefined} loadedFrom={cloud.from} loading={cloud.loading} ossMonthly={ossMonthly} />}
          {active === 'storage' && <StorageTab />}
          {active === 'attribution' && <AttributionTab cloud={isCloudApi ? cloud : undefined} />}
        </div>
        </ToolbarHost>
      </div>
    </CostContext.Provider>
  );
}
