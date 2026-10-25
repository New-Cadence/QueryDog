import { useState, useMemo } from 'react';
import { Wand2, Code, Users, Plus, Minus, Info } from 'lucide-react';
import { PageToolbar, Panel, Field, EmptyState, Pill } from '../ui';
import { inputClass } from '../uiTokens';
import { CopyButton, PrincipalSelect } from './common';
import { defaultPrincipalId, parsePrincipalId } from './helpers';
import { useDatabases, useTables, useColumns } from './catalog';
import { BUILDER_PRIVILEGES, validate, buildSql, applyStatement, previewImpact, type BuilderForm, type StatementKind } from './grantBuilder';
import type { SecurityData } from './model';

const KINDS: { id: StatementKind; label: string }[] = [
  { id: 'grant', label: 'GRANT privileges' },
  { id: 'revoke', label: 'REVOKE privileges' },
  { id: 'grant-role', label: 'GRANT role' },
  { id: 'revoke-role', label: 'REVOKE role' },
  { id: 'create-role', label: 'CREATE ROLE' },
  { id: 'create-user', label: 'CREATE USER' },
];

const AUTH_TYPES = ['sha256_password', 'bcrypt_password', 'double_sha1_password', 'no_password'];

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-300">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="w-3 h-3" />
      {label}
    </label>
  );
}

function MultiCheck({ options, selected, onChange, columns = 2 }: { options: string[]; selected: string[]; onChange: (v: string[]) => void; columns?: number }) {
  return (
    <div className={`grid gap-x-3 gap-y-1 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
      {options.map(o => (
        <Toggle key={o} label={o} checked={selected.includes(o)} onChange={on => onChange(on ? [...selected, o] : selected.filter(s => s !== o))} />
      ))}
    </div>
  );
}

export function GrantBuilderTab({ data }: { data: SecurityData }) {
  const [form, setForm] = useState<BuilderForm>(() => ({
    kind: 'grant', grantee: parsePrincipalId(data.roles[0] ? `role:${data.roles[0].name}` : defaultPrincipalId(data)),
    privileges: ['SELECT'], database: '', table: '', columns: [], grantOption: false,
    role: data.roles[0]?.name || '', adminOption: false,
    newName: '', auth: 'sha256_password', password: '', host: 'ANY', hostIp: '', newUserRoles: [],
  }));
  const set = (patch: Partial<BuilderForm>) => setForm(f => ({ ...f, ...patch }));

  const databases = useDatabases();
  const tables = useTables(form.database);
  const columns = useColumns(form.database, form.table);

  const error = useMemo(() => {
    const name = form.newName.trim();
    if (form.kind === 'create-user' && data.users.some(u => u.name === name)) return `User ${name} already exists`;
    if (form.kind === 'create-role' && data.roles.some(r => r.name === name)) return `Role ${name} already exists`;
    return validate(form);
  }, [form, data]);
  const sql = error ? [] : buildSql(form);
  const impact = useMemo(() => (error ? [] : previewImpact(form, data, applyStatement(form, data))), [error, form, data]);
  const sqlText = sql.map(s => `${s};`).join('\n');
  const usesPrivileges = form.kind === 'grant' || form.kind === 'revoke';
  const usesRole = form.kind === 'grant-role' || form.kind === 'revoke-role';
  const creates = form.kind === 'create-role' || form.kind === 'create-user';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <select value={form.kind} onChange={e => set({ kind: e.target.value as StatementKind })} className={`${inputClass} !w-48 !py-0.5`}>
            {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        }
        right={<span className="text-[11px] text-gray-500">Generates SQL only; nothing is executed against the server</span>}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 grid grid-cols-5 gap-3">
        <Panel title="Statement" icon={Wand2} className="col-span-2" bodyClassName="overflow-y-auto p-3 space-y-3">
          {!creates && (
            <Field label={usesRole ? 'Grant role to' : form.kind === 'revoke' ? 'Revoke from' : 'Grantee'}>
              <PrincipalSelect data={data} value={`${form.grantee.kind}:${form.grantee.name}`} onChange={id => set({ grantee: parsePrincipalId(id) })} />
            </Field>
          )}
          {usesPrivileges && (
            <>
              <Field label="Privileges">
                <MultiCheck options={BUILDER_PRIVILEGES} selected={form.privileges} onChange={privileges => set({ privileges })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Database">
                  <select value={form.database} onChange={e => set({ database: e.target.value, table: '', columns: [] })} className={inputClass}>
                    <option value="">* (all databases)</option>
                    {databases.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Field>
                <Field label="Table">
                  <select value={form.table} onChange={e => set({ table: e.target.value, columns: [] })} className={inputClass} disabled={!form.database}>
                    <option value="">* (all tables)</option>
                    {tables.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
              </div>
              {form.table && columns.length > 0 && (
                <Field label="Columns" hint="Leave empty for the whole table">
                  <MultiCheck options={columns} selected={form.columns} onChange={cols => set({ columns: cols })} columns={3} />
                </Field>
              )}
              <Toggle label={form.kind === 'grant' ? 'WITH GRANT OPTION' : 'Only revoke the GRANT OPTION'} checked={form.grantOption} onChange={grantOption => set({ grantOption })} />
            </>
          )}
          {usesRole && (
            <>
              <Field label="Role">
                <select value={form.role} onChange={e => set({ role: e.target.value })} className={inputClass}>
                  {data.roles.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
                </select>
              </Field>
              {form.kind === 'grant-role' && <Toggle label="WITH ADMIN OPTION" checked={form.adminOption} onChange={adminOption => set({ adminOption })} />}
            </>
          )}
          {creates && (
            <Field label={form.kind === 'create-role' ? 'Role name' : 'User name'}>
              <input value={form.newName} onChange={e => set({ newName: e.target.value })} className={inputClass} placeholder={form.kind === 'create-role' ? 'e.g. reporting_reader' : 'e.g. reporting_app'} />
            </Field>
          )}
          {form.kind === 'create-user' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Authentication">
                  <select value={form.auth} onChange={e => set({ auth: e.target.value })} className={inputClass}>
                    {AUTH_TYPES.map(a => <option key={a}>{a}</option>)}
                  </select>
                </Field>
                {form.auth !== 'no_password' && (
                  <Field label="Password" hint="Shown in the generated SQL only">
                    <input type="password" value={form.password} onChange={e => set({ password: e.target.value })} className={inputClass} placeholder="<password>" />
                  </Field>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Allowed hosts">
                  <select value={form.host} onChange={e => set({ host: e.target.value as BuilderForm['host'] })} className={inputClass}>
                    <option value="ANY">ANY</option>
                    <option value="LOCAL">LOCAL</option>
                    <option value="IP">IP / subnet</option>
                  </select>
                </Field>
                {form.host === 'IP' && (
                  <Field label="IP or subnet">
                    <input value={form.hostIp} onChange={e => set({ hostIp: e.target.value })} className={inputClass} placeholder="10.0.0.0/8" />
                  </Field>
                )}
              </div>
              {data.roles.length > 0 && (
                <Field label="Roles">
                  <MultiCheck options={data.roles.map(r => r.name)} selected={form.newUserRoles} onChange={newUserRoles => set({ newUserRoles })} />
                </Field>
              )}
              {form.auth === 'no_password' && <div className="text-[11px] text-red-400">no_password lets anyone who can reach the server log in as this user.</div>}
            </>
          )}
        </Panel>
        <div className="col-span-3 flex flex-col gap-3 overflow-hidden">
          <Panel title="Generated SQL" icon={Code} className="shrink-0" actions={sql.length > 0 && <CopyButton text={sqlText} />}>
            {error ? <div className="text-xs text-yellow-400">{error}</div> : (
              <pre className="text-xs font-mono text-green-300 whitespace-pre-wrap break-all select-all">{sqlText}</pre>
            )}
          </Panel>
          <Panel title="Preview impact on effective permissions" icon={Users} className="flex-1" bodyClassName="overflow-y-auto">
            {error ? <EmptyState icon={Info} title="Complete the statement to preview its impact" />
              : impact.length === 0 ? <EmptyState icon={Info} title="No existing user is affected">{form.kind === 'create-role' ? 'A new role has no members until it is granted.' : 'The grantee role has no members.'}</EmptyState>
                : (
                  <div className="divide-y divide-gray-800">
                    <div className="px-3 py-1.5 text-[11px] text-gray-500">Computed in the browser from the loaded grants. Preview only.</div>
                    {impact.map(u => (
                      <div key={u.user} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-white">{u.user}</span>
                          {u.added.length > 0 && <Pill tone="green">+{u.added.length}</Pill>}
                          {u.removed.length > 0 && <Pill tone="red">-{u.removed.length}</Pill>}
                          {!u.added.length && !u.removed.length && <Pill>no change</Pill>}
                        </div>
                        {u.note && <div className="text-[11px] text-yellow-400 mt-1">{u.note}</div>}
                        <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                          {u.added.map(l => <div key={`+${l}`} className="flex items-center gap-1.5 text-green-400"><Plus className="w-3 h-3 shrink-0" />{l}</div>)}
                          {u.removed.map(l => <div key={`-${l}`} className="flex items-center gap-1.5 text-red-400"><Minus className="w-3 h-3 shrink-0" />{l}</div>)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
