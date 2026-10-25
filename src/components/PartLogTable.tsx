import { useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, SortChangedEvent, ICellRendererParams } from 'ag-grid-community';
import { useQueryStore } from '../stores/queryStore';
import type { PartLogEntry } from '../types/queryLog';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber, formatDateTime } from '../utils/formatters';
import { GRID_OVERLAYS } from './gridOverlays';

// Register AG Grid Community modules
ModuleRegistry.registerModules([AllCommunityModule]);

// Numeric comparator for AG Grid sorting - handles null values and ensures numeric sorting
function numericComparator(valueA: unknown, valueB: unknown): number {
  const a = valueA === null || valueA === undefined ? null : Number(valueA);
  const b = valueB === null || valueB === undefined ? null : Number(valueB);
  if (a === null && b === null) return 0;
  if (a === null) return 1;  // nulls go to bottom
  if (b === null) return -1;
  if (isNaN(a) && isNaN(b)) return 0;
  if (isNaN(a)) return 1;
  if (isNaN(b)) return -1;
  return a - b;
}

function ArrayCellRenderer({ value }: { value: string[] }) {
  if (!value || value.length === 0) return <span className="text-gray-500">-</span>;
  if (value.length <= 2) {
    return <span className="text-xs">{value.join(', ')}</span>;
  }
  return (
    <span className="text-xs" title={value.join(', ')}>
      {value.slice(0, 2).join(', ')} +{value.length - 2}
    </span>
  );
}

export function PartLogTable() {
  const gridTheme = useGridTheme();
  const { partLogEntries, partLogColumns, setPartLogSortField, setPartLogSortOrder, partLogLoading } = useQueryStore();

  const columnDefs: ColDef<PartLogEntry>[] = useMemo(() => {
    const visibleCols = partLogColumns.filter((c) => c.visible);

    const defs: ColDef<PartLogEntry>[] = [];

    visibleCols.forEach((col) => {
      const def: ColDef<PartLogEntry> = {
        headerName: col.headerName,
        field: col.field as keyof PartLogEntry,
        width: col.width,
        sortable: col.sortable,
        resizable: true,
        headerTooltip: col.comment || col.headerName,
      };

      // Format based on type for array/map fields
      if (col.type.startsWith('Array(')) {
        def.cellRenderer = (params: ICellRendererParams) => <ArrayCellRenderer value={params.value} />;
      }

      // Custom formatters for specific fields
      switch (col.field) {
        case 'table':
          def.cellStyle = { color: '#60a5fa' };
          break;
        case 'event_time':
          def.valueFormatter = (params) => {
            if (!params.value) return '';
            return formatDateTime(params.value, { seconds: false });
          };
          break;
        case 'size_in_bytes':
        case 'bytes_uncompressed':
        case 'bytes_on_disk':
        case 'peak_memory_usage':
          def.valueFormatter = (params) => formatBytes(params.value as number);
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: '#86efac' };
          break;
        case 'rows':
        case 'rows_where_condition':
          def.valueFormatter = (params) => formatNumber(params.value as number);
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: '#86efac' };
          break;
        case 'duration_ms':
          def.valueFormatter = (params) => {
            const ms = params.value as number;
            if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
            return ms + 'ms';
          };
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: '#86efac' };
          break;
      }

      // Format bytes for any _bytes field
      if (col.field.endsWith('_bytes') && !def.valueFormatter) {
        def.valueFormatter = (params) => formatBytes(params.value as number);
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: '#86efac' };
      }

      defs.push(def);
    });

    return defs;
  }, [partLogColumns]);

  const onSortChanged = useCallback(
    (event: SortChangedEvent) => {
      const sortModel = event.api.getColumnState().find((col) => col.sort);
      if (sortModel) {
        setPartLogSortField(sortModel.colId);
        setPartLogSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
      }
    },
    [setPartLogSortField, setPartLogSortOrder]
  );

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  return (
    <div className="h-full w-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <AgGridReact<PartLogEntry> {...GRID_OVERLAYS}
        theme={gridTheme}
        rowData={partLogEntries}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        onSortChanged={onSortChanged}
        loading={partLogLoading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        tooltipShowDelay={300}
        tooltipInteraction={true}
        getRowId={(params) => String(params.data.event_time) + String(params.data.part_name)}
      />
    </div>
  );
}
