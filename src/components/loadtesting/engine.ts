// Browser-side load simulation. Nothing here talks to ClickHouse: each query's
// unloaded latency profile comes from calibration, and a simple queueing model
// slows queries down (and starts failing them) as concurrency exceeds the
// notional cluster capacity.
import { downsample, fmtMs, vusAt } from './model';
import type { Calibration, QueryResult, RunStatus, RunSummary, Scenario, SloStatus, TickPoint, CalibrationSource } from './model';

// Hard cap on simulated executions per second so a tick stays cheap
export const MAX_SIM_QPS = 20000;

// Nearest-rank percentile of an ascending array
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const LOG_STEP = Math.log(1.02);

// Log-bucketed latency histogram: ~2% accurate percentiles over a whole run in constant memory
class Histogram {
  private buckets = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;

  add(v: number) {
    const b = Math.floor(Math.log(Math.max(v, 0.1)) / LOG_STEP);
    this.buckets.set(b, (this.buckets.get(b) || 0) + 1);
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.max(1, Math.ceil(p * this.count));
    let seen = 0;
    for (const b of [...this.buckets.keys()].sort((x, y) => x - y)) {
      seen += this.buckets.get(b)!;
      if (seen >= rank) return Math.min(this.max, Math.exp((b + 0.5) * LOG_STEP));
    }
    return this.max;
  }
}

export interface RunQuery {
  name: string;
  sql: string;
  share: number;
  p50Ms: number;
  sigma: number;
  baseErrorRate: number;
  p95TargetMs: number | null;
  errorBudgetPct: number | null;
  source: CalibrationSource;
}

// Heuristic used only when a query has no recorded executions at all
export function estimateCalibration(sql: string): Calibration {
  const s = sql.toLowerCase();
  const count = (re: RegExp) => (s.match(re) || []).length;
  const p50 = 15 + 60 * count(/\bjoin\b/g) + 40 * count(/\bgroup by\b/g) + 20 * count(/\border by\b/g) + 30 * count(/\bselect\b/g);
  return { p50Ms: p50, p95Ms: p50 * 2.5, errorPct: 0.1, source: 'estimate', detail: 'No recorded runs: estimated from query shape' };
}

// Freeze the enabled part of the mix into the inputs the simulation needs
export function buildRunQueries(scenario: Scenario, calibration: Record<string, Calibration>): RunQuery[] {
  const active = scenario.mix.filter(m => m.enabled && m.weight > 0);
  const total = active.reduce((s, m) => s + m.weight, 0);
  return active.map(m => {
    const cal = calibration[m.sql] ?? estimateCalibration(m.sql);
    const p50 = Math.max(0.5, cal.p50Ms);
    return {
      name: m.name,
      sql: m.sql,
      share: m.weight / total,
      p50Ms: p50,
      // Log-normal spread that reproduces the calibrated p95 (z = 1.645)
      sigma: Math.min(1.5, Math.max(0.1, Math.log(Math.max(cal.p95Ms, p50 * 1.05) / p50) / 1.645)),
      baseErrorRate: Math.min(0.5, cal.errorPct / 100),
      p95TargetMs: m.p95TargetMs,
      errorBudgetPct: m.errorBudgetPct,
      source: cal.source,
    };
  });
}

// Closed-loop model for one VU count. Each VU runs a query then thinks. The
// simulated cluster serves `capacity` queries at once, so throughput tops out
// at capacity / mean latency; beyond that, extra VUs only queue (latency grows
// by the response-time law) and the overload starts producing errors.
function loadModel(queries: RunQuery[], s: Scenario, vus: number) {
  const meanBase = queries.reduce((sum, q) => sum + q.share * q.p50Ms * Math.exp((q.sigma * q.sigma) / 2), 0);
  const cap = Math.min(MAX_SIM_QPS, Math.max(1, s.maxQps));
  const demand0 = (vus * 1000) / (meanBase + s.thinkTimeMs);
  const maxThroughput0 = (Math.max(1, s.capacity) * 1000) / meanBase;
  // Offered load relative to capacity; the client-side QPS cap throttles before the cluster sees it
  const utilisation = Math.min(demand0, cap) / maxThroughput0;
  // Mild contention as the cluster fills up, and some thrashing once overloaded
  const contention = 1 + 0.5 * Math.pow(Math.min(utilisation, 1), 4);
  const service = meanBase * contention;
  const demand = (vus * 1000) / (service + s.thinkTimeMs);
  const maxThroughput = ((Math.max(1, s.capacity) * 1000) / service) * (1 - Math.min(0.3, Math.max(0, utilisation - 1) * 0.05));
  const qps = Math.min(demand, cap, maxThroughput);
  const latency = qps === maxThroughput && maxThroughput < Math.min(demand, cap) ? Math.max(service, (vus * 1000) / qps - s.thinkTimeMs) : service;
  return { qps, slowdown: latency / meanBase, utilisation };
}

function gaussian(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

interface SecondSample {
  qps: number;
  perQuery: { samples: number[]; errors: number }[];
}

// One simulated second at a fixed number of virtual users
function simulateSecond(queries: RunQuery[], s: Scenario, vus: number): SecondSample {
  const { qps, slowdown, utilisation } = loadModel(queries, s, vus);
  const noisyQps = qps * (0.95 + Math.random() * 0.1);
  const overloadErrors = utilisation > 1 ? Math.min(0.3, (utilisation - 1) * 0.03) : 0;
  const tickSlowdown = slowdown * (0.95 + Math.random() * 0.1);
  return {
    qps: noisyQps,
    perQuery: queries.map(q => {
      const n = Math.floor(noisyQps * q.share + Math.random());
      const samples = new Array<number>(n);
      let errors = 0;
      for (let i = 0; i < n; i++) {
        samples[i] = q.p50Ms * Math.exp(q.sigma * gaussian()) * tickSlowdown;
        if (Math.random() < q.baseErrorRate + overloadErrors) errors++;
      }
      return { samples, errors };
    }),
  };
}

// Overall thresholds plus every per-query SLO; returns a human-readable list of breaches
export function evaluate(s: Scenario, p95: number, errorPct: number, results: QueryResult[]): string[] {
  const out: string[] = [];
  if (p95 > s.p95ThresholdMs) out.push(`Overall p95 ${fmtMs(p95)} > ${fmtMs(s.p95ThresholdMs)}`);
  if (errorPct > s.errorThresholdPct) out.push(`Overall errors ${errorPct.toFixed(2)}% > ${s.errorThresholdPct}%`);
  for (const r of results) {
    if (r.p95TargetMs !== null && r.p95 > r.p95TargetMs) out.push(`${r.name}: p95 ${fmtMs(r.p95)} > ${fmtMs(r.p95TargetMs)}`);
    if (r.errorBudgetPct !== null && r.errorPct > r.errorBudgetPct) out.push(`${r.name}: errors ${r.errorPct.toFixed(2)}% > ${r.errorBudgetPct}%`);
  }
  return out;
}

function sloStatus(q: RunQuery, p95: number, errorPct: number, executions: number): SloStatus {
  if (q.p95TargetMs === null && q.errorBudgetPct === null) return 'none';
  if (!executions) return 'met';
  const breached = (q.p95TargetMs !== null && p95 > q.p95TargetMs) || (q.errorBudgetPct !== null && errorPct > q.errorBudgetPct);
  return breached ? 'breached' : 'met';
}

// Aggregates simulated seconds into per-query and overall statistics
class Accumulator {
  private queries: RunQuery[];
  private perQuery: { hist: Histogram; errors: number }[];
  private overall = new Histogram();
  errors = 0;

  constructor(queries: RunQuery[]) {
    this.queries = queries;
    this.perQuery = queries.map(() => ({ hist: new Histogram(), errors: 0 }));
  }

  add(sec: SecondSample) {
    sec.perQuery.forEach((pq, i) => {
      for (const v of pq.samples) {
        this.perQuery[i].hist.add(v);
        this.overall.add(v);
      }
      this.perQuery[i].errors += pq.errors;
      this.errors += pq.errors;
    });
  }

  get count() { return this.overall.count; }
  get errorPct() { return this.count ? (this.errors / this.count) * 100 : 0; }
  overallPercentile(p: number) { return this.overall.percentile(p); }

  results(): QueryResult[] {
    return this.queries.map((q, i) => {
      const { hist, errors } = this.perQuery[i];
      const errorPct = hist.count ? (errors / hist.count) * 100 : 0;
      const p95 = hist.percentile(0.95);
      return {
        name: q.name, sql: q.sql, executions: hist.count, errors, errorPct,
        avgMs: hist.count ? hist.sum / hist.count : 0,
        p50: hist.percentile(0.5), p95, p99: hist.percentile(0.99), maxMs: hist.max,
        p95TargetMs: q.p95TargetMs, errorBudgetPct: q.errorBudgetPct,
        slo: sloStatus(q, p95, errorPct, hist.count), source: q.source,
      };
    });
  }
}

export interface QueryTick {
  n: number;
  p95: number;
  errors: number;
}

// A single test run, advanced one simulated second per tick()
export class SimulatedRun {
  t = 0;
  series: TickPoint[] = [];
  // Parallel to series: per-query executions, p95 and errors for that second (used by filtered charts)
  byQuery: QueryTick[][] = [];
  readonly startedAt = new Date().toISOString();
  readonly scenario: Scenario;
  readonly queries: RunQuery[];
  private acc: Accumulator;

  constructor(scenario: Scenario, queries: RunQuery[]) {
    this.scenario = scenario;
    this.queries = queries;
    this.acc = new Accumulator(queries);
  }

  get done() { return this.t >= this.scenario.durationSec; }

  tick() {
    this.t += 1;
    const vus = vusAt(this.scenario, this.t);
    const sec = simulateSecond(this.queries, this.scenario, vus);
    this.acc.add(sec);
    const all = sec.perQuery.flatMap(p => p.samples).sort((a, b) => a - b);
    this.byQuery.push(sec.perQuery.map(p => ({
      n: p.samples.length, errors: p.errors, p95: Math.round(percentile([...p.samples].sort((a, b) => a - b), 0.95)),
    })));
    this.series.push({
      t: this.t, vus, qps: Math.round(sec.qps),
      p50: Math.round(percentile(all, 0.5)), p95: Math.round(percentile(all, 0.95)), p99: Math.round(percentile(all, 0.99)),
      errors: sec.perQuery.reduce((s, p) => s + p.errors, 0),
    });
  }

  results() { return this.acc.results(); }

  totals() {
    return {
      executions: this.acc.count, errors: this.acc.errors, errorPct: this.acc.errorPct,
      p50: this.acc.overallPercentile(0.5), p95: this.acc.overallPercentile(0.95), p99: this.acc.overallPercentile(0.99),
    };
  }

  summary(status: RunStatus): RunSummary {
    const tot = this.totals();
    const breaches = evaluate(this.scenario, tot.p95, tot.errorPct, this.results());
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      scenario: this.scenario.name, pattern: this.scenario.pattern, status, startedAt: this.startedAt,
      durationSec: this.t, peakVus: Math.max(0, ...this.series.map(p => p.vus)), totalQueries: tot.executions,
      avgQps: Math.round(tot.executions / Math.max(1, this.t)),
      p50: Math.round(tot.p50), p95: Math.round(tot.p95), p99: Math.round(tot.p99), errorPct: Number(tot.errorPct.toFixed(2)),
      p95ThresholdMs: this.scenario.p95ThresholdMs, errorThresholdPct: this.scenario.errorThresholdPct,
      passed: breaches.length === 0, breaches, series: downsample(this.series),
    };
  }
}

// ==================== Capacity finder ====================

export interface CapacityStep {
  vus: number;
  qps: number;
  p50: number;
  p95: number;
  p99: number;
  errorPct: number;
  breaches: string[];
}

export interface CapacitySettings {
  startVus: number;
  stepVus: number;
  maxVus: number;
  stepSec: number;
}

// Hold a constant VU count for stepSec simulated seconds and judge it against the thresholds
export function measureStep(scenario: Scenario, queries: RunQuery[], vus: number, stepSec: number): CapacityStep {
  const acc = new Accumulator(queries);
  let qpsSum = 0;
  for (let i = 0; i < stepSec; i++) {
    const sec = simulateSecond(queries, scenario, vus);
    acc.add(sec);
    qpsSum += sec.qps;
  }
  const p95 = acc.overallPercentile(0.95);
  return {
    vus, qps: Math.round(qpsSum / stepSec),
    p50: Math.round(acc.overallPercentile(0.5)), p95: Math.round(p95), p99: Math.round(acc.overallPercentile(0.99)),
    errorPct: Number(acc.errorPct.toFixed(2)),
    breaches: evaluate(scenario, p95, acc.errorPct, acc.results()),
  };
}
