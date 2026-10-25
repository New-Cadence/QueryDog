import { useState, useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Fingerprint, Key, Lock, CheckCircle2, XCircle, CircleDot } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, ToolbarSearch, Panel, Pill } from '../ui';
import { ListCounts, PrincipalSelect } from './common';
import { GRID_DEFAULT_COL_DEF, defaultPrincipalId, parsePrincipalId } from './helpers';
import {
  effectiveGrants, roleClosure, coverageOf, grantScope, scopeDatabase, viaLabel, isDangerous, MATRIX_PRIVS,
  policiesFor, type SecurityData, type EffectiveGrant,
} from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

const FIELDS: ClientFilterField<EffectiveGrant>[] = [
  { field: 'access_type', label: 'Privilege' },
  { field: 'database', label: 'Database', getValue: g => scopeDatabase(g) },
  { field: 'scope', label: 'Scope', getValue: g => grantScope(g) },
  { field: 'via', label: 'Granted via', getValue: g => (g.via.length ? g.via : 'direct') },
  { field: 'kind', label: 'Grant / revoke', getValue: g => (g.is_partial_revoke ? 'REVOKE' : 'GRANT') },
  { field: 'active', label: 'Active', getValue: g => (g.active ? 'default role' : 'needs SET ROLE') },
];

const searchText = (g: EffectiveGrant) => `${g.access_type} ${grantScope(g)} ${viaLabel(g)}`;

export function EffectiveTab({ data }: { data: SecurityData }) {
  const gridTheme = useGridTheme();
  const [principalId, setPrincipalId] = useState(() => defaultPrincipalId(data));
  const principal = useMemo(() => parsePrincipalId(principalId), [principalId]);
  const eff = useMemo(() => effectiveGrants(principal, data), [principal, data]);
  const closure = useMemo(() => roleClosure(principal, data.roleGrants), [principal, data]);
  const policies = useMemo(() => policiesFor(principal, [...closure.keys()], data.rowPolicies), [principal, closure, data]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(eff, FIELDS, searchText);

  // Matrix of database x privilege over the filtered grants
  const dbs = useMemo(() => ['*', ...new Set(filtered.map(g => g.database).filter((d): d is string => !!d))], [filtered]);
  const cell = (db: string, privilege: string) => {
    const { coverage, matching } = coverageOf(filtered, { privilege, database: db === '*' ? '' : db, table: '' });
    return coverage ? { coverage, via: [...new Set(matching.map(viaLabel))] } : null;
  };

  const columnDefs = useMemo((): ColDef<EffectiveGrant>[] => [
    { headerName: 'Privilege', field: 'access_type', width: 180, cellStyle: p => ({ color: p.data?.is_partial_revoke ? '#9ca3af' : isDangerous(p.value) ? '#f87171' : '#86efac' }) },
    { headerName: 'Scope', valueGetter: p => (p.data ? grantScope(p.data) : ''), width: 220, cellStyle: { color: '#93c5fd' } },
    { headerName: 'Granted via', valueGetter: p => (p.data ? viaLabel(p.data) : ''), flex: 1, cellStyle: { color: '#c4b5fd' } },
    { headerName: 'Active', field: 'active', width: 130, valueFormatter: p => (p.value ? 'yes' : 'needs SET ROLE'), cellStyle: p => ({ color: p.value ? '#9ca3af' : '#fbbf24' }) },
    { headerName: 'Grant option', field: 'grant_option', width: 110, valueFormatter: p => (p.value ? 'yes' : '') },
    { headerName: 'Revoke', field: 'is_partial_revoke', width: 90, valueFormatter: p => (p.value ? 'REVOKE' : ''), cellStyle: { color: '#fbbf24' } },
  ], []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <PrincipalSelect data={data} value={principalId} onChange={setPrincipalId} />
            <ClientFilterPanel rows={eff} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search privileges, scopes, roles..." />
          </>
        }
        right={<ListCounts count={filtered.length} noun="grants" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <div className="flex items-center gap-1 flex-wrap shrink-0">
          <span className="text-xs text-gray-500">Roles:</span>
          {closure.size === 0 ? <span className="text-xs text-gray-600">none</span> : [...closure.entries()].map(([r, { path, active }]) => (
            <Pill key={r} tone={active ? 'blue' : 'yellow'} title={`${path.join(' → ')}${active ? '' : ' (not a default role: requires SET ROLE)'}`}>
              {path.length > 1 ? `${r} (via ${path.slice(0, -1).join(' → ')})` : r}
            </Pill>
          ))}
          {policies.length > 0 && (
            <span className="flex items-center gap-1 ml-auto text-xs text-yellow-400">
              <Lock className="w-3 h-3" />{policies.length} row polic{policies.length === 1 ? 'y applies' : 'ies apply'}
            </span>
          )}
        </div>
        <div className="grid grid-cols-5 gap-3 flex-1 overflow-hidden">
          <Panel title="Privilege Matrix" icon={Fingerprint} className="col-span-2" bodyClassName="overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-800">
                <tr>
                  <th className="text-left px-2 py-1.5 text-gray-400 font-medium">Database</th>
                  {MATRIX_PRIVS.map(p => <th key={p} className="px-1 py-1.5 text-gray-400 font-medium text-[10px]">{p}</th>)}
                </tr>
              </thead>
              <tbody>
                {dbs.map(db => (
                  <tr key={db} className="border-b border-gray-800">
                    <td className="px-2 py-1.5 font-mono text-blue-300">{db === '*' ? '*.* (global)' : db}</td>
                    {MATRIX_PRIVS.map(p => {
                      const c = cell(db, p);
                      return (
                        <td key={p} className="text-center py-1.5" title={c ? `via ${c.via.join(', ')}${c.coverage === 'full' ? '' : ' (partial: some tables, columns or sub-privileges)'}` : 'not granted'}>
                          {!c ? <XCircle className="w-3.5 h-3.5 inline text-gray-700" />
                            : c.coverage === 'partial' ? <CircleDot className="w-3.5 h-3.5 inline text-yellow-400" />
                              : <CheckCircle2 className={`w-3.5 h-3.5 inline ${isDangerous(p) ? 'text-red-400' : 'text-green-400'}`} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 flex items-center gap-3 text-[10px] text-gray-500 border-t border-gray-800">
              <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-400" />full</span>
              <span className="flex items-center gap-1"><CircleDot className="w-3 h-3 text-yellow-400" />partial</span>
              <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-red-400" />destructive</span>
            </div>
            {policies.length > 0 && (
              <div className="p-3 space-y-1 border-t border-gray-700">
                <div className="text-[11px] text-gray-400 font-medium">Row policies</div>
                {policies.map(p => (
                  <div key={p.name} className="text-[11px] font-mono text-gray-300">
                    <span className="text-yellow-400">{p.database}.{p.table}</span> WHERE {p.select_filter || 'true'}
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title={`Effective grants (${filtered.length})`} icon={Key} className="col-span-3" bodyClassName="">
            <AgGridReact<EffectiveGrant> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={columnDefs} suppressCellFocus enableCellTextSelection
              defaultColDef={GRID_DEFAULT_COL_DEF} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
