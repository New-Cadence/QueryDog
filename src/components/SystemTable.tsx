import { useMemo, useCallback, useEffect, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, SortChangedEvent, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { Settings, X, Eye, Database } from 'lucide-react';
import type { ColumnMetadata } from '../types/queryLog';
import { createColumnsFromMetadata, type ColumnConfig } from '../types/queryLog';
import { useQueryStore } from '../stores/queryStore';
import { useGridTheme } from '../hooks/useTheme';
import { formatBytes, formatNumber, formatDateTime } from '../utils/formatters';
import { isMissingTableError } from '../services/api';
import { useClientFilters, type ClientFilterField } from '../hooks/useClientFilters';
import { ClientFilterPanel } from './ClientFilterPanel';
import { EmptyState, ToolbarSearch } from './ui';
import { GRID_OVERLAYS } from './gridOverlays';

type Row = Record<string, unknown>;

const NON_FILTERABLE_TYPE = /^(Array|Map|Tuple|Nullable\((Array|Map))|DateTime|Date|Float|Decimal|JSON|Object/;
const MAX_AUTO_FILTER_FIELDS = 8;
const MAX_AUTO_FILTER_VALUES = 30;

// Pick columns worth offering as value filters: low-cardinality columns
// (between 2 and 30 distinct values in the loaded rows), visible ones first.
function deriveFilterFields(columns: ColumnConfig[], data: Row[]): ClientFilterField<Row>[] {
  const candidates = columns.length > 0
    ? [...columns].sort((a, b) => Number(b.visible) - Number(a.visible))
    : Object.keys(data[0] ?? {}).map((field) => ({ field, headerName: field, type: '' }));
  const fields: ClientFilterField<Row>[] = [];
  for (const col of candidates) {
    if (fields.length >= MAX_AUTO_FILTER_FIELDS) break;
    if (NON_FILTERABLE_TYPE.test(col.type)) continue;
    const distinct = new Set<string>();
    for (const row of data) {
      const v = row[col.field];
      if (v !== null && typeof v === 'object') { distinct.clear(); break; }
      distinct.add(String(v ?? ''));
      if (distinct.size > MAX_AUTO_FILTER_VALUES) break;
    }
    if (distinct.size >= 2 && distinct.size <= MAX_AUTO_FILTER_VALUES && distinct.size < data.length) {
      fields.push({ field: col.field, label: col.headerName });
    }
  }
  return fields;
}

function rowSearchText(row: Row): string {
  return Object.values(row)
    .map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')))
    .join(' ');
}

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

function ArrayCellRenderer({ value }: { value: unknown[] }) {
  if (!value || value.length === 0) return <span className="text-gray-500">-</span>;
  const strValue = value.map(v => String(v));
  if (strValue.length <= 2) {
    return <span className="text-xs">{strValue.join(', ')}</span>;
  }
  return (
    <span className="text-xs" title={strValue.join(', ')}>
      {strValue.slice(0, 2).join(', ')} +{strValue.length - 2}
    </span>
  );
}

export interface SystemTableRef {
  columns: ColumnConfig[];
  toggleColumnVisibility: (field: string) => void;
  columnSelectorOpen: boolean;
  setColumnSelectorOpen: (open: boolean) => void;
}

interface SystemTableProps {
  title?: string;
  fetchData: (filters?: Record<string, string[]>) => Promise<Record<string, unknown>[]>;
  fetchColumns?: () => Promise<ColumnMetadata[]>;
  defaultColumns?: ColumnConfig[];
  defaultVisibleFields?: string[];
  filters?: Record<string, string[]>;
  getRowId?: (data: Record<string, unknown>) => string;
  onSortChange?: (field: string, order: 'ASC' | 'DESC') => void;
  onColumnsChange?: (columns: ColumnConfig[]) => void;
  hideTitle?: boolean;
  hideHeader?: boolean;
  showActionColumn?: boolean;
  onRowAction?: (data: Record<string, unknown>) => void;
  columnWidthOverrides?: Record<string, number>;
  defaultSort?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  onCellClick?: (field: string, value: unknown, data: Record<string, unknown>) => void;
  search?: string;
  // When set, the table renders the standard Filters / search / row-count
  // toolbar into this element and filters its rows client-side.
  toolbarContainer?: HTMLElement | null;
  // Explicit filter fields for the toolbar; derived from the data when omitted
  filterFields?: ClientFilterField<Row>[];
  searchPlaceholder?: string;
}

function SystemTableInner({
  title,
  fetchData,
  fetchColumns,
  defaultColumns,
  defaultVisibleFields,
  filters,
  getRowId,
  onSortChange,
  onColumnsChange,
  hideTitle = false,
  hideHeader = true,
  onCellClick,
  showActionColumn = false,
  onRowAction,
  columnWidthOverrides,
  defaultSort,
  search,
  toolbarContainer,
  filterFields,
  searchPlaceholder,
}: SystemTableProps, ref: React.ForwardedRef<SystemTableRef>) {
  const gridTheme = useGridTheme();
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnConfig[]>(defaultColumns || []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingTable, setMissingTable] = useState(false);
  const [columnSelectorOpen, setColumnSelectorOpen] = useState(false);
  const columnsLoadedRef = useRef(false);

  // Load columns
  useEffect(() => {
    if (columnsLoadedRef.current || !fetchColumns) return;
    columnsLoadedRef.current = true;

    fetchColumns()
      .then((metadata) => {
        const cols = createColumnsFromMetadata(metadata, 'query_log');
        // If defaultVisibleFields is provided, only show those and sort by that order
        if (defaultVisibleFields && defaultVisibleFields.length > 0) {
          const visibleSet = new Set(defaultVisibleFields);
          const sortedCols = cols
            .map(c => ({ ...c, visible: visibleSet.has(c.field) }))
            .sort((a, b) => {
              const aIndex = defaultVisibleFields.indexOf(a.field);
              const bIndex = defaultVisibleFields.indexOf(b.field);
              if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
              if (aIndex !== -1) return -1;
              if (bIndex !== -1) return 1;
              return 0;
            });
          setColumns(sortedCols);
        } else {
          setColumns(cols.map(c => ({ ...c, visible: true })));
        }
      })
      .catch((err) => console.error('Failed to load columns:', err));
  }, [fetchColumns, defaultVisibleFields]);

  // Notify parent when columns change
  useEffect(() => {
    if (onColumnsChange && columns.length > 0) {
      onColumnsChange(columns);
    }
  }, [columns, onColumnsChange]);

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMissingTable(false);
    try {
      const result = await fetchData(filters);
      setData(result);
    } catch (err) {
      setData([]);
      if (isMissingTableError(err)) setMissingTable(true);
      else setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [fetchData, filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Respond to global refresh trigger
  const globalRefreshTrigger = useQueryStore((state) => state.globalRefreshTrigger);
  const initialRenderRef = useRef(true);
  useEffect(() => {
    // Skip the initial render (data is already loaded above)
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    loadData();
  }, [globalRefreshTrigger, loadData]);

  const toolbarFields = useMemo(
    () => filterFields ?? (toolbarContainer ? deriveFilterFields(columns, data) : []),
    [filterFields, toolbarContainer, columns, data]
  );
  const clientFilters = useClientFilters(data, toolbarFields, rowSearchText);
  const rows = toolbarContainer ? clientFilters.filtered : data;

  const toggleColumnVisibility = useCallback((field: string) => {
    setColumns(cols => cols.map(c => c.field === field ? { ...c, visible: !c.visible } : c));
  }, []);

  // Expose column selector functionality via ref
  useImperativeHandle(ref, () => ({
    columns,
    toggleColumnVisibility,
    columnSelectorOpen,
    setColumnSelectorOpen,
  }), [columns, toggleColumnVisibility, columnSelectorOpen]);

  const ActionCellRenderer = useCallback((params: ICellRendererParams) => {
    if (!onRowAction) return null;
    return (
      <button
        onClick={() => onRowAction(params.data)}
        className="p-1 hover:bg-gray-600 rounded"
        title="View Details"
      >
        <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
      </button>
    );
  }, [onRowAction]);

  const columnDefs: ColDef[] = useMemo(() => {
    const visibleCols = columns.filter(c => c.visible);
    const defs: ColDef[] = [];

    // Add action column if enabled
    if (showActionColumn && onRowAction) {
      defs.push({
        headerName: '',
        field: '_action',
        width: 40,
        sortable: false,
        cellRenderer: ActionCellRenderer,
        cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      });
    }

    visibleCols.forEach((col) => {
      const def: ColDef = {
        headerName: col.headerName,
        field: col.field,
        width: columnWidthOverrides?.[col.field] ?? col.width,
        sortable: col.sortable,
        resizable: true,
        headerTooltip: col.comment || col.headerName,
      };

      if (col.type.startsWith('Array(')) {
        def.cellRenderer = (params: ICellRendererParams) => <ArrayCellRenderer value={params.value} />;
      }

      // Table, database, partition styling - light blue and clickable
      if (col.field === 'table' || col.field === 'database' || col.field === 'partition' || col.field === 'partition_id') {
        def.cellStyle = { color: '#60a5fa', cursor: onCellClick ? 'pointer' : 'default' };
        if (onCellClick) {
          def.onCellClicked = (params) => {
            if (params.data && params.value != null) {
              onCellClick(col.field, params.value, params.data);
            }
          };
        }
      }

      // Format bytes fields - light green
      if (col.field.includes('bytes') || col.field.includes('size') || col.field.includes('memory')) {
        def.valueFormatter = (params) => params.value != null ? formatBytes(Number(params.value)) : '-';
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: '#86efac' };
      }

      // Format number fields - light green
      if (col.field.includes('rows') || col.field.includes('count') || col.field.includes('num_')) {
        def.valueFormatter = (params) => params.value != null ? formatNumber(Number(params.value)) : '-';
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: '#86efac' };
      }

      // Format percentage fields - yellow
      if (col.field.includes('pct') || col.field.includes('percent') || col.field.includes('ratio')) {
        def.valueFormatter = (params) => {
          if (params.value == null || Number(params.value) < 0) return '-';
          return `${Number(params.value).toFixed(0)}%`;
        };
        def.comparator = numericComparator;
        def.cellStyle = { textAlign: 'right', color: '#fde047' };
      }

      // Format time fields
      if (col.field.includes('time') && col.type.includes('DateTime')) {
        def.valueFormatter = (params) => {
          if (!params.value) return '-';
          return formatDateTime(params.value, { seconds: false });
        };
      }

      defs.push(def);
    });

    return defs;
  }, [columns, showActionColumn, onRowAction, ActionCellRenderer, columnWidthOverrides, onCellClick]);

  const onSortChanged = useCallback((event: SortChangedEvent) => {
    if (!onSortChange) return;
    const sortModel = event.api.getColumnState().find(col => col.sort);
    if (sortModel) {
      onSortChange(sortModel.colId, sortModel.sort === 'asc' ? 'ASC' : 'DESC');
    }
  }, [onSortChange]);

  // Auto-size columns on first data render, excluding query columns
  const onFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    const columnsToSkip = ['query', 'example_query', 'normalized_query_hash'];
    const allColumns = event.api.getColumns();
    if (allColumns) {
      const columnsToSize = allColumns
        .filter(col => !columnsToSkip.includes(col.getColId()))
        .map(col => col.getColId());
      event.api.autoSizeColumns(columnsToSize);
    }
  }, []);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  const toolbar = toolbarContainer && createPortal(
    <>
      <div className="flex items-center gap-3 min-w-0">
        {toolbarFields.length > 0 && (
          <ClientFilterPanel
            rows={data}
            fields={toolbarFields}
            filters={clientFilters.filters}
            onChange={clientFilters.setFilter}
            onClearAll={clientFilters.clearAll}
          />
        )}
        <ToolbarSearch value={clientFilters.search} onChange={clientFilters.setSearch} placeholder={searchPlaceholder} />
      </div>
      <div className="flex items-center gap-4 text-xs shrink-0">
        <span className="text-gray-400">
          <span className="text-white font-medium">{rows.length.toLocaleString()}</span>
          {rows.length !== data.length && ` of ${data.length.toLocaleString()}`} rows
        </span>
        {clientFilters.activeCount > 0 && (
          <span className="text-blue-400">
            {clientFilters.activeCount} filter{clientFilters.activeCount > 1 ? 's' : ''} active
          </span>
        )}
      </div>
    </>,
    toolbarContainer
  );

  if (missingTable) {
    return (
      <>
        {toolbar}
        <EmptyState icon={Database} title={title ? `${title} is not available` : 'Not available on this server'}>
          The system table behind this view does not exist on this ClickHouse server (it may be disabled in the server config or unsupported by this version).
        </EmptyState>
      </>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900 border border-gray-700 rounded overflow-hidden">
      {toolbar}
      {hideHeader && error && (
        <div className="px-3 py-1.5 text-xs bg-red-900/40 border-b border-red-800 text-red-300 break-words">{error}</div>
      )}
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 bg-gray-900/50 border-b border-gray-700">
          <div className="flex items-center gap-3">
            {!hideTitle && title && <h2 className="text-sm font-semibold text-white">{title}</h2>}
            <span className="text-xs text-gray-400">{rows.length.toLocaleString()} rows</span>
            {error && <span className="text-xs text-red-400">{error}</span>}
          </div>
          <div className="flex items-center gap-2">
            {columns.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setColumnSelectorOpen(!columnSelectorOpen)}
                  className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
                  title="Configure columns"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
                {columnSelectorOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setColumnSelectorOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[200px]">
                      <div className="flex items-center justify-between p-2 border-b border-gray-700">
                        <span className="text-xs font-semibold text-gray-300">Columns</span>
                        <button onClick={() => setColumnSelectorOpen(false)} className="text-gray-400 hover:text-white">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="max-h-64 overflow-y-auto p-1">
                        {columns.map((col) => (
                          <label key={col.field} className="flex items-center gap-2 p-1.5 hover:bg-gray-700 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={col.visible}
                              onChange={() => toggleColumnVisibility(col.field)}
                              className="w-3 h-3 rounded border-gray-500 bg-gray-700 text-blue-500"
                            />
                            <span className="text-xs text-gray-300">{col.headerName}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="flex-1">
        <AgGridReact {...GRID_OVERLAYS}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          onSortChanged={onSortChanged}
          onFirstDataRendered={onFirstDataRendered}
          loading={loading}
          animateRows={false}
          suppressCellFocus={true}
          enableCellTextSelection={true}
          tooltipShowDelay={300}
          tooltipInteraction={true}
          quickFilterText={search || undefined}
          getRowId={getRowId ? (params) => getRowId(params.data) : undefined}
          initialState={defaultSort ? {
            sort: {
              sortModel: defaultSort
            }
          } : undefined}
        />
      </div>
    </div>
  );
}

export const SystemTable = forwardRef(SystemTableInner);
