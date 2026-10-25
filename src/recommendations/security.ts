import type { Recommendation, RecommendationProvider, RecommendationSeverity } from './types';
import {
  loadSecurityData, authTypes, hostSummary, isAnyHost, effectiveGrants, ownGrants, isDangerous,
  quoteIdent, sqlScope, sqlPrivilege, grantSource, type SecurityData, type CHGrant,
} from '../components/security/model';
import { loadLoginStats, displayAddress, INACTIVE_DAYS, FAILED_LOGIN_THRESHOLD, type LoginStats } from '../components/security/activity';

function rec(kind: string, target: string, severity: RecommendationSeverity, title: string, detail: string, remediation: string, impact?: string): Recommendation {
  return { id: `security:${kind}:${target}`, category: 'security', severity, title, detail, target, remediation, impact };
}

// Group grant rows into one GRANT/REVOKE statement per scope
function grantStatements(verb: 'GRANT' | 'REVOKE', grants: CHGrant[], principal: string, suffix = ''): string[] {
  const byScope = new Map<string, string[]>();
  for (const g of grants) {
    const scope = sqlScope(g);
    if (!byScope.has(scope)) byScope.set(scope, []);
    const priv = sqlPrivilege(g);
    if (!byScope.get(scope)!.includes(priv)) byScope.get(scope)!.push(priv);
  }
  const prep = verb === 'GRANT' ? 'TO' : 'FROM';
  return [...byScope].map(([scope, privs]) => `${verb} ${suffix}${privs.join(', ')} ON ${scope} ${prep} ${quoteIdent(principal)}`);
}

// Findings derived from users, roles and grants
function accessFindings(data: SecurityData): Recommendation[] {
  const out: Recommendation[] = [];
  for (const user of data.users) {
    const name = user.name;
    const u = quoteIdent(name);
    const types = authTypes(user);
    const hosts = hostSummary(user);
    const xmlUser = user.storage === 'users_xml';
    const eff = effectiveGrants({ kind: 'user', name }, data).filter(g => !g.is_partial_revoke);
    const direct = ownGrants({ kind: 'user', name }, data.grants).filter(g => !g.is_partial_revoke);
    const globalDangerous = eff.filter(g => !g.database && isDangerous(g.access_type));

    if (types.includes('no_password')) {
      out.push(rec('no-password', name, 'critical', 'User has no password',
        `${name} authenticates with no_password and can connect from ${hosts}. Anyone who can reach the server can log in as this user.`,
        xmlUser
          ? `Set <password_sha256_hex> for ${name} in users.xml (users_xml storage cannot be changed with SQL).`
          : `ALTER USER ${u} IDENTIFIED WITH sha256_password BY '<new password>'`,
        'Prevents unauthenticated access'));
    }
    if (types.includes('plaintext_password')) {
      out.push(rec('plaintext-password', name, 'medium', 'Password stored in plaintext',
        `${name}'s password is kept in plaintext in the ${xmlUser ? 'users.xml configuration' : 'access storage'}.`,
        xmlUser
          ? `Replace <password> with <password_sha256_hex> for ${name} in users.xml.`
          : `ALTER USER ${u} IDENTIFIED WITH sha256_password BY '<new password>'`));
    }
    if (globalDangerous.length > 0) {
      const privs = [...new Set(globalDangerous.map(g => g.access_type))];
      const viaRoles = [...new Set(globalDangerous.filter(g => g.via.length).map(grantSource))];
      const directDangerous = globalDangerous.filter(g => !g.via.length);
      out.push(rec('global-destructive', name, name === 'default' ? 'medium' : 'high', 'Destructive privileges on *.*',
        `${name} holds ${privs.join(', ')} on every database${viaRoles.length ? ` (via role ${viaRoles.join(', ')})` : ''}.`,
        xmlUser
          ? `Restrict ${name} in users.xml (remove access_management, assign a readonly profile) and use scoped SQL users for applications.`
          : [
            ...grantStatements('REVOKE', directDangerous, name),
            ...viaRoles.map(r => `-- or scope the grants of role ${r}`),
            `-- then grant only what is needed, e.g. GRANT SELECT ON <db>.* TO ${u}`,
          ].join(';\n')));
      if (isAnyHost(user)) {
        out.push(rec('any-host-privileged', name, 'high', 'Privileged user reachable from any host',
          `${name} has destructive privileges and no network restriction (HOST ANY).`,
          xmlUser ? `Restrict <networks> for ${name} in users.xml.` : `ALTER USER ${u} HOST IP '10.0.0.0/8'`));
      }
    }
    if (direct.length > 0 && name !== 'default') {
      const role = quoteIdent(`${name}_role`);
      out.push(rec('direct-grants', name, 'low', 'Privileges granted directly to user',
        `${direct.length} grant${direct.length === 1 ? '' : 's'} bypass roles, which makes access harder to audit.`,
        [`CREATE ROLE ${role}`, ...grantStatements('GRANT', direct, `${name}_role`), `GRANT ${role} TO ${u}`, ...grantStatements('REVOKE', direct, name)].join(';\n')));
    }
    const withOption = eff.filter(g => g.grant_option);
    if (withOption.length > 0 && name !== 'default') {
      const byPrincipal = new Map<string, CHGrant[]>();
      for (const g of withOption) {
        const p = g.via.length ? grantSource(g) : name;
        if (!byPrincipal.has(p)) byPrincipal.set(p, []);
        byPrincipal.get(p)!.push(g);
      }
      out.push(rec('grant-option', name, 'medium', 'Can re-grant privileges (WITH GRANT OPTION)',
        `${name} can delegate ${withOption.length} privilege${withOption.length === 1 ? '' : 's'} to other users and roles.`,
        [...byPrincipal].flatMap(([p, gs]) => grantStatements('REVOKE', gs, p, 'GRANT OPTION FOR ')).join(';\n')));
    }
    if (eff.length === 0) {
      out.push(rec('no-privileges', name, 'low', 'User has no privileges',
        `${name} has no direct grants and no roles. The account may be unused.`,
        `DROP USER IF EXISTS ${u}`));
    }
  }
  for (const role of data.roles) {
    if (!data.roleGrants.some(rg => rg.granted_role_name === role.name)) {
      out.push(rec('orphan-role', role.name, 'low', 'Role is not granted to anyone',
        `Role ${role.name} has no members.`, `DROP ROLE IF EXISTS ${quoteIdent(role.name)}`));
    }
  }
  return out;
}

// Findings derived from system.session_log
function loginFindings(data: SecurityData, logins: LoginStats): Recommendation[] {
  const out: Recommendation[] = [];
  for (const f of logins.recentFailures) {
    if (f.failures < FAILED_LOGIN_THRESHOLD) continue;
    const exists = data.users.some(u => u.name === f.user);
    const addrs = f.addresses.map(displayAddress);
    out.push(rec('failed-logins', f.user || '(unknown)', f.failures >= 20 ? 'high' : 'medium', 'Repeated failed logins',
      `${f.failures} failed logins in the last 24h for ${exists ? 'user' : 'non-existent user'} ${f.user || '(unknown)'} from ${addrs.join(', ')}.`,
      exists
        ? `Check the clients at ${addrs.join(', ')}; if they are not yours restrict the user: ALTER USER ${quoteIdent(f.user)} HOST IP '<trusted network>'`
        : `Block ${addrs.join(', ')} at the network layer if the attempts are not expected.`,
      'Possible brute force or misconfigured client'));
  }
  // Only claim inactivity when the log reaches back far enough to know
  if (logins.daysCovered >= INACTIVE_DAYS) {
    const last = new Map(logins.lastLogins.map(l => [l.user, l]));
    for (const user of data.users) {
      if (user.name === 'default') continue;
      const l = last.get(user.name);
      if (l && l.days_since < INACTIVE_DAYS) continue;
      out.push(rec('inactive-user', user.name, 'low', `No login in ${INACTIVE_DAYS}+ days`,
        l ? `${user.name} last logged in ${l.days_since} days ago (${l.last_login}).` : `${user.name} has not logged in during the ${logins.daysCovered} days covered by session_log.`,
        `DROP USER IF EXISTS ${quoteIdent(user.name)}  -- or ALTER USER ${quoteIdent(user.name)} HOST NONE to disable it`));
    }
  }
  return out;
}

const SEVERITY_ORDER: RecommendationSeverity[] = ['critical', 'high', 'medium', 'low'];

export function buildSecurityRecommendations(data: SecurityData, logins: LoginStats | null): Recommendation[] {
  return [...accessFindings(data), ...(logins ? loginFindings(data, logins) : [])]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

const SCORE_PENALTY: Record<RecommendationSeverity, number> = { critical: 25, high: 12, medium: 5, low: 1 };

export function securityScore(recs: Recommendation[]): number {
  return Math.max(0, 100 - recs.reduce((s, r) => s + SCORE_PENALTY[r.severity], 0));
}

// Worst severity per target, used to rate users on the Security page
export function worstSeverityByTarget(recs: Recommendation[]): Map<string, RecommendationSeverity> {
  const out = new Map<string, RecommendationSeverity>();
  for (const r of recs) {
    if (!r.target || r.id.startsWith('security:orphan-role:')) continue;
    const prev = out.get(r.target);
    if (!prev || SEVERITY_ORDER.indexOf(r.severity) < SEVERITY_ORDER.indexOf(prev)) out.set(r.target, r.severity);
  }
  return out;
}

export const securityProvider: RecommendationProvider = {
  category: 'security',
  label: 'Security',
  run: async () => {
    try {
      const [data, logins] = await Promise.all([loadSecurityData(), loadLoginStats()]);
      return buildSecurityRecommendations(data, logins);
    } catch {
      return [];
    }
  },
};
