// REST client for server/extensions/notebooks.js.
import type { Notebook, NotebookSummary, QueryStats } from './model';

const BASE = '/api/notebooks';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  }
  return res.json();
}

// Sent as text/plain so the server's larger notebook body limit applies
// (the app-wide JSON parser caps bodies at 100kb).
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify(body),
});

export const listNotebooks = () => request<NotebookSummary[]>(BASE);
export const getNotebook = (id: string) => request<Notebook>(`${BASE}/${encodeURIComponent(id)}`);
export const createNotebook = (nb: Notebook) => request<Notebook>(BASE, jsonBody('POST', nb));
export const saveNotebook = (nb: Notebook) => request<{ id: string; updatedAt: string }>(`${BASE}/${encodeURIComponent(nb.id)}`, jsonBody('PUT', nb));
export const deleteNotebook = (id: string) => request<{ ok: true }>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface RunResult {
  data: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  duration: number;
  queryId: string;
}

export const runQuery = (query: string, limit = 10000) =>
  request<RunResult>(`${BASE}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit }) });

// query_log is flushed asynchronously, so retry a few times before giving up.
// Returns null when the server has no query_log (501) or the entry never shows.
export async function fetchQueryStats(queryId: string, attempts = 4): Promise<QueryStats | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await request<QueryStats>(`${BASE}/query-stats/${queryId}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) return null;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}
