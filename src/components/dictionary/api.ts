// Types and fetch helpers for the Data Dictionary (server side lives in
// server/extensions/dictionary.js).
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

export const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];

export interface DictionaryTable {
  database: string;
  name: string;
  engine: string;
  comment: string;
  total_rows: number;
  total_bytes: number;
  partition_key: string;
  sorting_key: string;
  primary_key: string;
  sampling_key: string;
  metadata_modification_time: string;
  column_count: number;
  documented_columns: number;
}

export interface DictionaryColumn {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
  comment: string;
  is_in_partition_key: number;
  is_in_sorting_key: number;
  is_in_primary_key: number;
  compression_codec: string;
}

export interface TableUsage {
  table: string;
  queries: number;
  users: number;
  last_queried: string;
}

export interface UsageSummary {
  available: boolean;
  oldest?: string | null;
  days?: number;
  tables: TableUsage[];
}

export interface TableUsageDetail {
  available: boolean;
  days?: number;
  users?: { user: string; queries: number; last_queried: string }[];
  daily?: { day: string; queries: number }[];
  kinds?: { kind: string; queries: number }[];
  columns?: { column: string; reads: number; filtered: number }[];
  // Query counts per minute or hour (t = unix seconds), and totals for the window
  series?: { t: number; queries: number }[];
  overall?: { queries: number; users: number; last_queried: string } | null;
}

export interface ColumnProfile {
  type: string;
  method: string;
  total_rows: number;
  sampled_rows: number;
  null_count: number;
  distinct_count: number;
  min: string | null;
  max: string | null;
  top: { value: string | null; count: number }[];
}

export type LineageKind = 'materialized_view' | 'mv_target' | 'view' | 'distributed' | 'dictionary';

export interface LineageGraphData {
  nodes: { id: string; database: string; name: string; engine: string }[];
  edges: { from: string; to: string; kind: LineageKind }[];
}

export const tableId = (t: { database: string; name: string }) => `${t.database}.${t.name}`;

// Tables that store data, i.e. ones whose lack of queries means "unused".
export const isPhysical = (engine: string) => engine.includes('MergeTree') || ['Log', 'TinyLog', 'StripeLog', 'Memory'].includes(engine);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const fetchCatalog = () => request<DictionaryTable[]>('/api/dictionary/catalog');

export const fetchUsage = () => request<UsageSummary>('/api/dictionary/usage');

// Optional window (ms since epoch) and grain for the usage series
export const fetchTableUsage = (database: string, table: string, window?: { start: number; end: number; grain: 'minute' | 'hour' }) =>
  request<TableUsageDetail>(`/api/dictionary/usage/table?${qs({
    database, table,
    ...(window ? { start: String(Math.floor(window.start / 1000)), end: String(Math.ceil(window.end / 1000)), grain: window.grain } : {}),
  })}`);

export const fetchLineage = () => request<LineageGraphData>('/api/dictionary/lineage');

export const fetchColumnProfile = (database: string, table: string, column: string) =>
  request<ColumnProfile>(`/api/dictionary/profile?${qs({ database, table, column })}`);

export const fetchColumns = (database: string, table: string) =>
  request<DictionaryColumn[]>(`/api/browser/columns/${encodeURIComponent(database)}/${encodeURIComponent(table)}`);

export const fetchSample = (database: string, table: string) =>
  request<Record<string, unknown>[]>(`/api/browser/sample/${encodeURIComponent(database)}/${encodeURIComponent(table)}`);

// Saves a table comment, or a column comment when `column` is given.
export const saveComment = (database: string, table: string, comment: string, column?: string) =>
  request<{ ok: true; sql: string }>('/api/dictionary/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ database, table, column, comment }),
  });

export function engineTone(engine: string): 'blue' | 'green' | 'yellow' | 'red' | 'default' {
  if (engine.includes('MergeTree')) return 'blue';
  if (engine.includes('View')) return 'green';
  if (engine === 'Dictionary') return 'yellow';
  if (engine === 'Distributed') return 'red';
  return 'default';
}

export const gridDefaults = { resizable: true, sortable: true, suppressMovable: true };
