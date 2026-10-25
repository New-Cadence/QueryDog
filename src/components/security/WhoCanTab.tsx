import { useState, useMemo } from 'react';
import { Search, User, Lock, ArrowRight, CheckCircle2, XCircle, CircleDot } from 'lucide-react';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, ToolbarSearch, Panel, Pill, EmptyState } from '../ui';
import { ListCounts } from './common';
import { selectClass } from './helpers';
import { useDatabases, useTables } from './catalog';
import {
  effectiveGrants, roleClosure, coverageOf, policiesFor, grantScope, isDangerous, MATRIX_PRIVS,
  type SecurityData, type EffectiveGrant, type CHRowPolicy, type Coverage,
} from './model';

const PRIVILEGES = [...MATRIX_PRIVS, 'ALTER UPDATE', 'ALTER DELETE', 'CREATE TABLE', 'DROP TABLE', 'OPTIMIZE', 'dictGet', 'ACCESS MANAGEMENT'];

interface AccessRow {
  user: string;
  coverage: Coverage;
  access: string;
  matching: EffectiveGrant[];
  via: string[];
  policies: CHRowPolicy[];
}

const FIELDS: ClientFilterField<AccessRow>[] = [
  { field: 'access', label: 'Access' },
  { field: 'via', label: 'Granted via' },
  { field: 'policy', label: 'Row policy', getValue: r => (r.policies.length ? r.policies.map(p => p.short_name || p.name) : 'none') },
];

const searchText = (r: AccessRow) => `${r.user} ${r.via.join(' ')}`;
const ACCESS_LABEL = { full: 'Allowed', partial: 'Partial', none: 'Denied' };

export function WhoCanTab({ data }: { data: SecurityData }) {
  const databases = useDatabases();
  const [database, setDatabase] = useState(() => data.grants.find(g => g.database && g.database !== 'system')?.database || 'default');
  const [table, setTable] = useState('');
  const [privilege, setPrivilege] = useState('SELECT');
  const tables = useTables(database);

  const rows = useMemo((): AccessRow[] => data.users.map(u => {
    const principal = { kind: 'user' as const, name: u.name };
    const { coverage, matching } = coverageOf(effectiveGrants(principal, data), { privilege, database, table });
    const roles = [...roleClosure(principal, data.roleGrants).keys()];
    const policies = policiesFor(principal, roles, data.rowPolicies).filter(p => p.database === database && (!table || p.table === table));
    return {
      user: u.name, coverage, matching, policies,
      access: ACCESS_LABEL[coverage || 'none'],
      via: [...new Set(matching.map(g => (g.via.length ? g.via[0] : 'direct')))],
    };
  }).sort((a, b) => ['Allowed', 'Partial', 'Denied'].indexOf(a.access) - ['Allowed', 'Partial', 'Denied'].indexOf(b.access) || a.user.localeCompare(b.user)),
  [data, database, table, privilege]);

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(rows, FIELDS, searchText);
  const allowed = rows.filter(r => r.coverage === 'full').length;
  const partial = rows.filter(r => r.coverage === 'partial').length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <select value={privilege} onChange={e => setPrivilege(e.target.value)} className={selectClass} title="Privilege">
              {PRIVILEGES.map(p => <option key={p}>{p}</option>)}
            </select>
            <span className="text-xs text-gray-500">on</span>
            <input list="sec-dbs" value={database} onChange={e => { setDatabase(e.target.value); setTable(''); }} placeholder="database" className={`${selectClass} w-36`} />
            <datalist id="sec-dbs">{databases.map(d => <option key={d} value={d} />)}</datalist>
            <input list="sec-tables" value={table} onChange={e => setTable(e.target.value)} placeholder="any table" className={`${selectClass} w-36`} />
            <datalist id="sec-tables">{tables.map(t => <option key={t} value={t} />)}</datalist>
            <ClientFilterPanel rows={rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search users, roles..." width="w-48" />
          </>
        }
        right={<ListCounts count={filtered.length} noun="users" activeFilters={activeCount} />}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        <div className="text-xs text-gray-400 shrink-0">
          <span className="text-green-400 font-semibold">{allowed}</span> of {rows.length} users can {privilege} on{' '}
          <span className="font-mono text-blue-300">{database || '*'}.{table || '*'}</span>
          {partial > 0 && <>, <span className="text-yellow-400 font-semibold">{partial}</span> only on part of it</>}
        </div>
        <Panel title="Access paths" icon={Search} className="flex-1" bodyClassName="overflow-y-auto">
          {filtered.length === 0 ? <EmptyState icon={Search} title="No users match the filters" /> : (
            <div className="divide-y divide-gray-800">
              {filtered.map(r => (
                <div key={r.user} className={`px-3 py-2 flex items-start gap-3 ${r.coverage ? '' : 'opacity-50'}`}>
                  {r.coverage === 'full' ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                    : r.coverage === 'partial' ? <CircleDot className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                      : <XCircle className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <User className="w-3 h-3 text-amber-400" />
                      <span className="text-xs font-semibold text-white">{r.user}</span>
                      {r.coverage === 'partial' && <Pill tone="yellow">partial</Pill>}
                      {r.policies.length > 0 && <Pill tone="yellow"><Lock className="w-2.5 h-2.5" />filtered by {r.policies.map(p => p.short_name || p.name).join(', ')}</Pill>}
                    </div>
                    {r.coverage && (
                      <div className="mt-1 space-y-0.5">
                        {r.matching.slice(0, 4).map((g, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-400 font-mono flex-wrap">
                            <span className="text-amber-300">{r.user}</span>
                            {g.via.map(role => (
                              <span key={role} className="flex items-center gap-1.5"><ArrowRight className="w-3 h-3 text-gray-600" /><span className="text-violet-300">{role}</span></span>
                            ))}
                            <ArrowRight className="w-3 h-3 text-gray-600" />
                            <span className={isDangerous(g.access_type) ? 'text-red-400' : 'text-green-300'}>{g.access_type}</span>
                            <span>ON</span>
                            <span className="text-blue-300">{grantScope(g)}</span>
                            {!g.active && <span className="text-yellow-500">(after SET ROLE)</span>}
                          </div>
                        ))}
                        {r.matching.length > 4 && <div className="text-[11px] text-gray-600">+{r.matching.length - 4} more paths</div>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
