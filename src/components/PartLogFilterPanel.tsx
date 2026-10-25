import { useCallback } from 'react';
import { ActivityFilterPanel } from './ActivityFilterPanel';
import { useQueryStore } from '../stores/queryStore';
import { fetchPartLogDistinctValues } from '../services/api';

const FILTERABLE_FIELDS = [
  { field: 'event_type', label: 'Event Type' },
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table' },
  { field: 'partition_id', label: 'Partition ID' },
  { field: 'merge_reason', label: 'Merge Reason' },
  { field: 'merge_algorithm', label: 'Merge Algorithm' },
];

export function PartLogFilterPanel() {
  const { timeRange, partLogFieldFilters, setPartLogFieldFilter, clearPartLogFieldFilter, clearAllPartLogFilters } = useQueryStore();
  const fetchDistinct = useCallback((field: string) => fetchPartLogDistinctValues(field, timeRange), [timeRange]);

  return (
    <ActivityFilterPanel
      filters={partLogFieldFilters}
      onFilterChange={setPartLogFieldFilter}
      onClearFilter={clearPartLogFieldFilter}
      onClearAll={clearAllPartLogFilters}
      fetchDistinct={fetchDistinct}
      filterableFields={FILTERABLE_FIELDS}
    />
  );
}
