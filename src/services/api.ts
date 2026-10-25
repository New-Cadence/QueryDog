import type { TimeRange, BucketSize, HistogramData, ColumnMetadata, QueryLogEntry, PartLogEntry } from '../types/queryLog';
import type { RangeFilter } from '../stores/queryStore';

const API_BASE = '/api';

// GET <path> and parse JSON, throwing `<errorPrefix>: <statusText>` on
// non-2xx. The vast majority of endpoints in this file follow this exact
// shape; callers that need POST, custom error parsing, or non-JSON
// responses use `fetch` directly.
async function fetchJson<T>(path: string, errorPrefix: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw await apiError(response, errorPrefix);
  return response.json() as Promise<T>;
}

export interface ApiError extends Error {
  status?: number;
  type?: string;
}

// Build an Error from a non-2xx response, keeping the server's JSON
// `{ error, type }` body. Without it every failure collapses to the bare
// status text ("Internal Server Error"), which the UI would misreport as the
// backend being down.
async function apiError(response: Response, errorPrefix: string): Promise<ApiError> {
  const body = await response.json().catch(() => ({} as { error?: string; type?: string }));
  const err: ApiError = new Error(`${errorPrefix}: ${body.error || response.statusText}`);
  err.status = response.status;
  err.type = body.type;
  return err;
}

export function missingTableMessage(table: string): string {
  const setting = table.replace(/^system\./, '');
  return `${table} is not enabled on this server. Enable <${setting}> in the ClickHouse server config to use this screen.`;
}

// True when a request failed because a system table (system.query_log,
// text_log, part_log, ...) is not enabled on the server. The backend reports
// these as 404 `{ type: 'not_found' }`.
export function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ApiError;
  return e.type === 'not_found' || /Unknown table|UNKNOWN_TABLE|doesn't exist/.test(e.message || '');
}

// Common connection error patterns - errors that indicate the server/database is unreachable
const CONNECTION_ERROR_PATTERNS = [
  'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
  'EHOSTUNREACH', 'EAI_AGAIN', 'socket hang up', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'Failed to fetch', 'NetworkError', 'net::ERR_',
];

// Proxy/server error patterns - generic errors from Vite proxy when backend is down
const SERVER_ERROR_PATTERNS = [
  'Internal Server Error',
  '502 Bad Gateway',
  '503 Service Unavailable',
  '504 Gateway Timeout',
];

export function isConnectionError(message: string): boolean {
  return CONNECTION_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

export function isServerError(message: string): boolean {
  return SERVER_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function extractConnectionError(message: string): string {
  // Strip prefixes like "Failed to fetch query log: ", "Entries: " etc.
  const cleaned = message
    .replace(/^Failed to (fetch|load) [^:]+:\s*/i, '')
    .replace(/^(Entries|Time series|Stacked series|Count):\s*/i, '');
  return cleaned;
}

// Transform error messages into user-friendly versions
export function getUserFriendlyError(message: string): string {
  const cleaned = extractConnectionError(message);

  // A system log table that isn't enabled is a server config issue, not an outage
  const missingSystemTable = cleaned.match(/Unknown table[^']*'(system\.\w+)'/);
  if (missingSystemTable) {
    return missingTableMessage(missingSystemTable[1]);
  }

  // Server/proxy errors indicate backend is down
  if (isServerError(cleaned)) {
    return 'Cannot connect to backend server. Please ensure the server is running.';
  }

  // Network/connection errors
  if (cleaned.includes('ECONNREFUSED')) {
    return 'Connection refused. The backend server is not running or is unreachable.';
  }
  if (cleaned.includes('ETIMEDOUT')) {
    return 'Connection timed out. The server may be overloaded or unreachable.';
  }
  if (cleaned.includes('ENOTFOUND')) {
    return 'Server not found. Please check your network connection and server address.';
  }
  if (cleaned.includes('Failed to fetch') || cleaned.includes('NetworkError')) {
    return 'Network error. Please check your connection and ensure the server is running.';
  }
  if (isConnectionError(cleaned)) {
    return `Connection error: ${cleaned}`;
  }

  return cleaned;
}

export async function fetchHealth(): Promise<{ status: string; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) {
      // Server returned an error status
      const statusText = response.statusText || `HTTP ${response.status}`;
      if (isServerError(statusText) || response.status >= 500) {
        return { status: 'unhealthy', error: 'Backend server error' };
      }
      return { status: 'unhealthy', error: statusText };
    }
    return response.json();
  } catch (err) {
    // Network error - couldn't reach the server at all
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { status: 'unhealthy', error: getUserFriendlyError(message) };
  }
}

// ==================== ENVIRONMENT API ====================

export interface EnvironmentInfo {
  index: number;
  name: string;
  // Optional display labels from querydog.yml
  organisation?: string | null;
  environment?: string | null;
  host: string;
  port: number;
  user: string;
  database: string;
  deployment?: 'cloud' | 'oss';
}

export async function fetchEnvironments(): Promise<{ active: number; environments: EnvironmentInfo[] }> {
  return fetchJson(`/environments`, 'Failed to fetch environments');
}

export async function switchEnvironment(index: number): Promise<{ name: string; host: string; port: number; connected: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/environments/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  return response.json();
}

// ==================== ENVIRONMENT MANAGEMENT API ====================

export interface FullEnvironmentInfo {
  index: number;
  name: string;
  organisation?: string | null;
  environment?: string | null;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  secure: boolean;
  tls_reject_unauthorized: boolean;
  cluster: string;
  queries_folder: string;
  http_headers: Record<string, string>;
}

export async function fetchFullEnvironments(): Promise<{ active: number; environments: FullEnvironmentInfo[] }> {
  return fetchJson(`/config/environments/full`, 'Failed to fetch environments');
}

export async function addEnvironment(env: Omit<FullEnvironmentInfo, 'index'>): Promise<{ success: boolean; index?: number; error?: string }> {
  const response = await fetch(`${API_BASE}/config/environments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  });
  return response.json();
}

export async function updateEnvironment(index: number, env: Omit<FullEnvironmentInfo, 'index'>): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/config/environments/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  });
  return response.json();
}

export async function deleteEnvironment(index: number): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/config/environments/${index}`, {
    method: 'DELETE',
  });
  return response.json();
}

export async function testEnvironmentConnection(env: Partial<FullEnvironmentInfo>): Promise<{ success: boolean; error?: string; message?: string }> {
  const response = await fetch(`${API_BASE}/config/environments/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  });
  return response.json();
}

function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function fetchQueryLog(
  timeRange: TimeRange,
  search: string,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {},
  limit = 1000,
  offset = 0,
  bucketSize?: BucketSize
): Promise<QueryLogEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  return fetchJson(`/query-log?${params}`, 'Failed to fetch query log');
}

export async function fetchTimeSeries(
  timeRange: TimeRange,
  bucketSize: BucketSize,
  search: string,
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {}
): Promise<{ time: string; count: number }[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    bucket: bucketSize,
  });

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  return fetchJson(`/query-log/timeseries?${params}`, 'Failed to fetch time series');
}

export interface StackedTimeSeriesPoint {
  time: string;
  Select: number;
  Insert: number;
  Delete: number;
  Other: number;
}

export async function fetchStackedTimeSeries(
  timeRange: TimeRange,
  bucketSize: BucketSize,
  search: string,
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {},
  // What each query kind's value is: a count, or e.g. the average duration
  metric: string = 'count',
  aggregation: string = 'avg'
): Promise<StackedTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    bucket: bucketSize,
    metric,
    agg: aggregation,
  });

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  return fetchJson(`/query-log/timeseries-stacked?${params}`, 'Failed to fetch stacked time series');
}

export async function fetchHistogram(
  field: string,
  timeRange: TimeRange,
  search: string,
  filters: Record<string, string[]>,
  limit = 20,
  bucketSize?: BucketSize,
  rangeFilters: Record<string, RangeFilter> = {}
): Promise<HistogramData[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    limit: limit.toString(),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  return fetchJson(`/query-log/histogram/${field}?${params}`, 'Failed to fetch histogram');
}

export async function fetchDistinctValues(
  field: string,
  timeRange: TimeRange,
  limit = 100
): Promise<string[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    limit: limit.toString(),
  });

  return fetchJson(`/query-log/distinct/${field}?${params}`, 'Failed to fetch distinct values');
}

export async function fetchTotalCount(
  timeRange: TimeRange,
  search: string,
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {},
  bucketSize?: BucketSize
): Promise<number> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  const response = await fetch(`${API_BASE}/query-log/count?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch count');
  const data = await response.json();
  return data.total;
}

export async function fetchColumnMetadata(): Promise<ColumnMetadata[]> {
  return fetchJson(`/query-log/columns`, 'Failed to fetch column metadata');
}

export interface GroupedQueryEntry {
  example_query: string;
  normalized_query_hash?: string;  // Only present when normalize=true
  user: string;
  current_database: string;
  count: number;
  total_duration: number;
  avg_duration: number;
  max_duration: number;
  min_duration: number;
  total_memory: number;
  avg_memory: number;
  max_memory: number;
  total_read_rows: number;
  avg_read_rows: number;
  total_read_bytes: number;
  total_written_rows: number;
  avg_written_rows: number;
  total_result_rows: number;
  avg_result_rows: number;
  first_seen: string;
  last_seen: string;
}

export async function fetchGroupedQueryLog(
  timeRange: TimeRange,
  search: string,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {},
  limit = 1000,
  normalize = false,
  bucketSize?: BucketSize
): Promise<GroupedQueryEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  if (normalize) {
    params.set('normalize', 'true');
  }

  return fetchJson(`/query-log/grouped?${params}`, 'Failed to fetch grouped query log');
}

// ==================== BY TABLE STATS API ====================

export interface ByTableEntry {
  table_name: string;
  count: number;
  total_duration: number;
  avg_duration: number;
  max_duration: number;
  min_duration: number;
  total_memory: number;
  avg_memory: number;
  max_memory: number;
  total_read_rows: number;
  avg_read_rows: number;
  total_read_bytes: number;
  error_count: number;
  error_rate: number;
  first_seen: string;
  last_seen: string;
}

export async function fetchByTableStats(
  timeRange: TimeRange,
  search: string,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]>,
  rangeFilters: Record<string, RangeFilter> = {},
  limit = 500,
  bucketSize?: BucketSize
): Promise<ByTableEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  return fetchJson(`/query-log/by-table?${params}`, 'Failed to fetch by-table stats');
}

// ==================== QUERY VIEWS LOG API ====================

export interface QueryViewsLogEntry {
  event_time: string;
  view_name: string;
  view_type: string;
  view_query: string;
  view_target: string;
  read_rows: number;
  read_bytes: number;
  written_rows: number;
  written_bytes: number;
  peak_memory_usage: number;
  view_duration_ms: number;
  status: string;
  exception: string;
  initial_query_id: string;
}

export async function fetchQueryViewsLog(
  timeRange: TimeRange,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]> = {},
  search = '',
  limit = 1000,
  offset = 0
): Promise<QueryViewsLogEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (search) {
    params.set('search', search);
  }

  return fetchJson(`/query-views-log?${params}`, 'Failed to fetch query views log');
}

// ==================== PART LOG API ====================

export async function fetchPartLog(
  timeRange: TimeRange,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]> = {},
  limit = 1000,
  offset = 0
): Promise<PartLogEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  const response = await fetch(`${API_BASE}/part-log?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch part log');
  return response.json();
}

export async function fetchPartLogCount(
  timeRange: TimeRange,
  filters: Record<string, string[]> = {}
): Promise<number> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  const response = await fetch(`${API_BASE}/part-log/count?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch part log');
  const data = await response.json();
  return data.total;
}

export async function fetchPartLogColumnMetadata(): Promise<ColumnMetadata[]> {
  const response = await fetch(`${API_BASE}/part-log/columns`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch part log');
  return response.json();
}

export async function fetchPartLogDistinctValues(
  field: string,
  timeRange: TimeRange,
  limit = 100
): Promise<string[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    limit: limit.toString(),
  });

  return fetchJson(`/part-log/distinct/${field}?${params}`, 'Failed to fetch part_log distinct values');
}

export interface PartLogTimeSeriesPoint {
  time: string;
  count: number;
  new_rows: number;
  merged_rows: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
  sum_duration: number;
}

export interface PartLogStackedTimeSeriesPoint {
  time: string;
  NewPart: number;
  MergeParts: number;
  DownloadPart: number;
  RemovePart: number;
  MutatePart: number;
  Other: number;
}

export async function fetchPartLogHistogram(
  field: string,
  timeRange: TimeRange,
  filters: Record<string, string[]> = {},
  limit = 20
): Promise<HistogramData[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    limit: limit.toString(),
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  return fetchJson(`/part-log/histogram/${field}?${params}`, 'Failed to fetch part_log histogram');
}

export async function fetchPartLogTimeSeries(
  timeRange: TimeRange,
  bucketSize: BucketSize,
  filters: Record<string, string[]> = {}
): Promise<PartLogTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    bucket: bucketSize,
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  const response = await fetch(`${API_BASE}/part-log/timeseries?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch part log');
  return response.json();
}

export async function fetchPartLogStackedTimeSeries(
  timeRange: TimeRange,
  bucketSize: BucketSize,
  filters: Record<string, string[]> = {}
): Promise<PartLogStackedTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    bucket: bucketSize,
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  const response = await fetch(`${API_BASE}/part-log/timeseries-stacked?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch part log');
  return response.json();
}

// ==================== SYSTEM PARTS API ====================

export async function fetchParts(
  sortField = 'modification_time',
  sortOrder: 'ASC' | 'DESC' = 'DESC',
  filters: Record<string, string[]> = {},
  limit = 1000,
  offset = 0,
  search = ''
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ sortField, sortOrder, limit: limit.toString(), offset: offset.toString() });
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  return fetchJson(`/parts?${params}`, 'Failed to fetch parts');
}

export async function fetchPartsCount(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<number> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const data = await fetchJson<{ count: number }>(`/parts/count?${params}`, 'Failed to fetch parts count');
  return data.count;
}

export async function fetchPartsDistinctValues(
  field: string,
  limit = 100
): Promise<string[]> {
  const params = new URLSearchParams({ limit: limit.toString() });
  return fetchJson(`/parts/distinct/${field}?${params}`, 'Failed to fetch parts distinct values');
}

export async function fetchPartsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/parts/columns`, 'Failed to fetch parts columns');
}

export async function fetchPartsHistogram(
  field: string,
  filters: Record<string, string[]> = {},
  limit = 20
): Promise<HistogramData[]> {
  const params = new URLSearchParams({
    limit: limit.toString(),
  });

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  return fetchJson(`/parts/histogram/${field}?${params}`, 'Failed to fetch parts histogram');
}

// Aggregated partitions (grouped by partition_id)
export async function fetchPartitionsSummary(
  sortField = 'latest_modification',
  sortOrder: 'ASC' | 'DESC' = 'DESC',
  filters: Record<string, string[]> = {},
  limit = 1000,
  offset = 0,
  search = ''
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ sortField, sortOrder, limit: limit.toString(), offset: offset.toString() });
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  return fetchJson(`/partitions-summary?${params}`, 'Failed to fetch partitions summary');
}

export async function fetchPartitionsSummaryCount(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<number> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const data = await fetchJson<{ count: number }>(`/partitions-summary/count?${params}`, 'Failed to fetch partitions summary count');
  return data.count;
}

export async function fetchPartitionsSummaryColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/partitions-summary/columns`, 'Failed to fetch partitions summary columns');
}

export interface GroupedPartsEntry {
  database: string;
  table: string;
  engine_full: string;
  partition_count: number;
  part_count: number;
  total_rows: number;
  total_bytes: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  savings_pct: number;
  last_modification_time: string;
}

export interface ColumnCompressionEntry {
  name: string;
  type: string;
  compressed_bytes: number;
  uncompressed_bytes: number;
  savings_pct: number;
}

export async function fetchTableCompression(
  database: string,
  table: string
): Promise<ColumnCompressionEntry[]> {
  return fetchJson(`/table-compression/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch table compression');
}

export interface TablePartitionEntry {
  partition_id: string;
  parts_count: number;
  total_rows: number;
  total_bytes: number;
  min_block: number;
  max_block: number;
  oldest_part: string;
  newest_part: string;
}

export async function fetchTablePartitions(
  database: string,
  table: string,
  activeOnly = true
): Promise<TablePartitionEntry[]> {
  const params = new URLSearchParams({ activeOnly: activeOnly ? '1' : '0' });
  return fetchJson(`/table-partitions/${encodeURIComponent(database)}/${encodeURIComponent(table)}?${params}`, 'Failed to fetch table partitions');
}

export type MergeTreeIndexEntry = Record<string, unknown>;

export async function fetchMergeTreeIndex(
  database: string,
  table: string
): Promise<MergeTreeIndexEntry[]> {
  return fetchJson(`/table-mergetree-index/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch MergeTree index');
}

export async function fetchTableDefinition(
  database: string,
  table: string
): Promise<string> {
  const data = await fetchJson<{ definition: string }>(`/table-definition/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch table definition');
  return data.definition;
}

export interface PartitionPartEntry {
  name: string;
  rows: number;
  bytes_on_disk: number;
  data_compressed_bytes: number;
  data_uncompressed_bytes: number;
  marks: number;
  modification_time: string;
  min_block_number: number;
  max_block_number: number;
  level: number;
  primary_key_bytes_in_memory: number;
  active: number;
}

export async function fetchPartitionParts(
  database: string,
  table: string,
  partitionId: string,
  activeOnly = true
): Promise<PartitionPartEntry[]> {
  const params = new URLSearchParams({ activeOnly: activeOnly ? '1' : '0' });
  return fetchJson(`/partition-parts/${encodeURIComponent(database)}/${encodeURIComponent(table)}/${encodeURIComponent(partitionId)}?${params}`, 'Failed to fetch partition parts');
}

export async function fetchGroupedParts(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<GroupedPartsEntry[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const url = params.toString() ? `${API_BASE}/parts/grouped?${params}` : `${API_BASE}/parts/grouped`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch grouped parts: ${response.statusText}`);
  return response.json();
}

// ==================== ACTIVITY API ====================

export async function fetchProcesses(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/processes?${params}` : `${API_BASE}/processes`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch processes: ${response.statusText}`);
  return response.json();
}

export async function fetchProcessesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/processes/columns`, 'Failed to fetch processes columns');
}

export async function fetchProcessesDistinct(field: string): Promise<string[]> {
  return fetchJson(`/processes/distinct/${field}`, 'Failed to fetch processes distinct');
}

export async function fetchMerges(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/merges?${params}` : `${API_BASE}/merges`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch merges: ${response.statusText}`);
  return response.json();
}

export async function fetchMergesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/merges/columns`, 'Failed to fetch merges columns');
}

export async function fetchMergesDistinct(field: string): Promise<string[]> {
  return fetchJson(`/merges/distinct/${field}`, 'Failed to fetch merges distinct');
}

export async function fetchMutations(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/mutations?${params}` : `${API_BASE}/mutations`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch mutations: ${response.statusText}`);
  return response.json();
}

export async function fetchMutationsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/mutations/columns`, 'Failed to fetch mutations columns');
}

export async function fetchMutationsDistinct(field: string): Promise<string[]> {
  return fetchJson(`/mutations/distinct/${field}`, 'Failed to fetch mutations distinct');
}

// ==================== VIEW REFRESHES API ====================

export async function fetchViewRefreshes(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/view-refreshes?${params}` : `${API_BASE}/view-refreshes`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch view refreshes: ${response.statusText}`);
  return response.json();
}

export async function fetchViewRefreshesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/view-refreshes/columns`, 'Failed to fetch view refreshes columns');
}

export async function fetchViewRefreshesDistinct(field: string): Promise<string[]> {
  return fetchJson(`/view-refreshes/distinct/${field}`, 'Failed to fetch view refreshes distinct');
}

// ==================== QUERY CACHE API ====================

export async function fetchQueryCache(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/query-cache?${params}` : `${API_BASE}/query-cache`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch query cache: ${response.statusText}`);
  return response.json();
}

export async function fetchQueryCacheColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/query-cache/columns`, 'Failed to fetch query cache columns');
}

// ==================== ASYNC INSERTS API ====================

export async function fetchAsyncInserts(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/async-inserts?${params}` : `${API_BASE}/async-inserts`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch async inserts: ${response.statusText}`);
  return response.json();
}

export async function fetchAsyncInsertsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/async-inserts/columns`, 'Failed to fetch async inserts columns');
}

export async function fetchAsyncInsertsDistinct(field: string): Promise<string[]> {
  return fetchJson(`/async-inserts/distinct/${field}`, 'Failed to fetch async inserts distinct');
}

// ==================== DISTRIBUTED DDL API ====================

export async function fetchDistributedDDL(filters: Record<string, string[]> = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  const url = Object.keys(filters).length > 0 ? `${API_BASE}/distributed-ddl?${params}` : `${API_BASE}/distributed-ddl`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch distributed DDL: ${response.statusText}`);
  return response.json();
}

export async function fetchDistributedDDLColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/distributed-ddl/columns`, 'Failed to fetch distributed DDL columns');
}

export async function fetchDistributedDDLDistinct(field: string): Promise<string[]> {
  return fetchJson(`/distributed-ddl/distinct/${field}`, 'Failed to fetch distributed DDL distinct');
}

// ==================== DISKS API ====================

export async function fetchDisks(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/disks`, 'Failed to fetch disks');
}

export async function fetchDisksColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/disks/columns`, 'Failed to fetch disks columns');
}

// ==================== STORAGE POLICIES API ====================

export async function fetchStoragePolicies(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/storage-policies`, 'Failed to fetch storage policies');
}

export async function fetchStoragePoliciesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/storage-policies/columns`, 'Failed to fetch storage policies columns');
}

// ==================== METRICS API ====================

export async function fetchMetrics(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/metrics`, 'Failed to fetch metrics');
}

export async function fetchAsyncMetrics(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/async-metrics`, 'Failed to fetch async metrics');
}

export async function fetchEvents(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/events`, 'Failed to fetch events');
}

export async function fetchErrors(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/errors`, 'Failed to fetch errors');
}

export async function fetchErrorsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/errors/columns`, 'Failed to fetch errors columns');
}

export async function fetchWarnings(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/warnings`, 'Failed to fetch warnings');
}

export async function fetchWarningsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/warnings/columns`, 'Failed to fetch warnings columns');
}

// ==================== DATABASE BROWSER API ====================

export interface BrowserDatabase {
  name: string;
  engine: string;
  data_path: string;
  metadata_path: string;
  uuid: string;
}

export interface BrowserTable {
  name: string;
  engine: string;
  total_rows: number;
  total_bytes: number;
  metadata_modification_time: string;
  partition_count: number;
}

export interface BrowserPartition {
  partition_id: string;
  partition: string;
  part_count: number;
  total_rows: number;
  total_bytes: number;
  min_time: string;
  max_time: string;
}

export interface BrowserPart {
  name: string;
  partition_id: string;
  rows: number;
  bytes_on_disk: number;
  data_compressed_bytes: number;
  data_uncompressed_bytes: number;
  marks: number;
  modification_time: string;
  min_time: string;
  max_time: string;
  level: number;
  primary_key_bytes_in_memory: number;
}

export interface DatabaseSummary {
  database: string;
  engine: string;
  table_count: number;
  total_rows: number;
  total_bytes: number;
  partition_count: number;
  part_count: number;
  part_rows: number;
  bytes_on_disk: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  compression_ratio: number;
  latest_modification: string;
}

export async function fetchDatabasesSummary(): Promise<DatabaseSummary[]> {
  return fetchJson(`/databases/summary`, 'Failed to fetch databases summary');
}

export async function fetchBrowserDatabases(): Promise<BrowserDatabase[]> {
  return fetchJson(`/browser/databases`, 'Failed to fetch databases');
}

export async function fetchBrowserTables(database: string): Promise<BrowserTable[]> {
  return fetchJson(`/browser/tables/${encodeURIComponent(database)}`, 'Failed to fetch tables');
}

export async function fetchBrowserPartitions(database: string, table: string): Promise<BrowserPartition[]> {
  return fetchJson(`/browser/partitions/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch partitions');
}

export async function fetchBrowserParts(database: string, table: string, partition: string): Promise<BrowserPart[]> {
  return fetchJson(`/browser/parts/${encodeURIComponent(database)}/${encodeURIComponent(table)}/${encodeURIComponent(partition)}`, 'Failed to fetch parts');
}

export interface BrowserColumn {
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

export async function fetchBrowserColumns(database: string, table: string): Promise<BrowserColumn[]> {
  return fetchJson(`/browser/columns/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch columns');
}

export async function fetchBrowserSampleData(database: string, table: string): Promise<Record<string, unknown>[]> {
  return fetchJson(`/browser/sample/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch sample data');
}

export interface BrowserProjection {
  name: string;
  type: string;
  sorting_key: string;
  query: string;
  storage_policy: string;
  partition_key: string;
  primary_key: string;
}

export interface BrowserProjectionPart {
  name: string;
  part_name: string;
  partition_id: string;
  rows: number;
  bytes_on_disk: number;
  data_compressed_bytes: number;
  data_uncompressed_bytes: number;
  marks: number;
  modification_time: string;
  parent_part_name: string;
  is_broken: number;
}

export async function fetchBrowserProjections(database: string, table: string): Promise<BrowserProjection[]> {
  return fetchJson(`/browser/projections/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch projections');
}

export async function fetchBrowserProjectionParts(database: string, table: string, projection: string): Promise<BrowserProjectionPart[]> {
  return fetchJson(`/browser/projection-parts/${encodeURIComponent(database)}/${encodeURIComponent(table)}/${encodeURIComponent(projection)}`, 'Failed to fetch projection parts');
}

// System-wide projections API
export interface SystemProjection {
  database: string;
  table: string;
  name: string;
  type: string;
  sorting_key: string;
  query: string;
}

export async function fetchSystemProjections(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<SystemProjection[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const url = params.toString() ? `${API_BASE}/projections?${params}` : `${API_BASE}/projections`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch projections: ${response.statusText}`);
  return response.json();
}

export async function fetchProjectionParts(
  database: string,
  table: string,
  projection: string
): Promise<BrowserProjectionPart[]> {
  return fetchJson(`/projection-parts/${encodeURIComponent(database)}/${encodeURIComponent(table)}/${encodeURIComponent(projection)}`, 'Failed to fetch projection parts');
}

// System-wide views API
export interface SystemView {
  database: string;
  name: string;
  engine: string;
  as_select: string;
  metadata_modification_time: string;
  create_table_query: string;
}

export async function fetchSystemViews(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<SystemView[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const url = params.toString() ? `${API_BASE}/views?${params}` : `${API_BASE}/views`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch views: ${response.statusText}`);
  return response.json();
}

export async function fetchViewDefinition(
  database: string,
  view: string
): Promise<string> {
  const data = await fetchJson<{ definition: string }>(`/view-definition/${encodeURIComponent(database)}/${encodeURIComponent(view)}`, 'Failed to fetch view definition');
  return data.definition;
}

// System-wide dictionaries API
export interface SystemDictionary {
  database: string;
  name: string;
  uuid: string;
  status: string;
  origin: string;
  type: string;
  key: string;
  attribute_names: string[];
  attribute_types: string[];
  bytes_allocated: number;
  hierarchical_index_bytes_allocated: number;
  query_count: number;
  hit_rate: number;
  found_rate: number;
  element_count: number;
  load_factor: number;
  source: string;
  lifetime_min: number;
  lifetime_max: number;
  loading_start_time: string;
  last_successful_update_time: string;
  loading_duration: number;
  last_exception: string;
}

export async function fetchDictionaries(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<SystemDictionary[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const url = params.toString() ? `${API_BASE}/dictionaries?${params}` : `${API_BASE}/dictionaries`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch dictionaries: ${response.statusText}`);
  return response.json();
}

// Browser endpoint for indexes per table
export interface BrowserIndex {
  name: string;
  type: string;
  type_full: string;
  expr: string;
  granularity: number;
  data_compressed_bytes: number;
  data_uncompressed_bytes: number;
  marks: number;
}

export async function fetchBrowserIndexes(database: string, table: string): Promise<BrowserIndex[]> {
  return fetchJson(`/browser/indexes/${encodeURIComponent(database)}/${encodeURIComponent(table)}`, 'Failed to fetch indexes');
}

// Data skipping indexes (formatted size)
export interface DataSkippingIndex {
  database: string;
  table: string;
  name: string;
  type_full: string;
  size: string;
}

export async function fetchDataSkippingIndexes(
  filters: Record<string, string[]> = {},
  search = ''
): Promise<DataSkippingIndex[]> {
  const params = new URLSearchParams();
  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (search) {
    params.set('search', search);
  }
  const url = params.toString() ? `${API_BASE}/data-skipping-indexes?${params}` : `${API_BASE}/data-skipping-indexes`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch data skipping indexes: ${response.statusText}`);
  return response.json();
}

// ==================== TEXT LOG API ====================

export interface TextLogEntry {
  event_time: string;
  event_time_microseconds: string;
  event_date: string;
  level: string;
  query_id: string;
  logger_name: string;
  message: string;
  revision: number;
  source_file: string;
  source_line: number;
  thread_name: string;
  thread_id: number;
}

export interface TextLogTimeSeriesPoint {
  time: string;
  count: number;
  errors: number;
  warnings: number;
}

export async function fetchTextLog(
  timeRange: TimeRange,
  search: string,
  sortField: string,
  sortOrder: 'ASC' | 'DESC',
  filters: Record<string, string[]>,
  limit: number,
  offset: number
): Promise<TextLogEntry[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  return fetchJson(`/text-log?${params}`, 'Failed to fetch text log');
}

export async function fetchTextLogCount(
  timeRange: TimeRange,
  search: string,
  filters: Record<string, string[]>
): Promise<number> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
  });

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  const response = await fetch(`${API_BASE}/text-log/count?${params}`);
  if (!response.ok) throw await apiError(response, 'Failed to fetch text log count');
  const data = await response.json();
  return data.total;
}

export async function fetchTextLogTimeSeries(
  timeRange: TimeRange,
  bucket: BucketSize,
  filters: Record<string, string[]>,
  search?: string
): Promise<TextLogTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    bucket,
  });

  if (search) {
    params.set('search', search);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  return fetchJson(`/text-log/timeseries?${params}`, 'Failed to fetch text log time series');
}

export async function fetchTextLogDistinct(
  field: string,
  timeRange: TimeRange
): Promise<string[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
  });

  return fetchJson(`/text-log/distinct/${field}?${params}`, 'Failed to fetch text log distinct values');
}

// ==================== INSTANCE API ====================

export async function fetchUsers(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/users`, 'Failed to fetch users');
}

export async function fetchUsersColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/users/columns`, 'Failed to fetch users columns');
}

export async function fetchSettings(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/settings`, 'Failed to fetch settings');
}

export async function fetchSettingsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/settings/columns`, 'Failed to fetch settings columns');
}

// ==================== USERS & SECURITY API ====================

export async function fetchGrants(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/grants`, 'Failed to fetch grants');
}

export async function fetchGrantsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/grants/columns`, 'Failed to fetch grants columns');
}

export async function fetchRoles(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/roles`, 'Failed to fetch roles');
}

export async function fetchRolesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/roles/columns`, 'Failed to fetch roles columns');
}

export async function fetchRoleGrants(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/role-grants`, 'Failed to fetch role grants');
}

export async function fetchRoleGrantsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/role-grants/columns`, 'Failed to fetch role grants columns');
}

export async function fetchQuotas(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/quotas`, 'Failed to fetch quotas');
}

export async function fetchQuotasColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/quotas/columns`, 'Failed to fetch quotas columns');
}

export async function fetchQuotaUsage(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/quota-usage`, 'Failed to fetch quota usage');
}

export async function fetchQuotaUsageColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/quota-usage/columns`, 'Failed to fetch quota usage columns');
}

export async function fetchQuotaLimits(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/quota-limits`, 'Failed to fetch quota limits');
}

export async function fetchQuotaLimitsColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/quota-limits/columns`, 'Failed to fetch quota limits columns');
}

export async function fetchRowPolicies(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/row-policies`, 'Failed to fetch row policies');
}

export async function fetchRowPoliciesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/row-policies/columns`, 'Failed to fetch row policies columns');
}

export async function fetchSessionLog(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/session-log`, 'Failed to fetch session log');
}

export async function fetchSessionLogColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/session-log/columns`, 'Failed to fetch session log columns');
}

// ==================== EXPLAIN API ====================

export type ExplainType = 'plan' | 'indexes' | 'actions' | 'pipeline' | 'ast' | 'syntax' | 'estimate' | 'json' | 'json-plan';

export async function fetchExplainByType(query: string, type: ExplainType): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${API_BASE}/explain/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to run explain ${type}`);
  }
  return response.json();
}

// Fetch JSON explain plan with indexes - returns structured ClickHouse plan data
export async function fetchExplainJson(query: string, includeIndexes = true): Promise<Record<string, unknown>[]> {
  const type = includeIndexes ? 'json' : 'json-plan';
  const response = await fetch(`${API_BASE}/explain/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to run explain json`);
  }
  return response.json();
}

export interface QueryResult {
  data: Record<string, unknown>[];
  rowCount: number;
  duration: number;
}

export async function executeQuery(query: string, limit = 1000): Promise<QueryResult> {
  const response = await fetch(`${API_BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to execute query');
  }
  return response.json();
}

// ==================== PROFILE EVENTS API ====================

export async function fetchProfileEvents(
  timeRange: TimeRange,
  filters: Record<string, string[]>,
  eventColumns: string[],
  search?: string,
  sortField = 'event_time',
  sortOrder: 'ASC' | 'DESC' = 'DESC',
  rangeFilters: Record<string, RangeFilter> = {},
  limit = 1000,
  offset = 0,
  bucketSize?: BucketSize
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    start: formatDateTime(timeRange.start),
    end: formatDateTime(timeRange.end),
    sortField,
    sortOrder,
    limit: limit.toString(),
    offset: offset.toString(),
    eventColumns: eventColumns.join(','),
  });

  if (bucketSize) {
    params.set('bucket', bucketSize);
  }

  if (Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }

  if (Object.keys(rangeFilters).length > 0) {
    params.set('rangeFilters', JSON.stringify(rangeFilters));
  }

  if (search) {
    params.set('search', search);
  }

  return fetchJson(`/query-log/profile-events?${params}`, 'Failed to fetch profile events');
}

// ==================== CLUSTER API ====================

export async function fetchReplicationQueue(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/replication-queue`, 'Failed to fetch replication queue');
}

export async function fetchReplicationQueueColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/replication-queue/columns`, 'Failed to fetch replication queue columns');
}

export async function fetchReplicationQueueGrouped(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/replication-queue/grouped`, 'Failed to fetch grouped replication queue');
}

export async function fetchReplicas(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/replicas`, 'Failed to fetch replicas');
}

export async function fetchReplicasColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/replicas/columns`, 'Failed to fetch replicas columns');
}

export async function fetchClusters(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/clusters`, 'Failed to fetch clusters');
}

export async function fetchClustersColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/clusters/columns`, 'Failed to fetch clusters columns');
}

export async function fetchReplicatedFetches(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/fetches`, 'Failed to fetch replicated fetches');
}

export async function fetchReplicatedFetchesColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/fetches/columns`, 'Failed to fetch replicated fetches columns');
}

export async function fetchDistributedDdlQueue(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/distributed-ddl`, 'Failed to fetch distributed DDL queue');
}

export async function fetchDistributedDdlQueueColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/distributed-ddl/columns`, 'Failed to fetch distributed DDL queue columns');
}

export async function fetchZookeeper(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/zookeeper`, 'Failed to fetch zookeeper');
}

export async function fetchZookeeperColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/zookeeper/columns`, 'Failed to fetch zookeeper columns');
}

export async function fetchZookeeperConnection(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/zookeeper-connection`, 'Failed to fetch zookeeper_connection');
}

export async function fetchZookeeperConnectionColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/zookeeper-connection/columns`, 'Failed to fetch zookeeper_connection columns');
}

export async function fetchZookeeperConnectionLog(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/zookeeper-connection-log`, 'Failed to fetch zookeeper_connection_log');
}

export async function fetchZookeeperConnectionLogColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/zookeeper-connection-log/columns`, 'Failed to fetch zookeeper_connection_log columns');
}

export async function fetchDistributionQueue(): Promise<Record<string, unknown>[]> {
  return fetchJson(`/cluster/distribution-queue`, 'Failed to fetch distribution_queue');
}

export async function fetchDistributionQueueColumns(): Promise<ColumnMetadata[]> {
  return fetchJson(`/cluster/distribution-queue/columns`, 'Failed to fetch distribution_queue columns');
}

// ==================== METRIC LOG API (Dashboard) ====================

export interface MetricLogTimeSeriesPoint {
  time: string;
  [key: string]: string | number;
}

export async function fetchMetricLogTimeSeries(
  start: Date,
  end: Date,
  bucket: 'second' | 'minute' | 'hour' = 'minute',
  metrics?: string[]
): Promise<MetricLogTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: start.toISOString().slice(0, 19).replace('T', ' '),
    end: end.toISOString().slice(0, 19).replace('T', ' '),
    bucket,
  });

  if (metrics && metrics.length > 0) {
    params.set('metrics', metrics.join(','));
  }

  return fetchJson(`/metric-log/timeseries?${params}`, 'Failed to fetch metric_log timeseries');
}

// ==================== ASYNC METRIC LOG API (Dashboard) ====================

export async function fetchAsyncMetricLogTimeSeries(
  start: Date,
  end: Date,
  bucket: 'second' | 'minute' | 'hour' = 'minute',
  metrics?: string[]
): Promise<MetricLogTimeSeriesPoint[]> {
  const params = new URLSearchParams({
    start: start.toISOString().slice(0, 19).replace('T', ' '),
    end: end.toISOString().slice(0, 19).replace('T', ' '),
    bucket,
  });

  if (metrics && metrics.length > 0) {
    params.set('metrics', metrics.join(','));
  }

  return fetchJson(`/async-metric-log/timeseries?${params}`, 'Failed to fetch async metric_log timeseries');
}
