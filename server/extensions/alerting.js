// alerting extension - see server/extensions/index.js for the ctx contract.
//
// Turns the .sql checks in the client's monitoring folder into a real alerting
// engine: per-check rules (severity, threshold, pending period, channels),
// incidents with auto-resolve, notification channels (Slack, webhook,
// PagerDuty, email), silences and custom checks. Checks run on demand: from
// the UI or from the backend scheduler (server/scheduler.js), which calls the
// evaluate endpoint per environment.
// How each check alerts ships with the client in <alerts folder>/rules.yml and
// is read-only here; channels, incidents, silences and run history live in
// the Convoy database ('alerting' setting; runs in the runs table).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import yaml from 'js-yaml';
import { leadingKeyword } from '../sqlGuard.js';
import { checkMeta, readSqlHeader } from '../sqlHeader.js';
import { getSetting, setSetting, importJsonFile } from '../db.js';

const QUERY_TIMEOUT_S = 60;
const NOTIFY_TIMEOUT_MS = 10000;
const HISTORY_LIMIT = 100;
const SAMPLE_LIMIT = 50;
const INCIDENT_LIMIT = 500;
const DELIVERY_LIMIT = 1000;
const PAGERDUTY_URL = process.env.PAGERDUTY_EVENTS_URL || 'https://events.pagerduty.com/v2/enqueue';

const SEVERITIES = ['critical', 'warning', 'info'];
const OPERATORS = ['>', '>=', '=', '<'];
const CHANNEL_TYPES = ['slack', 'webhook', 'pagerduty', 'email'];
// Rule fields read from the client's rules.yml (channels are listed by name).
// Every check in the folder runs; there is no per-check enabled flag.
const FILE_RULE_FIELDS = ['severity', 'operator', 'threshold', 'forMinutes'];
const READ_ONLY = 'Read-only: checks and alert rules are loaded from the client folder in the repo. Change them there.';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const nowIso = () => new Date().toISOString();

// Same guard as /api/alerts/run: strip comments, then require SELECT or WITH.
export function isReadOnlyQuery(query) {
  return ['SELECT', 'WITH'].includes(leadingKeyword(query));
}

function guessSeverity(check) {
  if (/oom|readonly|disk_space_low|replication_lag|zookeeper|stuck|failed_dict|rejected/.test(check)) return 'critical';
  if (/slow|long_running|memory|merge|parts|queue|errors|exception/.test(check)) return 'warning';
  return 'info';
}

function defaultRule(check) {
  const severity = guessSeverity(check);
  return {
    severity,
    operator: '>',
    threshold: 0,
    forMinutes: 0,
    channels: [],
  };
}

function conditionMet(rowCount, operator, threshold) {
  switch (operator) {
    case '>=': return rowCount >= threshold;
    case '=': return rowCount === threshold;
    case '<': return rowCount < threshold;
    default: return rowCount > threshold;
  }
}

// Only keep known rule fields with valid values.
function sanitizeRulePatch(patch) {
  const out = {};
  if (SEVERITIES.includes(patch.severity)) out.severity = patch.severity;
  if (OPERATORS.includes(patch.operator)) out.operator = patch.operator;
  if (Number.isFinite(Number(patch.threshold)) && patch.threshold !== null && patch.threshold !== '') out.threshold = Number(patch.threshold);
  if (Number.isFinite(Number(patch.forMinutes)) && Number(patch.forMinutes) >= 0) out.forMinutes = Number(patch.forMinutes);
  if (Array.isArray(patch.channels)) out.channels = patch.channels.filter(c => typeof c === 'string');
  return out;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

function validateChannel({ type, name, target }) {
  if (!CHANNEL_TYPES.includes(type)) return 'Unknown channel type';
  if (!name || !String(name).trim()) return 'Name is required';
  const t = String(target || '').trim();
  if (!t) return 'Target is required';
  if ((type === 'slack' || type === 'webhook') && !/^https?:\/\//i.test(t)) return 'Target must be an http(s) URL';
  if (type === 'email') {
    if (t.split(',').some(addr => !/^[^@\s]+@[^@\s]+$/.test(addr.trim()))) return 'Target must be comma-separated email addresses';
  }
  return null;
}

// Hide secrets (webhook paths, routing keys) when sending channels to the UI.
function maskTarget(channel) {
  const t = channel.target || '';
  if (channel.type === 'email') return t;
  if (channel.type === 'pagerduty') return t.length > 4 ? `•••••${t.slice(-4)}` : '•••••';
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/•••••' : ''}`;
  } catch {
    return '•••••';
  }
}

export function register(app, ctx) {
  const smtpConfigured = Boolean(process.env.SMTP_URL);
  const mailer = smtpConfigured ? nodemailer.createTransport(process.env.SMTP_URL) : null;

  // ==================== Persistence ====================

  // State used to live in <dataDir>/alerting.json
  importJsonFile('alerting', 'alerting.json', ({ schedulerEnabled: _s, lastTick: _t, runtime: _r, ...rest }) => rest);

  function loadState() {
    const empty = { rules: {}, runtime: {}, channels: [], incidents: [], deliveries: [], silences: [], customChecks: [] };
    const stored = getSetting('alerting', {});
    // runtime is per environment: { [environment]: { [check]: {...} } }
    return { ...empty, ...stored, runtime: stored.runtime && !('history' in (Object.values(stored.runtime)[0] || {})) ? stored.runtime : {} };
  }

  const state = loadState();

  function save() {
    try {
      setSetting('alerting', state);
    } catch (e) {
      console.error('[alerting] could not save state:', e.message);
    }
  }

  // ==================== Checks & rules ====================

  function listChecks() {
    const dir = ctx.getAlertsPath();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  }

  const validCheckName = (check) => typeof check === 'string' && check.endsWith('.sql') && !/[/\\]/.test(check);

  // ---------- rules.yml in the client's alerts folder ----------

  const rulesFilePath = () => path.join(ctx.getClientFolder('alerts'), 'rules.yml');
  let fileRules = {};
  let fileRulesKey = null;

  // Re-read when the file (or the client folder) changes, so edits on disk apply without a restart
  function loadFileRules() {
    const file = rulesFilePath();
    let key;
    try {
      key = `${file}:${fs.statSync(file).mtimeMs}`;
    } catch {
      key = `${file}:missing`;
    }
    if (key === fileRulesKey) return fileRules;
    fileRulesKey = key;
    fileRules = {};
    try {
      const raw = yaml.load(fs.readFileSync(file, 'utf-8')) || {};
      const rules = raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
      for (const [name, rule] of Object.entries(rules)) {
        if (!rule || typeof rule !== 'object') continue;
        const channelNames = Array.isArray(rule.channels) ? rule.channels.map(String) : [];
        fileRules[name.endsWith('.sql') ? name : `${name}.sql`] = { ...pick(sanitizeRulePatch(rule), FILE_RULE_FIELDS), channelNames };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[alerting] could not read ${file}:`, e.message);
    }
    return fileRules;
  }

  // Defaults for checks not listed in rules.yml; channels named there map to
  // this installation's channels (configured under Settings)
  // The check file's `-- severity:` header wins over rules.yml and the name-based guess
  function headerFor(check) {
    return checkMeta(readSqlHeader(path.join(ctx.getAlertsPath(), check)).meta);
  }

  function ruleFor(check) {
    const { channelNames = [], ...fields } = loadFileRules()[check] || {};
    const wanted = new Set(channelNames.map(n => n.toLowerCase()));
    const channels = state.channels.filter(c => wanted.has(c.name.toLowerCase())).map(c => c.id);
    const { severity } = headerFor(check);
    return { ...defaultRule(check), ...fields, ...(severity ? { severity } : {}), channels };
  }

  // Last result, pending timer and history of a check in the request's environment
  function runtimeFor(check) {
    const byCheck = (state.runtime[envName()] ||= {});
    if (!byCheck[check]) {
      byCheck[check] = { lastEvaluatedAt: null, lastResult: null, lastError: null, pendingSince: null, history: [] };
    }
    return byCheck[check];
  }

  const envName = () => ctx.getActiveEnvironment()?.name || 'default';

  const openIncidentFor = (check, environment) =>
    state.incidents.find(i => i.check === check && i.environment === environment && i.status !== 'resolved');

  function activeSilences() {
    const now = Date.now();
    state.silences = state.silences.filter(s => new Date(s.until).getTime() > now);
    return state.silences;
  }

  const silenceFor = (check) => activeSilences().find(s => !s.check || s.check === check);

  async function runQuery(query) {
    const client = ctx.getClient();
    const startTime = Date.now();
    const result = await client.query({
      query,
      format: 'JSON',
      clickhouse_settings: { max_execution_time: QUERY_TIMEOUT_S },
      request_timeout: (QUERY_TIMEOUT_S + 5) * 1000,
    });
    const json = await result.json();
    const data = json.data || [];
    const stats = json.statistics || {};
    return {
      data,
      columns: (json.meta || []).map(m => m.name),
      rowCount: json.rows ?? data.length,
      duration: stats.elapsed ? Math.round(stats.elapsed * 1000) : Date.now() - startTime,
      readRows: stats.rows_read ?? null,
      readBytes: stats.bytes_read ?? null,
      queryId: result.query_id,
    };
  }

  // ==================== Notifications ====================

  function describeEvent(event, incident) {
    const title = incident.check.replace(/\.sql$/, '');
    if (event === 'test') return `Test notification from Convoy`;
    if (event === 'resolved') return `[RESOLVED] ${title} on ${incident.environment}`;
    return `[${incident.severity.toUpperCase()}] ${title} on ${incident.environment}: ${incident.rowCount} row${incident.rowCount === 1 ? '' : 's'}`;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status;
  }

  async function sendToChannel(channel, event, incident) {
    const summary = describeEvent(event, incident);
    const sample = (incident.sample || []).slice(0, 5);
    const description = ctx.readDescription(ctx.getAlertsPath(), incident.check);
    switch (channel.type) {
      case 'slack': {
        const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${summary}*${description ? `\n${description}` : ''}` } }];
        if (event === 'firing' && sample.length) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + JSON.stringify(sample, null, 2).slice(0, 2500) + '```' } });
        }
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `check \`${incident.check}\` · severity ${incident.severity} · incident ${incident.id}` }] });
        return postJson(channel.target, { text: summary, blocks });
      }
      case 'webhook':
        return postJson(channel.target, {
          event,
          summary,
          incidentId: incident.id,
          check: incident.check,
          description,
          severity: incident.severity,
          environment: incident.environment,
          status: incident.status,
          rowCount: incident.rowCount,
          openedAt: incident.openedAt,
          resolvedAt: incident.resolvedAt || null,
          sample: (incident.sample || []).slice(0, 25),
        });
      case 'pagerduty':
        return postJson(PAGERDUTY_URL, event === 'resolved'
          ? { routing_key: channel.target, event_action: 'resolve', dedup_key: incident.id }
          : {
            routing_key: channel.target,
            event_action: 'trigger',
            dedup_key: incident.id,
            payload: {
              summary,
              source: incident.environment,
              severity: incident.severity,
              component: 'clickhouse',
              custom_details: { check: incident.check, description, rowCount: incident.rowCount, sample },
            },
          });
      case 'email': {
        if (!mailer) throw new Error('SMTP is not configured (set SMTP_URL and SMTP_FROM)');
        const text = [summary, description, '', event === 'firing' && sample.length ? JSON.stringify(sample, null, 2) : '']
          .filter(Boolean).join('\n');
        await mailer.sendMail({ from: process.env.SMTP_FROM || 'convoy@localhost', to: channel.target, subject: summary, text });
        return 'sent';
      }
      default:
        throw new Error(`Unknown channel type ${channel.type}`);
    }
  }

  async function deliver(channel, event, incident) {
    const entry = {
      id: newId('dlv'), time: nowIso(), incidentId: incident.id, check: incident.check, event, environment: incident.environment,
      channelId: channel.id, channelName: channel.name, channelType: channel.type, ok: true, detail: null,
    };
    try {
      const result = await sendToChannel(channel, event, incident);
      entry.detail = String(result);
    } catch (e) {
      entry.ok = false;
      entry.detail = e.name === 'TimeoutError' ? 'Timed out' : e.message;
    }
    state.deliveries.unshift(entry);
    if (state.deliveries.length > DELIVERY_LIMIT) state.deliveries.length = DELIVERY_LIMIT;
    return entry;
  }

  // Notify every enabled channel on the rule, unless the check is silenced.
  async function notify(incident, event) {
    const rule = ruleFor(incident.check);
    const targets = state.channels.filter(c => c.enabled && rule.channels.includes(c.id));
    if (!targets.length) return;
    const silence = silenceFor(incident.check);
    if (silence) {
      incident.timeline.push({ time: nowIso(), type: 'suppressed', message: `${event} notification suppressed by silence: ${silence.reason || 'no reason given'}` });
      return;
    }
    for (const channel of targets) {
      const d = await deliver(channel, event, incident);
      incident.timeline.push({
        time: d.time, type: d.ok ? 'notified' : 'notify_failed',
        message: `${event} → ${channel.name} (${channel.type})${d.ok ? '' : `: ${d.detail}`}`,
      });
    }
  }

  // ==================== Evaluation ====================

  function openIncident(check, rule, result, environment) {
    const incident = {
      id: newId('inc'), check, severity: rule.severity, status: 'firing', environment,
      openedAt: nowIso(), lastSeenAt: nowIso(), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null,
      rowCount: result.rowCount, peakRows: result.rowCount,
      columns: result.columns, sample: result.data.slice(0, SAMPLE_LIMIT),
      timeline: [{ time: nowIso(), type: 'opened', message: `Opened: ${result.rowCount} rows ${rule.operator} ${rule.threshold}` }],
    };
    state.incidents.unshift(incident);
    if (state.incidents.length > INCIDENT_LIMIT) state.incidents.length = INCIDENT_LIMIT;
    return incident;
  }

  async function resolveIncident(incident, by, message) {
    incident.status = 'resolved';
    incident.resolvedAt = nowIso();
    incident.resolvedBy = by;
    incident.timeline.push({ time: incident.resolvedAt, type: 'resolved', message });
    await notify(incident, 'resolved');
  }

  // One evaluation per check at a time, so a manual "run now" during a scheduler
  // tick can't open (and page for) the same incident twice
  const inFlight = new Map();
  function evaluate(check) {
    if (!inFlight.has(check)) {
      inFlight.set(check, evaluateOnce(check).finally(() => inFlight.delete(check)));
    }
    return inFlight.get(check);
  }

  async function evaluateOnce(check) {
    const rule = ruleFor(check);
    const rt = runtimeFor(check);
    const environment = envName();
    const startedAt = Date.now();
    rt.lastEvaluatedAt = new Date(startedAt).toISOString();
    try {
      const filePath = path.join(ctx.getAlertsPath(), check);
      if (!fs.existsSync(filePath)) throw new Error('Check file not found');
      const query = fs.readFileSync(filePath, 'utf-8').trim();
      if (!isReadOnlyQuery(query)) throw new Error('Only SELECT and WITH (CTE) queries are allowed for alerts');

      const result = await runQuery(query);
      const met = conditionMet(result.rowCount, rule.operator, rule.threshold);
      ctx.recordRun('alert', check, {
        queryId: result.queryId, runTime: rt.lastEvaluatedAt, duration: result.duration,
        rowCount: result.rowCount, readRows: result.readRows, readBytes: result.readBytes, status: met ? 'fail' : 'ok',
      });
      let incident = openIncidentFor(check, environment);
      let outcome = 'ok';
      if (met) {
        if (incident) {
          incident.rowCount = result.rowCount;
          incident.peakRows = Math.max(incident.peakRows, result.rowCount);
          incident.lastSeenAt = nowIso();
          incident.columns = result.columns;
          incident.sample = result.data.slice(0, SAMPLE_LIMIT);
          outcome = 'firing';
        } else {
          rt.pendingSince = rt.pendingSince || rt.lastEvaluatedAt;
          if (Date.now() - new Date(rt.pendingSince).getTime() >= rule.forMinutes * 60000) {
            incident = openIncident(check, rule, result, environment);
            rt.pendingSince = null;
            await notify(incident, 'firing');
            outcome = 'firing';
          } else {
            outcome = 'pending';
          }
        }
      } else {
        rt.pendingSince = null;
        if (incident) await resolveIncident(incident, 'auto', `Auto-resolved: ${result.rowCount} rows, condition cleared`);
      }

      rt.lastError = null;
      rt.lastResult = { rowCount: result.rowCount, duration: result.duration, state: outcome, environment };
      rt.history.push({ time: rt.lastEvaluatedAt, rows: result.rowCount, duration: result.duration, fired: outcome === 'firing' });
    } catch (e) {
      ctx.recordRun('alert', check, { runTime: rt.lastEvaluatedAt, duration: Date.now() - startedAt, status: 'error', error: e.message });
      rt.lastError = e.message;
      rt.lastResult = { rowCount: null, duration: Date.now() - startedAt, state: 'error', environment };
      rt.history.push({ time: rt.lastEvaluatedAt, rows: null, duration: Date.now() - startedAt, fired: false, error: e.message.slice(0, 300) });
    }
    if (rt.history.length > HISTORY_LIMIT) rt.history.splice(0, rt.history.length - HISTORY_LIMIT);
    save();
    return rt;
  }

  // ==================== Routes ====================

  const publicChannel = (c) => ({ ...c, target: maskTarget(c) });
  // Incident list entries leave out the row snapshot; the detail route has it.
  function incidentSummary(incident) {
    const rest = { ...incident, sampleRows: incident.sample?.length || 0 };
    delete rest.sample;
    delete rest.columns;
    return rest;
  }

  // Incidents and deliveries of the request's environment only. Older
  // deliveries without an environment go by their incident's.
  function buildState() {
    const dir = ctx.getAlertsPath();
    const environment = envName();
    const incidents = state.incidents.filter(i => i.environment === environment);
    const incidentIds = new Set(incidents.map(i => i.id));
    const rules = listChecks().map(check => {
      const rt = state.runtime[envName()]?.[check] || {};
      return {
        check,
        description: ctx.readDescription(dir, check),
        category: headerFor(check).category,
        custom: state.customChecks.includes(check),
        ...ruleFor(check),
        lastEvaluatedAt: rt.lastEvaluatedAt || null,
        lastResult: rt.lastResult || null,
        lastError: rt.lastError || null,
        pendingSince: rt.pendingSince || null,
        history: rt.history || [],
      };
    });
    return {
      environment,
      smtpConfigured,
      rules,
      channels: state.channels.map(publicChannel),
      incidents: incidents.map(incidentSummary),
      deliveries: state.deliveries.filter(d => (d.environment ? d.environment === environment : incidentIds.has(d.incidentId))).slice(0, 200),
      silences: activeSilences(),
    };
  }

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(`[alerting] ${req.method} ${req.path} failed:`, e);
      res.status(500).json({ error: e.message });
    }
  };

  app.get('/api/alerting/state', handle((req, res) => res.json(buildState())));


  // Rules come from the repo; refuse edits (bulk is registered before :check)
  const readOnly = (req, res) => res.status(403).json({ error: READ_ONLY });
  app.post('/api/alerting/rules/bulk', readOnly);
  app.patch('/api/alerting/rules/:check', readOnly);

  app.post('/api/alerting/rules/:check/evaluate', handle(async (req, res) => {
    const { check } = req.params;
    if (!validCheckName(check) || !listChecks().includes(check)) return res.status(404).json({ error: 'Unknown check' });
    const rt = await evaluate(check);
    res.json({ check, lastEvaluatedAt: rt.lastEvaluatedAt, lastResult: rt.lastResult, lastError: rt.lastError, pendingSince: rt.pendingSince });
  }));

  // ---------- Channels ----------

  app.post('/api/alerting/channels', handle((req, res) => {
    const { type, name, target } = req.body || {};
    const error = validateChannel({ type, name, target });
    if (error) return res.status(400).json({ error });
    const channel = { id: newId('ch'), type, name: String(name).trim(), target: String(target).trim(), enabled: true, createdAt: nowIso() };
    state.channels.push(channel);
    save();
    res.json(publicChannel(channel));
  }));

  app.patch('/api/alerting/channels/:id', handle((req, res) => {
    const channel = state.channels.find(c => c.id === req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const { name, target, enabled } = req.body || {};
    const next = {
      ...channel,
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(target ? { target: String(target).trim() } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
    };
    const error = validateChannel(next);
    if (error) return res.status(400).json({ error });
    Object.assign(channel, next);
    save();
    res.json(publicChannel(channel));
  }));

  app.delete('/api/alerting/channels/:id', handle((req, res) => {
    const { id } = req.params;
    state.channels = state.channels.filter(c => c.id !== id);
    save();
    res.json({ success: true });
  }));

  app.post('/api/alerting/channels/:id/test', handle(async (req, res) => {
    const channel = state.channels.find(c => c.id === req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const testIncident = {
      id: newId('test'), check: 'test_notification.sql', severity: 'info', status: 'firing', environment: envName(),
      openedAt: nowIso(), rowCount: 1, sample: [{ message: 'This is a test notification from Convoy' }],
    };
    const delivery = await deliver(channel, 'test', testIncident);
    save();
    res.json(delivery);
  }));

  // ---------- Incidents ----------

  app.get('/api/alerting/incidents/:id', handle((req, res) => {
    const incident = state.incidents.find(i => i.id === req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ ...incident, deliveries: state.deliveries.filter(d => d.incidentId === incident.id) });
  }));

  app.post('/api/alerting/incidents/:id/acknowledge', handle((req, res) => {
    const incident = state.incidents.find(i => i.id === req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (incident.status !== 'firing') return res.status(400).json({ error: `Incident is ${incident.status}` });
    const by = String(req.body?.by || 'operator').slice(0, 100);
    incident.status = 'acknowledged';
    incident.acknowledgedAt = nowIso();
    incident.acknowledgedBy = by;
    incident.timeline.push({ time: incident.acknowledgedAt, type: 'acknowledged', message: `Acknowledged by ${by}` });
    save();
    res.json(incidentSummary(incident));
  }));

  app.post('/api/alerting/incidents/:id/resolve', handle(async (req, res) => {
    const incident = state.incidents.find(i => i.id === req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (incident.status === 'resolved') return res.status(400).json({ error: 'Incident is already resolved' });
    const by = String(req.body?.by || 'operator').slice(0, 100);
    await resolveIncident(incident, by, `Resolved manually by ${by}`);
    save();
    res.json(incidentSummary(incident));
  }));

  // ---------- Silences ----------

  app.post('/api/alerting/silences', handle((req, res) => {
    const { check, until, minutes, reason } = req.body || {};
    if (check && !listChecks().includes(check)) return res.status(404).json({ error: 'Unknown check' });
    const untilMs = until ? new Date(until).getTime() : Date.now() + Number(minutes) * 60000;
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return res.status(400).json({ error: 'Silence must end in the future' });
    const silence = { id: newId('sil'), check: check || null, until: new Date(untilMs).toISOString(), reason: String(reason || '').slice(0, 500), createdAt: nowIso() };
    state.silences.push(silence);
    save();
    res.json(silence);
  }));

  app.delete('/api/alerting/silences/:id', handle((req, res) => {
    state.silences = state.silences.filter(s => s.id !== req.params.id);
    save();
    res.json({ success: true });
  }));

  // ---------- Custom checks ----------

  async function testQuery(sql) {
    if (!isReadOnlyQuery(sql)) {
      const err = new Error('Only SELECT and WITH (CTE) queries are allowed for alerts');
      err.status = 400;
      throw err;
    }
    try {
      return await runQuery(sql);
    } catch (e) {
      const err = new Error(`Query failed: ${e.message}`);
      err.status = 400;
      throw err;
    }
  }

  const testResponse = (r) => ({ rowCount: r.rowCount, duration: r.duration, columns: r.columns, sample: r.data.slice(0, 10) });

  app.post('/api/alerting/checks/test', handle(async (req, res) => {
    try {
      res.json(testResponse(await testQuery(String(req.body?.sql || '').trim())));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }));

  app.post('/api/alerting/checks', readOnly);
  app.delete('/api/alerting/checks/:check', readOnly);
}
