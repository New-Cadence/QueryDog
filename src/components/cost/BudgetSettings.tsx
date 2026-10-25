// Monthly budget for the connected environment, edited under Settings > Budget.
// The Cost page's Budget tab reports against it.
import { useState } from 'react';
import { PiggyBank, Save } from 'lucide-react';
import { Field, Panel, ToolbarButton } from '../ui';
import { inputClass } from '../uiTokens';
import { useCost } from './costContext';
import { envSettings, type EnvCostSettings } from './costApi';

export function BudgetSettings() {
  const { status, settings, updateSettings } = useCost();
  const env = envSettings(settings, status.environment);
  const isCloud = status.deployment === 'cloud';
  const [budget, setBudget] = useState(env.budget?.toString() ?? '');
  const [warnPct, setWarnPct] = useState(String(env.warnPct));
  const [scope, setScope] = useState<EnvCostSettings['budgetScope']>(env.budgetScope);
  const [saved, setSaved] = useState(false);

  const save = () => {
    const patch: Partial<EnvCostSettings> = {
      budget: budget.trim() === '' ? null : Math.max(0, Number(budget) || 0),
      warnPct: Math.min(200, Math.max(1, Number(warnPct) || 80)),
      budgetScope: scope,
    };
    updateSettings({ ...settings, envs: { ...settings.envs, [status.environment]: { ...settings.envs[status.environment], ...patch } } });
    setSaved(true);
  };

  return (
    <div className="px-1.5 py-3">
      <Panel title={`Monthly budget: ${status.environment}`} icon={PiggyBank} className="max-w-2xl" bodyClassName="p-3 space-y-3">
        <Field label="Monthly budget ($)" hint="Leave empty for no budget">
          <input type="number" min={0} step={10} value={budget} onChange={e => { setBudget(e.target.value); setSaved(false); }} className={inputClass} placeholder="e.g. 500" />
        </Field>
        <Field label="Warn when the month-end forecast reaches (% of budget)">
          <input type="number" min={1} max={200} value={warnPct} onChange={e => { setWarnPct(e.target.value); setSaved(false); }} className={inputClass} />
        </Field>
        {isCloud && (
          <Field label="Budget covers">
            <select value={scope} onChange={e => { setScope(e.target.value as EnvCostSettings['budgetScope']); setSaved(false); }} className={inputClass}>
              <option value="organization">The whole organisation</option>
              <option value="service">This environment's service</option>
            </select>
          </Field>
        )}
        <div className="flex items-center gap-3">
          <ToolbarButton icon={Save} variant="primary" onClick={save}>Save budget</ToolbarButton>
          {saved && <span className="text-[11px] text-green-400">Saved</span>}
        </div>
        <p className="text-[10px] text-gray-500">
          Budgets are per environment; switch environment to set another. Cost › Budget shows the forecast against it, and
          forecasts above the warning threshold also appear in Recommendations.
        </p>
      </Panel>
    </div>
  );
}
