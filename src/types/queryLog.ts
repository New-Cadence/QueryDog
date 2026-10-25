// Dynamic types - query_log has 84 columns, part_log has its own set
export type QueryLogEntry = Record<string, unknown>;
export type PartLogEntry = Record<string, unknown>;

export interface ColumnMetadata {
  name: string;
  type: string;
  comment: string;
}

export interface TimeSeriesPoint {
  time: string;
  count: number;
}

export interface HistogramData {
  name: string;
  count: number;
}

export interface HistogramField {
  field: string;
  label: string;
  data: HistogramData[];
}

export type BucketSize = 'second' | 'minute' | 'hour';

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface QueryFilters {
  search: string;
  timeRange: TimeRange;
  bucketSize: BucketSize;
  fieldFilters: Record<string, string[]>;
}

export interface ColumnConfig {
  field: string;
  headerName: string;
  comment: string;
  type: string;
  visible: boolean;
  width: number;
  sortable: boolean;
}

// Columns visible by default — the most important columns for query analysis
const DEFAULT_VISIBLE_COLUMNS = new Set([
  'event_time', 'type', 'query_id', 'query', 'query_kind', 'query_duration_ms',
  'read_rows', 'read_bytes', 'written_rows', 'written_bytes',
  'result_rows', 'result_bytes', 'memory_usage', 'peak_memory_usage',
  'user', 'current_database', 'exception_code',
]);

// Array types that shouldn't be sortable
const ARRAY_TYPE_PATTERN = /^Array\(/;
const MAP_TYPE_PATTERN = /^Map\(/;
const TUPLE_TYPE_PATTERN = /^Tuple\(/;

function getColumnWidth(name: string, type: string): number {
  if (name === 'query') return 700;
  if (name === 'query_id' || name === 'initial_query_id') return 200;
  if (name === 'event_type') return 240;
  if (name === 'name') return 280;
  if (name.includes('time') && !name.includes('_ms')) return 150;
  if (name === 'exception' || name === 'stack_trace') return 250;
  if (ARRAY_TYPE_PATTERN.test(type) || MAP_TYPE_PATTERN.test(type)) return 180;
  if (type.includes('String')) return 120;
  return 100;
}

function formatHeaderName(name: string): string {
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Priority columns that should appear first (in order) for query_log
const QUERY_LOG_PRIORITY_COLUMNS = ['event_time', 'query_id', 'query'];

// Priority columns for part_log
const PART_LOG_PRIORITY_COLUMNS = ['event_time', 'table', 'database', 'event_type', 'part_name'];

// Default visible columns for part_log
const DEFAULT_VISIBLE_PART_LOG_COLUMNS = new Set([
  'event_time', 'event_type', 'database', 'table', 'part_name',
  'partition_id', 'rows', 'size_in_bytes', 'duration_ms'
]);

export function createColumnsFromMetadata(metadata: ColumnMetadata[], tableName: 'query_log' | 'part_log' = 'query_log'): ColumnConfig[] {
  const defaultVisible = tableName === 'part_log' ? DEFAULT_VISIBLE_PART_LOG_COLUMNS : DEFAULT_VISIBLE_COLUMNS;
  const priorityColumns = tableName === 'part_log' ? PART_LOG_PRIORITY_COLUMNS : QUERY_LOG_PRIORITY_COLUMNS;

  const columns = metadata
    .map(col => ({
      field: col.name,
      headerName: formatHeaderName(col.name),
      comment: col.comment,
      type: col.type,
      visible: defaultVisible.has(col.name),
      width: getColumnWidth(col.name, col.type),
      sortable: !ARRAY_TYPE_PATTERN.test(col.type) && !MAP_TYPE_PATTERN.test(col.type) && !TUPLE_TYPE_PATTERN.test(col.type),
    }));

  // Sort to put priority columns first
  return columns.sort((a, b) => {
    const aIndex = priorityColumns.indexOf(a.field);
    const bIndex = priorityColumns.indexOf(b.field);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return 0;
  });
}

// Fallback columns if metadata fetch fails
export const FALLBACK_COLUMNS: ColumnConfig[] = [
  { field: 'event_time', headerName: 'Event Time', comment: 'Query starting time.', type: 'DateTime', visible: true, width: 215, sortable: true },
  { field: 'query_id', headerName: 'Query ID', comment: 'ID of the query.', type: 'String', visible: true, width: 200, sortable: true },
  { field: 'query', headerName: 'Query', comment: 'Query string.', type: 'String', visible: true, width: 350, sortable: false },
  { field: 'query_duration_ms', headerName: 'Duration', comment: 'Duration of query execution in milliseconds.', type: 'UInt64', visible: true, width: 90, sortable: true },
  { field: 'read_rows', headerName: 'Read Rows', comment: 'Total number of rows read.', type: 'UInt64', visible: true, width: 100, sortable: true },
  { field: 'memory_usage', headerName: 'Memory', comment: 'Memory consumption by the query.', type: 'UInt64', visible: true, width: 100, sortable: true },
  { field: 'user', headerName: 'User', comment: 'Name of the user who initiated the query.', type: 'String', visible: true, width: 100, sortable: true },
];

// Fallback columns for part_log
export const FALLBACK_PART_LOG_COLUMNS: ColumnConfig[] = [
  { field: 'event_time', headerName: 'Event Time', comment: 'Time of the event.', type: 'DateTime', visible: true, width: 215, sortable: true },
  { field: 'event_type', headerName: 'Event Type', comment: 'Type of the event.', type: 'String', visible: true, width: 240, sortable: true },
  { field: 'database', headerName: 'Database', comment: 'Name of the database.', type: 'String', visible: true, width: 120, sortable: true },
  { field: 'table', headerName: 'Table', comment: 'Name of the table.', type: 'String', visible: true, width: 150, sortable: true },
  { field: 'part_name', headerName: 'Part Name', comment: 'Name of the data part.', type: 'String', visible: true, width: 200, sortable: true },
  { field: 'rows', headerName: 'Rows', comment: 'Number of rows in the part.', type: 'UInt64', visible: true, width: 100, sortable: true },
  { field: 'size_in_bytes', headerName: 'Size', comment: 'Size of the data part in bytes.', type: 'UInt64', visible: true, width: 100, sortable: true },
];

export const HISTOGRAM_FIELDS = [
  // Row 1: Most important
  { field: 'query_kind', label: 'Query Kind' },
  { field: 'current_database', label: 'Database' },
  { field: 'tables', label: 'Tables' },
  // Row 2
  { field: 'user', label: 'User' },
  { field: 'client_name', label: 'Client Name' },
  { field: 'type', label: 'Query Type' },
  // Row 3
  { field: 'used_functions', label: 'Used Functions' },
  { field: 'used_aggregate_functions', label: 'Aggregate Functions' },
  { field: 'used_table_functions', label: 'Table Functions' },
  // Row 4
  { field: 'exception_code', label: 'Exception Code' },
  { field: 'is_initial_query', label: 'Initial Query' },
  { field: 'client_hostname', label: 'Client Hostname' },
];
