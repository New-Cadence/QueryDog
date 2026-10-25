// Triage state for recommendations, stored in the Convoy database
// per environment (recommendation ids are only unique within one server).
// Recommendations are built on the server (scheduler or Run now) with
// reconcile(); the page reads them and changes triage status.
import type { Recommendation, RecommendationCategory } from '../../recommendations';

export type TriageStatus = 'open' | 'acknowledged' | 'snoozed' | 'dismissed' | 'resolved';

export interface TriageEntry {
  rec: Recommendation;
  status: TriageStatus;
  firstSeen: string;
  lastSeen: string;
  changedAt?: string;
  snoozeUntil?: string; // YYYY-MM-DD
  reason?: string;
}

export type TriageStore = Record<string, TriageEntry>;

const RESOLVED_RETENTION_DAYS = 30;

export const today = () => new Date().toISOString().slice(0, 10);

// How each provider did on the last server run (scheduler or Run now)
export interface ProviderRun {
  state: 'running' | 'ok' | 'error';
  error?: string;
  count?: number;
  ms?: number;
}

export interface StoredRecommendations {
  environment: string;
  store: TriageStore;
  lastRun: { startedAt: string; finishedAt: string; ok: boolean; summary: string; details?: { providers?: Partial<Record<RecommendationCategory, ProviderRun>> } } | null;
}

async function recommendationsRequest(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/recommendations${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Recommendations request failed (HTTP ${res.status})`);
  return json;
}

const toStored = (json: { environment: string; entries: TriageEntry[]; lastRun: StoredRecommendations['lastRun'] }): StoredRecommendations => ({
  environment: json.environment,
  store: Object.fromEntries(json.entries.map(e => [e.rec.id, e])),
  lastRun: json.lastRun,
});

// Recommendations stored for the active environment
export const fetchRecommendations = async () => toStored(await recommendationsRequest('GET', ''));

// Build them now on the server, the same way the scheduler does
export const runRecommendations = async () => toStored(await recommendationsRequest('POST', '/run'));

export async function updateRecommendationStatus(ids: string[], status: TriageStatus, extra: { snoozeUntil?: string; reason?: string } = {}) {
  await recommendationsRequest('PATCH', '/status', { ids, status, ...extra });
}

// Snoozes lapse back to open once their date has passed.
export function effectiveStatus(entry: TriageEntry): TriageStatus {
  if (entry.status === 'snoozed' && (!entry.snoozeUntil || entry.snoozeUntil < today())) return 'open';
  return entry.status;
}

export const isActive = (entry: TriageEntry) => {
  const s = effectiveStatus(entry);
  return s === 'open' || s === 'acknowledged';
};

// Merge one provider's fresh results into the store: new ids become open,
// ids that reappear after being resolved reopen, and ids of this category
// that are no longer reported are marked resolved.
export function reconcile(store: TriageStore, category: RecommendationCategory, recs: Recommendation[]): TriageStore {
  const now = new Date().toISOString();
  const next: TriageStore = { ...store };
  const seen = new Set<string>();
  for (const rec of recs) {
    seen.add(rec.id);
    const prev = next[rec.id];
    if (!prev) next[rec.id] = { rec, status: 'open', firstSeen: now, lastSeen: now };
    else if (prev.status === 'resolved') next[rec.id] = { ...prev, rec, status: 'open', lastSeen: now, changedAt: now, reason: undefined };
    else next[rec.id] = { ...prev, rec, lastSeen: now };
  }
  const cutoff = new Date(Date.now() - RESOLVED_RETENTION_DAYS * 86400_000).toISOString();
  for (const [id, entry] of Object.entries(next)) {
    if (entry.rec.category !== category || seen.has(id)) continue;
    if (entry.status !== 'resolved') next[id] = { ...entry, status: 'resolved', changedAt: now };
    else if ((entry.changedAt ?? entry.lastSeen) < cutoff) delete next[id];
  }
  return next;
}

export function setStatus(
  store: TriageStore,
  ids: string[],
  status: TriageStatus,
  extra: { snoozeUntil?: string; reason?: string } = {},
): TriageStore {
  const now = new Date().toISOString();
  const next = { ...store };
  for (const id of ids) {
    if (!next[id]) continue;
    next[id] = { ...next[id], status, changedAt: now, snoozeUntil: extra.snoozeUntil, reason: extra.reason };
  }
  return next;
}
