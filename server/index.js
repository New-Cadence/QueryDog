import express from 'express';
import tls from 'tls';
import cors from 'cors';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import figlet from 'figlet';
import https from 'https';
import http from 'http';
import dns from 'dns';
import { AsyncLocalStorage } from 'node:async_hooks';
import { recordCheckRun, runStats, runLog, clearRuns } from './db.js';
import { startScheduler } from './scheduler.js';
import { registerExtensions } from './extensions/index.js';
import { isBlockedStatement, leadingKeyword } from './sqlGuard.js';
import { checkMeta, durationLimits, durationStatus, parseSqlHeader, readSqlHeader } from './sqlHeader.js';
import { createAuth } from './auth.js';
import { validateConfig } from './configValidation.js';

// Force IPv4 to avoid Docker Desktop networking issues
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Login (querydog.yml `auth:`); a no-op until users are configured
const auth = createAuth({
  readAuthConfig: () => {
    const yamlPath = findConfigPath();
    try { return (yamlPath && yaml.load(fs.readFileSync(yamlPath, 'utf-8')))?.auth || null; } catch { return null; }
  },
});
app.use(auth.middleware);
auth.register(app);
app.use((req, res, next) => {
  const name = req.get('X-QueryDog-Environment');
  if (!name) return next();
  const env = environments.find(e => e.name === name);
  if (!env) return res.status(400).json({ error: `Unknown environment "${name}"` });
  const trigger = req.get('X-QueryDog-Trigger') === 'scheduler' ? 'scheduler' : 'manual';
  requestEnv.run({ env, client: clientForEnv(env), trigger }, next);
});

// Serve static files from the dist folder in production
app.use(express.static(path.join(__dirname, '../dist')));

// ==================== YAML CONFIG ====================

// Get home directory cross-platform
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';

// Search paths for querydog.yml in priority order
function getConfigSearchPaths() {
  return [
    path.join(process.cwd(), 'querydog.yml'),           // Current working directory
    path.join(HOME_DIR, 'querydog.yml'),                // Home directory ~/querydog.yml
    path.join(__dirname, '../querydog.yml'),            // Relative to server dir
    '/app/querydog.yml',                                // Docker mount path
  ].filter(Boolean);
}

// Track which config file was loaded
let loadedConfigPath = null;

// Find first existing config file (must be a file, not a directory)
function findConfigPath() {
  const searchPaths = getConfigSearchPaths();
  for (const configPath of searchPaths) {
    if (fs.existsSync(configPath)) {
      const stat = fs.statSync(configPath);
      if (stat.isDirectory()) {
        console.error(`ERROR: ${configPath} is a directory, not a file. Skipping.`);
        continue;
      }
      return configPath;
    }
  }
  return null;
}

// Whether an environment is ClickHouse Cloud or self-managed open source.
// Explicit `deployment: cloud | oss` in querydog.yml wins; otherwise infer from the host.
function resolveDeployment(env) {
  if (env.deployment === 'cloud' || env.deployment === 'oss') return env.deployment;
  return /\.clickhouse\.cloud$/i.test(String(env.host || '').trim()) ? 'cloud' : 'oss';
}

// A querydog.yml that fails validation, with every problem found
class ConfigError extends Error {
  constructor(file, problems) {
    super(`Invalid ${file}:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

// Load environments from querydog.yml, falling back to .env
function loadConfig(options = {}) {
  const { quiet = false } = options;
  const yamlPath = findConfigPath();

  if (yamlPath) {
    let raw;
    try {
      raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
    } catch (e) {
      throw new ConfigError(yamlPath, [`not valid YAML: ${e.message}`]);
    }
    const problems = validateConfig(raw);
    if (problems.length) throw new ConfigError(yamlPath, problems);
    if (raw && raw.environments && raw.environments.length > 0) {
      loadedConfigPath = yamlPath;
      if (!quiet) {
        console.log(`Loaded ${raw.environments.length} environment(s) from ${yamlPath}`);
      }
      // Organisation shown in Database Connections: the top-level
      // organisation_name, unless an environment sets its own
      const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const organisationName = text(raw.organisation_name);
      return raw.environments.map((env, i) => {
        const name = env.name || 'Default';
        if (!env.host || !String(env.host).trim()) {
          throw new Error(
            `Environment "${name}" (#${i + 1} in ${yamlPath}) has no host. ` +
            `Set a hostname for it, or remove the environment from the config.`
          );
        }
        return {
          name,
          // Optional labels for display: who the environment belongs to and which one it is
          organisation: text(env.organisation_name) ?? text(env.organisation) ?? organisationName,
          organisation_override: text(env.organisation_name) ?? text(env.organisation),
          environment: typeof env.environment === 'string' && env.environment.trim() ? env.environment.trim() : null,
          host: String(env.host).trim(),
          port: env.port || (env.secure ? 8443 : 8123),
          user: env.user || 'default',
          password: env.password || '',
          database: env.database || 'default',
          secure: env.secure || false,
          tls_reject_unauthorized: env.tls_reject_unauthorized !== false,
          // Resolved cluster name, or null for a single server. cluster: true uses
          // cluster_name (default "default", the cluster every Cloud service has);
          // a string is the older way of naming the cluster.
          cluster: typeof env.cluster === 'string' ? env.cluster.trim() : env.cluster === true ? (env.cluster_name || 'default').trim() : null,
          cluster_setting: typeof env.cluster === 'string' ? true : env.cluster === true || env.cluster === false ? env.cluster : null,
          cluster_name: typeof env.cluster === 'string' ? env.cluster.trim() : env.cluster_name || null,
          is_default: env.default === true,
          queries_folder: env.queries_folder || null,
          http_headers: env.http_headers || {},
          deployment: resolveDeployment(env),
          // What the config file says (null when inferred), so saving doesn't pin an inferred value
          deployment_setting: env.deployment === 'cloud' || env.deployment === 'oss' ? env.deployment : null,
          // Optional ClickHouse Cloud API credentials (key_id, key_secret, organization_id, service_id) for billing data
          cloud_api: env.cloud_api || null,
          // Per-environment schedule (read by server/scheduler.js), kept so saving doesn't drop it
          scheduler: env.scheduler ?? null,
          _embeddedId: env._embeddedId || null,
        };
      });
    }
  }

  // Fallback to .env
  if (!quiet) {
    const searchPaths = getConfigSearchPaths();
    console.log('No querydog.yml found in:', searchPaths.join(', '));
    console.log('Falling back to .env');
  }
  return [{
    name: 'Default',
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT_HTTP || '8123'),
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'default',
    secure: process.env.CLICKHOUSE_SECURE === '1',
    tls_reject_unauthorized: process.env.CLICKHOUSE_TLS_REJECT_UNAUTHORIZED !== '0',
    cluster: process.env.CLICKHOUSE_CLUSTER || null,
    queries_folder: process.env.QUERYDOG_QUERIES_FOLDER || null,
    deployment: resolveDeployment({ host: process.env.CLICKHOUSE_HOST, deployment: process.env.CLICKHOUSE_DEPLOYMENT }),
  }];
}

let environments;
try {
  environments = loadConfig();
} catch (e) {
  // Refuse to start on a broken config, listing what to fix
  console.error(`\n${e.message}\n`);
  process.exit(1);
}

// ==================== CLIENT CONFIG FOLDER ====================
// Each client's checks and queries live in one folder (e.g. clienta/) with a
// sub-folder per class. querydog.yml picks the client and can point any class
// elsewhere:
//   client: clienta
//   folders:
//     monitoring: monitoring     # relative to the client folder, or absolute
// QUERYDOG_CLIENT overrides `client`.
const CLIENT_FOLDER_KINDS = ['monitoring', 'alerts', 'performance', 'dataquality'];
const DEFAULT_CLIENT = 'clienta';
let clientConfig = { client: DEFAULT_CLIENT, folders: {} };

function loadClientConfig() {
  const yamlPath = findConfigPath();
  let raw = {};
  try {
    raw = (yamlPath && yaml.load(fs.readFileSync(yamlPath, 'utf-8'))) || {};
  } catch (e) {
    console.error(`Could not read client settings from ${yamlPath}:`, e.message);
  }
  const folders = {};
  if (raw.folders && typeof raw.folders === 'object') {
    for (const kind of CLIENT_FOLDER_KINDS) {
      if (typeof raw.folders[kind] === 'string' && raw.folders[kind].trim()) folders[kind] = raw.folders[kind].trim();
    }
  }
  clientConfig = { client: process.env.QUERYDOG_CLIENT || (typeof raw.client === 'string' && raw.client.trim()) || DEFAULT_CLIENT, folders };
}
loadClientConfig();

const resolveFromCwd = (p) => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));
const getClientDir = () => resolveFromCwd(clientConfig.client);
function getClientFolder(kind) {
  const configured = clientConfig.folders[kind] || kind;
  return path.isAbsolute(configured) ? configured : path.join(getClientDir(), configured);
}

// Active environment state
let activeEnvIndex = 0;
let activeClient = null;
let CLICKHOUSE_CLUSTER = null;

// A request can name an environment with X-QueryDog-Environment (the backend
// scheduler does, to run checks against every environment). It then uses that
// environment's client for its whole lifetime, while the UI keeps its own
// selection. Without the header, requests use the active environment.
const requestEnv = new AsyncLocalStorage();
const envClients = new Map(); // connection key -> client for header-selected environments
const scopedEnv = () => requestEnv.getStore()?.env ?? environments[activeEnvIndex];
const requestTrigger = () => requestEnv.getStore()?.trigger ?? 'manual';
// Failures where the request never reached ClickHouse, so retrying can't run
// a statement twice: connect timeouts / refusals and TLS handshakes that never finished
const CONNECT_FAILURE_RE = /ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ECONNECTTIMEOUT|Connection timed out after|socket disconnected before secure TLS connection/i;
const isConnectFailure = (err) => CONNECT_FAILURE_RE.test(`${err?.code ?? ''} ${err?.message ?? ''}`);
const RETRIED_METHODS = new Set(['query', 'command', 'exec']);

// `client` follows the request's environment; every route uses it unchanged.
// Queries that fail to connect are retried once.
const client = new Proxy({}, {
  get(_, prop) {
    const target = requestEnv.getStore()?.client ?? activeClient;
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (!RETRIED_METHODS.has(prop)) return value.bind(target);
    return async (...args) => {
      try {
        return await value.apply(target, args);
      } catch (err) {
        if (!isConnectFailure(err)) throw err;
        console.warn(`ClickHouse connection failed (${err.code || err.message}); retrying once`);
        return value.apply(target, args);
      }
    };
  },
});

// Bound how long opening a connection can take. ClickHouse Cloud hostnames
// resolve to several addresses: autoSelectFamily tries the next one when an
// address doesn't answer within CONNECT_ATTEMPT_MS, and the whole connect is
// abandoned after CONNECT_TIMEOUT_MS instead of the OS default (~75s).
const CONNECT_ATTEMPT_MS = 2500;
const CONNECT_TIMEOUT_MS = 10000;
function limitConnect(agent) {
  const create = agent.createConnection.bind(agent);
  agent.createConnection = (options, callback) => {
    const socket = create({ ...options, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS }, callback);
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`), { code: 'ECONNECTTIMEOUT' }));
    }, CONNECT_TIMEOUT_MS);
    const done = () => clearTimeout(timer);
    for (const event of ['connect', 'secureConnect', 'error', 'close']) socket.once(event, done);
    return socket;
  };
  return agent;
}

function clientForEnv(env) {
  const key = JSON.stringify([env.host, env.port, env.user, env.password, env.database, env.secure, env.http_headers]);
  if (!envClients.has(key)) envClients.set(key, createClientForEnv(env));
  return envClients.get(key);
}
let QUERIES_FOLDER = null;

function createClientForEnv(env) {
  const protocol = env.secure ? 'https' : 'http';
  const agent = limitConnect(env.secure
    ? new https.Agent({
        family: 4,
        keepAlive: true,
        keepAliveMsecs: 10000,
        timeout: 60000,
        maxSockets: 5,
        maxFreeSockets: 2,
        rejectUnauthorized: env.tls_reject_unauthorized,
        servername: env.host,
        secureContext: tls.createSecureContext({
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.3',
        }),
      })
    : new http.Agent({ family: 4, keepAlive: true, keepAliveMsecs: 10000, timeout: 60000, maxSockets: 5 }));

  return createClient({
    url: `${protocol}://${env.host}:${env.port}`,
    username: env.user,
    password: env.password,
    database: env.database,
    request_timeout: 3600000,
    http_agent: agent,
    clickhouse_settings: {
      max_execution_time: 0,
      // Progress headers keep long queries' connections alive through load
      // balancers' idle timeouts (and silence the client's startup warning)
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: '110000',
      // Emit and parse every DateTime in UTC, whatever timezone the ClickHouse
      // server runs in. Results otherwise carry the server's wall clock with no
      // zone attached, and the browser reads them as its own local time, so one
      // row shows a different timestamp to viewers in different timezones.
      session_timezone: 'UTC',
    },
    keep_alive: { enabled: false },  // Disabled - chproxy blocks ping requests
    tls: env.secure ? { rejectUnauthorized: env.tls_reject_unauthorized } : undefined,
    http_headers: env.http_headers || undefined,
    // The client logs every failed request with its full arguments; errors
    // reach the callers anyway, which log one line each
    log: { level: ClickHouseLogLevel.OFF },
  });
}

function switchEnvironment(index) {
  if (index < 0 || index >= environments.length) throw new Error('Invalid environment index');
  const env = environments[index];
  const protocol = env.secure ? 'https' : 'http';

  // Close previous client
  if (activeClient) {
    activeClient.close().catch(() => {});
  }

  activeEnvIndex = index;
  activeClient = createClientForEnv(env);
  CLICKHOUSE_CLUSTER = env.cluster;
  QUERIES_FOLDER = env.queries_folder || null;

  console.log(`Switched to environment: "${env.name}" - ${protocol}://${env.host}:${env.port} as '${env.user}' on '${env.database}'`);
}

// Start on the environment marked `default: true` in querydog.yml, else the
// first one. QUERYDOG_DEFAULT_ENVIRONMENT (an environment name) overrides it.
function defaultEnvironmentIndex() {
  const wanted = process.env.QUERYDOG_DEFAULT_ENVIRONMENT;
  if (wanted) {
    const index = environments.findIndex(e => e.name === wanted);
    if (index !== -1) return index;
    console.warn(`QUERYDOG_DEFAULT_ENVIRONMENT "${wanted}" is not in querydog.yml`);
  }
  return Math.max(environments.findIndex(e => e.is_default), 0);
}
switchEnvironment(defaultEnvironmentIndex());

// Helper to check connection with timeout (6 seconds)
// Uses SELECT 1 instead of ping because chproxy blocks ping requests
const CONNECTION_TIMEOUT_MS = 6000;
async function pingWithTimeout(timeoutMs = CONNECTION_TIMEOUT_MS) {
  return Promise.race([
    client.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then(r => r.json()),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database connection timed out - server may be unreachable')), timeoutMs)
    )
  ]);
}

// An environment's queries_folder overrides the client's performance folder.
// 'queries' was the old default for every environment, so it is ignored.
const getQueriesPath = () => (QUERIES_FOLDER && QUERIES_FOLDER !== 'queries' ? resolveFromCwd(QUERIES_FOLDER) : getClientFolder('performance'));

// ==================== RUN HISTORY ====================
// Every run of a check, manual or scheduled, is stored in the Convoy
// database with its environment (server/db.js). Grids show the runs of the
// environment the request is for.
const RUN_KIND = { alert: 'monitoring', query: 'performance' };
function recordRun(type, filename, entry) {
  if (!filename || !RUN_KIND[type]) return;
  recordCheckRun({
    kind: RUN_KIND[type], checkId: filename, environment: scopedEnv().name, trigger: requestTrigger(),
    startedAt: entry.runTime, durationMs: entry.duration, rowCount: entry.rowCount, readRows: entry.readRows,
    readBytes: entry.readBytes, queryId: entry.queryId, status: entry.status || 'ok', error: entry.error, detail: entry.detail,
  });
}
function getAggregatesForFilename(type, filename) {
  return runStats(RUN_KIND[type], scopedEnv().name).get(filename) || null;
}
function getAggregatesByFilename(type) {
  return runStats(RUN_KIND[type], scopedEnv().name);
}
function getRunLog(type, filename, limit = 50) {
  return runLog(RUN_KIND[type], filename, scopedEnv().name, limit);
}
function clearRunStats(type, filename = null) {
  clearRuns(RUN_KIND[type], scopedEnv().name, filename);
}

// Returns a coarse identifier for the currently-connected ClickHouse env so
// the portal can route an alert to the right environment row. Falls back to
// env vars when the active env can't be resolved from the config.
function currentEnv() {
  try {
    const active = Array.isArray(environments) ? scopedEnv() : null;
    if (active) {
      return {
        name: active.name,
        _embeddedId: active._embeddedId || process.env.QUERYDOG_EMBEDDED_ENV_ID || null,
      };
    }
  } catch {}
  return { name: process.env.CLICKHOUSE_HOST || 'default', _embeddedId: process.env.QUERYDOG_EMBEDDED_ENV_ID || null };
}

// Slack: incoming-webhook POST. Fire-and-forget. URL from env.
async function sendSlackAlert({ filename, description, data, rowCount }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const preview = JSON.stringify(data.slice(0, 5), null, 2).slice(0, 1500);
  const rowsLabel = rowCount === 1 ? 'row' : 'rows';
  const descLine = description ? '\n' + description : '';
  const text = '*' + filename + '* — ' + rowCount + ' ' + rowsLabel + descLine + '\n\n```' + preview + '```';
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error('[alert] slack post failed:', e.message);
  }
}

// Portal webhook: HMAC-signed POST to ALERT_WEBHOOK_URL using the shared
// QUERYDOG_BOOTSTRAP_SECRET. The portal's /api/alerts/ingest endpoint
// verifies the X-Bootstrap-Auth header before persisting.
function alertWebhookConfig(/* env */) {
  return process.env.ALERT_WEBHOOK_URL
    ? { url: process.env.ALERT_WEBHOOK_URL, secret: process.env.QUERYDOG_BOOTSTRAP_SECRET || '' }
    : null;
}
async function sendAlertWebhook({ filename, description, data, rowCount, env }) {
  const cfg = alertWebhookConfig(env);
  if (!cfg) return;
  let severity = 'medium';
  if (/(_crit|_critical|_high)/i.test(filename)) severity = 'high';
  else if (/(_low|_info)/i.test(filename)) severity = 'low';
  const body = JSON.stringify({
    environmentId: (env && env._embeddedId) || process.env.QUERYDOG_EMBEDDED_ENV_ID || '',
    check: filename,
    title: filename.replace(/\.sql$/, '').replace(/_/g, ' '),
    description: description || (rowCount + ' row' + (rowCount === 1 ? '' : 's') + ' returned by ' + filename + '.'),
    severity,
    status: 'firing',
    rowCount,
    sample: data.slice(0, 25),
  });
  // Portal expects header shape: 't=<unix>,sig=<hex>' where sig = HMAC(secret, '<unix>.<body>')
  const t = Math.floor(Date.now() / 1000);
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', cfg.secret).update(t + '.' + body).digest('hex');
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Auth': 't=' + t + ',sig=' + sig },
      body,
    });
    if (!res.ok) {
      console.error('[alert] portal webhook ' + res.status + ': ' + await res.text());
    } else {
      console.log('[alert] portal webhook ok for ' + filename);
    }
  } catch (e) {
    console.error('[alert] portal webhook failed:', e.message);
  }
}
// ==================== END ALERTS RUN-LOG STUBS ====================

// ==================== ALERTS HELPERS ====================
const getAlertsPath = () => getClientFolder('monitoring');
const descriptionPathFor = (folder, sqlFilename) =>
  path.join(folder, sqlFilename.replace(/.sql$/, '.md'));
// A `-- description:` header in the .sql file wins; a sidecar .md file is the fallback
function readDescription(folder, sqlFilename) {
  const fromHeader = checkMeta(readSqlHeader(path.join(folder, sqlFilename)).meta).description;
  if (fromHeader) return fromHeader;
  try { return fs.readFileSync(descriptionPathFor(folder, sqlFilename), 'utf-8').trim(); }
  catch { return ''; }
}
function writeDescription(folder, sqlFilename, description) {
  const mdPath = descriptionPathFor(folder, sqlFilename);
  if (description && description.trim()) fs.writeFileSync(mdPath, description.trim() + '\n', 'utf-8');
  else if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
}


// Helper to get system table reference - uses clusterAllReplicas() if cluster is configured
function getSystemTable(tableName) {
  const cluster = scopedEnv()?.cluster ?? null;
  if (cluster) {
    return `clusterAllReplicas('${cluster}', system.${tableName})`;
  }
  return `system.${tableName}`;
}

// Wrap an async route handler so thrown errors propagate to the Express
// error middleware below instead of needing a try/catch per route.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Build an Express handler that returns column metadata for a system.<table>.
function columnsHandler(systemTable) {
  return asyncHandler(async (req, res) => {
    const query = `SELECT name, type, comment FROM system.columns WHERE database = 'system' AND table = '${systemTable}' ORDER BY position`;
    const result = await client.query({ query, format: 'JSONEachRow' });
    res.json(await result.json());
  });
}

// Health check endpoint - tests ClickHouse connection (6 second timeout)
app.get('/api/health', async (req, res) => {
  try {
    await pingWithTimeout();
    res.json({
      status: 'healthy',
      clickhouse: 'connected'
    });
  } catch (error) {
    console.error('ClickHouse connection failed:', error.message);
    res.status(503).json({
      status: 'unhealthy',
      clickhouse: 'disconnected',
      error: error.message
    });
  }
});

// Connection info endpoint (6 second timeout)
app.get('/api/connection-info', async (req, res) => {
  const env = environments[activeEnvIndex];
  try {
    await pingWithTimeout();
    res.json({
      name: env.name,
      host: env.host,
      port: env.port,
      secure: env.secure,
      user: env.user,
      cluster: CLICKHOUSE_CLUSTER || null,
      deployment: env.deployment,
      connected: true
    });
  } catch (error) {
    console.error('ClickHouse connection failed:', error.message);
    res.status(503).json({
      name: env.name,
      host: env.host,
      port: env.port,
      secure: env.secure,
      user: env.user,
      cluster: CLICKHOUSE_CLUSTER || null,
      connected: false,
      error: error.message
    });
  }
});

// Read environments directly from querydog.yml (no ClickHouse connection required)
app.get('/api/config/environments', (req, res) => {
  const envs = loadConfig({ quiet: true });
  res.json({
    active: activeEnvIndex,
    environments: envs.map((env, i) => ({
      index: i,
      name: env.name,
      organisation: env.organisation || null,
      environment: env.environment || null,
      host: env.host,
      port: env.port,
      user: env.user,
      database: env.database,
      deployment: env.deployment,
    })),
  });
});

// Get config file info (useful for debugging)
app.get('/api/config/info', (req, res) => {
  res.json({
    loadedPath: loadedConfigPath,
    searchPaths: getConfigSearchPaths(),
    cwd: process.cwd(),
    homeDir: HOME_DIR,
  });
});

// List all environments
app.get('/api/environments', (req, res) => {
  // Reload from disk to pick up any external config changes
  reloadEnvironments();

  res.json({
    active: activeEnvIndex,
    environments: environments.map((env, i) => ({
      index: i,
      name: env.name,
      organisation: env.organisation || null,
      environment: env.environment || null,
      host: env.host,
      port: env.port,
      user: env.user,
      database: env.database,
      deployment: env.deployment,
    })),
  });
});

// Switch environment (6 second timeout)
app.post('/api/environments/switch', async (req, res) => {
  // Reload from disk to pick up any external config changes
  reloadEnvironments();

  const { index } = req.body;
  if (index === undefined || index < 0 || index >= environments.length) {
    return res.status(400).json({ error: 'Invalid environment index' });
  }
  try {
    switchEnvironment(index);
    // Test the new connection with timeout
    await pingWithTimeout();
    const env = environments[index];
    res.json({
      name: env.name,
      host: env.host,
      port: env.port,
      secure: env.secure,
      user: env.user,
      cluster: CLICKHOUSE_CLUSTER || null,
      connected: true
    });
  } catch (error) {
    const env = environments[index];
    res.status(503).json({
      name: env.name,
      host: env.host,
      port: env.port,
      secure: env.secure,
      user: env.user,
      cluster: CLICKHOUSE_CLUSTER || null,
      connected: false,
      error: error.message
    });
  }
});

// ==================== ENVIRONMENT MANAGEMENT API ====================

// Helper to get querydog.yml path (uses loaded path or falls back to home dir)
function getYamlPath() {
  // Return the path that was loaded, or default to home directory
  return loadedConfigPath || path.join(HOME_DIR, 'querydog.yml');
}

// Helper to save environments to querydog.yml
function saveConfig(envs) {
  const yamlPath = getYamlPath();
  let existing = {};
  try {
    existing = (fs.existsSync(yamlPath) && yaml.load(fs.readFileSync(yamlPath, 'utf-8'))) || {};
  } catch {
    existing = {};
  }
  // Keep top-level settings other than environments (client, folders, ...)
  const data = { ...existing, environments: envs.map(env => {
    const result = {
      name: env.name,
      ...(env.organisation_override ? { organisation_name: env.organisation_override } : {}),
      ...(env.environment ? { environment: env.environment } : {}),
      host: env.host,
      port: env.port,
      user: env.user,
      password: env.password,
      database: env.database,
      secure: env.secure,
    };
    // Only include optional fields if they have values
    if (env.tls_reject_unauthorized === false) {
      result.tls_reject_unauthorized = false;
    }
    if (env.is_default) {
      result.default = true;
    }
    if (env.cluster_setting !== null && env.cluster_setting !== undefined) {
      result.cluster = env.cluster_setting;
      if (env.cluster_setting && env.cluster_name && env.cluster_name !== 'default') result.cluster_name = env.cluster_name;
    } else if (env.cluster) {
      result.cluster = true;
      if (env.cluster !== 'default') result.cluster_name = env.cluster;
    }
    if (env.queries_folder && env.queries_folder !== 'queries') {
      result.queries_folder = env.queries_folder;
    }
    if (env.http_headers && Object.keys(env.http_headers).length > 0) {
      result.http_headers = env.http_headers;
    }
    if (env.deployment_setting) {
      result.deployment = env.deployment_setting;
    }
    if (env.cloud_api) {
      result.cloud_api = env.cloud_api;
    }
    if (env.scheduler !== null && env.scheduler !== undefined) {
      result.scheduler = env.scheduler;
    }
    if (env._embeddedId) {
      result._embeddedId = env._embeddedId;
    }
    return result;
  })};
  fs.writeFileSync(yamlPath, yaml.dump(data, { lineWidth: -1, quotingType: '"' }), 'utf-8');
}

// Helper to reload environments from disk
function reloadEnvironments() {
  let newEnvs;
  try {
    newEnvs = loadConfig({ quiet: true });
  } catch (e) {
    // Keep running on the last good config; the file is fixed and reloaded later
    console.error(`${e.message}\nKeeping the environments loaded earlier.`);
    return;
  }
  environments.length = 0;
  environments.push(...newEnvs);
  loadClientConfig();
}

// Which client folder is loaded and where each class of checks comes from
app.get('/api/client', (req, res) => {
  res.json({
    client: clientConfig.client,
    path: getClientDir(),
    folders: Object.fromEntries(CLIENT_FOLDER_KINDS.map(kind => {
      const dir = kind === 'performance' ? getQueriesPath() : getClientFolder(kind);
      const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      // alerts holds rules.yml; the other classes are .sql files
      const files = !exists ? 0 : kind === 'alerts'
        ? (fs.existsSync(path.join(dir, 'rules.yml')) ? 1 : 0)
        : fs.readdirSync(dir).filter(f => f.endsWith('.sql')).length;
      return [kind, { path: dir, exists, files }];
    })),
  });
});

// Get full environment details (including secure fields for editing)
app.get('/api/config/environments/full', (req, res) => {
  const envs = loadConfig({ quiet: true });
  res.json({
    active: activeEnvIndex,
    environments: envs.map((env, i) => ({
      index: i,
      name: env.name,
      organisation: env.organisation || null,
      environment: env.environment || null,
      host: env.host,
      port: env.port,
      user: env.user,
      password: env.password,
      database: env.database,
      secure: env.secure,
      tls_reject_unauthorized: env.tls_reject_unauthorized,
      cluster: env.cluster || '',
      queries_folder: env.queries_folder || null,
      http_headers: env.http_headers || {},
      deployment: env.deployment,
    })),
  });
});

// Add new environment
app.post('/api/config/environments', (req, res) => {
  try {
    const { name, host, port, user, password, database, secure, tls_reject_unauthorized, cluster, queries_folder, http_headers, deployment } = req.body;

    // Validate required fields
    if (!name || !host) {
      return res.status(400).json({ error: 'Name and host are required' });
    }

    const envs = loadConfig({ quiet: true });
    const newEnv = {
      name,
      organisation_override: typeof req.body.organisation === 'string' && req.body.organisation.trim() ? req.body.organisation.trim() : null,
      environment: typeof req.body.environment === 'string' && req.body.environment.trim() ? req.body.environment.trim() : null,
      host,
      port: parseInt(port) || (secure ? 8443 : 8123),
      user: user || 'default',
      password: password || '',
      database: database || 'default',
      secure: secure || false,
      tls_reject_unauthorized: tls_reject_unauthorized !== false,
      // The editor sends a cluster name; empty means a single server
      cluster: cluster ? String(cluster).trim() : null,
      cluster_setting: !!cluster,
      cluster_name: cluster ? String(cluster).trim() : null,
      queries_folder: queries_folder || null,
      http_headers: http_headers || {},
      deployment_setting: deployment === 'cloud' || deployment === 'oss' ? deployment : null,
    };

    envs.push(newEnv);
    saveConfig(envs);
    reloadEnvironments();

    console.log(`Added new environment: "${name}"`);
    res.json({
      success: true,
      index: envs.length - 1,
      environment: {
        index: envs.length - 1,
        name: newEnv.name,
        host: newEnv.host,
        port: newEnv.port,
        user: newEnv.user,
        database: newEnv.database,
      }
    });
  } catch (error) {
    console.error('Failed to add environment:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Update environment
app.put('/api/config/environments/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const envs = loadConfig({ quiet: true });

    if (index < 0 || index >= envs.length) {
      return res.status(400).json({ error: 'Invalid environment index' });
    }

    const { name, host, port, user, password, database, secure, tls_reject_unauthorized, cluster, queries_folder, http_headers, deployment } = req.body;

    // Validate required fields
    if (!name || !host) {
      return res.status(400).json({ error: 'Name and host are required' });
    }

    envs[index] = {
      name,
      organisation_override: req.body.organisation !== undefined ? (String(req.body.organisation || '').trim() || null) : envs[index].organisation_override,
      environment: req.body.environment !== undefined ? (String(req.body.environment || '').trim() || null) : envs[index].environment,
      host,
      port: parseInt(port) || (secure ? 8443 : 8123),
      user: user || 'default',
      password: password || '',
      database: database || 'default',
      secure: secure || false,
      tls_reject_unauthorized: tls_reject_unauthorized !== false,
      // The editor sends a cluster name; empty means a single server
      cluster: cluster ? String(cluster).trim() : null,
      cluster_setting: !!cluster,
      cluster_name: cluster ? String(cluster).trim() : null,
      queries_folder: queries_folder || null,
      http_headers: http_headers || {},
      // Fields the edit form doesn't manage are carried over from the existing entry
      deployment_setting: deployment === 'cloud' || deployment === 'oss' ? deployment : envs[index].deployment_setting,
      cloud_api: envs[index].cloud_api,
      is_default: envs[index].is_default,
      scheduler: envs[index].scheduler,
      _embeddedId: envs[index]._embeddedId,
    };

    saveConfig(envs);
    reloadEnvironments();

    // If we updated the active environment, reconnect
    if (index === activeEnvIndex) {
      switchEnvironment(index);
    }

    console.log(`Updated environment ${index}: "${name}"`);
    res.json({
      success: true,
      environment: {
        index,
        name: envs[index].name,
        host: envs[index].host,
        port: envs[index].port,
        user: envs[index].user,
        database: envs[index].database,
      }
    });
  } catch (error) {
    console.error('Failed to update environment:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete environment
app.delete('/api/config/environments/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const envs = loadConfig({ quiet: true });

    if (index < 0 || index >= envs.length) {
      return res.status(400).json({ error: 'Invalid environment index' });
    }

    if (envs.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last environment' });
    }

    const deletedName = envs[index].name;
    envs.splice(index, 1);
    saveConfig(envs);
    reloadEnvironments();

    // Adjust active index if needed
    if (activeEnvIndex >= envs.length) {
      switchEnvironment(envs.length - 1);
    } else if (activeEnvIndex === index) {
      // Reconnect to same index (now different env)
      switchEnvironment(activeEnvIndex);
    }

    console.log(`Deleted environment: "${deletedName}"`);
    res.json({ success: true, message: `Deleted environment: ${deletedName}` });
  } catch (error) {
    console.error('Failed to delete environment:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Test connection without switching
app.post('/api/config/environments/test', async (req, res) => {
  const { host, port, user, password, database, secure, tls_reject_unauthorized, http_headers } = req.body;

  if (!host) {
    return res.status(400).json({ error: 'Host is required' });
  }

  const testEnv = {
    host,
    port: parseInt(port) || (secure ? 8443 : 8123),
    user: user || 'default',
    password: password || '',
    database: database || 'default',
    secure: secure || false,
    tls_reject_unauthorized: tls_reject_unauthorized !== false,
    http_headers: http_headers || {},
  };

  let testClient = null;
  try {
    testClient = createClientForEnv(testEnv);

    // Test with timeout
    await Promise.race([
      testClient.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then(r => r.json()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out')), CONNECTION_TIMEOUT_MS)
      )
    ]);

    res.json({ success: true, message: 'Connection successful' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (testClient) {
      testClient.close().catch(() => {});
    }
  }
});

// Define which fields are arrays for proper filtering
const ARRAY_FIELDS = [
  'databases', 'tables', 'columns', 'partitions', 'projections', 'views',
  'used_functions', 'used_aggregate_functions', 'used_aggregate_function_combinators',
  'used_database_engines', 'used_data_type_families', 'used_dictionaries',
  'used_formats', 'used_storages', 'used_table_functions',
  'used_executable_user_defined_functions', 'used_sql_user_defined_functions',
  'used_row_policies', 'used_privileges', 'missing_privileges', 'thread_ids'
];

// Filter/column names from the browser are interpolated into SQL, so only
// plain identifiers are accepted; anything else is ignored.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Wrap user text for ILIKE so '%' and '_' in it match literally.
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
}

// Build filter condition handling both scalar and array fields
function buildFilterCondition(field, values, params, paramIndex) {
  const paramName = `filter_${paramIndex}`;
  if (!SAFE_IDENTIFIER.test(field)) return '1';

  // Special case: primary_table filters by the first element of tables array
  // This is useful for finding queries WHERE a table is the primary target (e.g., INSERT INTO target)
  if (field === 'primary_table') {
    params[paramName] = values;
    return `tables[1] IN {${paramName}:Array(String)}`;
  }

  // Special case: query_kind filtering
  // 1. 'Insert' should also match 'AsyncInsertFlush'
  // 2. In clusters, secondary/forwarded queries have empty query_kind, so also match by query text
  if (field === 'query_kind') {
    const expandedValues = [...values];
    if (values.includes('Insert') && !values.includes('AsyncInsertFlush')) {
      expandedValues.push('AsyncInsertFlush');
    }
    params[paramName] = expandedValues;

    // Build conditions: either query_kind matches OR (query_kind is empty AND query text matches)
    const conditions = [`toString(${field}) IN {${paramName}:Array(String)}`];

    // For clusters: also match queries with empty query_kind by inspecting query text
    const textMatches = [];
    if (values.includes('Insert')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'INSERT%'");
    }
    if (values.includes('Select')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'SELECT%'");
    }
    if (values.includes('Delete')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'DELETE%'");
    }
    if (values.includes('Create')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'CREATE%'");
    }
    if (values.includes('Alter')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'ALTER%'");
    }
    if (values.includes('Drop')) {
      textMatches.push("upper(trimLeft(query)) LIKE 'DROP%'");
    }

    if (textMatches.length > 0) {
      conditions.push(`(toString(${field}) IN ('', 'None') AND (${textMatches.join(' OR ')}))`);
    }

    return `(${conditions.join(' OR ')})`;
  }

  if (ARRAY_FIELDS.includes(field)) {
    // For array fields, use hasAny to check if array contains any of the values
    params[paramName] = values;
    return `hasAny(${field}, {${paramName}:Array(String)})`;
  } else {
    // For scalar fields, use IN
    params[paramName] = values;
    return `toString(${field}) IN {${paramName}:Array(String)}`;
  }
}

// Build range filter conditions
function buildRangeFilterConditions(rangeFilters, whereConditions, params) {
  if (!rangeFilters) return;
  const parsed = JSON.parse(rangeFilters);
  for (const [field, range] of Object.entries(parsed)) {
    if (!SAFE_IDENTIFIER.test(field) || !range) continue; // Safety check
    for (const [bound, op] of [['min', '>='], ['max', '<=']]) {
      const value = Number(range[bound]);
      if (range[bound] === undefined || range[bound] === null || !Number.isFinite(value)) continue;
      const paramName = `${field}_${bound}`;
      whereConditions.push(`${field} ${op} {${paramName}:Float64}`);
      params[paramName] = value;
    }
  }
}

function applyQueryLogSearch(search, whereConditions, params) {
  if (!search) return;
  const searchText = String(search).trim();
  if (!searchText) return;

  const normalizedSearch = searchText.replace(/[`"]/g, '');
  params.search = searchText;

  const clauses = [
    'positionCaseInsensitive(query, {search:String}) > 0',
    'positionCaseInsensitive(query_id, {search:String}) > 0',
    'positionCaseInsensitive(initial_query_id, {search:String}) > 0',
  ];

  if (normalizedSearch !== searchText) {
    clauses.push("positionCaseInsensitive(replaceAll(query, '`', ''), {search_normalized:String}) > 0");
    params.search_normalized = normalizedSearch;
  }

  whereConditions.push(`(${clauses.join(' OR ')})`);

  // Exclude internal query-log queries unless the user explicitly searches for query_log
  if (!/query_log/i.test(searchText)) {
    whereConditions.push("query NOT ILIKE '%system.query_log%'");
  }
}

// The browser sends start/end as naive 'YYYY-MM-DD HH:MM:SS' strings derived
// from Date.toISOString(), so they are always UTC. A bare {start:DateTime}
// makes ClickHouse parse them in the *server's* timezone, silently shifting
// every window by the server's UTC offset and hiding rows. Every bound below
// is therefore pinned with DateTime('UTC'); DateTime compares as epoch
// seconds, so this is correct whatever timezone the server runs in.

// Get effective end time - if start and end are the same, extend end to include the full bucket
function getEffectiveEndTime(start, end, bucket = 'minute') {
  if (!start || !end || start !== end) return end;
  const endDate = new Date(end);
  if (isNaN(endDate.getTime())) return end;

  switch (bucket) {
    case 'second':
      return end;
    case 'hour':
      endDate.setMinutes(59, 59, 999);
      break;
    default:
      endDate.setSeconds(59, 999);
      break;
  }

  return endDate.toISOString().replace('T', ' ').slice(0, 19);
}

// Helper: Add event_date and event_time conditions for query_log queries.
// If force_index_by_date is enabled, ClickHouse requires an event_date predicate
// so the merge-tree engine can prune partitions before scanning.
function applyQueryLogDateRange(start, end, bucket, whereConditions, params) {
  // event_date is materialised by the server in the server's own timezone,
  // while these bounds are UTC (see EVENT_TIME_FROM). Within a few hours of
  // midnight the two disagree by a day, so an exact event_date bound could
  // prune a partition that event_time still matches. Widening by a day costs
  // at most two extra partitions and is always enough: UTC offsets never
  // exceed +/-14 hours. event_time remains the predicate that decides the rows.
  if (start) {
    whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')}) - 1');
    whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
    params.start = start;
  }
  if (end) {
    const effectiveEnd = getEffectiveEndTime(start, end, bucket);
    whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')}) + 1');
    whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
    params.end = effectiveEnd;
  }
}

// Get query log entries
app.get('/api/query-log', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, limit = 1000, offset = 0, sortField = 'event_time', sortOrder = 'DESC', filters, rangeFilters } = req.query;

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  // Parse and apply field filters with array support
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Allow sorting by most columns (alphanumeric only for safety)
  const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'event_time';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const query = `
    SELECT *
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
  `;

  params.limit = parseInt(limit);
  params.offset = parseInt(offset);

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get column metadata from system.columns (must be before :field routes)
app.get('/api/query-log/columns', columnsHandler('query_log'));

// Get time series data for chart
app.get('/api/query-log/timeseries', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, filters, rangeFilters } = req.query;

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  let truncFunc;
  switch (bucket) {
    case 'second':
      truncFunc = 'toDateTime(event_time_microseconds)';
      break;
    case 'hour':
      truncFunc = 'toStartOfHour(event_time)';
      break;
    default:
      truncFunc = 'toStartOfMinute(event_time)';
  }

  const query = `
    SELECT
      ${truncFunc} as time,
      count() as count,
      avg(query_duration_ms) as avg_duration,
      max(query_duration_ms) as max_duration,
      min(query_duration_ms) as min_duration,
      sum(query_duration_ms) as sum_duration,
      avg(memory_usage) as avg_memory,
      max(memory_usage) as max_memory,
      min(memory_usage) as min_memory,
      sum(memory_usage) as sum_memory,
      avg(read_rows) as avg_read_rows,
      max(read_rows) as max_read_rows,
      min(read_rows) as min_read_rows,
      sum(read_rows) as sum_read_rows,
      avg(written_rows) as avg_written_rows,
      max(written_rows) as max_written_rows,
      min(written_rows) as min_written_rows,
      sum(written_rows) as sum_written_rows,
      avg(result_rows) as avg_result_rows,
      max(result_rows) as max_result_rows,
      min(result_rows) as min_result_rows,
      sum(result_rows) as sum_result_rows
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    GROUP BY time
    ORDER BY time ASC
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get stacked time series data for chart (grouped by query_kind)
// Columns the stacked chart can split by query kind, besides the plain count
const STACKED_METRIC_COLUMNS = { duration: 'query_duration_ms', memory: 'memory_usage', read_rows: 'read_rows', written_rows: 'written_rows', result_rows: 'result_rows' };
const STACKED_AGGREGATIONS = ['avg', 'sum', 'min', 'max'];

app.get('/api/query-log/timeseries-stacked', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, filters, rangeFilters, metric = 'count', agg = 'avg' } = req.query;
  // Allow-listed, so safe to interpolate: countIf(cond), or e.g. avgIf(memory_usage, cond)
  const column = STACKED_METRIC_COLUMNS[metric];
  const fn = STACKED_AGGREGATIONS.includes(agg) ? agg : 'avg';
  const kindValue = (cond) => (column ? `ifNotFinite(${fn}If(${column}, ${cond}), 0)` : `countIf(${cond})`);

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  let truncFunc;
  switch (bucket) {
    case 'second':
      truncFunc = 'toDateTime(event_time_microseconds)';
      break;
    case 'hour':
      truncFunc = 'toStartOfHour(event_time)';
      break;
    default:
      truncFunc = 'toStartOfMinute(event_time)';
  }

  // In clusters, secondary/forwarded queries have empty query_kind, so also match by query text
  const query = `
    SELECT
      ${truncFunc} as time,
      ${kindValue(`query_kind = 'Select' OR (query_kind IN ('', 'None') AND upper(trimLeft(query)) LIKE 'SELECT%')`)} as Select,
      ${kindValue(`query_kind IN ('Insert', 'AsyncInsertFlush') OR (query_kind IN ('', 'None') AND upper(trimLeft(query)) LIKE 'INSERT%')`)} as Insert,
      ${kindValue(`query_kind = 'Delete' OR (query_kind IN ('', 'None') AND upper(trimLeft(query)) LIKE 'DELETE%')`)} as Delete,
      ${kindValue(`query_kind NOT IN ('Select', 'Insert', 'AsyncInsertFlush', 'Delete', '', 'None')
        OR (query_kind IN ('', 'None') AND upper(trimLeft(query)) NOT LIKE 'SELECT%' AND upper(trimLeft(query)) NOT LIKE 'INSERT%' AND upper(trimLeft(query)) NOT LIKE 'DELETE%')`)} as Other
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    GROUP BY time
    ORDER BY time ASC
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get profile events from query_log
app.get('/api/query-log/profile-events', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', limit = 1000, offset = 0, sortField = 'event_time', sortOrder = 'DESC', filters, rangeFilters, eventColumns, search } = req.query;

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Allow sorting by most columns (alphanumeric only for safety)
  const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'event_time';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  // Parse the event columns to extract from ProfileEvents map
  const eventColumnsList = eventColumns ? eventColumns.split(',') : [];
  const eventSelects = eventColumnsList.map(col => {
    // Sanitize column name (alphanumeric and underscore only)
    const safeName = col.replace(/[^a-zA-Z0-9_]/g, '');
    return `ProfileEvents['${safeName}'] as ${safeName}`;
  }).join(',\n        ');

  const query = `
    SELECT
      event_time,
      query_id,
      query as query_text,
      query_duration_ms,
      ${eventSelects}
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
  `;

  params.limit = parseInt(limit);
  params.offset = parseInt(offset);

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get histogram data for a specific field
app.get('/api/query-log/histogram/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const { start, end, bucket = 'minute', limit = 20, search, filters, rangeFilters } = req.query;

  const scalarFields = [
    'client_name', 'user', 'type', 'query_kind', 'current_database',
    'exception_code', 'is_initial_query', 'client_hostname'
  ];

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [f, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(f, values, params, paramIndex++));
      }
    }
  }

  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  params.limit = parseInt(limit);

  let query;
  if (ARRAY_FIELDS.includes(field)) {
    query = `
      SELECT
        arrayJoin(${field}) as name,
        count() as count
      FROM ${getSystemTable('query_log')}
      ${whereClause}
      GROUP BY name
      HAVING name != ''
      ORDER BY count DESC
      LIMIT {limit:UInt32}
    `;
  } else if (scalarFields.includes(field)) {
    query = `
      SELECT
        toString(${field}) as name,
        count() as count
      FROM ${getSystemTable('query_log')}
      ${whereClause}
      GROUP BY name
      ORDER BY count DESC
      LIMIT {limit:UInt32}
    `;
  } else {
    return res.status(400).json({ error: 'Invalid field' });
  }

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get distinct values for a field (for filters) - supports both scalar and array fields
app.get('/api/query-log/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const { start, end, bucket = 'minute', limit = 100 } = req.query;

  const scalarFields = [
    'client_name', 'user', 'type', 'query_kind', 'current_database',
    'exception_code', 'is_initial_query', 'client_hostname'
  ];

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  params.limit = parseInt(limit);

  let query;
  if (ARRAY_FIELDS.includes(field)) {
    // Most frequent first, so the LIMIT keeps the values people are likely to filter on
    query = `
      SELECT arrayJoin(${field}) as value
      FROM ${getSystemTable('query_log')}
      ${whereClause}
      GROUP BY value
      ORDER BY count() DESC, value
      LIMIT {limit:UInt32}
    `;
  } else if (scalarFields.includes(field)) {
    query = `
      SELECT toString(${field}) as value
      FROM ${getSystemTable('query_log')}
      ${whereClause}
      GROUP BY value
      ORDER BY count() DESC, value
      LIMIT {limit:UInt32}
    `;
  } else {
    return res.status(400).json({ error: 'Invalid field' });
  }

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// ==================== SYSTEM PARTS ENDPOINTS ====================

// Get system.parts data
app.get('/api/parts', asyncHandler(async (req, res) => {
  const { limit = 2500, offset = 0, sortField = 'modification_time', sortOrder = 'DESC', filters, search } = req.query;

  let whereConditions = [];
  const params = { limit: parseInt(limit), offset: parseInt(offset) };

  // Apply search filter (searches table, database, partition_id, name)
  if (search) {
    whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'modification_time';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const query = `
    SELECT *
    FROM ${getSystemTable('parts')}
    ${whereClause}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get system.parts columns
app.get('/api/parts/columns', columnsHandler('parts'));

// Get system.parts count
app.get('/api/parts/count', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  // Apply search filter
  if (search) {
    whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT count() as count
    FROM ${getSystemTable('parts')}
    ${whereClause}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json({ count: data[0]?.count || 0 });
}));

// Get grouped parts by table
app.get('/api/parts/grouped', async (req, res) => {
  try {
    const { filters, search } = req.query;

    let whereConditions = [];
    const params = {};

    // Apply search filter
    if (search) {
      whereConditions.push('(t.name ILIKE {search:String} OR t.database ILIKE {search:String})');
      params.search = likePattern(search);
    }

    // Apply field filters
    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        // Skip 'active' filter - it's already handled in the JOIN clause (p.active = 1)
        // and applying it to WHERE would exclude tables with no parts
        if (field === 'active') continue;
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          // Map field names to table aliases
          const fieldRef = field === 'table' ? 't.name' : field === 'database' ? 't.database' : `toString(${field})`;
          whereConditions.push(`${fieldRef} IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT
        t.database,
        t.name as table,
        t.engine_full as engine_full,
        count(DISTINCT p.partition_id) as partition_count,
        count(p.name) as part_count,
        sum(p.rows) as total_rows,
        sum(p.bytes_on_disk) as total_bytes,
        sum(p.data_compressed_bytes) as compressed_bytes,
        sum(p.data_uncompressed_bytes) as uncompressed_bytes,
        round((sum(p.data_uncompressed_bytes) - sum(p.data_compressed_bytes)) / nullIf(sum(p.data_uncompressed_bytes), 0) * 100, 1) as savings_pct,
        max(p.modification_time) as last_modification_time
      FROM system.tables t
      LEFT JOIN ${getSystemTable('parts')} p ON t.database = p.database AND t.name = p.table AND p.active = 1
      WHERE t.database != 'information_schema'
        AND t.engine NOT IN ('Dictionary', 'View', 'MaterializedView')
      ${whereConditions.length > 0 ? 'AND ' + whereConditions.join(' AND ') : ''}
      GROUP BY t.database, t.name, t.engine_full
      ORDER BY total_bytes DESC NULLS LAST
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching grouped parts:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.parts',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.parts does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get column compression details for a table
app.get('/api/table-compression/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;

  const query = `
    SELECT
      name,
      type,
      sum(data_compressed_bytes) AS compressed_bytes,
      sum(data_uncompressed_bytes) AS uncompressed_bytes,
      round((sum(data_uncompressed_bytes) - sum(data_compressed_bytes)) / nullIf(sum(data_uncompressed_bytes), 0) * 100, 1) AS savings_pct
    FROM ${getSystemTable('columns')}
    WHERE database = {database:String} AND table = {table:String}
    GROUP BY name, type
    ORDER BY compressed_bytes DESC
  `;

  const result = await client.query({
    query,
    query_params: { database, table },
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get aggregated partitions data (grouped by partition)
app.get('/api/partitions-summary', asyncHandler(async (req, res) => {
  const { limit = 2500, offset = 0, sortField = 'modification_time', sortOrder = 'DESC', filters, search } = req.query;

  let whereConditions = ['active = 1'];
  const params = { limit: parseInt(limit), offset: parseInt(offset) };

  // Apply search filter
  if (search) {
    whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String})');
    params.search = likePattern(search);
  }

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Map sort field to aggregated field if needed
  const sortFieldMap = {
    'rows': 'total_rows',
    'bytes_on_disk': 'total_bytes',
    'modification_time': 'latest_modification'
  };
  const mappedSortField = sortFieldMap[sortField] || sortField;
  const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(mappedSortField) ? mappedSortField : 'latest_modification';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const query = `
    SELECT
      database,
      table,
      partition_id,
      partition,
      count() as parts_count,
      sum(rows) as total_rows,
      sum(bytes_on_disk) as total_bytes,
      sum(data_compressed_bytes) as total_compressed,
      sum(data_uncompressed_bytes) as total_uncompressed,
      round((sum(data_uncompressed_bytes) - sum(data_compressed_bytes)) / nullIf(sum(data_uncompressed_bytes), 0) * 100, 1) AS savings_pct,
      max(modification_time) as latest_modification,
      min(min_block_number) as min_block,
      max(max_block_number) as max_block
    FROM ${getSystemTable('parts')}
    ${whereClause}
    GROUP BY database, table, partition_id, partition
    ORDER BY database ASC, table ASC, ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get aggregated partitions count
app.get('/api/partitions-summary/count', async (req, res) => {
  try {
    const { filters, search } = req.query;

    let whereConditions = ['active = 1'];
    const params = {};

    if (search) {
      whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String})');
      params.search = likePattern(search);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT count() as count FROM (
        SELECT database, table, partition_id
        FROM ${getSystemTable('parts')}
        ${whereClause}
        GROUP BY database, table, partition_id
      )
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json({ count: data[0]?.count || 0 });
  } catch (error) {
    console.error('Error fetching partitions summary count:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.parts',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.parts does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get partitions summary columns (virtual columns for the aggregated view)
app.get('/api/partitions-summary/columns', asyncHandler(async (req, res) => {
  // Return virtual column definitions for the aggregated view
  const columns = [
    { name: 'database', type: 'String', comment: 'Database name' },
    { name: 'table', type: 'String', comment: 'Table name' },
    { name: 'partition_id', type: 'String', comment: 'Partition ID' },
    { name: 'partition', type: 'String', comment: 'Partition value' },
    { name: 'parts_count', type: 'UInt64', comment: 'Number of parts in partition' },
    { name: 'total_rows', type: 'UInt64', comment: 'Total rows in partition' },
    { name: 'total_bytes', type: 'UInt64', comment: 'Total bytes on disk' },
    { name: 'total_compressed', type: 'UInt64', comment: 'Total compressed bytes' },
    { name: 'total_uncompressed', type: 'UInt64', comment: 'Total uncompressed bytes' },
    { name: 'savings_pct', type: 'Float64', comment: 'Compression savings percentage' },
    { name: 'latest_modification', type: 'DateTime', comment: 'Latest modification time' },
    { name: 'min_block', type: 'UInt64', comment: 'Minimum block number' },
    { name: 'max_block', type: 'UInt64', comment: 'Maximum block number' },
  ];
  res.json(columns);
}));

// Get system.partitions data
app.get('/api/partitions', asyncHandler(async (req, res) => {
  const { limit = 2500, offset = 0, sortField = 'modification_time', sortOrder = 'DESC', filters, search } = req.query;

  let whereConditions = [];
  const params = { limit: parseInt(limit), offset: parseInt(offset) };

  // Apply search filter (searches table, database, partition_id, name)
  if (search) {
    whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'modification_time';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const query = `
    SELECT *
    FROM ${getSystemTable('parts')}
    ${whereClause}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get system.partitions count
app.get('/api/partitions/count', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  // Apply search filter
  if (search) {
    whereConditions.push('(table ILIKE {search:String} OR database ILIKE {search:String} OR partition_id ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  // Apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT count() as count
    FROM ${getSystemTable('parts')}
    ${whereClause}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json({ count: data[0]?.count || 0 });
}));

// Get system.partitions columns
app.get('/api/partitions/columns', columnsHandler('parts'));

// Get parts for a specific partition
app.get('/api/partition-parts/:database/:table/:partitionId', asyncHandler(async (req, res) => {
  const { database, table, partitionId } = req.params;
  const { activeOnly = '1' } = req.query;

  const query = `
    SELECT
      name,
      rows,
      bytes_on_disk,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks,
      modification_time,
      min_block_number,
      max_block_number,
      level,
      primary_key_bytes_in_memory,
      active
    FROM ${getSystemTable('parts')}
    WHERE database = {database:String}
      AND table = {table:String}
      AND partition_id = {partitionId:String}
      ${activeOnly === '1' ? 'AND active = 1' : ''}
    ORDER BY modification_time DESC
  `;

  const result = await client.query({
    query,
    query_params: { database, table, partitionId },
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get partition details for a specific table
app.get('/api/table-partitions/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  const { activeOnly = '1' } = req.query;

  const params = { database, table };
  const activeFilter = activeOnly === '1' ? 'AND active = 1' : '';

  const query = `
    SELECT
      partition_id,
      count() as parts_count,
      sum(rows) as total_rows,
      sum(bytes_on_disk) as total_bytes,
      min(min_block_number) as min_block,
      max(max_block_number) as max_block,
      min(modification_time) as oldest_part,
      max(modification_time) as newest_part
    FROM ${getSystemTable('parts')}
    WHERE database = {database:String} AND table = {table:String} ${activeFilter}
    GROUP BY partition_id
    ORDER BY partition_id
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get MergeTree index information for a specific table
app.get('/api/table-mergetree-index/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;

  // Escape single quotes to prevent SQL injection
  const safeDatabase = database.replace(/'/g, "''");
  const safeTable = table.replace(/'/g, "''");

  // Query mergeTreeIndex table function for granule boundaries (limit 50 for performance)
  const query = `SELECT * FROM mergeTreeIndex('${safeDatabase}', '${safeTable}') LIMIT 50`;

  console.log('MergeTree index query:', query);

  const result = await client.query({
    query,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  console.log('MergeTree index result count:', data.length);
  res.json(data);
}));

// Get table definition (SHOW CREATE TABLE)
app.get('/api/table-definition/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;

  const query = `SHOW CREATE TABLE \`${database}\`.\`${table}\``;

  const result = await client.query({
    query,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  // SHOW CREATE TABLE returns a single row with 'statement' column containing the SQL
  const definition = data[0]?.statement || '';
  res.json({ definition });
}));

// Get table statistics (null percent and cardinality per column)
app.post('/api/table-stats', asyncHandler(async (req, res) => {
  const { database, table } = req.body;

  // First get all columns with type information
  const columnsQuery = `
    SELECT
      name,
      type,
      type LIKE 'Nullable%' AS is_nullable,
      type LIKE 'LowCardinality%' AS is_low_cardinality
    FROM system.columns
    WHERE database = {database:String} AND table = {table:String}
    ORDER BY position
  `;

  const columnsResult = await client.query({
    query: columnsQuery,
    query_params: { database, table },
    format: 'JSONEachRow',
  });

  const columns = await columnsResult.json();

  // Build dynamic query to calculate null percent and cardinality for each column
  const selectStatements = columns.map(col => {
    const colName = col.name;
    // Use backticks for column names that might be reserved keywords
    const quotedCol = `\`${colName}\``;
    return `
      countIf(${quotedCol} IS NULL) * 100.0 / count() AS \`null_percent_${colName}\`,
      uniq(${quotedCol}) AS \`cardinality_${colName}\`
    `;
  }).join(',\n');

  const statsQuery = `
    SELECT
      ${selectStatements}
    FROM \`${database}\`.\`${table}\`
    LIMIT 1
  `;

  console.log('Stats query:', statsQuery);

  const statsResult = await client.query({
    query: statsQuery,
    format: 'JSONEachRow',
  });

  const statsData = await statsResult.json();

  // Transform the result into the expected format
  const result = columns.map(col => ({
    column: col.name,
    null_percent: statsData[0]?.[`null_percent_${col.name}`] || 0,
    cardinality: statsData[0]?.[`cardinality_${col.name}`] || 0,
    is_nullable: col.is_nullable,
    is_low_cardinality: col.is_low_cardinality,
  }));

  res.json(result);
}));

// Get distinct values for system.parts field (for filters)
app.get('/api/parts/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const { limit = 100 } = req.query;

  const allowedFields = ['database', 'table', 'partition_id', 'part_type', 'active', 'disk_name'];

  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }

  const params = { limit: parseInt(limit) };

  const query = `
    SELECT DISTINCT toString(${field}) as value
    FROM ${getSystemTable('parts')}
    ORDER BY value
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// Get histogram data for system.parts field
app.get('/api/parts/histogram/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const { limit = 20, filters } = req.query;

  const allowedFields = ['database', 'table', 'partition_id', 'part_type', 'disk_name', 'active'];
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field for histogram' });
  }

  let whereConditions = [];
  const params = { limit: parseInt(limit) };

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [f, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        const paramName = `filter_${paramIndex}`;
        whereConditions.push(`toString(${f}) IN {${paramName}:Array(String)}`);
        params[paramName] = values;
        paramIndex++;
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      toString(${field}) as name,
      count() as count
    FROM ${getSystemTable('parts')}
    ${whereClause}
    GROUP BY name
    ORDER BY count DESC
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// ==================== ACTIVITY ENDPOINTS ====================

// Get system.processes
app.get('/api/processes', asyncHandler(async (req, res) => {
  const { filters } = req.query;
  let whereConditions = [];
  const params = {};

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  const query = `SELECT * FROM ${getSystemTable('processes')} ${whereClause} ORDER BY elapsed DESC`;
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.processes columns
app.get('/api/processes/columns', columnsHandler('processes'));

// Get distinct values for processes
app.get('/api/processes/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'user';
  const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('processes')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// Get system.merges
app.get('/api/merges', asyncHandler(async (req, res) => {
  const { filters } = req.query;
  let whereConditions = [];
  const params = {};

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  const query = `SELECT * FROM ${getSystemTable('merges')} ${whereClause} ORDER BY progress DESC`;
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.merges columns
app.get('/api/merges/columns', columnsHandler('merges'));

// Get distinct values for merges
app.get('/api/merges/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'database';
  const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('merges')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// Get system.mutations
app.get('/api/mutations', asyncHandler(async (req, res) => {
  const { filters } = req.query;
  let whereConditions = [];
  const params = {};

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  const query = `SELECT * FROM ${getSystemTable('mutations')} ${whereClause} ORDER BY create_time DESC`;
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.mutations columns
app.get('/api/mutations/columns', columnsHandler('mutations'));

// Get distinct values for mutations
app.get('/api/mutations/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'database';
  const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('mutations')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// ==================== VIEW REFRESHES ENDPOINTS ====================

// Get system.view_refreshes
app.get('/api/view-refreshes', asyncHandler(async (req, res) => {
  const { filters } = req.query;
  let whereConditions = [];
  let params = {};

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (Array.isArray(values) && values.length > 0) {
        const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : null;
        if (safeField) {
          whereConditions.push(`toString(${safeField}) IN ({${safeField}_values:Array(String)})`);
          params[`${safeField}_values`] = values;
        }
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  const query = `SELECT * FROM ${getSystemTable('view_refreshes')} ${whereClause} ORDER BY next_refresh_time ASC`;
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.view_refreshes columns
app.get('/api/view-refreshes/columns', columnsHandler('view_refreshes'));

// Get distinct values for view_refreshes
app.get('/api/view-refreshes/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'database';
  const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('view_refreshes')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// ==================== QUERY CACHE ENDPOINTS ====================

// Get system.query_cache
app.get('/api/query-cache', async (req, res) => {
  try {
    const { filters } = req.query;
    let whereConditions = [];
    const params = {};

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${getSystemTable('query_cache')} ${whereClause}`;
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching query_cache:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.query_cache columns
app.get('/api/query-cache/columns', columnsHandler('query_cache'));

// ==================== BACKGROUND JOBS ENDPOINTS ====================

// Get system.background_schedule_pool_log
app.get('/api/background-jobs', async (req, res) => {
  try {
    const { filters } = req.query;
    let whereConditions = [];
    const params = {};

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${getSystemTable('backup_log')} ${whereClause} ORDER BY event_time DESC LIMIT 1000`;
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching background jobs:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.background_schedule_pool_log columns
app.get('/api/background-jobs/columns', columnsHandler('backup_log'));

// Get distinct values for background jobs
app.get('/api/background-jobs/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'status';
    const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('backup_log')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
    const result = await client.query({ query, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== ''));
  } catch (error) {
    console.error('Error fetching background jobs distinct:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==================== ASYNC INSERTS ENDPOINTS ====================

// Get system.asynchronous_inserts (current pending inserts)
app.get('/api/async-inserts', async (req, res) => {
  try {
    const { filters } = req.query;
    let whereConditions = [];
    const params = {};

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${getSystemTable('asynchronous_inserts')} ${whereClause} ORDER BY first_update DESC`;
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching async inserts:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.asynchronous_inserts columns
app.get('/api/async-inserts/columns', columnsHandler('asynchronous_inserts'));

// Get distinct values for async inserts
app.get('/api/async-inserts/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'database';
    const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('asynchronous_inserts')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
    const result = await client.query({ query, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== ''));
  } catch (error) {
    console.error('Error fetching async inserts distinct:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.asynchronous_insert_log (historical insert log)
app.get('/api/async-insert-log', async (req, res) => {
  try {
    const { filters } = req.query;
    let whereConditions = [];
    const params = {};

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${getSystemTable('asynchronous_insert_log')} ${whereClause} ORDER BY event_time DESC LIMIT 1000`;
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching async insert log:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.asynchronous_insert_log columns
app.get('/api/async-insert-log/columns', columnsHandler('asynchronous_insert_log'));

// Get distinct values for async insert log
app.get('/api/async-insert-log/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'database';
    const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('asynchronous_insert_log')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
    const result = await client.query({ query, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== ''));
  } catch (error) {
    console.error('Error fetching async insert log distinct:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==================== DISTRIBUTED DDL QUEUE ENDPOINTS ====================

// Get system.distributed_ddl_queue
app.get('/api/distributed-ddl', async (req, res) => {
  try {
    const { filters } = req.query;
    let whereConditions = [];
    const params = {};

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${getSystemTable('distributed_ddl_queue')} ${whereClause} ORDER BY entry_version DESC LIMIT 1000`;
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching distributed DDL:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get system.distributed_ddl_queue columns
app.get('/api/distributed-ddl/columns', columnsHandler('distributed_ddl_queue'));

// Get distinct values for distributed DDL
app.get('/api/distributed-ddl/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'status';
    const query = `SELECT DISTINCT toString(${safeField}) as value FROM ${getSystemTable('distributed_ddl_queue')} WHERE toString(${safeField}) != '' ORDER BY value LIMIT 100`;
    const result = await client.query({ query, format: 'JSONEachRow' });
    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== ''));
  } catch (error) {
    console.error('Error fetching distributed DDL distinct:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('doesn\'t exist')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==================== DISKS ENDPOINTS ====================

// Get system.disks
app.get('/api/disks', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM ${getSystemTable('disks')} ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.disks columns
app.get('/api/disks/columns', columnsHandler('disks'));

// ==================== STORAGE POLICIES ENDPOINTS ====================

// Get system.storage_policies
app.get('/api/storage-policies', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM ${getSystemTable('storage_policies')} ORDER BY policy_name, volume_name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.storage_policies columns
app.get('/api/storage-policies/columns', columnsHandler('storage_policies'));

// ==================== DATABASE BROWSER ENDPOINTS ====================

// Get all databases
app.get('/api/browser/databases', asyncHandler(async (req, res) => {
  // Filter out lowercase information_schema (duplicate of INFORMATION_SCHEMA)
  const query = `SELECT name, engine, data_path, metadata_path, uuid FROM system.databases WHERE name != 'information_schema' ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get database summary with statistics
app.get('/api/databases/summary', asyncHandler(async (req, res) => {
  const query = `
    SELECT
      d.name AS database,
      d.engine AS engine,
      COUNT(DISTINCT t.name) AS table_count,
      SUM(t.total_rows) AS total_rows,
      SUM(t.total_bytes) AS total_bytes,
      COUNT(DISTINCT p.partition) AS partition_count,
      COUNT(p.name) AS part_count,
      SUM(p.rows) AS part_rows,
      SUM(p.bytes_on_disk) AS bytes_on_disk,
      SUM(p.data_compressed_bytes) AS compressed_bytes,
      SUM(p.data_uncompressed_bytes) AS uncompressed_bytes,
      CASE
        WHEN SUM(p.data_uncompressed_bytes) > 0
        THEN ROUND(((SUM(p.data_uncompressed_bytes) - SUM(p.data_compressed_bytes)) / SUM(p.data_uncompressed_bytes)) * 100, 1)
        ELSE 0
      END AS compression_ratio,
      MAX(t.metadata_modification_time) AS latest_modification
    FROM ${getSystemTable('databases')} d
    LEFT JOIN ${getSystemTable('tables')} t ON d.name = t.database
    LEFT JOIN ${getSystemTable('parts')} p ON d.name = p.database AND t.name = p.table AND p.active = 1
    WHERE d.name != 'information_schema'
    GROUP BY d.name, d.engine
    ORDER BY total_bytes DESC NULLS LAST, d.name
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get tables for a database
app.get('/api/browser/tables/:database', asyncHandler(async (req, res) => {
  const { database } = req.params;
  const query = `
    SELECT
      t.name,
      t.engine,
      t.total_rows,
      t.total_bytes,
      t.metadata_modification_time,
      COUNT(DISTINCT p.partition) AS partition_count
    FROM system.tables t
    LEFT JOIN system.parts p ON t.database = p.database AND t.name = p.table AND p.active = 1
    WHERE t.database = {database:String}
    GROUP BY t.name, t.engine, t.total_rows, t.total_bytes, t.metadata_modification_time
    ORDER BY t.name
  `;
  const result = await client.query({
    query,
    query_params: { database },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get partitions for a table (aggregated from system.parts)
app.get('/api/browser/partitions/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  const query = `
    SELECT
      partition_id,
      partition,
      count() as part_count,
      sum(rows) as total_rows,
      sum(bytes_on_disk) as total_bytes,
      min(min_time) as min_time,
      max(max_time) as max_time
    FROM ${getSystemTable('parts')}
    WHERE database = {database:String} AND table = {table:String} AND active = 1
    GROUP BY partition_id, partition
    ORDER BY partition_id
  `;
  const result = await client.query({
    query,
    query_params: { database, table },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get columns for a table
app.get('/api/browser/columns/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  const query = `
    SELECT
      name,
      type,
      default_kind,
      default_expression,
      comment,
      is_in_partition_key,
      is_in_sorting_key,
      is_in_primary_key,
      compression_codec
    FROM system.columns
    WHERE database = {database:String} AND table = {table:String}
    ORDER BY position
  `;
  const result = await client.query({
    query,
    query_params: { database, table },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get sample data from a table (first 100 rows)
app.get('/api/browser/sample/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  // Use proper quoting for database and table names
  const query = `SELECT * FROM "${database}"."${table}" LIMIT 100`;
  const result = await client.query({
    query,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get parts for a partition
app.get('/api/browser/parts/:database/:table/:partition', asyncHandler(async (req, res) => {
  const { database, table, partition } = req.params;
  const query = `
    SELECT
      name,
      partition_id,
      rows,
      bytes_on_disk,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks,
      modification_time,
      min_time,
      max_time,
      level,
      primary_key_bytes_in_memory
    FROM ${getSystemTable('parts')}
    WHERE database = {database:String} AND table = {table:String} AND partition_id = {partition:String} AND active = 1
    ORDER BY name
  `;
  const result = await client.query({
    query,
    query_params: { database, table, partition },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// ==================== PROJECTIONS ENDPOINTS ====================

// Get all projections (system-wide)
app.get('/api/projections', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  if (filters) {
    const parsed = JSON.parse(filters);
    Object.entries(parsed).forEach(([field, values], idx) => {
      if (!values || !Array.isArray(values) || values.length === 0) return;
      const condition = buildFilterCondition(field, values, params, idx);
      whereConditions.push(condition);
    });
  }

  if (search) {
    params.search = likePattern(search);
    whereConditions.push(`(database ILIKE {search:String} OR table ILIKE {search:String} OR name ILIKE {search:String})`);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      database,
      table,
      name,
      type,
      sorting_key,
      query
    FROM ${getSystemTable('projections')}
    ${whereClause}
    ORDER BY database, table, name
  `;
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get projection parts (for a specific projection)
app.get('/api/projection-parts/:database/:table/:projection', asyncHandler(async (req, res) => {
  const { database, table, projection } = req.params;
  const query = `
    SELECT
      name,
      part_name,
      partition_id,
      rows,
      bytes_on_disk,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks,
      modification_time,
      parent_part_name,
      is_broken
    FROM ${getSystemTable('projection_parts')}
    WHERE database = {database:String} AND table = {table:String} AND name = {projection:String} AND active = 1
    ORDER BY part_name
  `;
  const result = await client.query({
    query,
    query_params: { database, table, projection },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get projections for a table (browser endpoint)
app.get('/api/browser/projections/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  const query = `
    SELECT
      name,
      type,
      sorting_key,
      query,
      toString(storage_policy) as storage_policy,
      toString(partition_key) as partition_key,
      toString(primary_key) as primary_key
    FROM ${getSystemTable('projections')}
    WHERE database = {database:String} AND table = {table:String}
    ORDER BY name
  `;
  const result = await client.query({
    query,
    query_params: { database, table },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get projection parts for a projection
app.get('/api/browser/projection-parts/:database/:table/:projection', asyncHandler(async (req, res) => {
  const { database, table, projection } = req.params;
  const query = `
    SELECT
      name,
      part_name,
      partition_id,
      rows,
      bytes_on_disk,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks,
      modification_time,
      parent_part_name,
      is_broken
    FROM ${getSystemTable('projection_parts')}
    WHERE database = {database:String} AND table = {table:String} AND name = {projection:String} AND active = 1
    ORDER BY part_name
  `;
  const result = await client.query({
    query,
    query_params: { database, table, projection },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// ==================== VIEWS ENDPOINTS ====================

// Get all views (View and MaterializedView)
app.get('/api/views', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = ["engine IN ('View', 'MaterializedView')"];
  const params = {};

  if (filters) {
    const parsed = JSON.parse(filters);
    Object.entries(parsed).forEach(([field, values], idx) => {
      if (!values || !Array.isArray(values) || values.length === 0) return;
      const condition = buildFilterCondition(field, values, params, idx);
      whereConditions.push(condition);
    });
  }

  if (search) {
    params.search = likePattern(search);
    whereConditions.push(`(database ILIKE {search:String} OR name ILIKE {search:String})`);
  }

  const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

  const query = `
    SELECT
      database,
      name,
      engine,
      as_select,
      metadata_modification_time,
      create_table_query
    FROM system.tables
    ${whereClause}
    ORDER BY database, name
  `;
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get view definition (CREATE statement)
app.get('/api/view-definition/:database/:view', asyncHandler(async (req, res) => {
  const { database, view } = req.params;
  const query = `SHOW CREATE TABLE ${database}.${view}`;
  const result = await client.query({
    query,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  const definition = data[0]?.statement || '';
  res.json({ definition });
}));

// ==================== DICTIONARIES ENDPOINTS ====================

// Get all dictionaries (system-wide)
app.get('/api/dictionaries', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  if (filters) {
    const parsed = JSON.parse(filters);
    Object.entries(parsed).forEach(([field, values], idx) => {
      if (!values || !Array.isArray(values) || values.length === 0) return;
      const condition = buildFilterCondition(field, values, params, idx);
      whereConditions.push(condition);
    });
  }

  if (search) {
    params.search = likePattern(search);
    whereConditions.push(`(database ILIKE {search:String} OR name ILIKE {search:String})`);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      database,
      name,
      uuid,
      status,
      origin,
      type,
      key,
      attribute.names as attribute_names,
      attribute.types as attribute_types,
      bytes_allocated,
      hierarchical_index_bytes_allocated,
      query_count,
      hit_rate,
      found_rate,
      element_count,
      load_factor,
      source,
      lifetime_min,
      lifetime_max,
      loading_start_time,
      last_successful_update_time,
      loading_duration,
      last_exception
    FROM system.dictionaries
    ${whereClause}
    ORDER BY database, name
  `;
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get dictionaries columns metadata
app.get('/api/dictionaries/columns', columnsHandler('dictionaries'));

// ==================== DATA SKIPPING INDEXES ENDPOINTS ====================

const DATA_SKIPPING_ALLOWED_FIELDS = ['database', 'table', 'name', 'type', 'type_full', 'expr', 'granularity'];

// Get all data skipping indexes (system-wide)
app.get('/api/indexes', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  // Parse and apply filters (skip fields not available in all ClickHouse versions)
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && DATA_SKIPPING_ALLOWED_FIELDS.includes(field)) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply search
  if (search) {
    whereConditions.push('(database ILIKE {search:String} OR table ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      database,
      table,
      name,
      type,
      type_full,
      expr,
      granularity,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks
    FROM ${getSystemTable('data_skipping_indices')}
    ${whereClause}
    ORDER BY database, table, name
  `;
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get data skipping indexes for a table (browser endpoint)
app.get('/api/browser/indexes/:database/:table', asyncHandler(async (req, res) => {
  const { database, table } = req.params;
  const query = `
    SELECT
      name,
      type,
      type_full,
      expr,
      granularity,
      data_compressed_bytes,
      data_uncompressed_bytes,
      marks
    FROM ${getSystemTable('data_skipping_indices')}
    WHERE database = {database:String} AND table = {table:String}
    ORDER BY name
  `;
  const result = await client.query({
    query,
    query_params: { database, table },
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// Get data skipping indexes with formatted size (for Data Skipping tab)
app.get('/api/data-skipping-indexes', asyncHandler(async (req, res) => {
  const { filters, search } = req.query;

  let whereConditions = [];
  const params = {};

  // Parse and apply filters (skip fields not available in all ClickHouse versions)
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && DATA_SKIPPING_ALLOWED_FIELDS.includes(field)) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply search
  if (search) {
    whereConditions.push('(database ILIKE {search:String} OR table ILIKE {search:String} OR name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT
      database,
      table,
      name,
      type_full,
      formatReadableSize(data_uncompressed_bytes) AS size
    FROM ${getSystemTable('data_skipping_indices')}
    ${whereClause}
    ORDER BY database, table, name
  `;
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow'
  });
  const data = await result.json();
  res.json(data);
}));

// ==================== METRICS ENDPOINTS ====================

// Get system.metrics
app.get('/api/metrics', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.metrics ORDER BY metric`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.asynchronous_metrics
app.get('/api/async-metrics', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.asynchronous_metrics ORDER BY metric`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.events
app.get('/api/events', asyncHandler(async (req, res) => {
  const query = `SELECT event, value, description FROM system.events ORDER BY event`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.errors
app.get('/api/errors', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.errors ORDER BY last_error_time DESC`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.errors columns
app.get('/api/errors/columns', columnsHandler('errors'));

// Get system.warnings
app.get('/api/warnings', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.warnings ORDER BY message`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.warnings columns
app.get('/api/warnings/columns', columnsHandler('warnings'));

// ==================== INSTANCE ENDPOINTS ====================

// Get system.users
app.get('/api/users', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.users ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.users columns
app.get('/api/users/columns', columnsHandler('users'));

// Get system.settings
app.get('/api/settings', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.settings ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.settings columns
app.get('/api/settings/columns', columnsHandler('settings'));

// ==================== USERS & SECURITY ENDPOINTS ====================

// Get system.grants
app.get('/api/grants', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.grants ORDER BY user_name, role_name, access_type`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.grants columns
app.get('/api/grants/columns', columnsHandler('grants'));

// Get system.roles
app.get('/api/roles', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.roles ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.roles columns
app.get('/api/roles/columns', columnsHandler('roles'));

// Get system.role_grants (role hierarchy)
app.get('/api/role-grants', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.role_grants ORDER BY user_name, role_name, granted_role_name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.role_grants columns
app.get('/api/role-grants/columns', columnsHandler('role_grants'));

// Get system.current_roles
app.get('/api/current-roles', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.current_roles`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.enabled_roles
app.get('/api/enabled-roles', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.enabled_roles`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.quotas
app.get('/api/quotas', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.quotas ORDER BY name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.quotas columns
app.get('/api/quotas/columns', columnsHandler('quotas'));

// Get system.quota_usage
app.get('/api/quota-usage', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.quota_usage ORDER BY quota_name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.quota_usage columns
app.get('/api/quota-usage/columns', columnsHandler('quota_usage'));

// Get system.quota_limits
app.get('/api/quota-limits', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.quota_limits ORDER BY quota_name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.quota_limits columns
app.get('/api/quota-limits/columns', columnsHandler('quota_limits'));

// Get system.row_policies
app.get('/api/row-policies', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.row_policies ORDER BY short_name, database, \`table\``;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.row_policies columns
app.get('/api/row-policies/columns', columnsHandler('row_policies'));

// Get system.session_log
app.get('/api/session-log', asyncHandler(async (req, res) => {
  const query = `
    SELECT *
    FROM system.session_log
    ORDER BY event_time DESC
    LIMIT 1000
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.session_log columns
app.get('/api/session-log/columns', columnsHandler('session_log'));

// ==================== EXPLAIN PLAN ENDPOINT ====================

// Run EXPLAIN on a query
app.post('/api/explain', asyncHandler(async (req, res) => {
  const { query: userQuery } = req.body;

  if (!userQuery) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Run EXPLAIN on the query
  const explainQuery = `EXPLAIN ${userQuery}`;

  const result = await client.query({
    query: explainQuery,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Run different EXPLAIN types
app.post('/api/explain/:type', asyncHandler(async (req, res) => {
  const { type } = req.params;
  const { query: userQuery } = req.body;

  if (!userQuery) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Supported explain types
  const explainTypes = {
    'plan': 'EXPLAIN',
    'indexes': 'EXPLAIN indexes = 1',
    'actions': 'EXPLAIN actions = 1',
    'pipeline': 'EXPLAIN PIPELINE',
    'ast': 'EXPLAIN AST',
    'syntax': 'EXPLAIN SYNTAX',
    'estimate': 'EXPLAIN ESTIMATE',
    'json': 'EXPLAIN json = 1, indexes = 1',
    'json-plan': 'EXPLAIN json = 1',
  };

  const explainPrefix = explainTypes[type];
  if (!explainPrefix) {
    return res.status(400).json({ error: `Invalid explain type: ${type}` });
  }

  const explainQuery = `${explainPrefix} ${userQuery}`;

  // AST and SYNTAX return plain text, not structured data
  // Use TabSeparated format and return as array of lines
  if (type === 'ast' || type === 'syntax') {
    const result = await client.query({
      query: explainQuery,
      format: 'TabSeparatedRaw',
    });
    const text = await result.text();
    // Return as array of objects with 'explain' key for consistency
    const lines = text.split('\n').filter(line => line.trim());
    res.json(lines.map(line => ({ explain: line })));
  } else {
    const result = await client.query({
      query: explainQuery,
      format: 'JSONEachRow',
    });
    const data = await result.json();
    res.json(data);
  }
}));

// Execute a query and return results
app.post('/api/query', asyncHandler(async (req, res) => {
  let { query: userQuery, limit = 1000 } = req.body;

  if (!userQuery) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Strip trailing semicolons (ClickHouse doesn't need them and they can cause issues)
  userQuery = userQuery.trim().replace(/;+$/, '').trim();

  // Safety: don't allow dangerous operations
  const upperQuery = userQuery.toUpperCase();
  const isDangerous = isBlockedStatement(userQuery);

  if (isDangerous) {
    return res.status(403).json({ error: 'Dangerous operations are not allowed through this interface' });
  }

  // A FORMAT clause at the end of the query, optionally followed by SETTINGS.
  // (Not formatReadableSize(...), INFORMATION_SCHEMA or a column called format.)
  const formatClause = /\s+FORMAT\s+[A-Za-z]\w*(?=(\s+SETTINGS\b[\s\S]*)?\s*$)/i;
  const hasFormat = formatClause.test(userQuery);

  // Add LIMIT only for SELECT queries that don't already have one
  // Don't add LIMIT to EXPLAIN, SHOW, DESCRIBE, or queries with FORMAT or subqueries at the end
  let finalQuery = userQuery;
  const shouldAddLimit = upperQuery.startsWith('SELECT')
    && !upperQuery.includes('LIMIT')
    && !hasFormat
    && !upperQuery.endsWith(')'); // Avoid adding LIMIT after closing parenthesis (subqueries)

  if (shouldAddLimit) {
    finalQuery = `${userQuery} LIMIT ${limit}`;
  }

  const startTime = Date.now();

  // If query already has FORMAT, don't specify format in client options
  // Strip the FORMAT clause and let the query handle it, or use text mode
  let data;
  if (hasFormat) {
    // Remove the query's own FORMAT clause so the result comes back as JSONEachRow
    finalQuery = userQuery.replace(formatClause, '');
    const result = await client.query({
      query: finalQuery,
      format: 'JSONEachRow',
    });
    data = await result.json();
  } else {
    const result = await client.query({
      query: finalQuery,
      format: 'JSONEachRow',
    });
    data = await result.json();
  }

  const duration = Date.now() - startTime;

  res.json({
    data,
    rowCount: data.length,
    duration,
  });
}));

// Data Explorer endpoint
app.post('/api/explore', asyncHandler(async (req, res) => {
  const { database, table, selectedColumns = [], groupByColumns = [], limit = 1000 } = req.body;

  if (!database || !table) {
    return res.status(400).json({ error: 'Database and table are required' });
  }

  // Validate limit
  const safeLimit = Math.min(10000, Math.max(1, parseInt(limit) || 1000));

  // Build SELECT clause
  let selectClause;
  if (groupByColumns.length > 0) {
    // When using GROUP BY, we need aggregations
    const groupCols = groupByColumns.map(col => `\`${col}\``).join(', ');

    // For non-grouped columns, use any() aggregation
    const otherCols = selectedColumns
      .filter(col => !groupByColumns.includes(col))
      .map(col => `any(\`${col}\`) AS \`${col}\``)
      .join(', ');

    if (otherCols) {
      selectClause = `${groupCols}, ${otherCols}`;
    } else {
      selectClause = groupCols;
    }
  } else {
    // No GROUP BY - just select the columns
    if (selectedColumns.length > 0) {
      selectClause = selectedColumns.map(col => `\`${col}\``).join(', ');
    } else {
      selectClause = '*';
    }
  }

  // Build the query
  let query = `SELECT ${selectClause} FROM \`${database}\`.\`${table}\``;

  if (groupByColumns.length > 0) {
    const groupByClause = groupByColumns.map(col => `\`${col}\``).join(', ');
    query += ` GROUP BY ${groupByClause}`;
  }

  query += ` LIMIT ${safeLimit}`;

  const startTime = Date.now();
  const result = await client.query({
    query,
    format: 'JSONEachRow',
  });
  const data = await result.json();
  const duration = Date.now() - startTime;

  // Get column names from first row or from selectedColumns
  const columns = data.length > 0 ? Object.keys(data[0]) : selectedColumns;

  res.json({
    columns,
    data,
    rowCount: data.length,
    duration,
    query,
  });
}));

// Column profiling endpoint - returns stats for each column
app.post('/api/profile', asyncHandler(async (req, res) => {
  const { database, table, columns = [], sampleSize = 10000 } = req.body;

  if (!database || !table) {
    return res.status(400).json({ error: 'Database and table are required' });
  }

  const safeSampleSize = Math.min(100000, Math.max(1000, parseInt(sampleSize) || 10000));
  const fullTableName = `\`${database}\`.\`${table}\``;

  // Get column info if not provided
  let targetColumns = columns;
  if (targetColumns.length === 0) {
    const colQuery = `SELECT name, type FROM system.columns WHERE database = '${database}' AND table = '${table}'`;
    const colResult = await client.query({ query: colQuery, format: 'JSONEachRow' });
    const colData = await colResult.json();
    targetColumns = colData.map(c => ({ name: c.name, type: c.type }));
  }

  // Get total row count
  const countQuery = `SELECT count() as total FROM ${fullTableName}`;
  const countResult = await client.query({ query: countQuery, format: 'JSONEachRow' });
  const [{ total: totalRows }] = await countResult.json();

  const profiles = [];

  for (const col of targetColumns) {
    const colName = typeof col === 'string' ? col : col.name;
    const colType = typeof col === 'string' ? null : col.type;
    const escapedCol = `\`${colName}\``;

    try {
      // Build profile query for this column
      // Get: count, null count, distinct count, min, max, and top values
      const isNumeric = colType && /^(Int|UInt|Float|Decimal|Date|DateTime)/.test(colType);

      let statsQuery;
      if (isNumeric) {
        statsQuery = `
          SELECT
            count() as total,
            countIf(isNull(${escapedCol}) OR toString(${escapedCol}) = '') as null_count,
            uniqExact(${escapedCol}) as cardinality,
            min(${escapedCol}) as min_val,
            max(${escapedCol}) as max_val,
            avg(toFloat64OrNull(toString(${escapedCol}))) as avg_val
          FROM (SELECT ${escapedCol} FROM ${fullTableName} LIMIT ${safeSampleSize})
        `;
      } else {
        statsQuery = `
          SELECT
            count() as total,
            countIf(isNull(${escapedCol}) OR toString(${escapedCol}) = '') as null_count,
            uniqExact(${escapedCol}) as cardinality,
            min(length(toString(${escapedCol}))) as min_len,
            max(length(toString(${escapedCol}))) as max_len,
            avg(length(toString(${escapedCol}))) as avg_len
          FROM (SELECT ${escapedCol} FROM ${fullTableName} LIMIT ${safeSampleSize})
        `;
      }

      const statsResult = await client.query({ query: statsQuery, format: 'JSONEachRow' });
      const [stats] = await statsResult.json();

      // Get top values histogram
      const topValuesQuery = `
        SELECT
          toString(${escapedCol}) as value,
          count() as count
        FROM (SELECT ${escapedCol} FROM ${fullTableName} LIMIT ${safeSampleSize})
        WHERE ${escapedCol} IS NOT NULL AND toString(${escapedCol}) != ''
        GROUP BY ${escapedCol}
        ORDER BY count DESC
        LIMIT 10
      `;
      const topResult = await client.query({ query: topValuesQuery, format: 'JSONEachRow' });
      const topValues = await topResult.json();

      profiles.push({
        column: colName,
        type: colType,
        total: parseInt(stats.total) || 0,
        nullCount: parseInt(stats.null_count) || 0,
        nullPercent: stats.total > 0 ? ((parseInt(stats.null_count) || 0) / parseInt(stats.total) * 100).toFixed(1) : '0.0',
        cardinality: parseInt(stats.cardinality) || 0,
        cardinalityPercent: stats.total > 0 ? ((parseInt(stats.cardinality) || 0) / parseInt(stats.total) * 100).toFixed(1) : '0.0',
        min: stats.min_val !== undefined ? stats.min_val : stats.min_len,
        max: stats.max_val !== undefined ? stats.max_val : stats.max_len,
        avg: stats.avg_val !== undefined ? stats.avg_val : stats.avg_len,
        topValues: topValues.map(v => ({ value: v.value, count: parseInt(v.count) })),
      });
    } catch (colError) {
      // If a column fails, add it with error info
      profiles.push({
        column: colName,
        type: colType,
        error: colError.message,
      });
    }
  }

  res.json({
    database,
    table,
    totalRows: parseInt(totalRows),
    sampleSize: safeSampleSize,
    profiles,
  });
}));

// ==================== QUERY VIEWS LOG ENDPOINTS ====================

// Get query_views_log entries
app.get('/api/query-views-log', async (req, res) => {
  try {
    const { start, end, search, limit = 1000, offset = 0, sortField = 'event_time', sortOrder = 'DESC', filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    if (search) {
      whereConditions.push(`(view_name ILIKE {search:String} OR view_query ILIKE {search:String} OR initial_query_id ILIKE {search:String})`);
      params.search = likePattern(search);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0) {
          whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'event_time';
    const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const query = `
      SELECT
        event_time,
        view_name,
        view_type,
        view_query,
        view_target,
        read_rows,
        read_bytes,
        written_rows,
        written_bytes,
        peak_memory_usage,
        view_duration_ms,
        status,
        exception,
        initial_query_id
      FROM ${getSystemTable('query_views_log')}
      ${whereClause}
      ORDER BY ${safeSortField} ${safeSortOrder}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    params.limit = parseInt(limit);
    params.offset = parseInt(offset);

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow'
    });
    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching query_views_log:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('Unknown table')) {
      res.json([]); // Return empty array if table doesn't exist
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get query_views_log count
app.get('/api/query-views-log/count', async (req, res) => {
  try {
    const { start, end, search, filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    if (search) {
      whereConditions.push(`(view_name ILIKE {search:String} OR view_query ILIKE {search:String} OR initial_query_id ILIKE {search:String})`);
      params.search = likePattern(search);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0) {
          whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `SELECT count() as total FROM ${getSystemTable('query_views_log')} ${whereClause}`;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow'
    });
    const data = await result.json();
    res.json({ total: data[0]?.total || 0 });
  } catch (error) {
    console.error('Error fetching query_views_log count:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('Unknown table')) {
      res.json({ total: 0 });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get distinct values for query_views_log field (for filters)
app.get('/api/query-views-log/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const { start, end, limit = 100 } = req.query;

    const safeField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) ? field : 'view_name';

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT DISTINCT toString(${safeField}) as value
      FROM ${getSystemTable('query_views_log')}
      ${whereClause}
      ORDER BY value
      LIMIT {limit:UInt32}
    `;

    params.limit = parseInt(limit);

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow'
    });
    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== '' && v !== null));
  } catch (error) {
    console.error('Error fetching query_views_log distinct:', error);
    if (error.message?.includes('UNKNOWN_TABLE') || error.message?.includes('Unknown table')) {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==================== PART LOG ENDPOINTS ====================

// Get part_log column metadata (must be before parameterized routes)
app.get('/api/part-log/columns', columnsHandler('part_log'));

// Get part_log entries
app.get('/api/part-log', async (req, res) => {
  try {
    const { start, end, limit = 2500, offset = 0, sortField = 'event_time', sortOrder = 'DESC', filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    // Apply field filters
    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Allow sorting by most columns (alphanumeric only for safety)
    const safeSortField = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sortField) ? sortField : 'event_time';
    const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const query = `
      SELECT *
      FROM ${getSystemTable('part_log')}
      ${whereClause}
      ORDER BY ${safeSortField} ${safeSortOrder}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    params.limit = parseInt(limit);
    params.offset = parseInt(offset);

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching part log:', error);
    // Check if it's an authentication error
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') { // ClickHouse auth error code
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    // Check if it's a permission error
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') { // ClickHouse access denied code
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    // Check if table doesn't exist
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get part_log count
app.get('/api/part-log/count', async (req, res) => {
  try {
    const { start, end, filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    // Apply field filters
    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT count() as total
      FROM ${getSystemTable('part_log')}
      ${whereClause}
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json({ total: data[0]?.total || 0 });
  } catch (error) {
    console.error('Error fetching part_log count:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get part_log time series for chart
app.get('/api/part-log/timeseries', async (req, res) => {
  try {
    const { start, end, bucket = 'minute', filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    let truncFunc;
    switch (bucket) {
      case 'second':
        // event_time is DateTime (second precision), so just use it directly
        truncFunc = 'event_time';
        break;
      case 'hour':
        truncFunc = 'toStartOfHour(event_time)';
        break;
      default:
        truncFunc = 'toStartOfMinute(event_time)';
    }

    const query = `
      SELECT
        ${truncFunc} as time,
        count() as count,
        sumIf(rows, event_type = 'NewPart') as new_rows,
        sumIf(rows, event_type = 'MergeParts') as merged_rows,
        avg(duration_ms) as avg_duration,
        min(duration_ms) as min_duration,
        max(duration_ms) as max_duration,
        sum(duration_ms) as sum_duration
      FROM ${getSystemTable('part_log')}
      ${whereClause}
      GROUP BY time
      ORDER BY time ASC
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching part_log time series:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get stacked time series for part_log by event_type
app.get('/api/part-log/timeseries-stacked', async (req, res) => {
  try {
    const { start, end, bucket = 'minute', filters } = req.query;

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [field, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
          const paramName = `filter_${paramIndex++}`;
          params[paramName] = values;
          whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    let truncFunc;
    switch (bucket) {
      case 'second':
        truncFunc = 'event_time';
        break;
      case 'hour':
        truncFunc = 'toStartOfHour(event_time)';
        break;
      default:
        truncFunc = 'toStartOfMinute(event_time)';
    }

    const query = `
      SELECT
        ${truncFunc} as time,
        countIf(event_type = 'NewPart') as NewPart,
        countIf(event_type = 'MergeParts') as MergeParts,
        countIf(event_type = 'DownloadPart') as DownloadPart,
        countIf(event_type = 'RemovePart') as RemovePart,
        countIf(event_type = 'MutatePart') as MutatePart,
        countIf(event_type NOT IN ('NewPart', 'MergeParts', 'DownloadPart', 'RemovePart', 'MutatePart')) as Other
      FROM ${getSystemTable('part_log')}
      ${whereClause}
      GROUP BY time
      ORDER BY time ASC
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching part_log stacked time series:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get histogram data for part_log field
app.get('/api/part-log/histogram/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const { start, end, limit = 20, filters } = req.query;

    const allowedFields = ['table', 'event_type', 'merge_reason', 'database', 'merge_algorithm'];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ error: 'Invalid field for histogram' });
    }

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    if (filters) {
      const parsedFilters = JSON.parse(filters);
      let paramIndex = 0;
      for (const [f, values] of Object.entries(parsedFilters)) {
        if (values && values.length > 0) {
          const paramName = `filter_${paramIndex}`;
          whereConditions.push(`${f} IN {${paramName}:Array(String)}`);
          params[paramName] = values;
          paramIndex++;
        }
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    params.limit = parseInt(limit);

    const query = `
      SELECT
        toString(${field}) as name,
        count() as count
      FROM ${getSystemTable('part_log')}
      ${whereClause}
      GROUP BY name
      ORDER BY count DESC
      LIMIT {limit:UInt32}
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching part_log histogram:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// Get distinct values for part_log field (for filters)
app.get('/api/part-log/distinct/:field', async (req, res) => {
  try {
    const { field } = req.params;
    const { start, end, limit = 100 } = req.query;

    const allowedFields = ['event_type', 'database', 'table', 'part_name', 'partition_id', 'merge_reason', 'merge_algorithm'];

    if (!allowedFields.includes(field)) {
      return res.status(400).json({ error: 'Invalid field' });
    }

    let whereConditions = [];
    const params = {};

    if (start) {
      whereConditions.push('event_date >= toDate({start:DateTime(\'UTC\')})');
      whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
      params.start = start;
    }
    if (end) {
      whereConditions.push('event_date <= toDate({end:DateTime(\'UTC\')})');
      whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
      params.end = getEffectiveEndTime(start, end);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    params.limit = parseInt(limit);

    const query = `
      SELECT DISTINCT toString(${field}) as value
      FROM ${getSystemTable('part_log')}
      ${whereClause}
      ORDER BY value
      LIMIT {limit:UInt32}
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    res.json(data.map(row => row.value).filter(v => v !== ''));
  } catch (error) {
    console.error('Error fetching part_log distinct values:', error);
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Authentication failed') ||
        errorMessage.includes('password is incorrect') ||
        errorMessage.includes('no user with such name') ||
        error.code === 'AUTHENTICATION_ERROR' ||
        error.code === 516 || error.code === '516') {
      return res.status(401).json({
        error: 'Authentication failed: Invalid username or password',
        details: errorMessage,
        type: 'authentication'
      });
    }
    if (errorMessage.includes('Not enough privileges') ||
        errorMessage.includes('ACCESS_DENIED') ||
        error.code === 497 || error.code === '497') {
      return res.status(403).json({
        error: 'Access denied: You do not have permission to access system.part_log',
        details: errorMessage,
        type: 'permission'
      });
    }
    if (errorMessage.includes('Unknown table') ||
        errorMessage.includes('doesn\'t exist') ||
        errorMessage.includes('UNKNOWN_TABLE')) {
      return res.status(404).json({
        error: 'Table system.part_log does not exist or is not accessible',
        details: errorMessage,
        type: 'not_found'
      });
    }
    res.status(500).json({
      error: errorMessage,
      type: 'server_error'
    });
  }
});

// ==================== TEXT LOG ENDPOINTS ====================

// Get text_log column metadata
app.get('/api/text-log/columns', columnsHandler('text_log'));

// Get text_log entries
app.get('/api/text-log', asyncHandler(async (req, res) => {
  const { start, end, search, limit = 1000, offset = 0, sortField = 'event_time', sortOrder = 'DESC', filters } = req.query;

  let whereConditions = [];
  const params = {};

  if (start) {
    whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
    params.start = start;
  }
  if (end) {
    whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
    params.end = getEffectiveEndTime(start, end);
  }
  if (search) {
    whereConditions.push('(message ILIKE {search:String} OR logger_name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Validate sort field
  const allowedSortFields = ['event_time', 'level', 'logger_name', 'message', 'thread_name', 'thread_id', 'query_id'];
  const safeSortField = allowedSortFields.includes(sortField) ? sortField : 'event_time';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  params.limit = parseInt(limit);
  params.offset = parseInt(offset);

  const query = `
    SELECT *
    FROM ${getSystemTable('text_log')}
    ${whereClause}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get text_log count
app.get('/api/text-log/count', asyncHandler(async (req, res) => {
  const { start, end, search, filters } = req.query;

  let whereConditions = [];
  const params = {};

  if (start) {
    whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
    params.start = start;
  }
  if (end) {
    whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
    params.end = getEffectiveEndTime(start, end);
  }
  if (search) {
    whereConditions.push('(message ILIKE {search:String} OR logger_name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT count() as total
    FROM ${getSystemTable('text_log')}
    ${whereClause}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json({ total: data[0]?.total || 0 });
}));

// Get text_log time series for chart
app.get('/api/text-log/timeseries', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, filters } = req.query;

  let whereConditions = [];
  const params = {};

  if (start) {
    whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
    params.start = start;
  }
  if (end) {
    whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
    params.end = getEffectiveEndTime(start, end);
  }

  if (search) {
    whereConditions.push('(message ILIKE {search:String} OR logger_name ILIKE {search:String})');
    params.search = likePattern(search);
  }

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0 && SAFE_IDENTIFIER.test(field)) {
        const paramName = `filter_${paramIndex++}`;
        params[paramName] = values;
        whereConditions.push(`toString(${field}) IN {${paramName}:Array(String)}`);
      }
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  let truncFunc;
  switch (bucket) {
    case 'second':
      truncFunc = 'toDateTime(event_time)';
      break;
    case 'hour':
      truncFunc = 'toStartOfHour(event_time)';
      break;
    default:
      truncFunc = 'toStartOfMinute(event_time)';
  }

  const query = `
    SELECT
      ${truncFunc} as time,
      count() as count,
      countIf(level = 'Error' OR level = 'Fatal') as errors,
      countIf(level = 'Warning') as warnings
    FROM ${getSystemTable('text_log')}
    ${whereClause}
    GROUP BY time
    ORDER BY time ASC
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get distinct values for text_log field (for filters)
app.get('/api/text-log/distinct/:field', asyncHandler(async (req, res) => {
  const { field } = req.params;
  const { start, end, limit = 100 } = req.query;

  const allowedFields = ['level', 'logger_name', 'thread_name', 'query_id'];

  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }

  let whereConditions = [];
  const params = {};

  if (start) {
    whereConditions.push('event_time >= {start:DateTime(\'UTC\')}');
    params.start = start;
  }
  if (end) {
    whereConditions.push('event_time <= {end:DateTime(\'UTC\')}');
    params.end = getEffectiveEndTime(start, end);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  params.limit = parseInt(limit);

  const query = `
    SELECT DISTINCT toString(${field}) as value
    FROM ${getSystemTable('text_log')}
    ${whereClause}
    ORDER BY value
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data.map(row => row.value).filter(v => v !== ''));
}));

// ==================== QUERY LOG ENDPOINTS ====================

// Get grouped query log (aggregated by query or normalized_query_hash)
app.get('/api/query-log/grouped', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, limit = 1000, sortField = 'count', sortOrder = 'DESC', filters, rangeFilters, normalize } = req.query;
  const useNormalized = normalize === 'true';

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  // Parse and apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Define valid sort fields for grouped view
  const validSortFields = ['count', 'total_duration', 'avg_duration', 'max_duration', 'min_duration',
    'total_memory', 'avg_memory', 'max_memory', 'total_read_rows', 'avg_read_rows',
    'total_read_bytes', 'total_result_rows', 'avg_result_rows', 'first_seen', 'last_seen'];
  const safeSortField = validSortFields.includes(sortField) ? sortField : 'count';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const groupByField = useNormalized ? 'normalized_query_hash' : 'query';
  const query = `
    SELECT
      any(query) as example_query,
      ${useNormalized ? 'normalized_query_hash,' : ''}
      any(user) as user,
      any(current_database) as current_database,
      count() as count,
      sum(query_duration_ms) as total_duration,
      avg(query_duration_ms) as avg_duration,
      max(query_duration_ms) as max_duration,
      min(query_duration_ms) as min_duration,
      sum(memory_usage) as total_memory,
      avg(memory_usage) as avg_memory,
      max(memory_usage) as max_memory,
      sum(read_rows) as total_read_rows,
      avg(read_rows) as avg_read_rows,
      sum(read_bytes) as total_read_bytes,
      sum(written_rows) as total_written_rows,
      avg(written_rows) as avg_written_rows,
      sum(result_rows) as total_result_rows,
      avg(result_rows) as avg_result_rows,
      min(event_time) as first_seen,
      max(event_time) as last_seen
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    GROUP BY ${groupByField}
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32}
  `;

  params.limit = parseInt(limit);

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get query statistics grouped by table
app.get('/api/query-log/by-table', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, limit = 500, sortField = 'count', sortOrder = 'DESC', filters, rangeFilters } = req.query;

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  // Parse and apply field filters
  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Define valid sort fields for by-table view
  const validSortFields = ['count', 'total_duration', 'avg_duration', 'max_duration', 'min_duration',
    'total_memory', 'avg_memory', 'max_memory', 'total_read_rows', 'avg_read_rows',
    'total_read_bytes', 'first_seen', 'last_seen', 'error_count', 'error_rate'];
  const safeSortField = validSortFields.includes(sortField) ? sortField : 'count';
  const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  // Use arrayJoin to expand the tables array and group by each table
  const query = `
    SELECT
      arrayJoin(tables) as table_name,
      count() as count,
      sum(query_duration_ms) as total_duration,
      avg(query_duration_ms) as avg_duration,
      max(query_duration_ms) as max_duration,
      min(query_duration_ms) as min_duration,
      sum(memory_usage) as total_memory,
      avg(memory_usage) as avg_memory,
      max(memory_usage) as max_memory,
      sum(read_rows) as total_read_rows,
      avg(read_rows) as avg_read_rows,
      sum(read_bytes) as total_read_bytes,
      countIf(exception_code != 0) as error_count,
      round(countIf(exception_code != 0) * 100.0 / count(), 2) as error_rate,
      min(event_time) as first_seen,
      max(event_time) as last_seen
    FROM ${getSystemTable('query_log')}
    ${whereClause}
    GROUP BY table_name
    HAVING table_name != ''
    ORDER BY ${safeSortField} ${safeSortOrder}
    LIMIT {limit:UInt32}
  `;

  params.limit = parseInt(limit);

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json(data);
}));

// Get total count
app.get('/api/query-log/count', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', search, filters, rangeFilters } = req.query;

  let whereConditions = [];
  const params = {};

  applyQueryLogDateRange(start, end, bucket, whereConditions, params);
  applyQueryLogSearch(search, whereConditions, params);

  if (filters) {
    const parsedFilters = JSON.parse(filters);
    let paramIndex = 0;
    for (const [field, values] of Object.entries(parsedFilters)) {
      if (values && values.length > 0) {
        whereConditions.push(buildFilterCondition(field, values, params, paramIndex++));
      }
    }
  }

  // Apply range filters
  buildRangeFilterConditions(rangeFilters, whereConditions, params);

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const query = `
    SELECT count() as total
    FROM ${getSystemTable('query_log')}
    ${whereClause}
  `;

  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });

  const data = await result.json();
  res.json({ total: data[0]?.total || 0 });
}));

// ==================== MY QUERIES ENDPOINTS ====================

const NO_RUNS = { lastRunTime: null, lastDuration: null, lastRowCount: null, lastStatus: null, lastError: null, avgRunTime: null, slowestRunTime: null, fastestRunTime: null, runCount: 0, history: [] };

// Check if queries folder exists
app.get('/api/my-queries/exists', (req, res) => {
  const queriesPath = getQueriesPath();
  const exists = fs.existsSync(queriesPath) && fs.statSync(queriesPath).isDirectory();
  res.json({ exists, path: queriesPath });
});

// Get all queries from the queries folder
app.get('/api/my-queries', (req, res) => {
  try {
    const queriesPath = getQueriesPath();

    if (!fs.existsSync(queriesPath)) {
      return res.json({ queries: [], path: queriesPath });
    }

    const files = fs.readdirSync(queriesPath).filter(f => f.endsWith('.sql'));
    const allStats = getAggregatesByFilename('query');
    const queries = files.map(filename => {
      const filePath = path.join(queriesPath, filename);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const header = parseSqlHeader(content).meta;
      const meta = checkMeta(header);
      const stats = allStats.get(filename) || NO_RUNS;


      return {
        filename,
        query: content,
        title: meta.title,
        description: meta.description || readDescription(queriesPath, filename),
        severity: meta.severity || 'info',
        category: meta.category,
        ...durationLimits(header),
        lastRunTime: stats.lastRunTime,
        lastDuration: stats.lastDuration,
        lastRowCount: stats.lastRowCount,
        avgRunTime: stats.avgRunTime,
        slowestRunTime: stats.slowestRunTime,
        fastestRunTime: stats.fastestRunTime,
        runCount: stats.runCount,
        // Last stored result, so the grid shows failures after a reload
        lastStatus: stats.lastStatus ?? null,
        lastError: stats.lastError ?? null,
        history: stats.history,
      };
    });

    res.json({ queries, path: queriesPath });
  } catch (error) {
    console.error('Error reading queries folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// Run a query from my-queries and track timing
app.post('/api/my-queries/run', asyncHandler(async (req, res) => {
  const { filename, query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Safety check - only allow SELECT, INSERT, and WITH (CTE) queries. The
  // leading keyword skips comments, so `-- description:` headers are fine.
  const keyword = leadingKeyword(query);
  if (!['SELECT', 'INSERT', 'WITH'].includes(keyword)) {
    return res.status(403).json({ error: 'Only SELECT, INSERT, and WITH (CTE) queries are allowed' });
  }

  const startTime = Date.now();
  const isSelect = keyword === 'SELECT' || keyword === 'WITH';

  let result;
  try {
    result = await client.query({
      query,
      format: isSelect ? 'JSON' : undefined,
      clickhouse_settings: {
        max_execution_time: 0, // No timeout limit for user queries
      },
      request_timeout: 3600000, // 1 hour HTTP timeout
    });
  } catch (err) {
    // Failed runs are part of the history too
    recordRun('query', filename, { runTime: new Date(startTime).toISOString(), duration: Date.now() - startTime, status: 'error', error: err.message });
    throw err;
  }

  // For SELECT queries, JSON format returns { meta, data, rows, statistics }
  // statistics contains elapsed, rows_read, bytes_read
  let data = [];
  let rowCount = 0;
  let duration = 0;
  let readRows = null;
  let readBytes = null;

  if (isSelect) {
    const jsonResponse = await result.json();
    data = jsonResponse.data || [];
    rowCount = jsonResponse.rows || data.length;
    const stats = jsonResponse.statistics || {};
    // Use ClickHouse's elapsed time (in seconds), convert to ms
    duration = stats.elapsed
      ? Math.round(stats.elapsed * 1000)
      : Date.now() - startTime;
    readRows = stats.rows_read || null;
    readBytes = stats.bytes_read || null;
  } else {
    duration = Date.now() - startTime;
  }

  const queryId = result.query_id;
  // warn_duration_ms / fail_duration_ms in the header grade a successful run
  const { status, detail } = durationStatus(duration, durationLimits(parseSqlHeader(query).meta));

  let updatedStats = null;
  if (filename) {
    recordRun('query', filename, { queryId, runTime: new Date(startTime).toISOString(), duration, rowCount, readRows, readBytes, status, error: detail });
    updatedStats = getAggregatesForFilename('query', filename);
  }

  res.json({
    data,
    rowCount,
    duration,
    queryId,
    status,
    detail,
    stats: updatedStats,
  });
}));

// Reset all run statistics (must be before parameterized route)
app.delete('/api/my-queries/stats', (req, res) => {
  clearRunStats('query');
  res.json({ success: true });
});

// Clear run statistics for a specific query
app.delete('/api/my-queries/stats/:filename', (req, res) => {
  const { filename } = req.params;
  clearRunStats('query', filename);
  res.json({ success: true });
});

// Get run log for a specific query with query_log info
app.get('/api/my-queries/run-log/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const entries = getRunLog('query', filename, 50);

  if (entries.length === 0) {
    return res.json({ runLog: [] });
  }

  // Get the query_ids from the run log
  const queryIds = entries.map(r => r.queryId).filter(Boolean);

  // Fetch query_log info for these query_ids (left join simulated)
  let queryLogData = {};
  if (queryIds.length > 0) {
    try {
      const queryLogTable = getSystemTable('query_log');
      const queryLogQuery = `
        SELECT
          query_id,
          type,
          query_duration_ms,
          read_rows,
          read_bytes,
          result_rows,
          result_bytes,
          memory_usage,
          ProfileEvents
        FROM ${queryLogTable}
        WHERE query_id IN (${queryIds.map(id => `'${id}'`).join(', ')})
          AND type = 'QueryFinish'
      `;
      const result = await client.query({ query: queryLogQuery, format: 'JSONEachRow' });
      const data = await result.json();
      // Index by query_id for easy lookup
      data.forEach(row => {
        queryLogData[row.query_id] = row;
      });
    } catch (err) {
      console.error('Error fetching query_log data:', err);
      // Continue without query_log data
    }
  }

  // Build the response with left join
  const runLog = entries.map(entry => ({
    queryId: entry.queryId,
    runTime: entry.runTime,
    duration: entry.duration,
    rowCount: entry.rowCount,
    readRows: entry.readRows,
    readBytes: entry.readBytes,
    status: entry.status,
    error: entry.error,
    trigger: entry.trigger,
    queryLog: queryLogData[entry.queryId] || null,
  })); // Most recent first

  res.json({ runLog });
}));

// Update a query file

// Clone a query file

// ==================== CLUSTER ENDPOINTS ====================

// Get system.replication_queue (detailed view)
app.get('/api/cluster/replication-queue', asyncHandler(async (req, res) => {
  const query = `
    SELECT
      database, table, replica_name, is_leader, is_readonly,
      future_parts, parts_to_check, queue_size, last_queue_update_exception
    FROM system.replicas
    ORDER BY database, table, replica_name
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.replication_queue columns (using replicas table for this view)
app.get('/api/cluster/replication-queue/columns', asyncHandler(async (req, res) => {
  const columns = [
    { name: 'database', type: 'String', comment: 'Database name' },
    { name: 'table', type: 'String', comment: 'Table name' },
    { name: 'replica_name', type: 'String', comment: 'Replica name in ZooKeeper' },
    { name: 'is_leader', type: 'UInt8', comment: 'Whether this replica is the leader' },
    { name: 'is_readonly', type: 'UInt8', comment: 'Whether this replica is in read-only mode' },
    { name: 'future_parts', type: 'UInt32', comment: 'Number of data parts that will appear after INSERTs' },
    { name: 'parts_to_check', type: 'UInt32', comment: 'Number of data parts in the queue for verification' },
    { name: 'queue_size', type: 'UInt32', comment: 'Size of the queue for operations waiting to be performed' },
    { name: 'last_queue_update_exception', type: 'String', comment: 'Last exception during queue update' },
  ];
  res.json(columns);
}));

// Get grouped replication queue errors
app.get('/api/cluster/replication-queue/grouped', asyncHandler(async (req, res) => {
  const query = `
    SELECT table, last_exception, postpone_reason, count() as count
    FROM system.replication_queue
    GROUP BY table, last_exception, postpone_reason
    ORDER BY count DESC
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.replicas
app.get('/api/cluster/replicas', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.replicas ORDER BY database, table, replica_name`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.replicas columns
app.get('/api/cluster/replicas/columns', columnsHandler('replicas'));

// Get system.clusters
app.get('/api/cluster/clusters', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.clusters ORDER BY cluster, shard_num, replica_num`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.clusters columns
app.get('/api/cluster/clusters/columns', columnsHandler('clusters'));

// Get system.replicated_fetches
app.get('/api/cluster/fetches', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.replicated_fetches ORDER BY database, table`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.replicated_fetches columns
app.get('/api/cluster/fetches/columns', columnsHandler('replicated_fetches'));

// Get system.distributed_ddl_queue
app.get('/api/cluster/distributed-ddl', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.distributed_ddl_queue ORDER BY entry_version DESC LIMIT 1000`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.distributed_ddl_queue columns
app.get('/api/cluster/distributed-ddl/columns', columnsHandler('distributed_ddl_queue'));

// Get system.zookeeper (root path)
app.get('/api/cluster/zookeeper', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.zookeeper WHERE path = '/' LIMIT 100`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.zookeeper columns
app.get('/api/cluster/zookeeper/columns', columnsHandler('zookeeper'));

// Get system.zookeeper_connection
app.get('/api/cluster/zookeeper-connection', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.zookeeper_connection LIMIT 1000`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.zookeeper_connection columns
app.get('/api/cluster/zookeeper-connection/columns', columnsHandler('zookeeper_connection'));

// Get system.zookeeper_connection_log
app.get('/api/cluster/zookeeper-connection-log', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.zookeeper_connection_log ORDER BY event_time DESC LIMIT 1000`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.zookeeper_connection_log columns
app.get('/api/cluster/zookeeper-connection-log/columns', columnsHandler('zookeeper_connection_log'));

// Get system.zookeeper_log
app.get('/api/cluster/zookeeper-log', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.zookeeper_log ORDER BY event_time DESC LIMIT 1000`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.zookeeper_log columns
app.get('/api/cluster/zookeeper-log/columns', columnsHandler('zookeeper_log'));

// Get system.distribution_queue
app.get('/api/cluster/distribution-queue', asyncHandler(async (req, res) => {
  const query = `SELECT * FROM system.distribution_queue ORDER BY data_path LIMIT 1000`;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get system.distribution_queue columns
app.get('/api/cluster/distribution-queue/columns', columnsHandler('distribution_queue'));

// ==================== METRIC LOG API (Dashboard) ====================

// Default top 20 metrics for the dashboard
const DEFAULT_DASHBOARD_METRICS = [
  'CurrentMetric_Query',
  'CurrentMetric_MemoryTracking',
  'CurrentMetric_TCPConnection',
  'CurrentMetric_HTTPConnection',
  'CurrentMetric_Merge',
  'CurrentMetric_BackgroundMergesAndMutationsPoolTask',
  'CurrentMetric_Read',
  'CurrentMetric_Write',
  'CurrentMetric_MarkCacheBytes',
  'CurrentMetric_UncompressedCacheBytes',
  'ProfileEvent_Query',
  'ProfileEvent_InsertedRows',
  'ProfileEvent_SelectedRows',
  'ProfileEvent_ReadCompressedBytes',
  'ProfileEvent_InsertedBytes',
  'ProfileEvent_MergedRows',
  'ProfileEvent_MarkCacheHits',
  'ProfileEvent_MarkCacheMisses',
  'ProfileEvent_QueryMemoryLimitExceeded',
  'ProfileEvent_FailedQuery',
];

// Get available metric columns from metric_log
app.get('/api/metric-log/columns', asyncHandler(async (req, res) => {
  const query = `
    SELECT name, type
    FROM system.columns
    WHERE database = 'system'
      AND table = 'metric_log'
      AND (name LIKE 'CurrentMetric_%' OR name LIKE 'ProfileEvent_%')
    ORDER BY name
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get time series data for selected metrics
app.get('/api/metric-log/timeseries', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', metrics } = req.query;

  // Parse metrics or use defaults
  const metricList = metrics
    ? (typeof metrics === 'string' ? metrics.split(',') : metrics)
    : DEFAULT_DASHBOARD_METRICS;

  // Validate metrics to prevent SQL injection
  const safeMetrics = metricList.filter(m => /^(CurrentMetric_|ProfileEvent_)[A-Za-z0-9_]+$/.test(m));

  if (safeMetrics.length === 0) {
    return res.json([]);
  }

  // Filter against actual columns in metric_log to avoid UNKNOWN_IDENTIFIER errors
  let validMetrics;
  try {
    const colResult = await client.query({
      query: `SELECT name FROM system.columns WHERE database = 'system' AND table = 'metric_log' AND name IN (${safeMetrics.map(m => `'${m}'`).join(',')})`,
      format: 'JSONEachRow',
    });
    const existingCols = new Set((await colResult.json()).map(r => r.name));
    validMetrics = safeMetrics.filter(m => existingCols.has(m));
  } catch (colErr) {
    console.error('Error checking metric_log columns, falling back to all metrics:', colErr.message);
    validMetrics = safeMetrics;
  }

  if (validMetrics.length === 0) {
    return res.json([]);
  }

  // Determine truncation function based on bucket
  // Use toDateTime to avoid toStartOfSecond incompatibility with DateTime columns
  let truncFunc;
  switch (bucket) {
    case 'second':
      truncFunc = 'toDateTime(event_time)';
      break;
    case 'hour':
      truncFunc = 'toStartOfHour(event_time)';
      break;
    default:
      truncFunc = 'toStartOfMinute(event_time)';
  }

  // Build dynamic SELECT: sum for ProfileEvent, max for CurrentMetric
  const selectClauses = validMetrics.map(m => {
    if (m.startsWith('ProfileEvent_')) {
      return `sum(${m}) as ${m}`;
    } else {
      return `max(${m}) as ${m}`;
    }
  }).join(',\n        ');

  const query = `
    SELECT
      ${truncFunc} as time,
      ${selectClauses}
    FROM system.metric_log
    WHERE event_date >= toDate('${start}') AND event_date <= toDate('${end}')
      AND event_time >= '${start}' AND event_time <= '${end}'
    GROUP BY time
    ORDER BY time
  `;

  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get default dashboard metrics list
app.get('/api/metric-log/defaults', async (req, res) => {
  res.json(DEFAULT_DASHBOARD_METRICS);
});

// ==================== ASYNC METRIC LOG API (Dashboard) ====================

// Default async metrics from asynchronous_metric_log for the dashboard
const DEFAULT_ASYNC_METRIC_LOG_METRICS = [
  'OSMemoryTotal',
  'OSMemoryAvailable',
  'OSMemoryCached',
  'OSMemoryBuffers',
  'jemalloc.resident',
  'jemalloc.allocated',
  'ReplicasMaxQueueSize',
  'ReplicasSumQueueSize',
  'UncompressedCacheBytes',
  'MarkCacheBytes',
];

// Get available async metric names from asynchronous_metric_log
app.get('/api/async-metric-log/columns', asyncHandler(async (req, res) => {
  const query = `
    SELECT DISTINCT metric as name
    FROM system.asynchronous_metric_log
    ORDER BY metric
    LIMIT 500
  `;
  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get time series data for selected async metrics
app.get('/api/async-metric-log/timeseries', asyncHandler(async (req, res) => {
  const { start, end, bucket = 'minute', metrics } = req.query;

  // Parse metrics or use defaults
  const metricList = metrics
    ? (typeof metrics === 'string' ? metrics.split(',') : metrics)
    : DEFAULT_ASYNC_METRIC_LOG_METRICS;

  // Validate metrics - async metrics can have various characters including dots
  const validMetrics = metricList.filter(m => /^[A-Za-z0-9_.]+$/.test(m));

  if (validMetrics.length === 0) {
    return res.json([]);
  }

  // Determine truncation function based on bucket
  // Use toDateTime to avoid toStartOfSecond incompatibility with DateTime columns
  let truncFunc;
  switch (bucket) {
    case 'second':
      truncFunc = 'toDateTime(event_time)';
      break;
    case 'hour':
      truncFunc = 'toStartOfHour(event_time)';
      break;
    default:
      truncFunc = 'toStartOfMinute(event_time)';
  }

  // Build query to pivot async metrics into columns
  const selectClauses = validMetrics.map(m =>
    `maxIf(value, metric = '${m}') as \`${m}\``
  ).join(',\n        ');

  const whereMetrics = validMetrics.map(m => `'${m}'`).join(', ');

  const query = `
    SELECT
      ${truncFunc} as time,
      ${selectClauses}
    FROM system.asynchronous_metric_log
    WHERE event_date >= toDate('${start}') AND event_date <= toDate('${end}')
      AND event_time >= '${start}' AND event_time <= '${end}'
      AND metric IN (${whereMetrics})
    GROUP BY time
    ORDER BY time
  `;

  const result = await client.query({ query, format: 'JSONEachRow' });
  const data = await result.json();
  res.json(data);
}));

// Get default async dashboard metrics list
app.get('/api/async-metric-log/defaults', async (req, res) => {
  res.json(DEFAULT_ASYNC_METRIC_LOG_METRICS);
});

// Serve the React app for any other routes (Express v5 compatible)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  } else {
    next();
  }
});

function isRunningInDocker() {
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

const DEFAULT_PORT = isRunningInDocker() ? 3001 : 3002;
const PORT = process.env.PORT || DEFAULT_PORT;
let server;
// The backend scheduler (set once the server listens)
let scheduler = null;

// Startup function - validates connection before starting server

// Express error middleware — last-resort handler for routes wrapped in
// asyncHandler that throw. Logs context, returns JSON 500.
// Convoy extensions (alerting engine, notebooks, data dictionary edits)
registerExtensions(app, {
  getClient: () => client,
  getActiveEnvironment: scopedEnv,
  getTrigger: requestTrigger,
  getSchedulerStatus: () => scheduler?.status(),
  runSchedulerJob: (environment, job) => scheduler?.runNow(environment, job),
  runSchedulerNow: () => scheduler?.runAll(),
  lastSchedulerRun: (environment, job) => scheduler?.lastRunOf(environment, job) ?? null,
  getAlertsPath,
  getClientFolder,
  readDescription,
  recordRun,
});

// Missing system tables (e.g. system.query_log before ClickHouse's first
// flush, or when logging is disabled) map to 404 not_found so the UI can show
// a friendly message instead of a stack trace.
app.use((err, req, res, _next) => {
  const message = err?.message || String(err);
  // Only a missing *system* table (e.g. query_log not enabled) is "not found";
  // a typo in a user's own table must surface as a normal error
  const unknownTable = err?.type === 'UNKNOWN_TABLE' || err?.code === '60' ||
    message.includes('Unknown table') || message.includes('doesn\'t exist');
  const missingTable = unknownTable && /\bsystem\.\w+/i.test(message);
  if (missingTable) {
    console.warn(`Missing table in ${req.method} ${req.path}: ${message.split(' in scope ')[0]}`);
    if (res.headersSent) return;
    return res.status(404).json({ error: message, type: 'not_found' });
  }
  console.error(`Error in ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: message });
});

async function startup() {
  // Display banner
  console.log('\n' + figlet.textSync('QueryDog', { font: 'Standard' }) + '\n');

  const env = environments[activeEnvIndex];
  const protocol = env.secure ? 'https' : 'http';

  // List available environments
  if (environments.length > 1) {
    console.log(`Available environments (${environments.length}):`);
    environments.forEach((e, i) => {
      const marker = i === activeEnvIndex ? ' (active)' : '';
      console.log(`  ${i + 1}. ${e.name} - ${e.host}:${e.port}${marker}`);
    });
    console.log('');
  }

  // Start HTTP server FIRST (non-blocking)
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}\n`);
    // The scheduler calls this server's own API, so start it once listening
    scheduler = startScheduler({
      port: server.address().port,
      readConfig: () => {
        const yamlPath = findConfigPath();
        return yamlPath ? yaml.load(fs.readFileSync(yamlPath, 'utf-8')) || {} : null;
      },
      environmentNames: () => environments.map(e => e.name),
    });
  });

  // Test ClickHouse connection in background (non-blocking, 6 second timeout)
  console.log(`Testing connection to "${env.name}" (${protocol}://${env.host}:${env.port})...`);
  pingWithTimeout().then(() => {
    console.log('ClickHouse connection successful!');
  }).catch((error) => {
    console.error('\n╔══════════════════════════════════════════════════════════════╗');
    console.error('║  WARNING: Failed to connect to ClickHouse                    ║');
    console.error('╚══════════════════════════════════════════════════════════════╝\n');
    console.error(`Environment: ${env.name}`);
    console.error(`Host: ${env.host}:${env.port}`);
    console.error(`User: ${env.user}`);
    console.error(`Database: ${env.database}`);
    console.error(`Secure: ${env.secure ? 'Yes' : 'No'}\n`);
    console.error('Error details:', error.message);
    console.error('\nPlease check your querydog.yml configuration and ensure ClickHouse is reachable.');
    console.error('You can switch environments from the UI.\n');
  });
}

// Graceful shutdown handler
let shuttingDown = false;
function shutdown(signal) {
  // A second Ctrl+C exits straight away
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down gracefully...`);
  if (!server) process.exit(0);

  // Force exit if graceful shutdown stalls
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 5000).unref();

  server.close(() => {
    console.log('HTTP server closed');
    Promise.resolve(activeClient?.close())
      .then(() => console.log('ClickHouse connection closed'))
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  // close() waits for keep-alive connections (browser polling, the Vite proxy); drop them
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 1000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


// Checks and queries are loaded from the client folder in the repo, so the
// app never edits them; change the files and redeploy instead.
function readOnlyClientConfig(req, res) {
  res.status(403).json({ error: 'Read-only: checks and queries are loaded from the client folder in the repo. Change them there.' });
}
app.put('/api/my-queries/update', readOnlyClientConfig);
app.post('/api/my-queries/clone', readOnlyClientConfig);
app.put('/api/alerts/update', readOnlyClientConfig);
app.post('/api/alerts/clone', readOnlyClientConfig);

// ==================== ALERTS ROUTES ====================
app.get('/api/alerts/exists', (req, res) => {
  const alertsPath = getAlertsPath();
  const exists = fs.existsSync(alertsPath) && fs.statSync(alertsPath).isDirectory();
  res.json({ exists, path: alertsPath });
});

app.get('/api/alerts', (req, res) => {
  try {
    const alertsPath = getAlertsPath();

    if (!fs.existsSync(alertsPath)) {
      return res.json({ alerts: [], path: alertsPath });
    }

    const files = fs.readdirSync(alertsPath).filter(f => f.endsWith('.sql'));
    const aggregates = getAggregatesByFilename('alert');
    const alerts = files.map(filename => {
      const filePath = path.join(alertsPath, filename);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const agg = aggregates.get(filename) || {
        avgRunTime: null, fastestRunTime: null, slowestRunTime: null,
        lastRunTime: null, lastDuration: null, lastRowCount: null, runCount: 0,
      };

      const meta = checkMeta(parseSqlHeader(content).meta);
      return {
        filename,
        query: content,
        title: meta.title,
        description: meta.description || readDescription(alertsPath, filename),
        severity: meta.severity,
        category: meta.category,
        lastRunTime: agg.lastRunTime,
        lastDuration: agg.lastDuration,
        lastRowCount: agg.lastRowCount,
        avgRunTime: agg.avgRunTime,
        slowestRunTime: agg.slowestRunTime,
        fastestRunTime: agg.fastestRunTime,
        runCount: agg.runCount,
      };
    });

    res.json({ alerts, path: alertsPath });
  } catch (error) {
    console.error('Error reading monitoring folder:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alerts/run', async (req, res) => {
  try {
    const { filename, query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Strip leading SQL line and block comments before checking the first keyword
    const stripped = query
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/^\s*--.*$/, ''))
      .join('\n')
      .trim();
    const upperQuery = stripped.toUpperCase();
    if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
      return res.status(403).json({ error: 'Only SELECT and WITH (CTE) queries are allowed for alerts' });
    }

    const startTime = Date.now();
    const result = await client.query({
      query,
      format: 'JSON',
      clickhouse_settings: { max_execution_time: 0 },
      request_timeout: 3600000,
    });

    const jsonResponse = await result.json();
    const data = jsonResponse.data || [];
    const rowCount = jsonResponse.rows || data.length;
    const stats = jsonResponse.statistics || {};
    const duration = stats.elapsed ? Math.round(stats.elapsed * 1000) : Date.now() - startTime;
    const readRows = stats.rows_read || null;
    const readBytes = stats.bytes_read || null;
    const queryId = result.query_id;

    let updatedStats = null;
    if (filename) {
      recordRun('alert', filename, {
        queryId,
        runTime: new Date().toISOString(),
        duration,
        rowCount,
        readRows,
        readBytes,
      });
      updatedStats = getAggregatesForFilename('alert', filename);
    }

    // Fire sinks when the alert is firing (i.e. the query returned rows).
    // Fire-and-forget — don't delay the HTTP response on webhook latency.
    if (data.length > 0 && filename) {
      const description = readDescription(getAlertsPath(), filename);
      const env = currentEnv();
      console.log(`[alert] firing: ${filename} (${rowCount} rows) embeddedEnv=${env?._embeddedId || 'n/a'}`);
      if (process.env.SLACK_WEBHOOK_URL) {
        void sendSlackAlert({ filename, description, data, rowCount });
      }
      if (alertWebhookConfig(env)) {
        void sendAlertWebhook({ filename, description, data, rowCount, env });
      }
    }

    res.json({ data, rowCount, duration, queryId, stats: updatedStats });
  } catch (error) {
    console.error('Error running alert:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/alerts/stats', (req, res) => {
  clearRunStats('alert');
  res.json({ success: true });
});

app.delete('/api/alerts/stats/:filename', (req, res) => {
  clearRunStats('alert', req.params.filename);
  res.json({ success: true });
});

app.get('/api/alerts/run-log/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const entries = getRunLog('alert', filename, 50);
    if (entries.length === 0) return res.json({ runLog: [] });

    const queryIds = entries.map(r => r.queryId).filter(Boolean);
    let queryLogData = {};
    if (queryIds.length > 0) {
      try {
        const queryLogTable = getSystemTable('query_log');
        const queryLogQuery = `
          SELECT query_id, type, query_duration_ms, read_rows, read_bytes,
                 result_rows, result_bytes, memory_usage, ProfileEvents
          FROM ${queryLogTable}
          WHERE query_id IN (${queryIds.map(id => `'${id}'`).join(', ')})
            AND type = 'QueryFinish'
        `;
        const result = await client.query({ query: queryLogQuery, format: 'JSONEachRow' });
        const data = await result.json();
        data.forEach(row => { queryLogData[row.query_id] = row; });
      } catch (err) {
        console.error('Error fetching query_log data for alert run log:', err);
      }
    }

    const runLog = entries.map(entry => ({
      queryId: entry.queryId,
      runTime: entry.runTime,
      duration: entry.duration,
      rowCount: entry.rowCount,
      readRows: entry.readRows,
      readBytes: entry.readBytes,
      queryLog: queryLogData[entry.queryId] || null,
    }));

    res.json({ runLog });
  } catch (error) {
    console.error('Error fetching alert run log:', error);
    res.status(500).json({ error: error.message });
  }
});




// ==================== END ALERTS ROUTES ====================

// Start the application
startup();
