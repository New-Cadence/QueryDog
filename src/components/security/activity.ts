// Login / session activity from system.session_log, shared by the Logins tab
// and the security recommendation provider.
import { executeQuery } from '../../services/api';

export async function systemTableExists(name: string): Promise<boolean> {
  try {
    const r = await executeQuery(`SELECT count() AS c FROM system.tables WHERE database = 'system' AND name = '${name}'`);
    return Number(r.data[0]?.c) > 0;
  } catch {
    return false;
  }
}

export interface LastLogin { user: string; last_login: string; days_since: number; logins: number }

export interface FailedLogins { user: string; failures: number; addresses: string[]; last_failure: string }

export interface LoginStats {
  // Days of history the session_log holds, so "no login in 30 days" is only
  // claimed when the log actually goes back that far
  daysCovered: number;
  lastLogins: LastLogin[];
  // Failures in the last 24 hours, per user name tried
  recentFailures: FailedLogins[];
}

export const INACTIVE_DAYS = 30;
export const FAILED_LOGIN_THRESHOLD = 5;

// null when session_log is not enabled on this server
export async function loadLoginStats(): Promise<LoginStats | null> {
  if (!(await systemTableExists('session_log'))) return null;
  try {
    const [coverage, last, failures] = await Promise.all([
      executeQuery(`SELECT dateDiff('day', min(event_time), now()) AS days FROM system.session_log`),
      executeQuery(`
        SELECT user, max(event_time) AS last_login, dateDiff('day', max(event_time), now()) AS days_since, count() AS logins
        FROM system.session_log
        WHERE type = 'LoginSuccess' AND user IS NOT NULL
        GROUP BY user
        ORDER BY user
        LIMIT 10000`),
      executeQuery(`
        SELECT user, count() AS failures, groupUniqArray(20)(toString(client_address)) AS addresses, max(event_time) AS last_failure
        FROM system.session_log
        WHERE type = 'LoginFailure' AND event_time >= now() - INTERVAL 1 DAY
        GROUP BY user
        ORDER BY failures DESC
        LIMIT 1000`),
    ]);
    return {
      daysCovered: Number(coverage.data[0]?.days) || 0,
      lastLogins: last.data.map(r => ({ ...r, days_since: Number(r.days_since), logins: Number(r.logins) })) as unknown as LastLogin[],
      recentFailures: failures.data.map(r => ({ ...r, user: r.user ?? '', failures: Number(r.failures) })) as unknown as FailedLogins[],
    };
  } catch {
    return null;
  }
}

// ClickHouse prints IPv4 clients as ::ffff:a.b.c.d; show them as plain IPv4
export function displayAddress(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}
