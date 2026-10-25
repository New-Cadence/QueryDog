import { useEffect, useCallback, useRef } from 'react';
import { useQueryStore } from '../stores/queryStore';
import {
  fetchQueryLog,
  fetchTimeSeries,
  fetchStackedTimeSeries,
  fetchTotalCount,
  fetchColumnMetadata,
  fetchPartLog,
  fetchPartLogCount,
  fetchPartLogColumnMetadata,
  fetchPartLogTimeSeries,
  fetchPartLogStackedTimeSeries,
  fetchHealth,
  isConnectionError,
  isServerError,
  getUserFriendlyError,
} from '../services/api';
import { createColumnsFromMetadata } from '../types/queryLog';

// envKey identifies the connected environment; column metadata reloads when it changes
export function useQueryData(enabled: boolean = true, envKey: number | null = null) {
  const {
    timeRange,
    bucketSize,
    search,
    fieldFilters,
    rangeFilters,
    sortField,
    sortOrder,
    pageSize,
    currentPage,
    chartType,
    chartMetric,
    chartAggregation,
    partLogSortField,
    partLogSortOrder,
    partLogFieldFilters,
    partLogPageSize,
    partLogCurrentPage,
    setEntries,
    setTimeSeries,
    setStackedTimeSeries,
    setTotalCount,
    setLoading,
    setError,
    setQueryLogMissing,
    setColumns,
    setPartLogEntries,
    setPartLogTimeSeries,
    setPartLogStackedTimeSeries,
    setPartLogTotalCount,
    setPartLogLoading,
    setHasPartLogAccess,
    setPartLogColumns,
  } = useQueryStore();

  const queryRequestIdRef = useRef(0);
  const partLogRequestIdRef = useRef(0);

  // Load column metadata for each connected environment. A server without the
  // table returns no columns; keep the current set rather than blanking the grid.
  useEffect(() => {
    if (envKey === null) return;
    let cancelled = false;
    fetchColumnMetadata()
      .then((metadata) => {
        if (!cancelled && metadata.length) setColumns(createColumnsFromMetadata(metadata, 'query_log'));
      })
      .catch((err) => {
        console.error('Failed to load column metadata:', err);
      });
    return () => { cancelled = true; };
  }, [setColumns, envKey]);

  useEffect(() => {
    if (envKey === null) return;
    let cancelled = false;
    fetchPartLogColumnMetadata()
      .then((metadata) => {
        if (!cancelled && metadata.length) setPartLogColumns(createColumnsFromMetadata(metadata, 'part_log'));
      })
      .catch((err) => {
        console.error('Failed to load part_log column metadata:', err);
      });
    return () => { cancelled = true; };
  }, [setPartLogColumns, envKey]);

  const loadData = useCallback(async () => {
    const requestId = ++queryRequestIdRef.current;
    setLoading(true);
    setError(null);

    // Check connectivity before loading data
    const health = await fetchHealth();
    if (health.status !== 'healthy') {
      const errorMessage = health.error || 'Cannot connect to database';
      setError(errorMessage);
      setLoading(false);
      return;
    }

    // Get latest state from store to ensure we have the most recent time range
    const state = useQueryStore.getState();
    const currentTimeRange = state.timeRange;

    const offset = currentPage * pageSize;

    try {
      const results = await Promise.allSettled([
        fetchQueryLog(currentTimeRange, search, sortField, sortOrder, fieldFilters, rangeFilters, pageSize, offset, bucketSize),
        fetchTimeSeries(currentTimeRange, bucketSize, search, fieldFilters, rangeFilters),
        fetchStackedTimeSeries(currentTimeRange, bucketSize, search, fieldFilters, rangeFilters, state.chartMetric, state.chartAggregation),
        fetchTotalCount(currentTimeRange, search, fieldFilters, rangeFilters, bucketSize),
      ]);

      // Process each result individually - set data if successful, show error if failed
      let hasAnyData = false;
      const errors: string[] = [];

      if (requestId !== queryRequestIdRef.current) return;

      setQueryLogMissing(results.some((r) => r.status === 'rejected' && r.reason?.type === 'not_found'));

      if (results[0].status === 'fulfilled') {
        setEntries(results[0].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load query log entries:', results[0].reason);
        errors.push(results[0].reason.message);
        setEntries([]);
      }

      if (results[1].status === 'fulfilled') {
        setTimeSeries(results[1].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load time series:', results[1].reason);
        errors.push(results[1].reason.message);
        setTimeSeries([]);
      }

      if (results[2].status === 'fulfilled') {
        setStackedTimeSeries(results[2].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load stacked time series:', results[2].reason);
        errors.push(results[2].reason.message);
        setStackedTimeSeries([]);
      }

      if (results[3].status === 'fulfilled') {
        setTotalCount(results[3].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load count:', results[3].reason);
        errors.push(results[3].reason.message);
        setTotalCount(0);
      }

      // Check for errors and categorize them
      if (errors.length > 0) {
        // Find the first error with a specific type (authentication, permission, not_found)
        const rejectedResult = results.find(r =>
          r.status === 'rejected' &&
          ['authentication', 'permission', 'not_found'].includes((r as PromiseRejectedResult).reason?.type)
        ) as PromiseRejectedResult | undefined;
        const criticalError: any = rejectedResult?.reason;

        if (criticalError?.type === 'authentication') {
          setError('Authentication failed: Invalid username or password for ClickHouse');
        } else if (criticalError?.type === 'permission') {
          setError('Access denied: You do not have permission to access system.query_log table');
        } else if (criticalError?.type === 'not_found') {
          // Missing system.query_log: the Queries page shows it inline (queryLogMissing)
        } else if (!hasAnyData) {
          // Check if this is a connection or server error
          const firstError = errors[0];
          if (isConnectionError(firstError) || isServerError(firstError)) {
            setError(getUserFriendlyError(firstError));
          } else {
            setError(`Failed to load data: ${getUserFriendlyError(firstError)}`);
          }
        } else {
          // Some data loaded, but some requests failed - show a warning
          console.warn('Some query log data failed to load:', errors.join('; '));
        }
      }
    } catch (err) {
      if (requestId !== queryRequestIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load data';
      if (isConnectionError(message) || isServerError(message)) {
        setError(getUserFriendlyError(message));
      } else {
        setError(getUserFriendlyError(message));
      }
    } finally {
      if (requestId === queryRequestIdRef.current) {
        setLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    timeRange.start.getTime(),
    timeRange.end.getTime(),
    bucketSize,
    search,
    fieldFilters,
    rangeFilters,
    sortField,
    sortOrder,
    pageSize,
    currentPage,
    chartType,
    setEntries,
    setTimeSeries,
    setStackedTimeSeries,
    setTotalCount,
    setLoading,
    setError,
    setQueryLogMissing,
  ]);

  const loadPartLogData = useCallback(async () => {
    const requestId = ++partLogRequestIdRef.current;
    setPartLogLoading(true);

    // Get latest state from store to ensure we have the most recent time range
    const state = useQueryStore.getState();
    const currentTimeRange = state.timeRange;

    const offset = partLogCurrentPage * partLogPageSize;

    try {
      const results = await Promise.allSettled([
        fetchPartLog(currentTimeRange, partLogSortField, partLogSortOrder, partLogFieldFilters, partLogPageSize, offset),
        fetchPartLogTimeSeries(currentTimeRange, bucketSize, partLogFieldFilters),
        fetchPartLogStackedTimeSeries(currentTimeRange, bucketSize, partLogFieldFilters),
        fetchPartLogCount(currentTimeRange, partLogFieldFilters),
      ]);

      // Process each result individually - set data if successful, show error if failed
      let hasAnyData = false;
      const errors: string[] = [];

      if (requestId !== partLogRequestIdRef.current) return;

      if (results[0].status === 'fulfilled') {
        setPartLogEntries(results[0].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load part log entries:', results[0].reason);
        errors.push(results[0].reason.message);
        setPartLogEntries([]);
      }

      if (results[1].status === 'fulfilled') {
        setPartLogTimeSeries(results[1].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load part log time series:', results[1].reason);
        errors.push(results[1].reason.message);
        setPartLogTimeSeries([]);
      }

      if (results[2].status === 'fulfilled') {
        setPartLogStackedTimeSeries(results[2].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load part log stacked time series:', results[2].reason);
        errors.push(results[2].reason.message);
        setPartLogStackedTimeSeries([]);
      }

      if (results[3].status === 'fulfilled') {
        setPartLogTotalCount(results[3].value);
        hasAnyData = true;
      } else {
        console.error('Failed to load part log count:', results[3].reason);
        errors.push(results[3].reason.message);
        setPartLogTotalCount(0);
      }

      // Check for errors and categorize them
      if (errors.length > 0) {
        // Find the first error with a specific type (authentication, permission, not_found)
        const rejectedResult = results.find(r =>
          r.status === 'rejected' &&
          ['authentication', 'permission', 'not_found'].includes((r as PromiseRejectedResult).reason?.type)
        ) as PromiseRejectedResult | undefined;
        const criticalError: any = rejectedResult?.reason;

        if (criticalError?.type === 'permission') {
          // Permission errors are expected - just mark as no access and don't show error
          console.info('Part log access denied - hiding part log features');
          setHasPartLogAccess(false);
        } else if (criticalError?.type === 'authentication') {
          // Authentication errors should be shown
          setError('Authentication failed: Invalid username or password for ClickHouse');
          setHasPartLogAccess(false);
        } else if (criticalError?.type === 'not_found') {
          // Table doesn't exist - hide but don't show error
          console.info('Part log table not found - hiding part log features');
          setHasPartLogAccess(false);
        } else if (!hasAnyData) {
          // Check if this is a connection or server error
          const firstError = errors[0];
          if (isConnectionError(firstError) || isServerError(firstError)) {
            setError(getUserFriendlyError(firstError));
          } else {
            setError(`Failed to load data: ${getUserFriendlyError(firstError)}`);
          }
          setHasPartLogAccess(false);
        } else {
          // Some data loaded, but some requests failed - show a warning
          console.warn('Some part log data failed to load:', errors.join('; '));
        }
      }
    } catch (err) {
      if (requestId !== partLogRequestIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load data';
      if (isConnectionError(message) || isServerError(message)) {
        setError(getUserFriendlyError(message));
      } else {
        setError(getUserFriendlyError(message));
      }
    } finally {
      if (requestId === partLogRequestIdRef.current) {
        setPartLogLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    timeRange.start.getTime(),
    timeRange.end.getTime(),
    bucketSize,
    partLogSortField,
    partLogSortOrder,
    partLogFieldFilters,
    partLogPageSize,
    partLogCurrentPage,
    setPartLogEntries,
    setPartLogTimeSeries,
    setPartLogStackedTimeSeries,
    setPartLogTotalCount,
    setPartLogLoading,
    setError,
  ]);

  useEffect(() => {
    if (!enabled) return;
    loadData();
  }, [loadData, enabled]);

  // Switching the metric or aggregation only needs the per-kind series again
  const firstMetric = useRef(true);
  useEffect(() => {
    if (firstMetric.current) { firstMetric.current = false; return; }
    if (!enabled) return;
    let cancelled = false;
    const state = useQueryStore.getState();
    fetchStackedTimeSeries(state.timeRange, bucketSize, search, fieldFilters, rangeFilters, chartMetric, chartAggregation)
      .then(data => { if (!cancelled) setStackedTimeSeries(data); })
      .catch(err => console.error('Failed to load stacked time series:', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMetric, chartAggregation]);

  // Load part log data on startup
  useEffect(() => {
    if (!enabled) return;
    loadPartLogData();
  }, [loadPartLogData, enabled]);

  const { triggerGlobalRefresh, refreshTimeRange } = useQueryStore();

  const refresh = useCallback(() => {
    // Update time range to current time if using a relative range (e.g., "last 15 minutes")
    refreshTimeRange();
    loadData();
    loadPartLogData();
    triggerGlobalRefresh();
  }, [loadData, loadPartLogData, triggerGlobalRefresh, refreshTimeRange]);

  return { refresh };
}
