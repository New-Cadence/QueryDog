// Shared row models, filter fields and helpers for the Data Dictionary views.
import type { ClientFilterField } from '../../hooks/useClientFilters';
import { type DictionaryColumn, type DictionaryTable, type TableUsage, type UsageSummary, SYSTEM_DATABASES, isPhysical, tableId } from './api';

// A catalog row joined with its 7-day query_log usage (null when unknown).
export interface CatalogRow extends DictionaryTable {
  usage: TableUsage | null;
  unused: boolean;
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

export const CATALOG_FILTER_FIELDS: ClientFilterField<CatalogRow>[] = [
  { field: 'database', label: 'Database' },
  { field: 'engine', label: 'Engine' },
  { field: 'documented', label: 'Documented', getValue: r => yesNo(!!r.comment) },
  { field: 'partitioned', label: 'Has partition key', getValue: r => yesNo(!!r.partition_key) },
  { field: 'unused', label: 'Unused (7d)', getValue: r => yesNo(r.unused) },
];

export const catalogSearchText = (r: CatalogRow) => `${r.database} ${r.name} ${r.comment}`;

export function joinUsage(tables: DictionaryTable[], usage: UsageSummary | null): CatalogRow[] {
  const byTable = new Map((usage?.tables || []).map(u => [u.table, u]));
  return tables.map(t => {
    const u = byTable.get(tableId(t)) || null;
    return { ...t, usage: u, unused: !!usage?.available && !u && isPhysical(t.engine) && !SYSTEM_DATABASES.includes(t.database) };
  });
}

// "Nullable(LowCardinality(String))" -> "String", "DateTime64(3)" -> "Date/Time"
export function typeFamily(type: string): string {
  let base = type;
  for (let m; (m = base.match(/^(?:Nullable|LowCardinality)\((.*)\)$/)); ) base = m[1];
  if (/^U?Int\d/.test(base)) return 'Integer';
  if (/^(Float|BFloat)/.test(base)) return 'Float';
  if (/^Decimal/.test(base)) return 'Decimal';
  if (/^(String|FixedString)/.test(base)) return 'String';
  if (/^Date/.test(base)) return 'Date/Time';
  if (/^Enum/.test(base)) return 'Enum';
  if (/^(Bool|UUID|IPv4|IPv6)/.test(base)) return base.match(/^\w+/)![0];
  if (/^(Array|Map|Tuple|Nested)/.test(base)) return base.match(/^\w+/)![0];
  if (/^(JSON|Object|Dynamic|Variant)/.test(base)) return 'Semi-structured';
  return 'Other';
}

export function columnKeys(c: DictionaryColumn): string[] {
  const keys = [];
  if (Number(c.is_in_primary_key)) keys.push('Primary');
  if (Number(c.is_in_sorting_key)) keys.push('Sorting');
  if (Number(c.is_in_partition_key)) keys.push('Partition');
  return keys.length ? keys : ['None'];
}

export const COLUMN_FILTER_FIELDS: ClientFilterField<DictionaryColumn>[] = [
  { field: 'family', label: 'Type family', getValue: c => typeFamily(c.type) },
  { field: 'keys', label: 'Key membership', getValue: columnKeys },
  { field: 'documented', label: 'Documented', getValue: c => (c.comment ? 'Yes' : 'No') },
];

export const columnSearchText = (c: DictionaryColumn) => `${c.name} ${c.type} ${c.comment}`;

