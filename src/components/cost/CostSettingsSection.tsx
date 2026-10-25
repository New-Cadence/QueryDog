// Cost settings on the general Settings page: the price list and per-environment
// costs, the monthly budget, and teams for cost allocation. Loads its own status
// and settings so it works outside CostPage.
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { fetchCostSettings, fetchCostStatus, saveCostSettings, type CostSettings, type CostStatus } from './costApi';
import { CostContext, errorMessage } from './costContext';
import { presetRange, type CostView } from './costRange';
import { todayUtc } from './usage';
import { ErrorBox, Spinner } from './common';
import { SettingsTab } from './SettingsTab';
import { BudgetSettings } from './BudgetSettings';
import { CostAllocationSettings } from './CostAllocationSettings';

export type CostSettingsKind = 'prices' | 'budget' | 'allocation';

export function CostSettingsSection({ section = 'prices' }: { section?: CostSettingsKind }) {
  const [status, setStatus] = useState<CostStatus | null>(null);
  const [settings, setSettings] = useState<CostSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(todayUtc);
  const [view, setView] = useState<CostView>(() => ({ range: presetRange('30', today), chartType: 'stacked-bar', bucket: 'day' }));

  useEffect(() => {
    Promise.all([fetchCostStatus(), fetchCostSettings()])
      .then(([s, cfg]) => { setStatus(s); setSettings(cfg); })
      .catch(err => setError(errorMessage(err)));
  }, []);

  const updateSettings = useCallback((next: CostSettings) => {
    setSettings(next);
    saveCostSettings(next).catch(err => setError(errorMessage(err)));
  }, []);

  if (error && !status) return <div className="p-3"><ErrorBox error={error} /></div>;
  if (!status || !settings) return <Spinner label="Loading cost settings…" />;

  return (
    <CostContext.Provider value={{ status, settings, updateSettings, basis: null, view, setView, today }}>
      {error && <div className="px-1.5 pt-2"><ErrorBox error={error} /></div>}
      {({ prices: <SettingsTab />, budget: <BudgetSettings />, allocation: <CostAllocationSettings /> } satisfies Record<CostSettingsKind, ReactNode>)[section]}
    </CostContext.Provider>
  );
}
