import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { RotateCcw, Save, Server } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { Field, Panel, ToolbarButton, ToolbarSearch } from '../ui';
import { inputClass } from '../uiTokens';
import { CostToolbar, FilterCounts } from './common';
import { gridDefaults, rightAlign, useCost } from './costContext';
import { effectivePrice, envSettings, type CostSettings, type EnvCostSettings } from './costApi';
import { LIST_PRICES, LIST_PRICES_FETCHED, LIST_PRICES_SOURCE, type Tier } from './pricing';
import { GRID_OVERLAYS } from '../gridOverlays';

interface PriceRow {
  key: string;
  label: string;
  provider: string;
  basic: number;
  scale: number;
  enterprise: number;
  storageTbMonth: number;
  internetEgressGb: number;
  interRegionEgressGb: number;
  overridden: string[];
}

const FIELDS: ClientFilterField<PriceRow>[] = [
  { field: 'provider', label: 'Cloud provider' },
  { field: 'overridden', label: 'Edited', getValue: r => (r.overridden.length ? 'edited' : 'list price') },
];
const searchText = (r: PriceRow) => `${r.key} ${r.label}`;
const TIER_FIELDS: Tier[] = ['basic', 'scale', 'enterprise'];
const OTHER_FIELDS = ['storageTbMonth', 'internetEgressGb', 'interRegionEgressGb'] as const;

// Editable price list (pre-filled with ClickHouse Cloud list prices) used for
// what-if estimates and storage pricing, plus this environment's settings.
export function SettingsTab() {
  const gridTheme = useGridTheme();
  const { status, settings, updateSettings } = useCost();

  const rows = useMemo((): PriceRow[] => Object.keys(LIST_PRICES).map(key => {
    const list = LIST_PRICES[key];
    const p = effectivePrice(settings, key)!;
    const overridden = [
      ...TIER_FIELDS.filter(t => p.compute[t] !== list.compute[t]),
      ...OTHER_FIELDS.filter(f => p[f] !== list[f]),
    ];
    return {
      key, label: p.label, provider: key.startsWith('gcp-') ? 'GCP' : key.startsWith('azure-') ? 'Azure' : 'AWS',
      ...p.compute, storageTbMonth: p.storageTbMonth, internetEgressGb: p.internetEgressGb, interRegionEgressGb: p.interRegionEgressGb, overridden,
    };
  }), [settings]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);

  const onEdit = (e: CellValueChangedEvent<PriceRow>) => {
    const field = e.colDef.field as keyof PriceRow;
    const value = Number(e.newValue);
    if (!e.data || !Number.isFinite(value) || value < 0) return;
    const list = LIST_PRICES[e.data.key];
    const cur = { ...(settings.prices[e.data.key] || {}) };
    if (TIER_FIELDS.includes(field as Tier)) {
      const compute = { ...(cur.compute || {}) };
      if (value === list.compute[field as Tier]) delete compute[field as Tier];
      else compute[field as Tier] = value;
      cur.compute = compute;
      if (!Object.keys(compute).length) delete cur.compute;
    } else {
      const f = field as (typeof OTHER_FIELDS)[number];
      if (value === list[f]) delete cur[f];
      else cur[f] = value;
    }
    const prices = { ...settings.prices, [e.data.key]: cur };
    if (!Object.keys(cur).length) delete prices[e.data.key];
    updateSettings({ ...settings, prices });
  };

  const cols = useMemo((): ColDef<PriceRow>[] => {
    const priceCol = (field: keyof PriceRow, headerName: string, digits: number): ColDef<PriceRow> => ({
      field, headerName, width: 120, editable: true, cellStyle: p => ({ ...rightAlign, color: p.data?.overridden.includes(field) ? '#fbbf24' : '#e5e7eb' }),
      valueFormatter: p => `$${Number(p.value).toFixed(digits)}`, valueParser: p => Number(p.newValue),
    });
    return [
      { field: 'label', headerName: 'Region', flex: 1, minWidth: 220, cellStyle: { color: '#f3f4f6' } },
      { field: 'provider', headerName: 'Cloud', width: 80 },
      priceCol('basic', 'Basic $/unit-h', 4),
      priceCol('scale', 'Scale $/unit-h', 4),
      priceCol('enterprise', 'Enterprise $/unit-h', 4),
      priceCol('storageTbMonth', 'Storage $/TB-mo', 2),
      priceCol('internetEgressGb', 'Egress $/GB', 4),
      priceCol('interRegionEgressGb', 'Inter-region $/GB', 4),
    ];
  }, []);

  const overrideCount = Object.keys(settings.prices).length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search regions..." width="w-48" />
        </>}
        right={<>
          <FilterCounts count={filtered.length} noun="regions" active={activeCount} />
          <ToolbarButton icon={RotateCcw} disabled={!overrideCount} onClick={() => updateSettings({ ...settings, prices: {} })}
            title="Discard every edited price">Reset to list prices</ToolbarButton>
        </>}
      />
      <div className={`flex-1 overflow-hidden px-1.5 pt-3 pb-4 grid grid-cols-1 gap-3 ${status.deployment === 'oss' ? 'xl:grid-cols-4' : ''}`}>
        <div className={`flex flex-col gap-2 min-h-0 ${status.deployment === 'oss' ? 'xl:col-span-3' : ''}`}>
          <p className="text-[11px] text-gray-500 shrink-0">
            ClickHouse Cloud list prices from <a href={LIST_PRICES_SOURCE} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">clickhouse.com/pricing</a>, fetched {LIST_PRICES_FETCHED}.
            One compute unit is 8 GiB RAM and 2 vCPU per replica for an hour; backups are charged at the storage rate. Double-click a price to enter your negotiated rate
            ({overrideCount} region{overrideCount === 1 ? '' : 's'} edited, shown in yellow). Prices feed storage pricing and recommendations; real bills come from the usage API.
          </p>
          <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden min-h-64">
            <AgGridReact<PriceRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={cols} defaultColDef={gridDefaults}
              getRowId={p => p.data.key} onCellValueChanged={onEdit} singleClickEdit={false} stopEditingWhenCellsLoseFocus />
          </div>
        </div>
        {/* Self-managed servers need their running costs entered; Cloud costs come from the usage API */}
        {status.deployment === 'oss' && (
          <EnvironmentSettings key={status.environment} settings={settings} environment={status.environment} onSave={updateSettings} />
        )}
      </div>
    </div>
  );
}

function EnvironmentSettings({ settings, environment, onSave }: {
  settings: CostSettings; environment: string; onSave: (s: CostSettings) => void;
}) {
  const [draft, setDraft] = useState<EnvCostSettings>(() => envSettings(settings, environment));
  const setOss = (k: keyof EnvCostSettings['oss'], v: string) =>
    setDraft(d => ({ ...d, oss: { ...d.oss, [k]: k === 'nodeCountOverride' ? (v.trim() === '' ? null : Math.max(1, Number(v) || 1)) : Math.max(0, Number(v) || 0) } }));
  const save = () => onSave({ ...settings, envs: { ...settings.envs, [environment]: draft } });

  return (
    <Panel title={`Environment: ${environment}`} icon={Server} bodyClassName="p-3 space-y-3 overflow-y-auto">
      <p className="text-[11px] text-gray-400">Self-managed ClickHouse: enter what your servers cost. Node count and resources are read from the cluster.</p>
      <Field label="Cost per node ($ / month)" hint="Instance, licence and support per ClickHouse server">
        <input type="number" min={0} value={draft.oss.nodeMonthly} onChange={e => setOss('nodeMonthly', e.target.value)} className={inputClass} />
      </Field>
      <Field label="Storage ($ / TB-month, optional)" hint="Disks / object storage priced per compressed TB">
        <input type="number" min={0} step={0.01} value={draft.oss.storageTbMonth} onChange={e => setOss('storageTbMonth', e.target.value)} className={inputClass} />
      </Field>
      <Field label="Fixed monthly costs ($, optional)" hint="Keeper nodes, networking, monitoring, staff time">
        <input type="number" min={0} value={draft.oss.fixedMonthly} onChange={e => setOss('fixedMonthly', e.target.value)} className={inputClass} />
      </Field>
      <Field label="Node count override" hint="Leave empty to count hosts in system.clusters">
        <input type="number" min={1} value={draft.oss.nodeCountOverride ?? ''} onChange={e => setOss('nodeCountOverride', e.target.value)} className={inputClass} />
      </Field>
      <p className="text-[10px] text-gray-500">The monthly budget is set on the Budget tab. Settings are stored by the Convoy server.</p>
      <ToolbarButton icon={Save} variant="primary" onClick={save}>Save environment settings</ToolbarButton>
    </Panel>
  );
}
