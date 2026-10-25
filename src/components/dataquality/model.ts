// Data Quality model and API helper (server side lives in
// server/extensions/dataquality.js).
import { useCallback, useEffect, useState } from 'react';
import {
  CircleSlash, Fingerprint, ListChecks, Regex, Ruler, TextCursorInput, Clock, Rows3, Link2, Code2, type LucideIcon,
} from 'lucide-react';

// ==================== Model ====================

export type RuleType =
  | 'not_null' | 'unique' | 'accepted_values' | 'regex' | 'range' | 'length'
  | 'freshness' | 'row_count' | 'referential' | 'custom_sql';
export type { Severity } from '../checks/model';
import type { Severity } from '../checks/model';
import type { ClientFilterField } from '../../hooks/useClientFilters';
export type RunStatus = 'pass' | 'fail' | 'error';
export type CustomMode = 'rows' | 'count' | 'boolean';

export interface RuleParams {
  treatEmptyAsNull?: boolean;
  values?: string[];
  pattern?: string;
  min?: number | null;
  max?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  maxAgeMinutes?: number;
  maxChangePct?: number | null;
  refDatabase?: string;
  refTable?: string;
  refColumn?: string;
  sql?: string;
  mode?: CustomMode;
}

export interface RuleDraft {
  name: string;
  description: string;
  type: RuleType;
  database: string;
  table: string;
  column: string | null;
  columns: string[];
  params: RuleParams;
  where: string;
  severity: Severity;
  // From the file's `-- category:` header
  category?: string;
  threshold: number;
  tags: string[];
}

export interface RunSummary {
  id: string;
  ruleId: string;
  time: string;
  environment: string;
  trigger: 'manual' | 'scheduled';
  status: RunStatus;
  total: number | null;
  failing: number | null;
  failurePct: number | null;
  compliance: number | null;
  detail: string | null;
  metric: Record<string, unknown> | null;
  error: string | null;
  duration: number;
  queryId: string | null;
  sampleRows: number;
  sampleError?: string;
}

export interface Run extends Omit<RunSummary, 'sampleRows'> {
  sample: Record<string, unknown>[];
  sampleColumns: string[];
  sampleTrimmed?: boolean;
  sql: string | null;
}

export interface HistoryPoint { time: string; status: RunStatus; compliance: number | null; failing: number | null; total: number | null }

export interface Rule extends RuleDraft {
  id: string;
  // The .sql file the check was loaded from
  file?: string;
  createdAt: string;
  updatedAt: string;
  lastRun: RunSummary | null;
  history: HistoryPoint[];
}

export interface TrendDay { day: string; pass: number; fail: number; error: number; score: number | null; compliance: number | null }

export interface DqState {
  environment: string;
  // Repo folder the checks' .sql files are loaded from, and files that failed to parse
  folder?: string;
  fileErrors?: { file: string; error: string }[];
  running: string[];
  trend: TrendDay[];
  rules: Rule[];
}

export interface RunRow extends RunSummary {
  ruleName: string;
  type: RuleType;
  database: string;
  table: string;
  column: string | null;
  severity: Severity;
}

export interface CatalogTable { database: string; table: string; engine: string; totalRows: number | null }
export interface CatalogColumn { name: string; type: string; primaryKey: boolean }

export interface ProfileColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  nullRate: number;
  emptyRate: number | null;
  distinct: number | null;
  min: number | null;
  max: number | null;
  latest: string | null;
  ageSeconds: number | null;
  values: string[] | null;
}

export interface Suggestion { key: string; confidence: 'high' | 'medium' | 'low'; reason: string; exists: boolean; rule: RuleDraft }

export interface SuggestResult {
  database: string;
  table: string;
  totalRows: number;
  sampledRows: number;
  columns: ProfileColumn[];
  suggestions: Suggestion[];
}

export interface Preview { name: string; check: string; sample: string | null; total: string | null }

// Shared actions the tabs call back into the page with.
export interface DqActions {
  act: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  runRules: (target: { ids?: string[]; database?: string; table?: string }, label: string) => Promise<void>;
  openRule: (id: string) => void;
  openRun: (id: string) => void;
  // Suggested checks live in the Recommendations mode
  openRecommendations: () => void;
  openDataset: (database: string, table: string) => void;
  isRunning: (id: string) => boolean;
}

// ==================== API ====================

export const API = '/api/dataquality';
export const POLL_MS = 10000;

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

// Close overlays on Escape.
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

// GET a resource, refetching whenever `version` changes.
export function useFetched<T>(url: string, version: string) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const key = `${url}|${version}`;
  useEffect(() => {
    let cancelled = false;
    api<T>('GET', url)
      .then(data => { if (!cancelled) setState({ key, data, error: null }); })
      .catch(e => { if (!cancelled) setState({ key, data: null, error: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [url, key]);
  // Keep showing the previous data while a newer version loads
  return { data: state?.data ?? null, error: state?.error ?? null, loading: state?.key !== key };
}

// Tables the rule editor and suggestions can target (system databases
// excluded), reloaded when the environment changes.
export function useCatalog(environment: string) {
  const [tables, setTables] = useState<CatalogTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<CatalogTable[]>('GET', '/catalog')
      .then(t => { if (!cancelled) { setTables(t); setError(null); } })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [version, environment]);
  const reload = useCallback(() => setVersion(v => v + 1), []);
  return { tables, error, reload };
}

// Columns of one table; null while loading (or when no table is chosen).
export function useColumns(database: string, table: string) {
  const key = database && table ? `${database}.${table}` : '';
  const [loaded, setLoaded] = useState<{ key: string; columns: CatalogColumn[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api<CatalogColumn[]>('GET', `/catalog/${encodeURIComponent(database)}/${encodeURIComponent(table)}`)
      .then(columns => { if (!cancelled) setLoaded({ key, columns, error: null }); })
      .catch(e => { if (!cancelled) setLoaded({ key, columns: [], error: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [key, database, table]);
  const current = loaded?.key === key ? loaded : null;
  return { columns: current?.columns ?? null, error: current?.error ?? null };
}

// ==================== Rule types ====================

export type Dimension = 'Completeness' | 'Uniqueness' | 'Validity' | 'Timeliness' | 'Volume' | 'Consistency' | 'Custom';
export const DIMENSIONS: Dimension[] = ['Completeness', 'Uniqueness', 'Validity', 'Timeliness', 'Volume', 'Consistency', 'Custom'];

export const RULE_TYPES: Record<RuleType, { label: string; icon: LucideIcon; dimension: Dimension; description: string; column: 'one' | 'many' | 'none' }> = {
  not_null: { label: 'Not null', icon: CircleSlash, dimension: 'Completeness', column: 'one', description: 'Share of rows where the column is NULL (or optionally an empty string).' },
  unique: { label: 'Unique', icon: Fingerprint, dimension: 'Uniqueness', column: 'many', description: 'Rows sharing a key with another row. Pick one column or a composite key.' },
  accepted_values: { label: 'Accepted values', icon: ListChecks, dimension: 'Validity', column: 'one', description: 'Values outside an allowed list (compared as text). NULLs are ignored.' },
  regex: { label: 'Pattern match', icon: Regex, dimension: 'Validity', column: 'one', description: 'Values that do not match a regular expression (RE2 syntax, via match()).' },
  range: { label: 'Numeric range', icon: Ruler, dimension: 'Validity', column: 'one', description: 'Numbers below the minimum or above the maximum.' },
  length: { label: 'String length', icon: TextCursorInput, dimension: 'Validity', column: 'one', description: 'Values shorter or longer than the allowed length (UTF-8 characters).' },
  freshness: { label: 'Freshness', icon: Clock, dimension: 'Timeliness', column: 'one', description: 'Fails when the newest timestamp is older than the allowed age.' },
  row_count: { label: 'Row count', icon: Rows3, dimension: 'Volume', column: 'none', description: 'Fails when the row count is outside bounds or changes too much since the previous run.' },
  referential: { label: 'Referential integrity', icon: Link2, dimension: 'Consistency', column: 'one', description: 'Values with no match in another table\'s column (orphaned foreign keys).' },
  custom_sql: { label: 'Custom SQL', icon: Code2, dimension: 'Custom', column: 'none', description: 'Your own read-only SELECT: failing rows, a failing count, or a pass/fail boolean.' },
};


// Row-level checks are scored by failing share and honour the threshold;
// the others are pass/fail on the whole table.
export const isBinaryRule = (r: Pick<RuleDraft, 'type' | 'params'>) =>
  r.type === 'freshness' || r.type === 'row_count' || (r.type === 'custom_sql' && r.params.mode === 'boolean');

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
export { severityTone } from '../checks/model';
export const statusTone: Record<RunStatus, 'green' | 'red' | 'yellow'> = { pass: 'green', fail: 'red', error: 'yellow' };

export const ruleTarget = (r: Pick<RuleDraft, 'type' | 'column' | 'columns'>) => (r.type === 'unique' ? r.columns.join(', ') : r.column || '');
export const datasetKey = (database: string, table: string) => `${database}.${table}`;
export type RuleState = RunStatus | 'never';
export const ruleState = (r: Rule): RuleState => (r.lastRun ? r.lastRun.status : 'never');

// Short, human description of a rule's parameters.
export function describeParams(r: Pick<RuleDraft, 'type' | 'params' | 'threshold'>): string {
  const p = r.params;
  const tol = r.threshold ? ` (allow ${r.threshold}%)` : '';
  switch (r.type) {
    case 'not_null': return `${p.treatEmptyAsNull ? 'no NULL or empty' : 'no NULL'}${tol}`;
    case 'unique': return `no duplicates${tol}`;
    case 'accepted_values': return `in [${(p.values || []).slice(0, 6).join(', ')}${(p.values?.length || 0) > 6 ? ', …' : ''}]${tol}`;
    case 'regex': return `matches /${p.pattern}/${tol}`;
    case 'range': return `${p.min ?? '-∞'} ≤ x ≤ ${p.max ?? '∞'}${tol}`;
    case 'length': return `length ${p.minLength ?? 0}..${p.maxLength ?? '∞'}${tol}`;
    case 'freshness': return `newer than ${formatMinutes(p.maxAgeMinutes || 0)}`;
    case 'row_count': return [
      p.min !== null && p.min !== undefined ? `≥ ${p.min}` : '',
      p.max !== null && p.max !== undefined ? `≤ ${p.max}` : '',
      p.maxChangePct ? `±${p.maxChangePct}% vs last run` : '',
    ].filter(Boolean).join(', ');
    case 'referential': return `in ${p.refDatabase}.${p.refTable}.${p.refColumn}${tol}`;
    case 'custom_sql': return p.mode === 'boolean' ? 'returns true' : p.mode === 'count' ? `count = 0${tol}` : `returns no rows${tol}`;
  }
}

// Severity-weighted share of rules passing (0-100), over rules whose last run
// succeeded. Null when nothing has been evaluated.
export function qualityScore(rules: Rule[]): number | null {
  let weight = 0;
  let passed = 0;
  for (const r of rules) {
    if (!r.lastRun || r.lastRun.status === 'error') continue;
    const w = SEVERITY_WEIGHT[r.severity];
    weight += w;
    if (r.lastRun.status === 'pass') passed += w;
  }
  return weight ? (passed / weight) * 100 : null;
}

// Mean row-level compliance of the latest successful runs.
export function meanCompliance(rules: Rule[]): number | null {
  const values = rules.filter(r => r.lastRun?.compliance !== null && r.lastRun?.compliance !== undefined && r.lastRun.status !== 'error')
    .map(r => r.lastRun!.compliance as number);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export const scoreTone = (score: number | null): 'default' | 'green' | 'yellow' | 'red' =>
  score === null ? 'default' : score >= 95 ? 'green' : score >= 80 ? 'yellow' : 'red';

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value > 99.9 && value < 100) return `${value.toFixed(3).replace(/0+$/, '')}%`;
  return `${value.toFixed(value === 100 || value === 0 ? 0 : digits)}%`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${+(minutes / 60).toFixed(1)}h`;
  return `${+(minutes / 1440).toFixed(1)}d`;
}

export function formatAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const secs = Math.round((now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.max(secs, 0)}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// ==================== Datasets ====================

// One row per database.table with its rules rolled up.
export interface Dataset {
  key: string;
  database: string;
  table: string;
  rules: Rule[];
  pass: number;
  fail: number;
  error: number;
  never: number;
  score: number | null;
  compliance: number | null;
  dimensions: Dimension[];
  lastRun: string | null;
  totalRows: number | null;
  monitored: boolean;
}

export function buildDatasets(rules: Rule[], catalog: CatalogTable[] | null, includeUnmonitored: boolean): Dataset[] {
  const byKey = new Map<string, Rule[]>();
  for (const r of rules) {
    const k = datasetKey(r.database, r.table);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const rowsByKey = new Map((catalog || []).map(t => [datasetKey(t.database, t.table), t.totalRows]));
  const keys = new Set(byKey.keys());
  if (includeUnmonitored) for (const t of catalog || []) keys.add(datasetKey(t.database, t.table));
  return [...keys].map(key => {
    const list = byKey.get(key) || [];
    const sample = list[0];
    const [database, table] = sample ? [sample.database, sample.table] : [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const states = list.map(ruleState);
    const times = list.map(r => r.lastRun?.time).filter((t): t is string => Boolean(t)).sort();
    return {
      key, database, table, rules: list,
      pass: states.filter(s => s === 'pass').length,
      fail: states.filter(s => s === 'fail').length,
      error: states.filter(s => s === 'error').length,
      never: states.filter(s => s === 'never').length,
      score: qualityScore(list),
      compliance: meanCompliance(list),
      dimensions: DIMENSIONS.filter(d => list.some(r => RULE_TYPES[r.type].dimension === d)),
      lastRun: times.at(-1) || null,
      totalRows: rowsByKey.get(key) ?? null,
      monitored: list.length > 0,
    };
  });
}

// Filters and search shared by the Overview and Checks tabs
export const ruleFields: ClientFilterField<Rule>[] = [
  { field: 'status', label: 'Last result', getValue: r => ruleState(r) },
  { field: 'severity', label: 'Severity' },
  { field: 'category', label: 'Category', getValue: r => r.category || 'Uncategorised' },
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table', getValue: r => `${r.database}.${r.table}` },
  { field: 'tags', label: 'Tag', getValue: r => r.tags },
];
export const ruleSearchText = (r: Rule) => `${r.name} ${r.description} ${r.database}.${r.table} ${ruleTarget(r)} ${r.type} ${r.tags.join(' ')}`;
