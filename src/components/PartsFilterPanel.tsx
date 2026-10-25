import { ActivityFilterPanel } from './ActivityFilterPanel';
import { fetchPartsDistinctValues } from '../services/api';

const FILTERABLE_FIELDS = [
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table' },
  { field: 'partition_id', label: 'Partition ID' },
  { field: 'part_type', label: 'Part Type' },
  { field: 'active', label: 'Active' },
  { field: 'disk_name', label: 'Disk Name' },
];

const fetchDistinct = (field: string) => fetchPartsDistinctValues(field);

interface PartsFilterPanelProps {
  filters: Record<string, string[]>;
  onFilterChange: (field: string, values: string[]) => void;
  onClearFilter: (field: string) => void;
  onClearAll: () => void;
}

export function PartsFilterPanel(props: PartsFilterPanelProps) {
  return <ActivityFilterPanel {...props} fetchDistinct={fetchDistinct} filterableFields={FILTERABLE_FIELDS} />;
}
