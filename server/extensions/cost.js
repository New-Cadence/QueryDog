// Cost extension: proxies the ClickHouse Cloud API (billing, services,
// backups, live metrics) for the active environment and stores the Cost
// area's settings (price overrides, budgets, open-source node prices, teams)
// in the Convoy database under the 'cost' key.
// API credentials stay on the server: responses never include them.
import { getSetting, setSetting, importJsonFile } from '../db.js';

const API_BASE = 'https://api.clickhouse.cloud/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
// usageCost accepts at most 31 days per request; longer ranges are split.
const USAGE_CHUNK_DAYS = 31;
const MAX_USAGE_DAYS = 186;

class CostError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const cache = new Map();

function cloudConfig(env) {
  if (!env) throw new CostError(400, 'No active environment', 'not_configured');
  if (env.deployment !== 'cloud') {
    throw new CostError(400, `Environment "${env.name}" is not a ClickHouse Cloud deployment (deployment: ${env.deployment}).`, 'not_cloud');
  }
  const api = env.cloud_api;
  const missing = missingCloudFields(api);
  if (missing.length) {
    throw new CostError(400, `ClickHouse Cloud API is not configured for "${env.name}". Add cloud_api (${missing.join(', ')}) to this environment in querydog.yml.`, 'not_configured');
  }
  return {
    orgId: String(api.organization_id),
    serviceId: api.service_id ? String(api.service_id) : null,
    auth: 'Basic ' + Buffer.from(`${api.key_id}:${api.key_secret}`).toString('base64'),
  };
}

function missingCloudFields(api) {
  return ['key_id', 'key_secret', 'organization_id'].filter(k => !api || !api[k]);
}

function describeUpstreamError(status, body, orgId) {
  const detail = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return `ClickHouse Cloud API rejected the key (401 Unauthorized${detail ? `: ${detail}` : ''}). Check cloud_api.key_id and key_secret in querydog.yml.`;
  if (status === 403) return `The API key is not allowed to read this resource (403 Forbidden). Give the key at least the Developer role for organization ${orgId}.`;
  if (status === 404) return `Not found in ClickHouse Cloud (404${detail ? `: ${detail}` : ''}). Check cloud_api.organization_id / service_id.`;
  if (status === 429) return 'ClickHouse Cloud API rate limit reached (429). Try again in a minute.';
  return `ClickHouse Cloud API error ${status}${detail ? `: ${detail}` : ''}`;
}

// GET a v1 path and return its `result`, cached per environment for 5 minutes.
async function cloudGet(env, cfg, apiPath, { refresh = false, optional = false } = {}) {
  const key = `${env.name}|${cfg.orgId}|${apiPath}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let response;
  try {
    response = await fetch(API_BASE + apiPath, {
      headers: { Authorization: cfg.auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CostError(502, `Could not reach the ClickHouse Cloud API: ${err.name === 'TimeoutError' ? 'request timed out' : err.message}`, 'unreachable');
  }
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    // Optional resources (e.g. a service without a scaling schedule) read as null
    if (optional && (response.status === 404 || response.status === 403)) return null;
    const message = describeUpstreamError(response.status, body, cfg.orgId);
    throw new CostError(response.status === 401 || response.status === 403 ? response.status : 502, message, `upstream_${response.status}`);
  }
  const data = typeof body === 'string' ? body : body?.result;
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ==================== Response normalisation (pure, fixture-tested) ====================

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function normalizeUsageRecord(r) {
  const metrics = {};
  for (const [k, v] of Object.entries(r.metrics || {})) metrics[k] = num(v);
  return {
    date: String(r.date),
    entityType: r.entityType,
    entityId: r.entityId,
    entityName: r.entityName || r.entityId,
    serviceId: r.serviceId ?? null,
    dataWarehouseId: r.dataWarehouseId ?? null,
    organizationTier: r.organizationTier ?? null,
    locked: !!r.locked,
    metrics,
    totalCHC: num(r.totalCHC),
  };
}

export function normalizeService(s, ownServiceId) {
  const scaling = s.currentScaling || {};
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    region: s.region,
    state: s.state,
    tier: s.tier ?? null,
    clickhouseVersion: s.clickhouseVersion ?? null,
    createdAt: s.createdAt ?? null,
    dataWarehouseId: s.dataWarehouseId ?? null,
    isPrimary: s.isPrimary ?? null,
    isReadonly: s.isReadonly ?? null,
    releaseChannel: s.releaseChannel ?? null,
    profile: s.profile ?? null,
    autoscalingMode: scaling.effectiveAutoscalingMode ?? s.autoscalingMode ?? 'vertical',
    numReplicas: num(scaling.effectiveMinReplicas ?? s.numReplicas ?? s.minReplicas ?? 1),
    maxReplicas: num(scaling.effectiveMaxReplicas ?? s.maxReplicas ?? s.numReplicas ?? 1),
    minReplicaMemoryGb: num(scaling.effectiveMinReplicaMemoryGb ?? s.minReplicaMemoryGb ?? s.replicaMemoryGb),
    maxReplicaMemoryGb: num(scaling.effectiveMaxReplicaMemoryGb ?? s.maxReplicaMemoryGb ?? s.replicaMemoryGb),
    idleScaling: scaling.effectiveIdleScaling ?? s.idleScaling ?? true,
    idleTimeoutMinutes: scaling.effectiveIdleTimeoutMinutes ?? s.idleTimeoutMinutes ?? null,
    tags: Array.isArray(s.tags) ? s.tags.map(t => (t.value ? `${t.key}=${t.value}` : t.key)) : [],
    isOwn: !!ownServiceId && s.id === ownServiceId,
  };
}

// Parse the Prometheus text exposition into one entry per service with
// per-replica memory / CPU / MergeTree bytes. Read from the API this never
// wakes an idle service (idle services simply report no replicas).
export function parsePrometheusServices(text) {
  const services = new Map();
  const wanted = {
    ClickHouse_ServiceInfo: 'info',
    ClickHouseAsyncMetrics_CGroupMemoryUsed: 'memoryUsed',
    ClickHouseAsyncMetrics_CGroupMemoryTotal: 'memoryTotal',
    ClickHouseAsyncMetrics_CGroupMaxCPU: 'maxCpu',
    ClickHouseAsyncMetrics_CGroupUserTimeNormalized: 'cpuUser',
    ClickHouseAsyncMetrics_CGroupSystemTimeNormalized: 'cpuSystem',
    ClickHouseAsyncMetrics_TotalBytesOfMergeTreeTables: 'mergeTreeBytes',
    ClickHouseAsyncMetrics_TotalRowsOfMergeTreeTables: 'mergeTreeRows',
  };
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\w+)\{(.*)\}\s+(\S+)/);
    if (!m || !wanted[m[1]]) continue;
    const labels = {};
    for (const [, k, v] of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v;
    const id = labels.clickhouse_service;
    if (!id) continue;
    if (!services.has(id)) services.set(id, { serviceId: id, name: labels.clickhouse_service_name || id, status: null, version: null, replicas: {} });
    const svc = services.get(id);
    if (wanted[m[1]] === 'info') {
      svc.status = labels.clickhouse_cluster_status || null;
      svc.version = labels.clickhouse_version || null;
      continue;
    }
    const host = labels.hostname || labels.instance || 'replica';
    svc.replicas[host] = svc.replicas[host] || { hostname: host };
    svc.replicas[host][wanted[m[1]]] = Number(m[3]);
  }
  return [...services.values()].map(s => ({ ...s, replicas: Object.values(s.replicas) }));
}

// ==================== Settings persistence ====================

// Teams for cost allocation: { id, name, services: [Cloud service id] }, with
// each service kept on the first team that lists it.
function sanitizeTeams(teams) {
  if (!Array.isArray(teams)) return [];
  const claimed = new Set();
  return teams
    .filter(t => t && typeof t === 'object')
    .slice(0, 200)
    .map(t => ({
      id: String(t.id ?? '').slice(0, 64),
      name: String(t.name ?? '').trim().slice(0, 100),
      services: (Array.isArray(t.services) ? t.services : []).map(String).filter(id => !claimed.has(id) && claimed.add(id)).slice(0, 500),
    }))
    .filter(t => t.id && t.name);
}

function readSettings() {
  return getSetting('cost', { prices: {}, envs: {}, teams: [] });
}

function writeSettings(settings) {
  setSetting('cost', settings);
}

// ==================== Routes ====================

function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sendError(res, err) {
  const status = err instanceof CostError ? err.status : 500;
  res.status(status).json({ error: err.message, code: err.code || 'error' });
}

export function register(app, ctx) {
  // Settings used to live in <dataDir>/cost-settings.json
  importJsonFile('cost', 'cost-settings.json');

  // Cheap, credential-free description of how this environment is priced.
  app.get('/api/cost/status', (req, res) => {
    const env = ctx.getActiveEnvironment();
    if (!env) return res.status(500).json({ error: 'No active environment' });
    const api = env.cloud_api;
    const missing = missingCloudFields(api);
    res.json({
      environment: env.name,
      deployment: env.deployment,
      cluster: env.cluster || null,
      cloudApiConfigured: env.deployment === 'cloud' && missing.length === 0,
      missing: env.deployment === 'cloud' ? missing : [],
      organizationId: api?.organization_id || null,
      serviceId: api?.service_id || null,
    });
  });

  app.get('/api/cost/cloud/usage', async (req, res) => {
    try {
      const env = ctx.getActiveEnvironment();
      const cfg = cloudConfig(env);
      const from = isoDate(req.query.from_date);
      const to = isoDate(req.query.to_date);
      if (!from || !to || from > to) throw new CostError(400, 'from_date and to_date (YYYY-MM-DD, from <= to) are required', 'bad_request');
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
      if (days > MAX_USAGE_DAYS) throw new CostError(400, `Date range is limited to ${MAX_USAGE_DAYS} days`, 'bad_request');
      const refresh = req.query.refresh === '1';
      const costs = [];
      let grandTotalCHC = 0;
      for (let start = from; start <= to; start = addDays(start, USAGE_CHUNK_DAYS)) {
        const end = addDays(start, USAGE_CHUNK_DAYS - 1) < to ? addDays(start, USAGE_CHUNK_DAYS - 1) : to;
        const result = await cloudGet(env, cfg, `/organizations/${cfg.orgId}/usageCost?from_date=${start}&to_date=${end}`, { refresh });
        grandTotalCHC += num(result?.grandTotalCHC);
        for (const r of result?.costs || []) costs.push(normalizeUsageRecord(r));
      }
      res.json({ from_date: from, to_date: to, grandTotalCHC, costs });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/cost/cloud/services', async (req, res) => {
    try {
      const env = ctx.getActiveEnvironment();
      const cfg = cloudConfig(env);
      const result = await cloudGet(env, cfg, `/organizations/${cfg.orgId}/services`, { refresh: req.query.refresh === '1' });
      res.json({ services: (result || []).map(s => normalizeService(s, cfg.serviceId)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Backups, backup schedule and autoscaling schedule for one service.
  app.get('/api/cost/cloud/services/:id', async (req, res) => {
    try {
      const env = ctx.getActiveEnvironment();
      const cfg = cloudConfig(env);
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CostError(400, 'Invalid service id', 'bad_request');
      const base = `/organizations/${cfg.orgId}/services/${id}`;
      const refresh = req.query.refresh === '1';
      const [service, backups, backupConfiguration, scalingSchedule] = await Promise.all([
        cloudGet(env, cfg, base, { refresh }),
        cloudGet(env, cfg, `${base}/backups`, { refresh, optional: true }),
        cloudGet(env, cfg, `${base}/backupConfiguration`, { refresh, optional: true }),
        cloudGet(env, cfg, `${base}/scalingSchedule`, { refresh, optional: true }),
      ]);
      res.json({
        service: normalizeService(service, cfg.serviceId),
        backups: (backups || []).map(b => ({
          id: b.id, status: b.status, type: b.type, startedAt: b.startedAt, finishedAt: b.finishedAt ?? null,
          sizeInBytes: num(b.sizeInBytes), durationInSeconds: num(b.durationInSeconds),
        })),
        backupConfiguration: backupConfiguration || null,
        scalingSchedule: scalingSchedule || null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Organisation name plus trial / prepaid credit balances.
  app.get('/api/cost/cloud/organization', async (req, res) => {
    try {
      const env = ctx.getActiveEnvironment();
      const cfg = cloudConfig(env);
      const refresh = req.query.refresh === '1';
      const [org, credits] = await Promise.all([
        cloudGet(env, cfg, `/organizations/${cfg.orgId}`, { refresh }),
        cloudGet(env, cfg, `/organizations/${cfg.orgId}/creditBalances`, { refresh, optional: true }),
      ]);
      res.json({
        organization: { id: org?.id, name: org?.name, createdAt: org?.createdAt ?? null },
        credits: credits
          ? {
            totalRemaining: num(credits.totalRemainingCredits),
            balances: (credits.balances || []).map(b => ({
              id: b.id, type: b.type, remaining: num(b.remainingCredits), total: num(b.totalAmount),
              spent: num(b.amountSpent), startDate: b.startDate, expirationDate: b.expirationDate,
            })),
          }
          : null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Live per-replica memory / CPU / storage for every service in the org.
  app.get('/api/cost/cloud/metrics', async (req, res) => {
    try {
      const env = ctx.getActiveEnvironment();
      const cfg = cloudConfig(env);
      const text = await cloudGet(env, cfg, `/organizations/${cfg.orgId}/prometheus?filtered_metrics=true`, { refresh: req.query.refresh === '1' });
      res.json({ fetchedAt: new Date().toISOString(), services: parsePrometheusServices(text || '') });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/cost/settings', (req, res) => {
    res.json(readSettings());
  });

  app.put('/api/cost/settings', (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CostError(400, 'Settings must be a JSON object', 'bad_request');
      const settings = {
        prices: body.prices && typeof body.prices === 'object' ? body.prices : {},
        envs: body.envs && typeof body.envs === 'object' ? body.envs : {},
        teams: sanitizeTeams(body.teams),
      };
      if (JSON.stringify(settings).length > 1_000_000) throw new CostError(400, 'Settings too large', 'bad_request');
      writeSettings(settings);
      res.json(settings);
    } catch (err) {
      sendError(res, err);
    }
  });
}
