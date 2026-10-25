// Backend scheduler: periodically runs the monitoring checks, data quality
// checks, performance queries and recommendation providers against every
// configured environment. Configured only in querydog.yml (re-read on each
// tick); the UI shows it read-only under Settings > Scheduler.
//
//   scheduler:
//     enabled: true
//     environments: all            # or a list of environment names
//     jobs:                        # defaults for every scheduled environment
//       monitoring:      { every: 5m }
//       dataquality:     { every: 1h, exclude: ["sales_fresh"] }
//       performance:     { every: 6h, enabled: false }
//       recommendations: { every: 6h }
//
//   environments:
//     - name: "Production"
//       scheduler: false             # never scheduled
//     - name: "NC Test Production"
//       scheduler:                   # scheduled, with its own job settings
//         jobs:
//           monitoring: { every: 1m }
//
// Checks run through the same HTTP API as Run / Run all in the UI, with an
// X-QueryDog-Environment header choosing the environment, so manual and
// scheduled runs behave and record identically. Progress is logged to stdout
// and to the scheduler_log table; repeated identical failures are logged once.
import { AsyncLocalStorage } from 'node:async_hooks';
import { logScheduler, listRecommendations, saveRecommendations, getSetting, setSetting } from './db.js';
import { INTERNAL_HEADER, INTERNAL_TOKEN } from './auth.js';

export const JOBS = ['monitoring', 'dataquality', 'performance', 'recommendations'];
const DEFAULT_EVERY = { monitoring: '5m', dataquality: '1h', performance: '6h', recommendations: '6h' };
const TICK_MS = Number(process.env.QUERYDOG_SCHEDULER_TICK_MS) || 30000;
const REQUEST_TIMEOUT_MS = 10 * 60000;
const EVERY_RE = /^(\d+)\s*(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

// ==================== Config ====================

function parseEvery(value, fallback) {
  const m = EVERY_RE.exec(String(value ?? fallback).trim());
  if (!m) return null;
  return Math.max(60000, Number(m[1]) * UNIT_MS[m[2]]);
}

const toList = v => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
const globToRegExp = g => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// Normalise the `scheduler:` section of querydog.yml. Problems become warnings
// shown in Settings rather than stopping the server.
// Job settings: `src` (scheduler.jobs or an environment's scheduler.jobs)
// layered over `base` (the global jobs, when parsing an environment)
function parseJobs(src, base, where, warnings) {
  const jobs = {};
  for (const kind of JOBS) {
    const j = src?.[kind];
    const inherited = base?.[kind];
    if (j === undefined && inherited) {
      jobs[kind] = inherited;
      continue;
    }
    const cfg = j && typeof j === 'object' ? j : {};
    const every = String(cfg.every ?? inherited?.every ?? DEFAULT_EVERY[kind]);
    const everyMs = parseEvery(every, DEFAULT_EVERY[kind]);
    if (everyMs === null) warnings.push(`${where}.${kind}.every "${every}" is not like 30s, 5m, 1h or 1d`);
    const switchedOn = j === false || cfg.enabled === false ? false
      : cfg.enabled === true || j === true ? true
      : inherited ? inherited.enabled : true;
    jobs[kind] = {
      enabled: everyMs !== null && switchedOn,
      every,
      everyMs: everyMs ?? 0,
      include: cfg.include !== undefined ? toList(cfg.include) : inherited?.include ?? [],
      exclude: cfg.exclude !== undefined ? toList(cfg.exclude) : inherited?.exclude ?? [],
    };
  }
  return jobs;
}

// Normalise the `scheduler:` section of querydog.yml plus each environment's
// optional `scheduler:` key (false to skip it, or { jobs } to override the
// defaults). Problems become warnings shown in Settings rather than errors.
export function parseSchedulerConfig(raw, environmentNames, environmentSchedulers = {}) {
  const warnings = [];
  const section = raw && typeof raw === 'object' ? raw : null;
  // QUERYDOG_SCHEDULER=on|off overrides scheduler.enabled, so only one of
  // several servers sharing a querydog.yml runs the schedule
  const override = String(process.env.QUERYDOG_SCHEDULER || '').toLowerCase();
  const enabled = override === 'on' || override === 'true' ? true
    : override === 'off' || override === 'false' ? false
    : !!section && section.enabled !== false;

  let candidates = environmentNames;
  if (section && section.environments !== undefined && section.environments !== 'all') {
    const wanted = toList(section.environments);
    candidates = wanted.filter(n => environmentNames.includes(n));
    for (const n of wanted.filter(n => !environmentNames.includes(n))) warnings.push(`Unknown environment "${n}" in scheduler.environments`);
  }

  const jobs = parseJobs(section?.jobs, null, 'scheduler.jobs', warnings);
  const environments = [];
  const jobsByEnvironment = {};
  for (const name of candidates) {
    const own = environmentSchedulers[name];
    if (own === false || (own && typeof own === 'object' && own.enabled === false)) continue;
    environments.push(name);
    jobsByEnvironment[name] = own && typeof own === 'object' && own.jobs
      ? parseJobs(own.jobs, jobs, `environments["${name}"].scheduler.jobs`, warnings)
      : jobs;
  }
  return { enabled, configured: !!section, environments, jobs, jobsByEnvironment, warnings, tickMs: TICK_MS };
}

function selected(job, id) {
  const name = String(id).replace(/\.sql$/, '');
  const match = list => list.some(g => globToRegExp(g).test(name));
  return (!job.include.length || match(job.include)) && !match(job.exclude);
}

// ==================== Scheduler ====================

/**
 * @param {object} opts
 * @param {number} opts.port                     Port this server listens on
 * @param {() => object|null} opts.readConfig    The parsed querydog.yml (scheduler and environments)
 * @param {() => string[]} opts.environmentNames Names of every configured environment
 */
export function startScheduler({ port, readConfig, environmentNames }) {
  const base = `http://127.0.0.1:${port}`;
  // `${env}|${job}` -> { startedAt, finishedAt, summary, ok, details }, kept in
  // the database so status survives restarts and a restart doesn't rerun everything
  const lastRun = new Map(Object.entries(getSetting('scheduler.lastRun', {}) || {}));
  const recordLastRun = (key, value) => {
    lastRun.set(key, value);
    setSetting('scheduler.lastRun', Object.fromEntries(lastRun));
  };
  const failures = new Map();      // `${env}|${job}|${check}` -> last error, to log repeats once
  let running = null;              // { environment, job, startedAt }

  // Recommendation providers call relative /api URLs with fetch; inside a
  // scheduled run, send those to this server for the run's environment.
  const scope = new AsyncLocalStorage();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const env = scope.getStore();
    if (env && typeof input === 'string' && input.startsWith('/')) {
      const headers = new Headers(init.headers);
      headers.set('X-QueryDog-Environment', env);
      headers.set('X-QueryDog-Trigger', 'scheduler');
      headers.set(INTERNAL_HEADER, INTERNAL_TOKEN);
      return realFetch(base + input, { ...init, headers });
    }
    return realFetch(input, init);
  };

  async function call(environment, method, url, body) {
    const res = await realFetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-QueryDog-Environment': environment, 'X-QueryDog-Trigger': 'scheduler', [INTERNAL_HEADER]: INTERNAL_TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // Log a failure the first time it happens or when its message changes, and
  // log the recovery; identical repeats stay quiet.
  function noteResult(environment, job, check, error) {
    const key = `${environment}|${job}|${check}`;
    const previous = failures.get(key);
    if (error) {
      if (previous !== error) logScheduler('warn', `${check} failed: ${error}`, { environment, kind: job });
      failures.set(key, error);
    } else if (previous !== undefined) {
      logScheduler('info', `${check} recovered`, { environment, kind: job });
      failures.delete(key);
    }
  }

  // Each job lists its checks through the API, then runs them one at a time.
  const runners = {
    async monitoring(environment, cfg) {
      const { alerts = [] } = await call(environment, 'GET', '/api/alerts');
      const checks = alerts.map(a => a.filename).filter(f => selected(cfg, f));
      let firing = 0, errors = 0;
      for (const check of checks) {
        try {
          const r = await call(environment, 'POST', `/api/alerting/rules/${encodeURIComponent(check)}/evaluate`);
          if (r.lastError) throw new Error(r.lastError);
          if (r.lastResult?.state === 'firing') firing++;
          noteResult(environment, 'monitoring', check, null);
        } catch (e) {
          errors++;
          noteResult(environment, 'monitoring', check, e.message);
        }
      }
      return { ok: errors === 0, summary: `${checks.length} checks, ${firing} firing, ${errors} errors` };
    },

    async dataquality(environment, cfg) {
      const { rules = [] } = await call(environment, 'GET', '/api/dataquality/state');
      const chosen = rules.filter(r => selected(cfg, r.id));
      let failed = 0, errors = 0;
      for (const rule of chosen) {
        try {
          const run = await call(environment, 'POST', `/api/dataquality/rules/${encodeURIComponent(rule.id)}/run`);
          if (run.status === 'error') throw new Error(run.error || 'error');
          if (run.status === 'fail') failed++;
          noteResult(environment, 'dataquality', rule.id, null);
        } catch (e) {
          errors++;
          noteResult(environment, 'dataquality', rule.id, e.message);
        }
      }
      return { ok: errors === 0, summary: `${chosen.length} checks, ${failed} failing, ${errors} errors` };
    },

    async performance(environment, cfg) {
      const { queries = [] } = await call(environment, 'GET', '/api/my-queries');
      const chosen = queries.filter(q => selected(cfg, q.filename));
      let errors = 0;
      const graded = { warn: 0, fail: 0 };
      for (const q of chosen) {
        try {
          const run = await call(environment, 'POST', '/api/my-queries/run', { filename: q.filename, query: q.query });
          if (run?.status in graded) graded[run.status]++;
          // A fixed message, so a query that stays too slow is logged once
          noteResult(environment, 'performance', q.filename, run?.status === 'fail' ? `slower than fail_duration_ms (${q.failDurationMs} ms)` : null);
        } catch (e) {
          errors++;
          noteResult(environment, 'performance', q.filename, e.message);
        }
      }
      return { ok: errors === 0 && graded.fail === 0, summary: `${chosen.length} queries, ${graded.fail} too slow, ${graded.warn} slow, ${errors} errors` };
    },

    // Same providers and reconcile() as the Recommendations page: existing
    // recommendations are updated in place, never duplicated, and ones no
    // longer reported are marked resolved.
    async recommendations(environment, cfg) {
      const { RECOMMENDATION_PROVIDERS, reconcile } = await import('./generated/recommendations.mjs');
      let store = Object.fromEntries(listRecommendations(environment).map(e => [e.rec.id, e]));
      let total = 0, errors = 0;
      const providers = {};
      for (const provider of RECOMMENDATION_PROVIDERS.filter(p => selected(cfg, p.category))) {
        const t0 = Date.now();
        try {
          const recs = await scope.run(environment, () => provider.run());
          store = reconcile(store, provider.category, recs);
          total += recs.length;
          providers[provider.category] = { state: 'ok', count: recs.length, ms: Date.now() - t0 };
          noteResult(environment, 'recommendations', provider.category, null);
        } catch (e) {
          errors++;
          providers[provider.category] = { state: 'error', error: e.message, ms: Date.now() - t0 };
          noteResult(environment, 'recommendations', provider.category, e.message);
        }
      }
      saveRecommendations(environment, Object.values(store));
      return { ok: errors === 0, summary: `${total} recommendations, ${errors} provider errors`, details: { providers } };
    },
  };

  async function runJob(environment, job, cfg) {
    const key = `${environment}|${job}`;
    const startedAt = new Date().toISOString();
    running = { environment, job, startedAt };
    const t0 = Date.now();
    try {
      // One reachability check per job so an unreachable server is one log line, not one per check
      await call(environment, 'GET', '/api/health').then(h => {
        if (h.status && h.status !== 'healthy') throw new Error(h.error || 'not healthy');
      });
      noteResult(environment, job, '(connection)', null);
      const { ok, summary, details } = await runners[job](environment, cfg);
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      logScheduler(ok ? 'info' : 'warn', `${summary} in ${seconds}s`, { environment, kind: job });
      recordLastRun(key, { startedAt, finishedAt: new Date().toISOString(), ok, summary, ...(details ? { details } : {}) });
      return true;
    } catch (e) {
      // Unreachable (or an idle Cloud service still waking): retry on the next
      // tick rather than waiting a whole interval
      noteResult(environment, job, '(connection)', `environment unreachable: ${e.message}`);
      recordLastRun(key, { startedAt, finishedAt: new Date().toISOString(), ok: false, summary: e.message, retry: true });
      return false;
    } finally {
      running = null;
    }
  }

  let ticking = false;
  let announced = null;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const config = currentConfig();
      const state = config.enabled ? `on for ${config.environments.length} environment(s)` : 'off';
      if (state !== announced) {
        logScheduler('info', `scheduler ${state}`);
        for (const w of config.warnings) logScheduler('warn', w);
        announced = state;
      }
      if (!config.enabled) return;
      for (const environment of config.environments) {
        for (const job of JOBS) {
          const cfg = config.jobsByEnvironment[environment][job];
          if (!cfg.enabled) continue;
          const last = lastRun.get(`${environment}|${job}`);
          if (last && !last.retry && Date.now() - new Date(last.startedAt).getTime() < cfg.everyMs) continue;
          // Unreachable: leave this environment's other jobs for the next tick
          if (!(await runJob(environment, job, cfg))) break;
        }
      }
    } catch (e) {
      logScheduler('error', `tick failed: ${e.message}`);
    } finally {
      ticking = false;
    }
  }

  function currentConfig() {
    let raw = null;
    try {
      raw = readConfig();
    } catch (e) {
      return { ...parseSchedulerConfig(null, []), warnings: [`Could not read querydog.yml: ${e.message}`] };
    }
    const environmentSchedulers = Object.fromEntries((Array.isArray(raw?.environments) ? raw.environments : [])
      .filter(e => e && e.name !== undefined && e.scheduler !== undefined)
      .map(e => [String(e.name), e.scheduler]));
    return parseSchedulerConfig(raw?.scheduler ?? null, environmentNames(), environmentSchedulers);
  }

  // First tick shortly after startup so the server is listening
  setTimeout(() => void tick(), 5000).unref();
  setInterval(() => void tick(), TICK_MS).unref();

  // Run one job now for one environment (e.g. Recommendations > Run now),
  // whether or not the schedule is enabled. Returns that job's last-run record.
  const pending = new Map();
  function runNow(environment, job) {
    if (!JOBS.includes(job)) throw new Error(`Unknown job ${job}`);
    const key = `${environment}|${job}`;
    if (!pending.has(key)) {
      const config = currentConfig();
      const cfg = { ...(config.jobsByEnvironment[environment]?.[job] ?? config.jobs[job]), include: [], exclude: [] };
      pending.set(key, runJob(environment, job, cfg).then(() => lastRun.get(key)).finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }
  const lastRunOf = (environment, job) => lastRun.get(`${environment}|${job}`) || null;

  // Settings > Scheduler > Run now: every enabled job for every scheduled
  // environment, one after another, in the background
  let runAllStartedAt = null;
  function runAll() {
    if (runAllStartedAt) return { started: false, startedAt: runAllStartedAt };
    const config = currentConfig();
    runAllStartedAt = new Date().toISOString();
    logScheduler('info', 'run now: running every job for every scheduled environment');
    void (async () => {
      try {
        for (const environment of config.environments) {
          for (const job of JOBS) {
            if (!config.jobsByEnvironment[environment][job].enabled) continue;
            await runNow(environment, job);
            // Unreachable: skip this environment's other jobs
            if (lastRunOf(environment, job)?.retry) break;
          }
        }
        logScheduler('info', 'run now finished');
      } catch (e) {
        logScheduler('error', `run now failed: ${e.message}`);
      } finally {
        runAllStartedAt = null;
      }
    })();
    return { started: true, startedAt: runAllStartedAt };
  }

  // Read-only status for Settings > Scheduler
  function status() {
    const config = currentConfig();
    const now = Date.now();
    return {
      ...config,
      running,
      jobsByEnvironment: config.environments.map(environment => ({
        environment,
        jobs: JOBS.map(job => {
          const last = lastRun.get(`${environment}|${job}`) || null;
          const cfg = config.jobsByEnvironment[environment][job];
          const nextAt = !config.enabled || !cfg.enabled ? null
            : last ? new Date(Math.max(now, new Date(last.startedAt).getTime() + cfg.everyMs)).toISOString() : new Date(now).toISOString();
          return { job, enabled: cfg.enabled, every: cfg.every, last, nextAt };
        }),
      })),
    };
  }

  return { status: () => ({ ...status(), runAllStartedAt }), runNow, runAll, lastRunOf };
}
