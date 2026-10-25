import { useMemo } from 'react';
import { Lock, Gauge, Users } from 'lucide-react';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, ToolbarSearch, Panel, Pill, EmptyState } from '../ui';
import { ListCounts } from './common';
import type { SecurityData, CHRowPolicy, CHQuota, CHProfile } from './model';

type PolicyRow =
  | { kind: 'Row policy'; name: string; appliesTo: string[]; target: string; mode: string; item: CHRowPolicy }
  | { kind: 'Quota'; name: string; appliesTo: string[]; target: string; mode: string; item: CHQuota }
  | { kind: 'Settings profile'; name: string; appliesTo: string[]; target: string; mode: string; item: CHProfile };

const FIELDS: ClientFilterField<PolicyRow>[] = [
  { field: 'kind', label: 'Type' },
  { field: 'appliesTo', label: 'Applies to' },
  { field: 'target', label: 'Table' },
  { field: 'mode', label: 'Mode' },
];

const searchText = (r: PolicyRow) => `${r.name} ${r.target} ${r.appliesTo.join(' ')} ${r.kind === 'Row policy' ? r.item.select_filter || '' : ''}`;

function appliesTo(all: number, list: string[] | undefined, except: string[] | undefined): string[] {
  if (all) return except?.length ? [`ALL EXCEPT ${except.join(', ')}`] : ['ALL'];
  return list?.length ? list : ['nobody'];
}

function formatInterval(s: number) {
  return s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
}

export function PoliciesTab({ data }: { data: SecurityData }) {
  const rows = useMemo((): PolicyRow[] => [
    ...data.rowPolicies.map(p => ({
      kind: 'Row policy' as const, name: p.short_name || p.name, item: p, target: `${p.database}.${p.table}`,
      mode: p.is_restrictive ? 'Restrictive' : 'Permissive', appliesTo: appliesTo(p.apply_to_all, p.apply_to_list, p.apply_to_except),
    })),
    ...data.quotas.map(q => ({
      kind: 'Quota' as const, name: q.name, item: q, target: '', mode: q.keys?.length ? `keyed by ${q.keys.join(', ')}` : 'not keyed',
      appliesTo: appliesTo(q.apply_to_all, q.apply_to_list, q.apply_to_except),
    })),
    ...data.profiles.map(p => ({
      kind: 'Settings profile' as const, name: p.name, item: p, target: '', mode: '',
      appliesTo: appliesTo(p.apply_to_all, p.apply_to_list, p.apply_to_except),
    })),
  ], [data]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);
  const policies = filtered.filter(r => r.kind === 'Row policy');
  const quotas = filtered.filter(r => r.kind === 'Quota');
  const profiles = filtered.filter(r => r.kind === 'Settings profile');
  const card = 'bg-gray-800/60 border border-gray-700 rounded p-2';
  const applies = (r: PolicyRow) => <div className="text-[11px] text-gray-500 mt-1">Applies to: <span className="text-gray-300">{r.appliesTo.join(', ')}</span></div>;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search policies, filters, principals..." />
          </>
        }
        right={<ListCounts count={filtered.length} noun="policies" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 grid grid-cols-3 gap-3">
        <Panel title={`Row Policies (${policies.length})`} icon={Lock} bodyClassName="overflow-y-auto p-2 space-y-2">
          {policies.map(r => r.kind === 'Row policy' && (
            <div key={r.item.name} className={card}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">{r.name}</span>
                <Pill tone={r.item.is_restrictive ? 'red' : 'green'}>{r.mode.toUpperCase()}</Pill>
              </div>
              <div className="text-[11px] font-mono text-blue-300 mt-1">{r.target}</div>
              <div className="text-[11px] font-mono text-gray-300 mt-1 bg-gray-950 rounded px-1.5 py-1">WHERE {r.item.select_filter || 'true'}</div>
              {applies(r)}
            </div>
          ))}
          {policies.length === 0 && <EmptyState icon={Lock} title={data.rowPolicies.length ? 'No row policies match' : 'No row policies defined'} />}
        </Panel>
        <Panel title={`Quotas (${quotas.length})`} icon={Gauge} bodyClassName="overflow-y-auto p-2 space-y-2">
          {quotas.map(r => r.kind === 'Quota' && (
            <div key={r.name} className={card}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">{r.name}</span>
                {r.item.durations?.map(d => <Pill key={d} tone="blue">per {formatInterval(d)}</Pill>)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">Keyed by: <span className="text-gray-300">{r.item.keys?.length ? r.item.keys.join(', ') : 'none'}</span></div>
              {applies(r)}
            </div>
          ))}
          {quotas.length === 0 && <EmptyState icon={Gauge} title={data.quotas.length ? 'No quotas match' : 'No quotas defined'} />}
        </Panel>
        <Panel title={`Settings Profiles (${profiles.length})`} icon={Users} bodyClassName="overflow-y-auto p-2 space-y-2">
          {profiles.map(r => (
            <div key={r.name} className={card}>
              <div className="text-xs font-semibold text-white">{r.name}</div>
              {applies(r)}
            </div>
          ))}
          {profiles.length === 0 && <EmptyState icon={Users} title={data.profiles.length ? 'No profiles match' : 'No settings profiles'} />}
        </Panel>
      </div>
    </div>
  );
}
