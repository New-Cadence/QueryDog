// Access control model for the Security mode: loads users, roles and grants
// from ClickHouse and answers "what can this principal do?" client-side.
// Shared by the Security page tabs and the security recommendation provider.
import { fetchUsers, fetchRoles, fetchRoleGrants, fetchGrants, fetchRowPolicies, fetchQuotas, executeQuery } from '../../services/api';

// ==================== Types ====================

export interface CHUser {
  name: string;
  // Array(Enum) on recent versions, a single Enum string on older ones
  auth_type: string | string[] | null;
  host_ip: string[];
  host_names: string[];
  host_names_regexp?: string[];
  host_names_like?: string[];
  default_roles_all: number;
  default_roles_list: string[];
  storage: string;
}

export interface CHRole { name: string; storage: string }

export interface CHRoleGrant {
  user_name: string | null;
  role_name: string | null;
  granted_role_name: string;
  granted_role_is_default: number;
  with_admin_option: number;
}

export interface CHGrant {
  user_name: string | null;
  role_name: string | null;
  access_type: string;
  database: string | null;
  table: string | null;
  column: string | null;
  is_partial_revoke: number;
  grant_option: number;
  // Set for prefix grants such as GRANT SELECT ON db_prefix*.*
  is_wildcard?: number;
}

export interface CHRowPolicy {
  name: string;
  short_name: string;
  database: string;
  table: string;
  select_filter: string | null;
  is_restrictive: number;
  apply_to_all: number;
  apply_to_list: string[];
  apply_to_except: string[];
}

export interface CHQuota {
  name: string;
  durations: number[];
  apply_to_all: number;
  apply_to_list: string[];
  apply_to_except?: string[];
  keys: string[];
}

export interface CHProfile { name: string; apply_to_list: string[]; apply_to_all: number; apply_to_except?: string[] }

export interface SecurityData {
  users: CHUser[];
  roles: CHRole[];
  roleGrants: CHRoleGrant[];
  grants: CHGrant[];
  rowPolicies: CHRowPolicy[];
  quotas: CHQuota[];
  profiles: CHProfile[];
}

export type PrincipalKind = 'user' | 'role';
export interface Principal { kind: PrincipalKind; name: string }

export interface EffectiveGrant extends CHGrant {
  // Role path the grant was inherited through; empty for direct grants
  via: string[];
  // False when the role is granted but not a default role, so the user only
  // gets it after SET ROLE
  active: boolean;
}

export async function loadSecurityData(): Promise<SecurityData> {
  // Users are required; everything else degrades to empty on missing tables/permissions
  const safe = <T,>(p: Promise<unknown>) => p.then(r => r as T[]).catch(() => [] as T[]);
  const [users, roles, roleGrants, grants, rowPolicies, quotas, profiles] = await Promise.all([
    fetchUsers() as Promise<unknown> as Promise<CHUser[]>,
    safe<CHRole>(fetchRoles()),
    safe<CHRoleGrant>(fetchRoleGrants()),
    safe<CHGrant>(fetchGrants()),
    safe<CHRowPolicy>(fetchRowPolicies()),
    safe<CHQuota>(fetchQuotas()),
    safe<CHProfile>(executeQuery('SELECT name, apply_to_all, apply_to_list, apply_to_except FROM system.settings_profiles ORDER BY name').then(r => r.data)),
  ]);
  return { users, roles, roleGrants, grants, rowPolicies, quotas, profiles };
}

// ==================== Users ====================

export function authTypes(user: CHUser): string[] {
  const a = user.auth_type;
  if (a === null || a === undefined) return [];
  return (Array.isArray(a) ? a : [a]).map(String);
}

function hostPatterns(user: CHUser): string[] {
  return [...(user.host_ip || []), ...(user.host_names || []), ...(user.host_names_like || []), ...(user.host_names_regexp || [])];
}

export function isAnyHost(user: CHUser): boolean {
  return (user.host_ip || []).some(ip => ip === '::/0' || ip === '0.0.0.0/0')
    || (user.host_names_like || []).includes('%')
    || (user.host_names_regexp || []).includes('.*');
}

export function hostSummary(user: CHUser): string {
  if (isAnyHost(user)) return 'ANY';
  const parts = hostPatterns(user);
  return parts.length ? parts.join(', ') : 'NONE';
}

export function hostRestriction(user: CHUser): string {
  if (isAnyHost(user)) return 'Any host';
  const parts = hostPatterns(user);
  if (!parts.length) return 'No hosts';
  if (parts.every(p => ['localhost', '127.0.0.1', '::1'].includes(p))) return 'Localhost only';
  return 'Restricted';
}

// ==================== Roles ====================

export interface RolePath { path: string[]; active: boolean }

// Every role reachable from a principal through role_grants, with the path used
// to reach it. Paths through default roles are preferred so `active` is true
// whenever the role is in effect without SET ROLE.
export function roleClosure(principal: Principal, roleGrants: CHRoleGrant[]): Map<string, RolePath> {
  const result = new Map<string, RolePath>();
  const starts = roleGrants
    .filter(rg => (principal.kind === 'user' ? rg.user_name === principal.name : rg.role_name === principal.name))
    .map(rg => ({ role: rg.granted_role_name, path: [rg.granted_role_name], active: principal.kind === 'role' || !!rg.granted_role_is_default }));
  for (const active of [true, false]) {
    const queue = starts.filter(s => s.active === active);
    while (queue.length) {
      const { role, path } = queue.shift()!;
      if (result.has(role)) continue;
      result.set(role, { path, active });
      for (const rg of roleGrants) {
        if (rg.role_name === role && !result.has(rg.granted_role_name)) {
          queue.push({ role: rg.granted_role_name, path: [...path, rg.granted_role_name], active });
        }
      }
    }
  }
  return result;
}

export function ownGrants(principal: Principal, grants: CHGrant[]): CHGrant[] {
  return grants.filter(g => (principal.kind === 'user' ? g.user_name === principal.name : g.role_name === principal.name));
}

export function effectiveGrants(principal: Principal, data: Pick<SecurityData, 'grants' | 'roleGrants'>): EffectiveGrant[] {
  const out: EffectiveGrant[] = ownGrants(principal, data.grants).map(g => ({ ...g, via: [], active: true }));
  for (const [role, { path, active }] of roleClosure(principal, data.roleGrants)) {
    for (const g of data.grants) if (g.role_name === role) out.push({ ...g, via: path, active });
  }
  return out;
}

// The principal a grant row belongs to, used to group grants: revokes only
// subtract from grants held by the same principal.
export function grantSource(g: EffectiveGrant): string {
  return g.via.length ? g.via[g.via.length - 1] : 'direct';
}

export function viaLabel(g: EffectiveGrant): string {
  return g.via.length ? g.via.join(' → ') : 'direct';
}

// Row policies that apply to a principal directly or through one of its roles
export function policiesFor(principal: Principal, roles: string[], policies: CHRowPolicy[]): CHRowPolicy[] {
  const names = [principal.name, ...roles];
  return policies.filter(p => (p.apply_to_all ? !p.apply_to_except?.some(n => names.includes(n)) : p.apply_to_list?.some(n => names.includes(n))));
}

// ==================== Privileges & scopes ====================

// Privileges that can destroy data or take over the instance
export const DANGEROUS_PRIVS = ['ALL', 'DROP', 'DROP TABLE', 'DROP DATABASE', 'ALTER', 'ACCESS MANAGEMENT', 'CREATE USER', 'TRUNCATE', 'SYSTEM', 'KILL QUERY'];
export const MATRIX_PRIVS = ['SELECT', 'INSERT', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'SHOW', 'SYSTEM'];

// Access management statements share a first word with data privileges
// (CREATE USER, ALTER ROLE, SHOW USERS) but sit under ACCESS MANAGEMENT / SHOW ACCESS.
const ACCESS_MGMT = /^(CREATE|ALTER|DROP) (USER|ROLE|ROW POLICY|QUOTA|SETTINGS PROFILE|MASKING POLICY)$|^SHOW (USERS|ROLES|ROW POLICIES|QUOTAS|SETTINGS PROFILES)$/;

// Does holding `granted` give `requested`? ClickHouse privileges form a tree in
// which a child's name extends its parent's (ALTER → ALTER UPDATE, CREATE → CREATE TABLE).
export function privilegeImplies(granted: string, requested: string): boolean {
  if (granted === requested || granted === 'ALL') return true;
  if (ACCESS_MGMT.test(requested)) return granted === 'ACCESS MANAGEMENT' || (requested.startsWith('SHOW') && granted === 'SHOW ACCESS');
  return requested.startsWith(granted + ' ');
}

export function isDangerous(accessType: string): boolean {
  return DANGEROUS_PRIVS.includes(accessType);
}

// Request scope: database '' = every database, table '' = every table in it
export interface AccessRequest { privilege: string; database: string; table: string; column?: string }

function nameMatches(pattern: string, name: string, wildcard: boolean) {
  return wildcard ? name.startsWith(pattern) : pattern === name;
}

// 'contains' when the grant scope includes the whole request scope, 'within'
// when it only covers part of it (a table of the requested database, a column...).
function scopeRelation(g: CHGrant, req: AccessRequest): 'contains' | 'within' | null {
  const wildcard = !!g.is_wildcard;
  if (!g.database) return 'contains';
  if (!req.database) return 'within';
  if (!nameMatches(g.database, req.database, wildcard && !g.table)) return null;
  if (!g.table) return 'contains';
  if (!req.table) return 'within';
  if (!nameMatches(g.table, req.table, wildcard)) return null;
  if (!g.column) return 'contains';
  return req.column === g.column ? 'contains' : 'within';
}

function privilegeRelation(granted: string, requested: string): 'contains' | 'within' | null {
  if (privilegeImplies(granted, requested)) return 'contains';
  if (privilegeImplies(requested, granted)) return 'within';
  return null;
}

export type Coverage = 'full' | 'partial' | null;

// Coverage of a request by the grants of a single principal, honouring that
// principal's partial revokes.
function principalCoverage(grants: CHGrant[], req: AccessRequest): { coverage: Coverage; matching: CHGrant[] } {
  let coverage: Coverage = null;
  const matching: CHGrant[] = [];
  for (const g of grants) {
    if (g.is_partial_revoke) continue;
    const s = scopeRelation(g, req);
    const p = privilegeRelation(g.access_type, req.privilege);
    if (!s || !p) continue;
    matching.push(g);
    if (s === 'contains' && p === 'contains') coverage = 'full';
    else if (!coverage) coverage = 'partial';
  }
  if (!coverage) return { coverage, matching };
  for (const r of grants) {
    if (!r.is_partial_revoke) continue;
    const s = scopeRelation(r, req);
    const p = privilegeRelation(r.access_type, req.privilege);
    if (!s || !p) continue;
    if (s === 'contains' && p === 'contains') return { coverage: null, matching: [] };
    coverage = 'partial';
  }
  return { coverage, matching };
}

// Best coverage across the principal's own grants and each inherited role.
export function coverageOf(eff: EffectiveGrant[], req: AccessRequest): { coverage: Coverage; matching: EffectiveGrant[] } {
  const bySource = new Map<string, EffectiveGrant[]>();
  for (const g of eff) {
    const key = grantSource(g);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(g);
  }
  let best: Coverage = null;
  const matching: EffectiveGrant[] = [];
  for (const grants of bySource.values()) {
    const r = principalCoverage(grants, req);
    if (r.coverage === 'full') best = 'full';
    else if (r.coverage === 'partial' && !best) best = 'partial';
    matching.push(...(r.matching as EffectiveGrant[]));
  }
  return { coverage: best, matching };
}

export function grantScope(g: Pick<CHGrant, 'database' | 'table' | 'column'> & { is_wildcard?: number }): string {
  const star = g.is_wildcard ? '*' : '';
  if (!g.database) return '*.*';
  if (!g.table) return `${g.database}${star}.*`;
  return g.column ? `${g.database}.${g.table}${star}(${g.column})` : `${g.database}.${g.table}${star}`;
}

export function scopeDatabase(g: Pick<CHGrant, 'database'>): string {
  return g.database || '*';
}

// A stable description of one privilege line, used to diff permissions
export function grantKey(g: CHGrant): string {
  return `${g.is_partial_revoke ? 'REVOKE ' : ''}${g.access_type} ON ${grantScope(g)}${g.grant_option ? ' WITH GRANT OPTION' : ''}`;
}

// ==================== SQL helpers ====================

export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
}

export function sqlScope(g: Pick<CHGrant, 'database' | 'table'>): string {
  if (!g.database) return '*.*';
  return `${quoteIdent(g.database)}.${g.table ? quoteIdent(g.table) : '*'}`;
}

export function sqlPrivilege(g: Pick<CHGrant, 'access_type' | 'column'>): string {
  return g.column ? `${g.access_type}(${quoteIdent(g.column)})` : g.access_type;
}
