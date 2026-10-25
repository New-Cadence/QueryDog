import { executeQuery } from '../services/api';
import type { Recommendation, RecommendationProvider, RecommendationSeverity } from './types';

// Undocumented tables and columns, ranked by how often they are queried so
// documentation effort goes where people actually look.

const ident = (s: string) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

async function safeRows<T>(sql: string): Promise<T[]> {
  try {
    return (await executeQuery(sql, 100000)).data as T[];
  } catch {
    return [];
  }
}

interface TableRow {
  database: string;
  name: string;
  engine: string;
  comment: string;
  columns: number;
  undocumented: string[];
}

const MAX_COLUMNS_IN_SQL = 20;

// 7-day query counts per 'db.table', empty when query_log is missing.
async function queryCounts(): Promise<Map<string, number>> {
  const rows = await safeRows<{ t: string; q: number }>(`
    SELECT arrayJoin(tables) AS t, count() AS q FROM system.query_log
    WHERE event_date >= today() - 7 AND event_time >= now() - INTERVAL 7 DAY AND type = 'QueryFinish' AND is_initial_query
    GROUP BY t LIMIT 100000`);
  return new Map(rows.map(r => [r.t, Number(r.q)]));
}

function severityFor(queries: number): RecommendationSeverity {
  if (queries >= 1000) return 'high';
  if (queries >= 50) return 'medium';
  return 'low';
}

const usageNote = (queries: number | undefined) =>
  queries === undefined ? undefined : queries > 0 ? `Queried ${queries.toLocaleString()} times in the last 7 days` : 'Not queried in the last 7 days';

export const documentationProvider: RecommendationProvider = {
  category: 'documentation',
  label: 'Documentation',
  run: async () => {
    const [tables, counts] = await Promise.all([
      safeRows<TableRow>(`
        SELECT t.database AS database, t.name AS name, t.engine AS engine, t.comment AS comment,
          toUInt32(c.columns) AS columns, c.undocumented AS undocumented
        FROM system.tables t
        LEFT JOIN (
          SELECT database, table, count() AS columns, groupArrayIf(name, comment = '') AS undocumented
          FROM system.columns GROUP BY database, table
        ) c ON c.database = t.database AND c.table = t.name
        WHERE t.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
          AND NOT t.is_temporary AND NOT startsWith(t.name, '.inner')
        LIMIT 20000`),
      queryCounts(),
    ]);
    const hasUsage = counts.size > 0;

    const recs: Recommendation[] = [];
    for (const t of tables) {
      const id = `${t.database}.${t.name}`;
      const queries = hasUsage ? counts.get(id) || 0 : undefined;
      const target = `${ident(t.database)}.${ident(t.name)}`;

      if (!t.comment) {
        recs.push({
          id: `documentation:table-comment:${id}`,
          category: 'documentation',
          severity: severityFor(queries || 0),
          title: `Table ${id} has no description`,
          detail: 'Add a COMMENT so people browsing the Data Dictionary know what this table contains, who owns it and how it is populated.',
          target: id,
          remediation: `ALTER TABLE ${target} MODIFY COMMENT '<what this table contains, owner, refresh cadence>';`,
          impact: usageNote(queries),
        });
      }

      // Dictionaries and materialized views don't accept COMMENT COLUMN
      const undocumented = t.undocumented || [];
      if (undocumented.length && !['Dictionary', 'MaterializedView'].includes(t.engine)) {
        const shown = undocumented.slice(0, MAX_COLUMNS_IN_SQL);
        recs.push({
          id: `documentation:column-comments:${id}`,
          category: 'documentation',
          severity: severityFor(queries || 0) === 'high' ? 'medium' : 'low',
          title: `${undocumented.length} of ${t.columns} columns undocumented in ${id}`,
          detail: `Columns without a COMMENT: ${undocumented.slice(0, 10).join(', ')}${undocumented.length > 10 ? ', ...' : ''}.`,
          target: id,
          remediation:
            `ALTER TABLE ${target}\n` +
            shown.map(c => `  COMMENT COLUMN ${ident(c)} '<description>'`).join(',\n') + ';' +
            (undocumented.length > shown.length ? `\n-- ...and ${undocumented.length - shown.length} more columns` : ''),
          impact: usageNote(queries),
        });
      }
    }
    return recs;
  },
};
