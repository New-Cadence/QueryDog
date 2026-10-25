// Settings extension - see server/extensions/index.js for the ctx contract.
//
// Settings saved from the Settings area (API keys, appearance), the
// recommendations and their triage state, run history, and the read-only
// scheduler status. Everything is stored in the Convoy database.
import { getSetting, setSetting, listRecommendations, saveRecommendations, setRecommendationStatus, listRuns, listSchedulerLog } from '../db.js';

const TRIAGE_STATUSES = ['open', 'acknowledged', 'snoozed', 'dismissed', 'resolved'];

// Settings documents the UI may read and write through /api/settings/:key
const UI_SETTINGS = {
  // [{ id, name, prefix, createdAt, expiresAt }]: never the secret itself
  api_keys: v => (Array.isArray(v) ? v.slice(0, 500).map(k => ({
    id: String(k?.id ?? ''), name: String(k?.name ?? '').slice(0, 200), prefix: String(k?.prefix ?? '').slice(0, 16),
    createdAt: String(k?.createdAt ?? ''), expiresAt: k?.expiresAt ? String(k.expiresAt) : null,
  })).filter(k => k.id) : []),
  appearance: v => ({ theme: v?.theme === 'light' ? 'light' : 'dark' }),
};

export function register(app, ctx) {
  const envName = (req) => String(req.query.environment || ctx.getActiveEnvironment()?.name || 'default');

  app.get('/api/settings/:key', (req, res) => {
    if (!UI_SETTINGS[req.params.key]) return res.status(404).json({ error: 'Unknown setting' });
    res.json({ value: getSetting(req.params.key, null) });
  });

  app.put('/api/settings/:key', (req, res) => {
    const clean = UI_SETTINGS[req.params.key];
    if (!clean) return res.status(404).json({ error: 'Unknown setting' });
    const value = clean(req.body?.value);
    setSetting(req.params.key, value);
    res.json({ value });
  });

  // ---------- Recommendations (per environment) ----------

  // Stored recommendations plus how each provider did on the last run
  app.get('/api/recommendations', (req, res) => {
    const env = envName(req);
    res.json({ environment: env, entries: listRecommendations(env), lastRun: ctx.lastSchedulerRun?.(env, 'recommendations') ?? null });
  });

  // Build recommendations now on the server (same code path as the scheduler)
  app.post('/api/recommendations/run', async (req, res) => {
    const env = envName(req);
    try {
      if (!ctx.runSchedulerJob) return res.status(503).json({ error: 'The scheduler is not running yet' });
      const lastRun = await ctx.runSchedulerJob(env, 'recommendations');
      res.json({ environment: env, entries: listRecommendations(env), lastRun });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/recommendations/status', (req, res) => {
    const { ids, status, snoozeUntil, reason } = req.body || {};
    if (!Array.isArray(ids) || !TRIAGE_STATUSES.includes(status)) return res.status(400).json({ error: 'ids[] and a valid status are required' });
    const changed = setRecommendationStatus(envName(req), ids, status, {
      snoozeUntil: typeof snoozeUntil === 'string' ? snoozeUntil.slice(0, 10) : null,
      reason: typeof reason === 'string' ? reason.slice(0, 1000) : null,
    });
    res.json({ changed });
  });

  app.put('/api/recommendations', (req, res) => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length > 20000) return res.status(400).json({ error: 'entries[] is required' });
    saveRecommendations(envName(req), entries);
    res.json({ saved: entries.length });
  });

  // ---------- Run history and scheduler ----------

  app.get('/api/runs', (req, res) => {
    // Runs of the active environment unless one is named; environment=* for all
    const { kind, check, since, limit } = req.query;
    const environment = req.query.environment === '*' ? undefined : String(req.query.environment || ctx.getActiveEnvironment()?.name || '');
    res.json({ runs: listRuns({ kind, checkId: check, environment, since, limit }) });
  });

  // Run every scheduled job now (Settings > Scheduler > Run now)
  app.post('/api/scheduler/run', (req, res) => {
    if (!ctx.runSchedulerNow) return res.status(503).json({ error: 'The scheduler is not running yet' });
    res.status(202).json(ctx.runSchedulerNow());
  });

  app.get('/api/scheduler', (req, res) => {
    const status = ctx.getSchedulerStatus?.();
    res.json({ ...(status || { enabled: false, configured: false, environments: [], jobs: {}, warnings: [] }), log: listSchedulerLog(Number(req.query.limit) || 200) });
  });
}
