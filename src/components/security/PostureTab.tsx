import { useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ShieldCheck, ShieldAlert, Users, Key, Lock, Globe, Unlock, Lightbulb, ArrowRight } from 'lucide-react';
import type { Recommendation, RecommendationSeverity } from '../../recommendations/types';
import { securityScore, worstSeverityByTarget } from '../../recommendations/security';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, ToolbarSearch, StatCard, Pill } from '../ui';
import { ListCounts } from './common';
import { GRID_DEFAULT_COL_DEF, severityTone } from './helpers';
import { authTypes, hostSummary, hostRestriction, roleClosure, effectiveGrants, ownGrants, scopeDatabase, type SecurityData } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

interface UserRow {
  name: string;
  risk: RecommendationSeverity | 'ok';
  auth: string[];
  hosts: string;
  hostRestriction: string;
  roles: string[];
  direct: number;
  effective: number;
  databases: string[];
  storage: string;
}

const FIELDS: ClientFilterField<UserRow>[] = [
  { field: 'risk', label: 'Risk' },
  { field: 'auth', label: 'Auth type' },
  { field: 'hostRestriction', label: 'Host restriction' },
  { field: 'storage', label: 'Storage' },
  { field: 'roles', label: 'Role' },
];

const searchText = (r: UserRow) => `${r.name} ${r.roles.join(' ')} ${r.hosts} ${r.databases.join(' ')}`;

// App.tsx exposes navigation helpers on window, like navigateToQueryId
function openRecommendations() {
  (window as unknown as { navigateToMode?: (mode: string) => void }).navigateToMode?.('recommendations');
}

export function PostureTab({ data, recs }: { data: SecurityData; recs: Recommendation[] }) {
  const gridTheme = useGridTheme();
  const score = securityScore(recs);
  const count = (sev: RecommendationSeverity) => recs.filter(r => r.severity === sev).length;
  const canNavigate = !!(window as unknown as { navigateToMode?: unknown }).navigateToMode;

  const rows = useMemo((): UserRow[] => {
    const worst = worstSeverityByTarget(recs);
    return data.users.map(u => {
      const principal = { kind: 'user' as const, name: u.name };
      const eff = effectiveGrants(principal, data).filter(g => !g.is_partial_revoke);
      return {
        name: u.name,
        risk: worst.get(u.name) || 'ok',
        auth: authTypes(u),
        hosts: hostSummary(u),
        hostRestriction: hostRestriction(u),
        roles: [...roleClosure(principal, data.roleGrants).keys()],
        direct: ownGrants(principal, data.grants).length,
        effective: eff.length,
        databases: [...new Set(eff.map(scopeDatabase))],
        storage: u.storage,
      };
    });
  }, [data, recs]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);

  const columnDefs = useMemo((): ColDef<UserRow>[] => [
    { headerName: 'User', field: 'name', width: 140, cellStyle: { color: '#f3f4f6', fontWeight: 600 } },
    {
      headerName: 'Risk', field: 'risk', width: 90,
      comparator: (a: string, b: string) => ['critical', 'high', 'medium', 'low', 'ok'].indexOf(a) - ['critical', 'high', 'medium', 'low', 'ok'].indexOf(b),
      cellRenderer: (p: ICellRendererParams<UserRow>) => (p.value === 'ok'
        ? <Pill tone="green">OK</Pill>
        : <Pill tone={severityTone[p.value as RecommendationSeverity]}><span className="capitalize">{p.value}</span></Pill>),
    },
    { headerName: 'Auth', field: 'auth', width: 150, valueFormatter: p => (p.value as string[]).join(', ') },
    { headerName: 'Hosts', field: 'hosts', width: 120, cellStyle: p => ({ color: p.value === 'ANY' ? '#fbbf24' : '#9ca3af' }) },
    { headerName: 'Roles (effective)', field: 'roles', flex: 1, minWidth: 160, valueFormatter: p => (p.value as string[]).join(', '), cellStyle: { color: '#c4b5fd' } },
    { headerName: 'Direct', field: 'direct', width: 80, type: 'rightAligned' },
    { headerName: 'Effective', field: 'effective', width: 90, type: 'rightAligned', cellStyle: { color: '#86efac' } },
    { headerName: 'Databases', field: 'databases', flex: 1, minWidth: 140, valueFormatter: p => (p.value as string[]).join(', '), cellStyle: { color: '#93c5fd' } },
    { headerName: 'Storage', field: 'storage', width: 120 },
  ], []);

  const getRowId = useCallback((p: { data: UserRow }) => p.data.name, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search users, roles, databases..." />
          </>
        }
        right={<ListCounts count={filtered.length} noun="users" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <div className="grid grid-cols-7 gap-3 shrink-0">
          <StatCard label="Security Score" value={`${score}/100`} icon={ShieldCheck} tone={score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red'}
            sub={`From ${recs.length} recommendation${recs.length === 1 ? '' : 's'}`} />
          <StatCard label="Critical / High" value={`${count('critical')} / ${count('high')}`} icon={ShieldAlert} tone={count('critical') + count('high') > 0 ? 'red' : 'green'} />
          <StatCard label="Users" value={data.users.length} icon={Users} sub={`${rows.filter(r => r.risk === 'ok').length} without issues`} />
          <StatCard label="Roles" value={data.roles.length} icon={Key} sub={`${data.roleGrants.length} role grants`} />
          <StatCard label="Unauthenticated" value={rows.filter(r => r.auth.includes('no_password')).length} icon={Unlock}
            tone={rows.some(r => r.auth.includes('no_password')) ? 'red' : 'green'} sub="no_password users" />
          <StatCard label="Any Host" value={rows.filter(r => r.hosts === 'ANY').length} icon={Globe} sub="users with HOST ANY" />
          <StatCard label="Policies / Quotas" value={`${data.rowPolicies.length} / ${data.quotas.length}`} icon={Lock} sub={`${data.profiles.length} settings profiles`} />
        </div>
        {recs.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs shrink-0">
            <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
            {canNavigate ? (
              <button onClick={openRecommendations} className="text-blue-400 hover:text-blue-300 hover:underline flex items-center gap-1">
                {recs.length} security recommendation{recs.length === 1 ? '' : 's'} <ArrowRight className="w-3 h-3" />
              </button>
            ) : (
              <span className="text-gray-400">{recs.length} security recommendation{recs.length === 1 ? '' : 's'} in the Recommendations mode</span>
            )}
          </div>
        )}
        <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
          <AgGridReact<UserRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={columnDefs} getRowId={getRowId}
            suppressCellFocus enableCellTextSelection defaultColDef={GRID_DEFAULT_COL_DEF} />
        </div>
      </div>
    </div>
  );
}
