// Types, defaults, presets and persistence for the (simulated) load tester.

export type LoadPattern = 'constant' | 'ramp' | 'step' | 'spike' | 'soak';

export const PATTERNS: { id: LoadPattern; hint: string }[] = [
  { id: 'constant', hint: 'Ramp up, then hold at the target VUs' },
  { id: 'ramp', hint: 'Linear climb from 1 to the target VUs over the whole run' },
  { id: 'step', hint: 'Five equal steps up to the target VUs' },
  { id: 'spike', hint: '15% baseline with a burst to the target VUs in the middle 20%' },
  { id: 'soak', hint: 'Ramp up, then hold for a long run to expose slow degradation' },
];

// Patterns whose curve uses the ramp-up setting
export const usesRampUp = (p: LoadPattern) => p === 'constant' || p === 'soak';

// One query in a scenario's mix, with its optional per-query SLO
export interface MixEntry {
  name: string;
  sql: string;
  weight: number;
  enabled: boolean;
  p95TargetMs: number | null;
  errorBudgetPct: number | null;
}

export interface Scenario {
  name: string;
  pattern: LoadPattern;
  virtualUsers: number;
  durationSec: number;
  rampUpSec: number;
  thinkTimeMs: number;
  maxQps: number;
  // Notional number of queries the simulated cluster runs concurrently before queueing
  capacity: number;
  p95ThresholdMs: number;
  errorThresholdPct: number;
  mix: MixEntry[];
}

// A saved .sql file from /api/my-queries
export interface PoolQuery {
  name: string;
  sql: string;
  avgRunTime: number | null;
  slowestRunTime: number | null;
  runCount: number;
}

export type CalibrationSource = 'query_log' | 'saved_runs' | 'estimate';

export const SOURCE_LABEL: Record<CalibrationSource, { label: string; tone: 'green' | 'blue' | 'default' }> = {
  query_log: { label: 'query_log', tone: 'green' },
  saved_runs: { label: 'saved runs', tone: 'blue' },
  estimate: { label: 'estimate', tone: 'default' },
};

// Unloaded latency profile for one query, used to shape the simulated samples
export interface Calibration {
  p50Ms: number;
  p95Ms: number;
  errorPct: number;
  source: CalibrationSource;
  detail: string;
}

export interface TickPoint {
  t: number;
  vus: number;
  qps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

export type SloStatus = 'met' | 'breached' | 'none';

export interface QueryResult {
  name: string;
  sql: string;
  executions: number;
  errors: number;
  errorPct: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  p95TargetMs: number | null;
  errorBudgetPct: number | null;
  slo: SloStatus;
  source: CalibrationSource;
}

export type RunStatus = 'completed' | 'stopped';

export interface RunSummary {
  id: string;
  scenario: string;
  pattern: LoadPattern;
  status: RunStatus;
  startedAt: string;
  durationSec: number;
  peakVus: number;
  totalQueries: number;
  avgQps: number;
  p50: number;
  p95: number;
  p99: number;
  errorPct: number;
  p95ThresholdMs: number;
  errorThresholdPct: number;
  passed: boolean;
  breaches: string[];
  series: TickPoint[];
}

export interface SavedScenario {
  id: string;
  builtIn: boolean;
  description: string;
  scenario: Scenario;
}

export const SAMPLE_QUERIES: PoolQuery[] = [
  { name: 'sample_dashboard_kpis.sql', sql: 'SELECT count(), sum(revenue) FROM analytics.events WHERE event_time > now() - INTERVAL 1 DAY', avgRunTime: null, slowestRunTime: null, runCount: 0 },
  { name: 'sample_top_pages.sql', sql: 'SELECT page, count() c FROM analytics.events GROUP BY page ORDER BY c DESC LIMIT 20', avgRunTime: null, slowestRunTime: null, runCount: 0 },
  { name: 'sample_user_lookup.sql', sql: 'SELECT * FROM analytics.users WHERE user_id = 42', avgRunTime: null, slowestRunTime: null, runCount: 0 },
  { name: 'sample_monthly_report.sql', sql: 'SELECT toStartOfMonth(event_time) m, uniq(user_id) FROM analytics.events GROUP BY m', avgRunTime: null, slowestRunTime: null, runCount: 0 },
];

export const DEFAULT_SCENARIO: Scenario = {
  name: 'Untitled scenario',
  pattern: 'ramp',
  virtualUsers: 50,
  durationSec: 60,
  rampUpSec: 10,
  thinkTimeMs: 250,
  maxQps: 500,
  capacity: 32,
  p95ThresholdMs: 500,
  errorThresholdPct: 1,
  mix: [],
};

const entry = (q: PoolQuery, enabled: boolean, weight = 10): MixEntry => ({
  name: q.name, sql: q.sql, weight, enabled, p95TargetMs: null, errorBudgetPct: null,
});

export const isWrite = (sql: string) => /^\s*(--[^\n]*\n\s*)*insert\b/i.test(sql);

export function defaultMix(pool: PoolQuery[]): MixEntry[] {
  return pool.map((q, i) => entry(q, i < 5));
}

// Keep a scenario's own entries and append any pool queries it does not mention (disabled).
// Entries are identified by file name: several saved files can share the same SQL.
export function mergeMix(mix: MixEntry[], pool: PoolQuery[]): MixEntry[] {
  const byName = new Map(pool.map(q => [q.name, q]));
  const known = new Set(mix.map(m => m.name));
  // Pick up edits to a saved file's SQL since the scenario was saved
  return [...mix.map(m => ({ ...m, sql: byName.get(m.name)?.sql ?? m.sql })), ...pool.filter(q => !known.has(q.name)).map(q => entry(q, false))];
}

// Built-in presets: a config plus a rule that builds the mix from whatever queries are available
const PRESETS: { id: string; description: string; config: Omit<Scenario, 'mix'>; mix: (pool: PoolQuery[]) => MixEntry[] }[] = [
  {
    id: 'preset-dashboard',
    description: 'Ramp to 80 dashboard users; read queries only, short queries hit most often.',
    config: { ...DEFAULT_SCENARIO, name: 'Dashboard peak', pattern: 'ramp', virtualUsers: 80, durationSec: 120, thinkTimeMs: 500, p95ThresholdMs: 500, errorThresholdPct: 1 },
    mix: pool => pool.map((q, i) => entry(q, !isWrite(q.sql) && i < 8, Math.max(5, 40 - i * 5))),
  },
  {
    id: 'preset-ingest',
    description: 'Constant 40 VUs mixing INSERT queries (weight 30) with reads (weight 10).',
    config: { ...DEFAULT_SCENARIO, name: 'Ingest + query mix', pattern: 'constant', virtualUsers: 40, durationSec: 180, rampUpSec: 15, thinkTimeMs: 200, p95ThresholdMs: 800, errorThresholdPct: 1 },
    mix: pool => pool.map(q => entry(q, true, isWrite(q.sql) ? 30 : 10)),
  },
  {
    id: 'preset-soak',
    description: '25 VUs held for 30 minutes across every query with a tight error budget.',
    config: { ...DEFAULT_SCENARIO, name: 'Soak test', pattern: 'soak', virtualUsers: 25, durationSec: 1800, rampUpSec: 60, thinkTimeMs: 1000, p95ThresholdMs: 400, errorThresholdPct: 0.5 },
    mix: pool => pool.map(q => entry(q, true)),
  },
];

export function builtInScenarios(pool: PoolQuery[]): SavedScenario[] {
  return PRESETS.map(p => ({ id: p.id, builtIn: true, description: p.description, scenario: { ...p.config, mix: p.mix(pool) } }));
}

// Target number of virtual users at second t (1..durationSec) for the chosen pattern
export function vusAt(s: Pick<Scenario, 'pattern' | 'virtualUsers' | 'durationSec' | 'rampUpSec'>, t: number): number {
  const max = Math.max(1, s.virtualUsers);
  const d = Math.max(1, s.durationSec);
  const rampFrac = s.rampUpSec > 0 ? Math.min(1, t / s.rampUpSec) : 1;
  switch (s.pattern) {
    case 'constant':
    case 'soak':
      return Math.max(1, Math.ceil(rampFrac * max));
    case 'ramp':
      return Math.max(1, Math.ceil(Math.min(1, t / d) * max));
    case 'step':
      return Math.max(1, Math.ceil(((Math.min(4, Math.floor(((t - 1) / d) * 5)) + 1) / 5) * max));
    case 'spike':
      return Math.abs(t - d / 2) <= d * 0.1 ? max : Math.max(1, Math.round(max * 0.15));
  }
}

// ==================== Persistence ====================

const HISTORY_KEY = 'missioncontrol_loadtest_history_v2';
const SCENARIOS_KEY = 'missioncontrol_loadtest_scenarios';
export const MAX_HISTORY = 40;
export const MAX_SERIES_POINTS = 300;

function readJson<T>(key: string, valid: (v: unknown) => boolean): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: keep working in memory
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const loadHistory = () =>
  readJson<RunSummary>(HISTORY_KEY, v => isObj(v) && typeof v.id === 'string' && Array.isArray(v.series) && Array.isArray(v.breaches));
export const saveHistory = (runs: RunSummary[]) => writeJson(HISTORY_KEY, runs.slice(0, MAX_HISTORY));

export const loadSavedScenarios = () =>
  readJson<SavedScenario>(SCENARIOS_KEY, v => isObj(v) && typeof v.id === 'string' && isObj(v.scenario) && Array.isArray(v.scenario.mix));
export const saveSavedScenarios = (list: SavedScenario[]) => writeJson(SCENARIOS_KEY, list.filter(s => !s.builtIn));

// Average a long series down to at most MAX_SERIES_POINTS points for storage
export function downsample(series: TickPoint[]): TickPoint[] {
  if (series.length <= MAX_SERIES_POINTS) return series;
  const size = series.length / MAX_SERIES_POINTS;
  return Array.from({ length: MAX_SERIES_POINTS }, (_, i) => {
    const chunk = series.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    const avg = (k: keyof TickPoint) => Math.round(chunk.reduce((s, p) => s + p[k], 0) / chunk.length);
    return { t: chunk[chunk.length - 1].t, vus: avg('vus'), qps: avg('qps'), p50: avg('p50'), p95: avg('p95'), p99: avg('p99'), errors: avg('errors') };
  });
}

export const fmtMs = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
