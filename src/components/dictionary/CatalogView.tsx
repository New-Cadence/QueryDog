import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { PageToolbar, ToolbarSearch, StatCard, Pill, LoadingState } from '../ui';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { useClientFilters } from '../../hooks/useClientFilters';
import { useGridTheme } from '../../hooks/useTheme';
import { formatBytes, formatNumber, formatDateTime } from '../../utils/formatters';
import { type UsageSummary, SYSTEM_DATABASES, engineTone, gridDefaults, tableId } from './api';
import { type CatalogRow, CATALOG_FILTER_FIELDS, catalogSearchText } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

export function CatalogView({
  rows,
  usage,
  loading,
  error,
  onSelect,
}: {
  rows: CatalogRow[];
  usage: UsageSummary | null;
  loading: boolean;
  error: string | null;
  onSelect: (row: CatalogRow) => void;
}) {
  const gridTheme = useGridTheme();
  const [includeSystem, setIncludeSystem] = useState(false);
  const scoped = useMemo(() => (includeSystem ? rows : rows.filter(r => !SYSTEM_DATABASES.includes(r.database))), [rows, includeSystem]);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(scoped, CATALOG_FILTER_FIELDS, catalogSearchText);

  const stats = useMemo(() => {
    const documented = filtered.filter(t => t.comment).length;
    return {
      databases: new Set(filtered.map(t => t.database)).size,
      rows: filtered.reduce((sum, t) => sum + t.total_rows, 0),
      bytes: filtered.reduce((sum, t) => sum + t.total_bytes, 0),
      documentedPct: filtered.length ? Math.round((documented / filtered.length) * 100) : 0,
      unused: filtered.filter(t => t.unused).length,
    };
  }, [filtered]);

  const usageAvailable = !!usage?.available;
  const columnDefs = useMemo<ColDef<CatalogRow>[]>(() => [
    { field: 'database', headerName: 'Database', width: 130 },
    { field: 'name', headerName: 'Table', width: 220, cellClass: 'text-white' },
    {
      field: 'engine', headerName: 'Engine', width: 150,
      cellRenderer: (p: { value: string }) => <Pill tone={engineTone(p.value)}>{p.value}</Pill>,
    },
    {
      field: 'comment', headerName: 'Description', flex: 1, minWidth: 220, tooltipField: 'comment',
      cellRenderer: (p: { value: string }) => (p.value ? <span>{p.value}</span> : <span className="text-gray-600 italic">undocumented</span>),
    },
    { field: 'total_rows', headerName: 'Rows', width: 100, type: 'rightAligned', valueFormatter: p => formatNumber(p.value) },
    { field: 'total_bytes', headerName: 'Size', width: 95, type: 'rightAligned', valueFormatter: p => formatBytes(p.value) },
    {
      colId: 'docs', headerName: 'Cols documented', width: 125, type: 'rightAligned',
      valueGetter: p => (p.data && p.data.column_count ? p.data.documented_columns / p.data.column_count : 0),
      valueFormatter: p => (p.data ? `${p.data.documented_columns}/${p.data.column_count}` : ''),
    },
    {
      colId: 'queries', headerName: 'Queries 7d', width: 115, type: 'rightAligned', hide: !usageAvailable,
      valueGetter: p => p.data?.usage?.queries ?? 0,
      cellRenderer: (p: { value: number; data?: CatalogRow }) =>
        p.data?.unused ? <Pill tone="yellow" title="No queries in system.query_log over the last 7 days">unused</Pill> : formatNumber(p.value),
    },
    { colId: 'users', headerName: 'Users 7d', width: 90, type: 'rightAligned', hide: !usageAvailable, valueGetter: p => p.data?.usage?.users ?? 0 },
    {
      colId: 'last_used', headerName: 'Last used', width: 150, hide: !usageAvailable,
      valueGetter: p => p.data?.usage?.last_queried ?? '',
      valueFormatter: p => (p.value ? formatDateTime(p.value) : ''),
    },
    { field: 'partition_key', headerName: 'Partition key', width: 150 },
    { field: 'metadata_modification_time', headerName: 'Modified', width: 175, valueFormatter: p => formatDateTime(p.value) },
  ], [usageAvailable]);

  return (
    <div className="h-full flex flex-col">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={scoped} fields={CATALOG_FILTER_FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search tables, databases, descriptions..." />
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={includeSystem} onChange={e => setIncludeSystem(e.target.checked)} />
              Include system databases
            </label>
          </>
        }
        right={
          <div className="flex items-center gap-4 text-xs">
            {usage && !usage.available && <span className="text-gray-500" title="Usage columns need system.query_log">query_log unavailable</span>}
            <span className="text-gray-400"><span className="text-white font-medium">{filtered.length}</span> tables</span>
            {activeCount > 0 && <span className="text-blue-400">{activeCount} filter{activeCount > 1 ? 's' : ''} active</span>}
          </div>
        }
      />
      <div className="flex-1 flex flex-col overflow-hidden px-1.5 pt-3 pb-4 gap-3">
        <div className={`grid ${usageAvailable ? 'grid-cols-6' : 'grid-cols-5'} gap-3 shrink-0`}>
          <StatCard label="Databases" value={String(stats.databases)} />
          <StatCard label="Tables" value={formatNumber(filtered.length)} />
          <StatCard label="Total Rows" value={formatNumber(stats.rows)} />
          <StatCard label="Total Size" value={formatBytes(stats.bytes)} />
          <StatCard label="Documented" value={`${stats.documentedPct}%`} sub="Tables with a COMMENT" tone={stats.documentedPct > 50 ? 'green' : 'yellow'} />
          {usageAvailable && (
            <StatCard label="Unused" value={formatNumber(stats.unused)} sub={`No queries in ${usage?.days ?? 7} days`} tone={stats.unused ? 'yellow' : 'green'} />
          )}
        </div>
        <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
          {loading ? (
            <LoadingState label="Loading catalog…" />
          ) : error ? (
            <div className="p-3 text-xs text-red-400">{error}</div>
          ) : (
            <AgGridReact<CatalogRow> {...GRID_OVERLAYS}
              theme={gridTheme}
              rowData={filtered}
              columnDefs={columnDefs}
              defaultColDef={gridDefaults}
              getRowId={p => tableId(p.data)}
              onRowClicked={e => e.data && onSelect(e.data)}
              rowClass="cursor-pointer"
              suppressCellFocus
              tooltipShowDelay={300}
            />
          )}
        </div>
      </div>
    </div>
  );
}
