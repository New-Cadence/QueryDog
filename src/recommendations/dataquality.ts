import type { Recommendation, RecommendationProvider, RecommendationSeverity } from './types';

// Tables that have no data quality checks, or are missing checks that
// profiling suggests. Checks are .sql files in the repo, so each
// recommendation gives the files to add. Profiling reads up to 200k rows per
// table, so only the largest tables are profiled on each run.

const API = '/api/dataquality';
const MAX_TABLES = 12;
const CONCURRENCY = 3;

interface CatalogTable { database: string; table: string; engine: string; totalRows: number | null }
// `sql` returns the failing rows: what the check file holds
interface Suggestion { key: string; confidence: 'high' | 'medium' | 'low'; reason: string; exists: boolean; rule: { name?: string } & Record<string, unknown>; sql: string }
interface SuggestResult { database: string; table: string; totalRows: number; suggestions: Suggestion[] }
interface DqState { folder?: string; rules: { database: string; table: string }[] }

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

// Runs `fn` over `items` with at most `limit` in flight
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// A check file in the format the server loads: `-- key: value` headers, then
// SQL returning the failing rows
function checkFile(target: string, s: Suggestion): { name: string; text: string } {
  const r = s.rule as Record<string, unknown>;
  const name = String(r.name || s.key);
  const text = [
    `-- title: ${name}`,
    `-- description: ${s.reason.replace(/\s+/g, ' ')}`,
    `-- table: ${target}`,
    `-- severity: ${r.severity ?? 'warning'}`,
    ...(Number(r.threshold) ? [`-- threshold: ${r.threshold}`] : []),
    s.sql,
  ].join('\n');
  return { name: `${slug(target)}__${slug(name)}.sql`, text };
}

function severityFor(rows: number, hasChecks: boolean): RecommendationSeverity {
  if (hasChecks) return 'low';
  return rows >= 1_000_000 ? 'high' : 'medium';
}

export const dataQualityProvider: RecommendationProvider = {
  category: 'dataquality',
  label: 'Data quality',
  run: async () => {
    const [state, catalog] = await Promise.all([get<DqState>('/state'), get<CatalogTable[]>('/catalog')]);
    if (!state || !catalog) return [];
    const folder = state.folder || "the repo's dataquality folder";
    const checked = new Map<string, number>();
    for (const r of state.rules) checked.set(`${r.database}.${r.table}`, (checked.get(`${r.database}.${r.table}`) || 0) + 1);

    // Unchecked tables first, then the largest
    const candidates = catalog
      .filter(t => (t.totalRows ?? 0) > 0)
      .sort((a, b) => Number(checked.has(`${a.database}.${a.table}`)) - Number(checked.has(`${b.database}.${b.table}`)) || (b.totalRows ?? 0) - (a.totalRows ?? 0))
      .slice(0, MAX_TABLES);

    const results = await mapLimited(candidates, CONCURRENCY, t =>
      get<SuggestResult>(`/suggest/${encodeURIComponent(t.database)}/${encodeURIComponent(t.table)}`));

    const recs: Recommendation[] = [];
    results.forEach((res, i) => {
      if (!res) return;
      const t = candidates[i];
      const target = `${t.database}.${t.table}`;
      const existing = checked.get(target) || 0;
      const missing = res.suggestions.filter(s => !s.exists && s.confidence !== 'low');
      if (!missing.length) return;
      const plural = missing.length === 1 ? 'check' : 'checks';
      const files = missing.map(m => checkFile(target, m));
      recs.push({
        id: `dataquality:${existing ? 'more-checks' : 'no-checks'}:${target}`,
        category: 'dataquality',
        severity: severityFor(res.totalRows, existing > 0),
        title: existing ? `${missing.length} more suggested ${plural} for ${target}` : `No data quality checks on ${target}`,
        detail: existing
          ? `${target} has ${existing} check${existing === 1 ? '' : 's'}, but profiling its data suggests ${missing.length} more.`
          : `${target} (${res.totalRows.toLocaleString()} rows) has no data quality checks, so bad data in it goes unnoticed. Profiling its data suggests ${missing.length} ${plural}.`,
        target,
        remediation: [
          `-- Save each file below in ${folder}`,
          ...files.map(f => `\n-- ===== ${f.name} =====\n${f.text}`),
        ].join('\n'),
        remediationFormat: 'code',
        impact: `${missing.length} ${plural} to add`,
      });
    });
    return recs;
  },
};
