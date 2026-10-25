import type { Recommendation, RecommendationProvider } from './types';
import { fmtBytes, num, queryRows, sqlString, str, systemTables } from './performance';

// Reliability recommendations: replication health, stuck mutations, detached
// parts, disk space, dictionaries, server errors, Keeper sessions, backups and
// server warnings. Each check only runs when its system table exists.

const GiB = 1024 ** 3;

// Stable short id for free-text keys such as warning messages.
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function replicaChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT database, table, is_readonly, is_session_expired, absolute_delay, queue_size, total_replicas, active_replicas,
      last_queue_update_exception, zookeeper_exception
    FROM system.replicas
    WHERE is_readonly OR is_session_expired OR absolute_delay >= 60 OR queue_size >= 100 OR active_replicas < total_replicas
    LIMIT 50`);
  const recs: Recommendation[] = [];
  for (const r of rows) {
    const table = `${str(r.database)}.${str(r.table)}`;
    const exception = str(r.zookeeper_exception) || str(r.last_queue_update_exception);
    if (num(r.is_readonly) || num(r.is_session_expired)) {
      recs.push({
        id: `reliability:replica-readonly:${table}`,
        category: 'reliability',
        severity: 'critical',
        title: `Replica of ${table} is read-only`,
        detail: `The replica ${num(r.is_session_expired) ? 'has lost its Keeper session' : 'is in read-only mode'}, so inserts into ${table} fail.` +
          (exception ? `\n\nLast exception: ${exception}` : ''),
        target: table,
        impact: 'Inserts rejected on this replica',
        remediation: `-- Check Keeper connectivity, then restart the replica:\nSELECT * FROM system.zookeeper_connection;\nSYSTEM RESTART REPLICA ${table};`,
      });
    }
    const delay = num(r.absolute_delay);
    if (delay >= 60 || num(r.queue_size) >= 100) {
      recs.push({
        id: `reliability:replica-lag:${table}`,
        category: 'reliability',
        severity: delay >= 300 ? 'high' : 'medium',
        title: `Replica of ${table} is lagging`,
        detail: `Absolute delay is ${delay}s with ${num(r.queue_size)} entries in the replication queue. Reads from this replica may return stale data.`,
        target: table,
        impact: `${delay}s behind`,
        remediation: `-- See what the replication queue is stuck on:\nSELECT type, create_time, num_tries, last_exception, postpone_reason\nFROM system.replication_queue\nWHERE database = ${sqlString(str(r.database))} AND table = ${sqlString(str(r.table))}\nORDER BY create_time LIMIT 20;`,
      });
    }
    if (num(r.active_replicas) < num(r.total_replicas)) {
      recs.push({
        id: `reliability:replica-inactive:${table}`,
        category: 'reliability',
        severity: 'high',
        title: `${num(r.total_replicas) - num(r.active_replicas)} inactive replica(s) of ${table}`,
        detail: `Only ${num(r.active_replicas)} of ${num(r.total_replicas)} replicas are active. Data is less redundant and the inactive replicas' replication logs keep growing in Keeper.`,
        target: table,
        impact: 'Reduced redundancy',
        remediation: `SELECT replica_name, is_active FROM system.zookeeper\nWHERE path = (SELECT concat(zookeeper_path, '/replicas') FROM system.replicas WHERE database = ${sqlString(str(r.database))} AND table = ${sqlString(str(r.table))});\n\n-- If a replica is permanently gone:\n-- SYSTEM DROP REPLICA '<replica_name>' FROM TABLE ${table};`,
      });
    }
  }
  return recs;
}

async function mutationChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT database, table, mutation_id, command, toString(create_time) AS created, parts_to_do, latest_fail_reason,
      dateDiff('minute', create_time, now()) AS age_min
    FROM system.mutations
    WHERE is_done = 0 AND NOT is_killed AND (create_time < now() - INTERVAL 15 MINUTE OR latest_fail_reason != '')
    ORDER BY create_time
    LIMIT 30`);
  return rows.map(r => {
    const table = `${str(r.database)}.${str(r.table)}`;
    const failing = str(r.latest_fail_reason) !== '';
    return {
      id: `reliability:stuck-mutation:${table}:${str(r.mutation_id)}`,
      category: 'reliability' as const,
      severity: failing ? 'high' : 'medium',
      title: failing ? `Mutation failing on ${table}` : `Mutation stuck on ${table} for ${Math.round(num(r.age_min) / 60 * 10) / 10}h`,
      detail: `Mutation ${str(r.mutation_id)} (created ${str(r.created)}) still has ${num(r.parts_to_do)} part(s) to process.\n\nCommand: ${str(r.command)}` +
        (failing ? `\n\nLatest failure: ${str(r.latest_fail_reason)}` : '') +
        '\n\nLater mutations on the same table queue behind it.',
      target: table,
      impact: failing ? 'Blocks later mutations; retries forever' : 'Holds back later mutations',
      remediation: `KILL MUTATION WHERE database = ${sqlString(str(r.database))} AND table = ${sqlString(str(r.table))} AND mutation_id = ${sqlString(str(r.mutation_id))};`,
    };
  });
}

async function detachedPartChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT database, table, reason, count() AS parts, sum(bytes_on_disk) AS bytes, groupArray(5)(name) AS names
    FROM system.detached_parts
    WHERE database IS NOT NULL
    GROUP BY database, table, reason
    ORDER BY bytes DESC
    LIMIT 30`);
  return rows.map(r => {
    const table = `${str(r.database)}.${str(r.table)}`;
    const reason = str(r.reason);
    const broken = /broken|unexpected|covered-by-broken|noquorum/.test(reason);
    const names = (r.names as string[]) || [];
    return {
      id: `reliability:detached-parts:${table}:${reason || 'manual'}`,
      category: 'reliability' as const,
      severity: broken ? 'high' : 'low',
      title: broken ? `Broken parts detached from ${table}` : `Detached parts left on disk for ${table}`,
      detail: `${num(r.parts)} detached part(s) (${fmtBytes(num(r.bytes))}) with reason "${reason || 'detached manually'}".` +
        (broken ? ' ClickHouse detached these because they failed checks: data in them is not visible to queries.' : ' They take disk space but are not queried.'),
      target: table,
      impact: broken ? 'Possible data loss' : `${fmtBytes(num(r.bytes))} of disk`,
      remediation: (broken
        ? `-- Inspect, and re-attach if the data is valid:\nALTER TABLE ${table} ATTACH PART ${sqlString(names[0] || '<part>')};\n\n`
        : '') +
        `-- Remove once no longer needed:\n` +
        names.map(n => `ALTER TABLE ${table} DROP DETACHED PART ${sqlString(n)} SETTINGS allow_drop_detached = 1;`).join('\n'),
    };
  });
}

async function diskChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT name, path, free_space, total_space, is_broken
    FROM system.disks
    WHERE total_space > 0 AND NOT is_remote AND (is_broken OR free_space < 0.2 * total_space)
    LIMIT 20`);
  return rows.map(r => {
    const free = num(r.free_space) / Math.max(num(r.total_space), 1);
    const broken = !!num(r.is_broken);
    return {
      id: `reliability:disk:${str(r.name)}`,
      category: 'reliability' as const,
      severity: broken || free < 0.1 ? 'critical' : 'high',
      title: broken ? `Disk ${str(r.name)} is broken` : `Disk ${str(r.name)} is ${(100 - free * 100).toFixed(0)}% full`,
      detail: broken
        ? `Disk ${str(r.name)} (${str(r.path)}) is marked broken; parts on it cannot be read.`
        : `Only ${(num(r.free_space) / GiB).toFixed(1)} GiB of ${(num(r.total_space) / GiB).toFixed(1)} GiB is free on ${str(r.name)} (${str(r.path)}). ` +
          'Merges need free space for their output and stop when the disk is full, after which inserts fail with TOO_MANY_PARTS or NOT_ENOUGH_SPACE.',
      target: str(r.name),
      impact: broken ? 'Data unavailable' : `${(free * 100).toFixed(0)}% free`,
      remediation: `-- Largest tables on this disk:\nSELECT database, table, sum(bytes_on_disk) AS bytes FROM system.parts\nWHERE active AND disk_name = ${sqlString(str(r.name))}\nGROUP BY database, table ORDER BY bytes DESC LIMIT 20;\n\n` +
        '-- Free space with a TTL, by dropping old partitions, or add a volume to the storage policy.',
    };
  });
}

async function dictionaryChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT database, name, toString(status) AS status, last_exception
    FROM system.dictionaries
    WHERE status IN ('FAILED', 'FAILED_AND_RELOADING') OR last_exception != ''
    LIMIT 30`);
  return rows.map(r => {
    const name = str(r.database) ? `${str(r.database)}.${str(r.name)}` : str(r.name);
    return {
      id: `reliability:dictionary:${name}`,
      category: 'reliability' as const,
      severity: 'high',
      title: `Dictionary ${name} failed to load`,
      detail: `Status ${str(r.status)}. Queries using dictGet on it fail or read stale data.\n\nLast exception: ${str(r.last_exception)}`,
      target: name,
      impact: 'dictGet queries fail',
      remediation: `-- Fix the source, then:\nSYSTEM RELOAD DICTIONARY ${name};`,
    };
  });
}

// Errors that point at server / infrastructure trouble rather than bad user SQL.
const SERIOUS_ERRORS = [
  'MEMORY_LIMIT_EXCEEDED', 'CANNOT_ALLOCATE_MEMORY', 'NOT_ENOUGH_SPACE', 'TOO_MANY_PARTS', 'CHECKSUM_DOESNT_MATCH',
  'CORRUPTED_DATA', 'CANNOT_READ_ALL_DATA', 'KEEPER_EXCEPTION', 'NO_ZOOKEEPER', 'TABLE_IS_READ_ONLY', 'NETWORK_ERROR',
  'SOCKET_TIMEOUT', 'ALL_CONNECTION_TRIES_FAILED', 'ALL_REPLICAS_ARE_STALE', 'REPLICA_IS_ALREADY_ACTIVE',
  'TOO_MANY_SIMULTANEOUS_QUERIES', 'TIMEOUT_EXCEEDED', 'S3_ERROR', 'CANNOT_WRITE_TO_FILE_DESCRIPTOR', 'POCO_EXCEPTION', 'LOGICAL_ERROR',
];

async function errorChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT name, code, value, toString(last_error_time) AS last_time, last_error_message
    FROM system.errors
    WHERE last_error_time >= now() - INTERVAL 1 HOUR AND remote = 0 AND name IN (${SERIOUS_ERRORS.map(sqlString).join(', ')})
    ORDER BY value DESC
    LIMIT 20`);
  return rows.map(r => {
    const count = num(r.value);
    const name = str(r.name);
    return {
      id: `reliability:error:${name}`,
      category: 'reliability' as const,
      severity: name === 'LOGICAL_ERROR' || name === 'CORRUPTED_DATA' || name === 'CHECKSUM_DOESNT_MATCH' ? 'high' : count >= 100 ? 'medium' : 'low',
      title: `${name} errors on the server`,
      detail: `${count.toLocaleString()} ${name} errors since server start, the latest at ${str(r.last_time)}.\n\nLast message: ${str(r.last_error_message)}`,
      target: 'server',
      impact: `${count.toLocaleString()} occurrences`,
      remediation: `-- Recent queries that hit this error:\nSELECT event_time, user, query_id, exception FROM system.query_log\nWHERE event_time >= now() - INTERVAL 1 HOUR AND exception_code = ${num(r.code)}\nORDER BY event_time DESC LIMIT 20;`,
    };
  });
}

async function keeperChecks(tables: Set<string>): Promise<Recommendation[]> {
  const replicated = await queryRows("SELECT count() AS c FROM system.tables WHERE engine LIKE 'Replicated%' LIMIT 1");
  if (!num(replicated[0]?.c)) return [];
  const rows = tables.has('zookeeper_connection')
    ? await queryRows('SELECT name, host, port, is_expired, session_uptime_elapsed_seconds AS uptime FROM system.zookeeper_connection LIMIT 10')
    : [];
  const recs: Recommendation[] = [];
  if (!rows.length) {
    recs.push({
      id: 'reliability:keeper:no-session',
      category: 'reliability',
      severity: 'critical',
      title: 'No Keeper session while replicated tables exist',
      detail: `${num(replicated[0].c)} Replicated*MergeTree table(s) exist but there is no active ZooKeeper / ClickHouse Keeper connection, so they are read-only.`,
      target: 'keeper',
      impact: 'Replicated inserts fail',
      remediation: "-- Check the <zookeeper> section of the server config and Keeper availability, then:\nSELECT * FROM system.zookeeper_connection;",
    });
  }
  for (const r of rows) {
    if (!num(r.is_expired) && num(r.uptime) >= 600) continue;
    recs.push({
      id: `reliability:keeper:${str(r.name)}`,
      category: 'reliability',
      severity: num(r.is_expired) ? 'critical' : 'medium',
      title: num(r.is_expired) ? 'Keeper session expired' : 'Keeper session recently re-established',
      detail: num(r.is_expired)
        ? `The session to ${str(r.host)}:${str(r.port)} has expired; replicated tables go read-only until it reconnects.`
        : `The session to ${str(r.host)}:${str(r.port)} is only ${num(r.uptime)}s old, suggesting a recent disconnect.`,
      target: `${str(r.host)}:${str(r.port)}`,
      impact: 'Replicated tables may go read-only',
      remediation: "SELECT event_time, message FROM system.text_log\nWHERE logger_name LIKE '%ZooKeeper%' AND event_time >= now() - INTERVAL 1 HOUR\nORDER BY event_time DESC LIMIT 50;",
    });
  }
  return recs;
}

async function backupChecks(tables: Set<string>): Promise<Recommendation[]> {
  // ClickHouse Cloud takes backups outside of SQL, so they never show up here.
  const [shared, data] = await Promise.all([
    queryRows("SELECT count() AS c FROM system.tables WHERE engine LIKE 'Shared%' LIMIT 1"),
    queryRows("SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') LIMIT 1"),
  ]);
  if (num(shared[0]?.c) || num(data[0]?.bytes) < 100 * 1024 ** 2) return [];

  const source = tables.has('backup_log') ? 'system.backup_log' : 'system.backups';
  const [latest, uptime] = await Promise.all([
    queryRows(`SELECT toString(max(end_time)) AS last, countIf(end_time >= now() - INTERVAL 7 DAY) AS recent FROM ${source} WHERE status = 'BACKUP_CREATED' LIMIT 1`),
    queryRows("SELECT toUInt64(value) AS v FROM system.asynchronous_metrics WHERE metric = 'Uptime' LIMIT 1"),
  ]);
  if (num(latest[0]?.recent)) return [];
  // system.backups only covers the current process; don't flag a fresh restart.
  if (source === 'system.backups' && num(uptime[0]?.v) < 7 * 86400) return [];
  const last = str(latest[0]?.last);
  const hasLast = last && !last.startsWith('1970');
  return [{
    id: 'reliability:no-recent-backup',
    category: 'reliability',
    severity: 'high',
    title: 'No backup in the last 7 days',
    detail: (hasLast ? `The last successful backup finished at ${last}.` : `No successful backup is recorded in ${source}.`) +
      ` ${(num(data[0]?.bytes) / GiB).toFixed(1)} GiB of table data would be unrecoverable after accidental deletion or disk loss.`,
    target: 'server',
    impact: 'No point-in-time recovery',
    remediation: "-- Configure a backups disk or S3 bucket, then e.g.:\nBACKUP DATABASE <db> TO Disk('backups', '<db>-' || toString(today()) || '.zip');\n-- or\nBACKUP DATABASE <db> TO S3('https://<bucket>.s3.amazonaws.com/backups/<db>', '<key>', '<secret>');",
  }];
}

async function warningChecks(): Promise<Recommendation[]> {
  const rows = await queryRows('SELECT message, toString(message_format_string) AS fmt FROM system.warnings LIMIT 50');
  return rows.map(r => {
    const message = str(r.message);
    return {
      id: `reliability:warning:${hashText(str(r.fmt) || message)}`,
      category: 'reliability' as const,
      severity: /memory|disk|space|swap|corrupt/i.test(message) ? 'medium' : 'low',
      title: 'Server warning',
      detail: message,
      target: 'server',
      remediation: 'Server warnings come from configuration or environment checks at startup; address the condition and restart. Current list:\nSELECT message FROM system.warnings;',
    };
  });
}

export const reliabilityProvider: RecommendationProvider = {
  category: 'reliability',
  label: 'Reliability',
  run: async () => {
    const tables = await systemTables();
    const checks: [string, () => Promise<Recommendation[]>][] = [
      ['replicas', replicaChecks],
      ['mutations', mutationChecks],
      ['detached_parts', detachedPartChecks],
      ['disks', diskChecks],
      ['dictionaries', dictionaryChecks],
      ['errors', errorChecks],
      ['warnings', warningChecks],
      ['replicas', () => keeperChecks(tables)],
      ['parts', () => backupChecks(tables)],
    ];
    const results = await Promise.all(
      checks.filter(([table]) => tables.has(table)).map(([, check]) => check().catch(() => [])),
    );
    return results.flat();
  },
};
