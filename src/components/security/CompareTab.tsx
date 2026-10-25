import { useState, useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ArrowLeftRight } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, ToolbarSearch, Pill, StatCard } from '../ui';
import { ListCounts, PrincipalSelect } from './common';
import { GRID_DEFAULT_COL_DEF, defaultPrincipalId, parsePrincipalId } from './helpers';
import {
  effectiveGrants, roleClosure, coverageOf, grantScope, scopeDatabase, viaLabel, isDangerous,
  type SecurityData, type EffectiveGrant,
} from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

type Side = 'Only A' | 'Only B' | 'Both';

interface DiffRow {
  key: string;
  privilege: string;
  scope: string;
  database: string;
  revoke: boolean;
  side: Side;
  viaA: string;
  viaB: string;
  // Set when the other side still has this through a broader grant
  note: string;
}

const FIELDS: ClientFilterField<DiffRow>[] = [
  { field: 'side', label: 'Difference' },
  { field: 'privilege', label: 'Privilege' },
  { field: 'database', label: 'Database' },
];

const searchText = (r: DiffRow) => `${r.key} ${r.viaA} ${r.viaB}`;

// Effective privilege lines keyed without the role path, so the same privilege
// reached through different roles still compares as equal
function linesOf(eff: EffectiveGrant[]): Map<string, EffectiveGrant[]> {
  const out = new Map<string, EffectiveGrant[]>();
  for (const g of eff) {
    const key = `${g.is_partial_revoke ? 'REVOKE ' : ''}${g.access_type} ON ${grantScope(g)}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(g);
  }
  return out;
}

const sideTone: Record<Side, 'blue' | 'yellow' | 'default'> = { 'Only A': 'blue', 'Only B': 'yellow', Both: 'default' };

export function CompareTab({ data }: { data: SecurityData }) {
  const gridTheme = useGridTheme();
  const [aId, setAId] = useState(() => defaultPrincipalId(data, 0));
  const [bId, setBId] = useState(() => defaultPrincipalId(data, 1));
  const a = useMemo(() => parsePrincipalId(aId), [aId]);
  const b = useMemo(() => parsePrincipalId(bId), [bId]);

  const { rows, rolesA, rolesB } = useMemo(() => {
    const effA = effectiveGrants(a, data);
    const effB = effectiveGrants(b, data);
    const linesA = linesOf(effA);
    const linesB = linesOf(effB);
    const covered = (eff: EffectiveGrant[], g: EffectiveGrant) => !g.is_partial_revoke && coverageOf(eff, {
      privilege: g.access_type, database: g.database || '', table: g.table || '', column: g.column || undefined,
    }).coverage === 'full';
    const out: DiffRow[] = [];
    for (const key of new Set([...linesA.keys(), ...linesB.keys()])) {
      const ga = linesA.get(key);
      const gb = linesB.get(key);
      const g = (ga || gb)![0];
      const side: Side = ga && gb ? 'Both' : ga ? 'Only A' : 'Only B';
      out.push({
        key, side, privilege: g.access_type, scope: grantScope(g), database: scopeDatabase(g), revoke: !!g.is_partial_revoke,
        viaA: ga ? [...new Set(ga.map(viaLabel))].join(', ') : '',
        viaB: gb ? [...new Set(gb.map(viaLabel))].join(', ') : '',
        note: side === 'Only A' && covered(effB, g) ? 'B has it via a broader grant'
          : side === 'Only B' && covered(effA, g) ? 'A has it via a broader grant' : '',
      });
    }
    const order: Side[] = ['Only A', 'Only B', 'Both'];
    out.sort((x, y) => order.indexOf(x.side) - order.indexOf(y.side) || x.key.localeCompare(y.key));
    return { rows: out, rolesA: [...roleClosure(a, data.roleGrants).keys()], rolesB: [...roleClosure(b, data.roleGrants).keys()] };
  }, [a, b, data]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);
  const count = (s: Side) => filtered.filter(r => r.side === s).length;

  const columnDefs = useMemo((): ColDef<DiffRow>[] => [
    { headerName: '', field: 'side', width: 90, cellRenderer: (p: ICellRendererParams<DiffRow>) => <Pill tone={sideTone[p.value as Side]}>{p.value}</Pill> },
    { headerName: 'Privilege', field: 'privilege', width: 170, valueGetter: p => (p.data ? `${p.data.revoke ? 'REVOKE ' : ''}${p.data.privilege}` : ''),
      cellStyle: p => ({ color: p.data?.revoke ? '#fbbf24' : isDangerous(p.data?.privilege || '') ? '#f87171' : '#86efac' }) },
    { headerName: 'Scope', field: 'scope', width: 200, cellStyle: { color: '#93c5fd' } },
    { headerName: `A: ${a.name} via`, field: 'viaA', flex: 1, minWidth: 140, cellStyle: { color: '#c4b5fd' } },
    { headerName: `B: ${b.name} via`, field: 'viaB', flex: 1, minWidth: 140, cellStyle: { color: '#c4b5fd' } },
    { headerName: 'Note', field: 'note', width: 200, cellStyle: { color: '#9ca3af' } },
  ], [a.name, b.name]);

  const roleChips = (roles: string[], other: string[], tone: 'blue' | 'yellow') => roles.map(r => (
    <Pill key={r} tone={other.includes(r) ? 'default' : tone}>{r}</Pill>
  ));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <span className="text-xs text-blue-400 font-semibold">A</span>
            <PrincipalSelect data={data} value={aId} onChange={setAId} />
            <button onClick={() => { setAId(bId); setBId(aId); }} className="text-gray-400 hover:text-white" title="Swap A and B">
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-yellow-400 font-semibold">B</span>
            <PrincipalSelect data={data} value={bId} onChange={setBId} />
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search privileges, scopes..." width="w-48" />
          </>
        }
        right={<ListCounts count={filtered.length} noun="privileges" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3 shrink-0">
          <StatCard label={`Only ${a.name}`} value={count('Only A')} tone="blue" sub={<span className="flex gap-1 flex-wrap">{rolesA.length ? roleChips(rolesA, rolesB, 'blue') : 'no roles'}</span>} />
          <StatCard label="Both" value={count('Both')} sub={`${rolesA.filter(r => rolesB.includes(r)).length} shared roles`} />
          <StatCard label={`Only ${b.name}`} value={count('Only B')} tone="yellow" sub={<span className="flex gap-1 flex-wrap">{rolesB.length ? roleChips(rolesB, rolesA, 'yellow') : 'no roles'}</span>} />
        </div>
        <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
          <AgGridReact<DiffRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={filtered} columnDefs={columnDefs} getRowId={p => p.data.key}
            suppressCellFocus enableCellTextSelection defaultColDef={GRID_DEFAULT_COL_DEF} />
        </div>
      </div>
    </div>
  );
}
