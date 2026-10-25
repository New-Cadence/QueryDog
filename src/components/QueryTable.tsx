import { useMemo, useCallback, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, SortChangedEvent, ICellRendererParams, SelectionChangedEvent, RowClassParams } from 'ag-grid-community';
import { Eye, Pin } from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import type { QueryLogEntry } from '../types/queryLog';
import { useGridTheme, useIsLightMode } from '../hooks/useTheme';
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

export function QueryTable() {
  const gridTheme = useGridTheme();
  const { entries, columns, sortField, sortOrder, search, setSortField, setSortOrder, setSelectedEntry, setSelectedEntries, pinnedEntries, pinEntry, unpinEntry, loading } = useQueryStore();
  const gridRef = useRef<AgGridReact<QueryLogEntry>>(null);
  const isLight = useIsLightMode();

  const normalizedSearch = useMemo(() => search.trim().toLowerCase(), [search]);

  const matchesSearch = useCallback((entry: QueryLogEntry) => {
    if (!normalizedSearch) return true;
    const queryText = String(entry.query ?? '').toLowerCase();
    const queryId = String(entry.query_id ?? '').toLowerCase();
    return queryText.includes(normalizedSearch) || queryId.includes(normalizedSearch);
  }, [normalizedSearch]);

  const visiblePinnedEntries = useMemo(() => {
    return pinnedEntries.filter(matchesSearch);
  }, [pinnedEntries, matchesSearch]);

  // Keep pinned entries at the top while sorting the rest
  const unpinnedEntries = useMemo(() => {
    const pinnedIds = new Set(pinnedEntries.map(e => `${e.query_id}-${e.event_time}`));
    return entries.filter(e => !pinnedIds.has(`${e.query_id}-${e.event_time}`));
  }, [entries, pinnedEntries]);

  // Check if an entry is pinned
  const isPinned = useCallback((entry: QueryLogEntry) => {
    return pinnedEntries.some(e => e.query_id === entry.query_id && e.event_time === entry.event_time);
  }, [pinnedEntries]);

  const ActionCellRenderer = useCallback((params: ICellRendererParams<QueryLogEntry>) => {
    return (
      <button
        onClick={() => setSelectedEntry(params.data!)}
        className="p-1 hover:bg-gray-600 rounded"
        title="View details (read-only)"
      >
        <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
      </button>
    );
  }, [setSelectedEntry]);

  const PinCellRenderer = useCallback((params: ICellRendererParams<QueryLogEntry>) => {
    const entry = params.data!;
    const pinned = isPinned(entry);
    return (
      <button
        onClick={() => {
          if (pinned) {
            unpinEntry(String(entry.query_id), String(entry.event_time));
          } else {
            pinEntry(entry);
          }
        }}
        className={`p-1 hover:bg-gray-600 rounded ${pinned ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}
        title={pinned ? 'Unpin row' : 'Pin row'}
      >
        <Pin className={`w-3.5 h-3.5 ${pinned ? 'fill-current' : ''}`} />
      </button>
    );
  }, [isPinned, pinEntry, unpinEntry]);

  const onSelectionChanged = useCallback((event: SelectionChangedEvent<QueryLogEntry>) => {
    const selectedRows = event.api.getSelectedRows();
    setSelectedEntries(selectedRows.slice(0, 10)); // Limit to 10
  }, [setSelectedEntries]);

  // Theme-aware cell colors
  const colorTimestamp = isLight ? '#991b1b' : '#fca5a5';
  const colorBlue = isLight ? '#1e40af' : '#93c5fd';
  const colorNumeric = isLight ? '#166534' : '#86efac';

  const columnDefs: ColDef<QueryLogEntry>[] = useMemo(() => {
    const visibleCols = columns.filter((c) => c.visible);

    const defs: ColDef<QueryLogEntry>[] = [
      {
        headerName: '',
        colId: '__view',
        field: '__view',
        width: 40,
        sortable: false,
        cellRenderer: ActionCellRenderer,
        cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      },
      {
        headerName: '',
        colId: '__pin',
        field: '__pin',
        width: 40,
        sortable: false,
        cellRenderer: PinCellRenderer,
        cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      },
    ];

    visibleCols.forEach((col) => {
      const def: ColDef<QueryLogEntry> = {
        headerName: col.headerName,
        field: col.field as keyof QueryLogEntry,
        width: col.field === 'event_time' ? Math.max(col.width, 210) : col.width,
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
        case 'event_time':
        case 'query_start_time':
          def.valueFormatter = (params) => {
            if (!params.value) return '';
            return formatDateTime(params.value, { ms: true });
          };
          def.cellStyle = { color: colorTimestamp };
          break;
        case 'query':
          def.tooltipValueGetter = (params) => {
            const q = params.value as string;
            if (!q) return '';
            // Format SQL with newlines after keywords and limit to 1000 chars
            const formatted = q
              .replace(/\s+/g, ' ')
              .replace(/(SELECT|FROM|WHERE|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP BY|ORDER BY|LIMIT|HAVING|UNION|INSERT|UPDATE|DELETE|SET|INTO|VALUES)/gi, '\n$1')
              .trim();
            const maxLen = 1000;
            return formatted.length > maxLen ? formatted.substring(0, maxLen) + '\n...(truncated)' : formatted;
          };
          def.valueFormatter = (params) => {
            const q = params.value as string;
            return q?.length > 80 ? q.substring(0, 80) + '...' : q;
          };
          def.cellStyle = { color: colorBlue };
          break;
        case 'tables':
          def.cellStyle = { color: colorBlue };
          break;
        case 'user':
        case 'client_hostname':
          def.cellStyle = { color: colorBlue };
          break;
        case 'memory_usage':
        case 'read_bytes':
        case 'written_bytes':
        case 'result_bytes':
          def.valueFormatter = (params) => formatBytes(Number(params.value));
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: colorNumeric };
          break;
        case 'read_rows':
        case 'written_rows':
        case 'result_rows':
          def.valueFormatter = (params) => formatNumber(Number(params.value));
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: colorNumeric };
          break;
        case 'query_duration_ms':
          def.valueFormatter = (params) => {
            const ms = Number(params.value);
            if (isNaN(ms)) return '-';
            if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
            return ms + 'ms';
          };
          def.comparator = numericComparator;
          def.cellStyle = { textAlign: 'right', color: colorNumeric };
          break;
      }

      // Format bytes for any _bytes field
      if (col.field.endsWith('_bytes') && !def.valueFormatter) {
        def.valueFormatter = (params) => formatBytes(Number(params.value));
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: colorNumeric };
      }

      // Format rows for any _rows field
      if (col.field.endsWith('_rows') && !def.valueFormatter) {
        def.valueFormatter = (params) => formatNumber(Number(params.value));
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: colorNumeric };
      }

      defs.push(def);
    });

    return defs;
  }, [columns, ActionCellRenderer, PinCellRenderer, colorTimestamp, colorBlue, colorNumeric]);

  const onSortChanged = useCallback(
    (event: SortChangedEvent) => {
      const sortModel = event.api.getColumnState().find((col) => col.sort);
      if (sortModel) {
        setSortField(sortModel.colId);
        setSortOrder(sortModel.sort === 'asc' ? 'ASC' : 'DESC');
      }
    },
    [setSortField, setSortOrder]
  );

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  // Row class for pinned rows
  const getRowClass = useCallback((params: RowClassParams<QueryLogEntry>) => {
    if (params.data && isPinned(params.data)) {
      return 'pinned-row';
    }
    return '';
  }, [isPinned]);

  return (
    <div className="h-full w-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <style>{`
        .pinned-row {
          background-color: rgba(59, 130, 246, 0.15) !important;
        }
        .pinned-row:hover {
          background-color: rgba(59, 130, 246, 0.25) !important;
        }
      `}</style>
      <AgGridReact<QueryLogEntry> {...GRID_OVERLAYS}
        ref={gridRef}
        theme={gridTheme}
        rowData={unpinnedEntries}
        pinnedTopRowData={visiblePinnedEntries}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        initialState={{
          sort: {
            sortModel: [{
              colId: sortField,
              sort: sortOrder === 'ASC' ? 'asc' : 'desc',
            }],
          },
        }}
        onSortChanged={onSortChanged}
        onSelectionChanged={onSelectionChanged}
        rowSelection="multiple"
        rowMultiSelectWithClick={true}
        loading={loading}
        animateRows={false}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        tooltipShowDelay={300}
        tooltipInteraction={true}
        getRowId={(params) => String(params.data.query_id) + String(params.data.event_time)}
        getRowClass={getRowClass}
      />
    </div>
  );
}
