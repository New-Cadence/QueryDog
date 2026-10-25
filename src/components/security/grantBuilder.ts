// Statement generation and client-side impact simulation for the Grant Builder.
// Nothing here talks to ClickHouse: we only compose SQL and apply its effect to
// a copy of the loaded access model so the page can preview the change.
import {
  effectiveGrants, roleClosure, coverageOf, grantKey, privilegeImplies, quoteIdent,
  type SecurityData, type CHGrant, type Principal,
} from './model';

export type StatementKind = 'grant' | 'revoke' | 'grant-role' | 'revoke-role' | 'create-role' | 'create-user';

export interface BuilderForm {
  kind: StatementKind;
  grantee: Principal;
  privileges: string[];
  database: string; // '' = all databases
  table: string; // '' = all tables
  columns: string[];
  grantOption: boolean; // WITH GRANT OPTION / REVOKE GRANT OPTION FOR
  role: string;
  adminOption: boolean;
  newName: string;
  auth: string;
  password: string;
  host: 'ANY' | 'LOCAL' | 'IP';
  hostIp: string;
  newUserRoles: string[];
}

export const BUILDER_PRIVILEGES = [
  'SELECT', 'INSERT', 'ALTER', 'ALTER UPDATE', 'ALTER DELETE', 'CREATE TABLE', 'CREATE VIEW', 'CREATE DATABASE',
  'DROP TABLE', 'DROP DATABASE', 'TRUNCATE', 'OPTIMIZE', 'SHOW TABLES', 'dictGet', 'SYSTEM', 'KILL QUERY', 'ACCESS MANAGEMENT', 'ALL',
];

// Privileges that accept a column list
const COLUMN_PRIVS = ['SELECT', 'INSERT', 'ALTER UPDATE', 'SHOW COLUMNS'];
const GLOBAL_ONLY = ['ACCESS MANAGEMENT', 'KILL QUERY'];

const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function scopeSql(f: BuilderForm): string {
  if (!f.database) return '*.*';
  return `${quoteIdent(f.database)}.${f.table ? quoteIdent(f.table) : '*'}`;
}

function privilegeList(f: BuilderForm): string {
  const cols = f.columns.length ? `(${f.columns.map(quoteIdent).join(', ')})` : '';
  return f.privileges.map(p => `${p}${cols}`).join(', ');
}

export function validate(f: BuilderForm): string | null {
  switch (f.kind) {
    case 'grant':
    case 'revoke':
      if (!f.grantee.name) return 'Pick a grantee';
      if (!f.privileges.length) return 'Pick at least one privilege';
      if (f.columns.length && f.privileges.some(p => !COLUMN_PRIVS.includes(p))) return `Column scope only works with ${COLUMN_PRIVS.join(', ')}`;
      if (f.database && f.privileges.some(p => GLOBAL_ONLY.includes(p))) return `${f.privileges.filter(p => GLOBAL_ONLY.includes(p)).join(', ')} can only be granted ON *.*`;
      return null;
    case 'grant-role':
    case 'revoke-role':
      if (!f.role) return 'Pick a role';
      if (!f.grantee.name) return 'Pick a grantee';
      if (f.grantee.kind === 'role' && f.grantee.name === f.role) return 'A role cannot be granted to itself';
      return null;
    case 'create-role':
    case 'create-user':
      if (!f.newName.trim()) return `Enter a ${f.kind === 'create-role' ? 'role' : 'user'} name`;
      if (f.kind === 'create-user' && f.host === 'IP' && !f.hostIp.trim()) return 'Enter an IP or subnet';
      return null;
  }
}

export function buildSql(f: BuilderForm): string[] {
  const grantee = quoteIdent(f.grantee.name);
  switch (f.kind) {
    case 'grant':
      return [`GRANT ${privilegeList(f)} ON ${scopeSql(f)} TO ${grantee}${f.grantOption ? ' WITH GRANT OPTION' : ''}`];
    case 'revoke':
      return [`REVOKE ${f.grantOption ? 'GRANT OPTION FOR ' : ''}${privilegeList(f)} ON ${scopeSql(f)} FROM ${grantee}`];
    case 'grant-role':
      return [`GRANT ${quoteIdent(f.role)} TO ${grantee}${f.adminOption ? ' WITH ADMIN OPTION' : ''}`];
    case 'revoke-role':
      return [`REVOKE ${quoteIdent(f.role)} FROM ${grantee}`];
    case 'create-role':
      return [`CREATE ROLE ${quoteIdent(f.newName.trim())}`];
    case 'create-user': {
      const name = quoteIdent(f.newName.trim());
      const auth = f.auth === 'no_password' ? 'IDENTIFIED WITH no_password' : `IDENTIFIED WITH ${f.auth} BY ${lit(f.password || '<password>')}`;
      const host = f.host === 'IP' ? `HOST IP ${lit(f.hostIp.trim())}` : `HOST ${f.host}`;
      return [
        `CREATE USER ${name} ${auth} ${host}`,
        ...(f.newUserRoles.length ? [`GRANT ${f.newUserRoles.map(quoteIdent).join(', ')} TO ${name}`] : []),
      ];
    }
  }
}

// Is `inner`'s scope inside `outer`'s?
function scopeContains(outer: CHGrant, inner: CHGrant): boolean {
  if (!outer.database) return true;
  if (outer.database !== inner.database) return false;
  if (!outer.table) return true;
  if (outer.table !== inner.table) return false;
  return !outer.column || outer.column === inner.column;
}

function owns(g: CHGrant, p: Principal) {
  return p.kind === 'user' ? g.user_name === p.name : g.role_name === p.name;
}

// The grant rows ClickHouse would store for the form's privileges
function formRows(f: BuilderForm, revoke: boolean): CHGrant[] {
  const cols = f.columns.length ? f.columns : [null];
  return f.privileges.flatMap(p => cols.map(column => ({
    user_name: f.grantee.kind === 'user' ? f.grantee.name : null,
    role_name: f.grantee.kind === 'role' ? f.grantee.name : null,
    access_type: p, database: f.database || null, table: (f.database && f.table) || null, column,
    is_partial_revoke: revoke ? 1 : 0, grant_option: f.grantOption ? 1 : 0,
  })));
}

// The access model after the statement runs
export function applyStatement(f: BuilderForm, data: SecurityData): SecurityData {
  const p = f.grantee;
  switch (f.kind) {
    case 'grant': {
      const added = formRows(f, false);
      // A grant cancels partial revokes it covers
      const grants = data.grants.filter(g => !(owns(g, p) && g.is_partial_revoke && added.some(a => privilegeImplies(a.access_type, g.access_type) && scopeContains(a, g))));
      return { ...data, grants: [...grants, ...added] };
    }
    case 'revoke': {
      const revoked = formRows(f, true);
      const hit = (g: CHGrant) => owns(g, p) && !g.is_partial_revoke && revoked.some(r => privilegeImplies(r.access_type, g.access_type) && scopeContains(r, g));
      if (f.grantOption) return { ...data, grants: data.grants.map(g => (hit(g) ? { ...g, grant_option: 0 } : g)) };
      const grants = data.grants.filter(g => !hit(g));
      // Revoking part of a broader grant leaves a partial revoke behind
      const partial = revoked.filter(r => grants.some(g => owns(g, p) && !g.is_partial_revoke && privilegeImplies(g.access_type, r.access_type) && scopeContains(g, r)));
      return { ...data, grants: [...grants, ...partial] };
    }
    case 'grant-role':
      return {
        ...data,
        roleGrants: [...data.roleGrants.filter(rg => !(rg.granted_role_name === f.role && (p.kind === 'user' ? rg.user_name === p.name : rg.role_name === p.name))), {
          user_name: p.kind === 'user' ? p.name : null, role_name: p.kind === 'role' ? p.name : null,
          granted_role_name: f.role, granted_role_is_default: 1, with_admin_option: f.adminOption ? 1 : 0,
        }],
      };
    case 'revoke-role':
      return { ...data, roleGrants: data.roleGrants.filter(rg => !(rg.granted_role_name === f.role && (p.kind === 'user' ? rg.user_name === p.name : rg.role_name === p.name))) };
    case 'create-role':
      return { ...data, roles: [...data.roles, { name: f.newName.trim(), storage: 'local_directory' }] };
    case 'create-user': {
      const name = f.newName.trim();
      return {
        ...data,
        users: [...data.users, {
          name, auth_type: [f.auth], host_ip: f.host === 'ANY' ? ['::/0'] : f.host === 'IP' ? [f.hostIp.trim()] : [],
          host_names: f.host === 'LOCAL' ? ['localhost'] : [], default_roles_all: 1, default_roles_list: [], storage: 'local_directory',
        }],
        roleGrants: [...data.roleGrants, ...f.newUserRoles.map(r => ({ user_name: name, role_name: null, granted_role_name: r, granted_role_is_default: 1, with_admin_option: 0 }))],
      };
    }
  }
}

export interface UserImpact {
  user: string;
  added: string[];
  removed: string[];
  // Explains a REVOKE that changes nothing because access comes from a role
  note?: string;
}

// Privileges only reachable through a non-default role are listed separately,
// so making a role default (or granting it some other way) shows as a change
function lines(user: string, data: SecurityData): Set<string> {
  const eff = effectiveGrants({ kind: 'user', name: user }, data);
  const active = new Set(eff.filter(g => g.active).map(grantKey));
  const inactive = eff.filter(g => !g.active).map(grantKey).filter(k => !active.has(k)).map(k => `${k} (after SET ROLE)`);
  return new Set([...active, ...inactive]);
}

// Users whose effective privileges could change: the grantee itself, or every
// member (direct or nested) of the grantee role
export function previewImpact(f: BuilderForm, before: SecurityData, after: SecurityData): UserImpact[] {
  const affected = f.kind === 'create-user' ? [f.newName.trim()]
    : f.kind === 'create-role' ? []
      : f.grantee.kind === 'user' ? [f.grantee.name]
        : after.users.filter(u => roleClosure({ kind: 'user', name: u.name }, [...before.roleGrants, ...after.roleGrants]).has(f.grantee.name)).map(u => u.name);
  return affected.map(user => {
    const was = before.users.some(u => u.name === user) ? lines(user, before) : new Set<string>();
    const now = lines(user, after);
    const impact: UserImpact = { user, added: [...now].filter(l => !was.has(l)), removed: [...was].filter(l => !now.has(l)) };
    if (f.kind === 'revoke' && !impact.added.length && !impact.removed.length) {
      const eff = effectiveGrants({ kind: 'user', name: user }, after);
      const viaRole = f.privileges.some(priv => coverageOf(eff.filter(g => g.via.length), { privilege: priv, database: f.database, table: f.table }).coverage);
      if (viaRole) impact.note = 'Unchanged: this access is inherited from a role. Revoke it from the role instead.';
    }
    return impact;
  });
}
