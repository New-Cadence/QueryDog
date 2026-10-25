import { create } from 'zustand';
import type { QueryLogEntry, PartLogEntry, TimeRange, BucketSize, ColumnConfig } from '../types/queryLog';
import { FALLBACK_COLUMNS, FALLBACK_PART_LOG_COLUMNS } from '../types/queryLog';
import type { GroupedQueryEntry } from '../services/api';

export interface RangeFilter {
  min?: number;
  max?: number;
}

// Number of active query_log filters (value + range) — shared by the Filters
// button badge and the "N filters active" toolbar label so they always agree.
export function countActiveFilters(fieldFilters: Record<string, string[]>, rangeFilters: Record<string, RangeFilter> = {}): number {
  return Object.values(fieldFilters).filter((v) => v.length > 0).length +
    Object.values(rangeFilters).filter((r) => r.min !== undefined || r.max !== undefined).length;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export type ChartMetric = 'count' | 'duration' | 'memory' | 'read_rows' | 'written_rows' | 'result_rows';
export type ChartType = 'bar' | 'stacked-bar' | 'line' | 'stacked-line' | 'scatter';
export type ChartAggregation = 'avg' | 'sum' | 'min' | 'max';

export interface TimeSeriesPoint {
  time: string;
  count: number;
  avg_duration?: number;
  max_duration?: number;
  min_duration?: number;
  sum_duration?: number;
  avg_memory?: number;
  max_memory?: number;
  min_memory?: number;
  sum_memory?: number;
  avg_read_rows?: number;
  max_read_rows?: number;
  min_read_rows?: number;
  sum_read_rows?: number;
  avg_written_rows?: number;
  max_written_rows?: number;
  min_written_rows?: number;
  sum_written_rows?: number;
  avg_result_rows?: number;
  max_result_rows?: number;
  min_result_rows?: number;
  sum_result_rows?: number;
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

export interface StackedTimeSeriesPoint {
  time: string;
  Select: number;
  Insert: number;
  Delete: number;
  Other: number;
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

interface QueryState {
  // Data
  entries: QueryLogEntry[];
  timeSeries: TimeSeriesPoint[];
  stackedTimeSeries: StackedTimeSeriesPoint[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  // system.query_log is not enabled on the server (shown inline, not as an error)
  queryLogMissing: boolean;

  // Grouped Query Data
  groupedEntries: GroupedQueryEntry[];
  groupedLoading: boolean;
  groupedSortField: string;
  groupedSortOrder: 'ASC' | 'DESC';
  normalizeQueries: boolean;

  // Part Log Data
  partLogEntries: PartLogEntry[];
  partLogTimeSeries: PartLogTimeSeriesPoint[];
  partLogStackedTimeSeries: PartLogStackedTimeSeriesPoint[];
  partLogTotalCount: number;
  partLogLoading: boolean;
  hasPartLogAccess: boolean;
  hasPartsAccess: boolean;

  // Chart
  chartMetric: ChartMetric;
  chartType: ChartType;
  chartAggregation: ChartAggregation;
  partLogChartMetric: 'count' | 'duration';

  // Filters
  timeRange: TimeRange;
  relativeTimeMinutes: number | null; // null = custom range, number = relative range in minutes
  bucketSize: BucketSize;
  search: string;
  fieldFilters: Record<string, string[]>;
  rangeFilters: Record<string, RangeFilter>;

  // Table config
  columns: ColumnConfig[];
  columnsLoaded: boolean;
  sortField: string;
  sortOrder: 'ASC' | 'DESC';

  // Pagination
  pageSize: number;
  currentPage: number;

  // Part Log Table config
  partLogColumns: ColumnConfig[];
  partLogColumnsLoaded: boolean;
  partLogSortField: string;
  partLogSortOrder: 'ASC' | 'DESC';
  partLogFieldFilters: Record<string, string[]>;
  partLogPageSize: number;
  partLogCurrentPage: number;

  // Parts Table config
  partsTotalCount: number;
  partsPageSize: number;
  partsCurrentPage: number;

  // Partitions Table config
  partitionsTotalCount: number;
  partitionsPageSize: number;
  partitionsCurrentPage: number;

  // UI state
  selectedEntry: QueryLogEntry | null;
  selectedEntries: QueryLogEntry[];
  pinnedEntries: QueryLogEntry[];
  activeTab: 'queries' | 'grouped' | 'histograms' | 'profileEvents' | 'byTable' | 'queryViewsLog';

  // Global refresh trigger - increment to trigger refresh on all pages
  globalRefreshTrigger: number;

  // Actions
  setEntries: (entries: QueryLogEntry[]) => void;
  setTimeSeries: (data: TimeSeriesPoint[]) => void;
  setStackedTimeSeries: (data: StackedTimeSeriesPoint[]) => void;
  setChartMetric: (metric: ChartMetric) => void;
  setChartType: (type: ChartType) => void;
  setChartAggregation: (aggregation: ChartAggregation) => void;
  setPartLogChartMetric: (metric: 'count' | 'duration') => void;
  setTotalCount: (count: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setQueryLogMissing: (missing: boolean) => void;
  setTimeRange: (range: TimeRange) => void;
  setRelativeTimeRange: (minutes: number) => void;
  refreshTimeRange: () => void;
  setBucketSize: (size: BucketSize) => void;
  setSearch: (search: string) => void;
  setFieldFilter: (field: string, values: string[]) => void;
  setRangeFilter: (field: string, filter: RangeFilter) => void;
  clearFieldFilter: (field: string) => void;
  clearRangeFilter: (field: string) => void;
  clearAllFilters: () => void;
  setColumns: (columns: ColumnConfig[]) => void;
  toggleColumnVisibility: (field: string) => void;
  setSortField: (field: string) => void;
  setSortOrder: (order: 'ASC' | 'DESC') => void;
  setCurrentPage: (page: number) => void;
  setSelectedEntry: (entry: QueryLogEntry | null) => void;
  setSelectedEntries: (entries: QueryLogEntry[]) => void;
  pinEntry: (entry: QueryLogEntry) => void;
  unpinEntry: (queryId: string, eventTime: string) => void;
  clearPinnedEntries: () => void;
  setActiveTab: (tab: 'queries' | 'grouped' | 'histograms' | 'profileEvents' | 'byTable' | 'queryViewsLog') => void;
  // Grouped Query Actions
  setGroupedEntries: (entries: GroupedQueryEntry[]) => void;
  setGroupedLoading: (loading: boolean) => void;
  setGroupedSortField: (field: string) => void;
  setGroupedSortOrder: (order: 'ASC' | 'DESC') => void;
  setNormalizeQueries: (normalize: boolean) => void;
  // Part Log Actions
  setPartLogEntries: (entries: PartLogEntry[]) => void;
  setPartLogTimeSeries: (data: PartLogTimeSeriesPoint[]) => void;
  setPartLogStackedTimeSeries: (data: PartLogStackedTimeSeriesPoint[]) => void;
  setPartLogTotalCount: (count: number) => void;
  setPartLogLoading: (loading: boolean) => void;
  setHasPartLogAccess: (hasAccess: boolean) => void;
  setHasPartsAccess: (hasAccess: boolean) => void;
  setPartLogColumns: (columns: ColumnConfig[]) => void;
  togglePartLogColumnVisibility: (field: string) => void;
  setPartLogSortField: (field: string) => void;
  setPartLogSortOrder: (order: 'ASC' | 'DESC') => void;
  setPartLogFieldFilter: (field: string, values: string[]) => void;
  clearPartLogFieldFilter: (field: string) => void;
  clearAllPartLogFilters: () => void;
  setPartLogCurrentPage: (page: number) => void;
  // Parts Actions
  setPartsTotalCount: (count: number) => void;
  setPartsCurrentPage: (page: number) => void;
  // Partitions Actions
  setPartitionsTotalCount: (count: number) => void;
  setPartitionsCurrentPage: (page: number) => void;
  // Global refresh
  triggerGlobalRefresh: () => void;
}

const now = new Date();
const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

export const useQueryStore = create<QueryState>((set) => ({
  entries: [],
  timeSeries: [],
  stackedTimeSeries: [],
  totalCount: 0,
  loading: false,
  error: null,
  queryLogMissing: false,

  // Grouped Query Data
  groupedEntries: [],
  groupedLoading: false,
  groupedSortField: 'count',
  groupedSortOrder: 'DESC',
  normalizeQueries: false,

  // Part Log Data
  partLogEntries: [],
  partLogTimeSeries: [],
  partLogStackedTimeSeries: [],
  partLogTotalCount: 0,
  partLogLoading: false,
  hasPartLogAccess: true,
  hasPartsAccess: true,

  chartMetric: 'count',
  chartType: 'stacked-bar',
  chartAggregation: 'avg',
  partLogChartMetric: 'count',

  timeRange: { start: fifteenMinutesAgo, end: now },
  relativeTimeMinutes: 15, // Default to 15 minutes relative range
  bucketSize: 'minute',
  search: '',
  fieldFilters: { type: ['QueryFinish'] },
  rangeFilters: {},

  columns: FALLBACK_COLUMNS,
  columnsLoaded: false,
  sortField: 'event_time',
  sortOrder: 'DESC',

  pageSize: 1000,
  currentPage: 0,

  // Part Log Table config
  partLogColumns: FALLBACK_PART_LOG_COLUMNS,
  partLogColumnsLoaded: false,
  partLogSortField: 'event_time',
  partLogSortOrder: 'DESC',
  partLogFieldFilters: { event_type: ['NewPart', 'MergeParts', 'DownloadPart', 'RemovePart', 'MutatePart'] },
  partLogPageSize: 1000,
  partLogCurrentPage: 0,

  // Parts Table config
  partsTotalCount: 0,
  partsPageSize: 1000,
  partsCurrentPage: 0,

  // Partitions Table config
  partitionsTotalCount: 0,
  partitionsPageSize: 1000,
  partitionsCurrentPage: 0,

  selectedEntry: null,
  selectedEntries: [],
  pinnedEntries: [],
  activeTab: 'queries',

  // Global refresh trigger
  globalRefreshTrigger: 0,

  setEntries: (entries) => set({ entries }),
  setTimeSeries: (timeSeries) => set({ timeSeries }),
  setStackedTimeSeries: (stackedTimeSeries) => set({ stackedTimeSeries }),
  setChartMetric: (chartMetric) => set({ chartMetric }),
  setChartType: (chartType) => set({ chartType }),
  setChartAggregation: (chartAggregation) => set({ chartAggregation }),
  setPartLogChartMetric: (partLogChartMetric) => set({ partLogChartMetric }),
  setTotalCount: (totalCount) => set({ totalCount }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setQueryLogMissing: (queryLogMissing) => set({ queryLogMissing }),
  setTimeRange: (timeRange) => set({ timeRange, relativeTimeMinutes: null, currentPage: 0 }),
  setRelativeTimeRange: (minutes) => {
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60 * 1000);
    set({ timeRange: { start, end }, relativeTimeMinutes: minutes, currentPage: 0 });
  },
  refreshTimeRange: () => set((state) => {
    if (state.relativeTimeMinutes === null) {
      // Custom range - don't modify
      return state;
    }
    const end = new Date();
    const start = new Date(end.getTime() - state.relativeTimeMinutes * 60 * 1000);
    return { timeRange: { start, end } };
  }),
  setBucketSize: (bucketSize) => set({ bucketSize }),
  setSearch: (search) => set({ search, currentPage: 0, selectedEntry: null, selectedEntries: [] }),
  // Empty selections are removed rather than stored, so filter counts and the
  // serialised API params only ever contain filters that actually apply.
  setFieldFilter: (field, values) =>
    set((state) => {
      const rest = omit(state.fieldFilters, field);
      return { fieldFilters: values.length ? { ...rest, [field]: values } : rest, currentPage: 0 };
    }),
  setRangeFilter: (field, filter) =>
    set((state) => {
      const rest = omit(state.rangeFilters, field);
      const isSet = filter.min !== undefined || filter.max !== undefined;
      return { rangeFilters: isSet ? { ...rest, [field]: filter } : rest, currentPage: 0 };
    }),
  clearFieldFilter: (field) =>
    set((state) => {
      const rest = omit(state.fieldFilters, field);
      return { fieldFilters: rest, currentPage: 0 };
    }),
  clearRangeFilter: (field) =>
    set((state) => {
      const rest = omit(state.rangeFilters, field);
      return { rangeFilters: rest, currentPage: 0 };
    }),
  clearAllFilters: () => set({ fieldFilters: { type: ['QueryFinish'] }, rangeFilters: {}, search: '', currentPage: 0 }),
  setColumns: (columns) => {
    set({ columns, columnsLoaded: true });
  },
  toggleColumnVisibility: (field) =>
    set((state) => ({
      columns: state.columns.map((col) =>
        col.field === field ? { ...col, visible: !col.visible } : col
      ),
    })),
  setSortField: (sortField) => set({ sortField, currentPage: 0 }),
  setSortOrder: (sortOrder) => set({ sortOrder, currentPage: 0 }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setSelectedEntry: (selectedEntry) => set({ selectedEntry }),
  setSelectedEntries: (selectedEntries) => set({ selectedEntries }),
  pinEntry: (entry) =>
    set((state) => {
      // Check if already pinned (by query_id + event_time)
      const alreadyPinned = state.pinnedEntries.some(
        (e) => e.query_id === entry.query_id && e.event_time === entry.event_time
      );
      if (alreadyPinned) return state;
      return { pinnedEntries: [...state.pinnedEntries, entry] };
    }),
  unpinEntry: (queryId, eventTime) =>
    set((state) => ({
      pinnedEntries: state.pinnedEntries.filter(
        (e) => !(e.query_id === queryId && e.event_time === eventTime)
      ),
    })),
  clearPinnedEntries: () => set({ pinnedEntries: [] }),
  setActiveTab: (activeTab) => set({ activeTab }),
  // Grouped Query Actions
  setGroupedEntries: (groupedEntries) => set({ groupedEntries }),
  setGroupedLoading: (groupedLoading) => set({ groupedLoading }),
  setGroupedSortField: (groupedSortField) => set({ groupedSortField }),
  setGroupedSortOrder: (groupedSortOrder) => set({ groupedSortOrder }),
  setNormalizeQueries: (normalizeQueries) => set({ normalizeQueries }),
  // Part Log Actions
  setPartLogEntries: (partLogEntries) => set({ partLogEntries }),
  setPartLogTimeSeries: (partLogTimeSeries) => set({ partLogTimeSeries }),
  setPartLogStackedTimeSeries: (partLogStackedTimeSeries) => set({ partLogStackedTimeSeries }),
  setPartLogTotalCount: (partLogTotalCount) => set({ partLogTotalCount }),
  setPartLogLoading: (partLogLoading) => set({ partLogLoading }),
  setHasPartLogAccess: (hasPartLogAccess) => set({ hasPartLogAccess }),
  setHasPartsAccess: (hasPartsAccess) => set({ hasPartsAccess }),
  setPartLogColumns: (partLogColumns) => set({ partLogColumns, partLogColumnsLoaded: true }),
  togglePartLogColumnVisibility: (field) =>
    set((state) => ({
      partLogColumns: state.partLogColumns.map((col) =>
        col.field === field ? { ...col, visible: !col.visible } : col
      ),
    })),
  setPartLogSortField: (partLogSortField) => set({ partLogSortField, partLogCurrentPage: 0 }),
  setPartLogSortOrder: (partLogSortOrder) => set({ partLogSortOrder, partLogCurrentPage: 0 }),
  setPartLogFieldFilter: (field, values) =>
    set((state) => {
      const rest = omit(state.partLogFieldFilters, field);
      return { partLogFieldFilters: values.length ? { ...rest, [field]: values } : rest, partLogCurrentPage: 0 };
    }),
  clearPartLogFieldFilter: (field) =>
    set((state) => {
      const rest = omit(state.partLogFieldFilters, field);
      return { partLogFieldFilters: rest, partLogCurrentPage: 0 };
    }),
  clearAllPartLogFilters: () => set({ partLogFieldFilters: { event_type: ['NewPart', 'MergeParts', 'DownloadPart', 'RemovePart', 'MutatePart'] }, partLogCurrentPage: 0 }),
  setPartLogCurrentPage: (partLogCurrentPage) => set({ partLogCurrentPage }),
  // Parts Actions
  setPartsTotalCount: (partsTotalCount) => set({ partsTotalCount }),
  setPartsCurrentPage: (partsCurrentPage) => set({ partsCurrentPage }),
  // Partitions Actions
  setPartitionsTotalCount: (partitionsTotalCount) => set({ partitionsTotalCount }),
  setPartitionsCurrentPage: (partitionsCurrentPage) => set({ partitionsCurrentPage }),
  // Global refresh
  triggerGlobalRefresh: () => set((state) => ({ globalRefreshTrigger: state.globalRefreshTrigger + 1 })),
}));
