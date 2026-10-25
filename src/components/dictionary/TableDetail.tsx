import { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Activity, ArrowDownUp, ArrowLeft, Check, Columns, Copy, Eye, FileCode, GitBranch, Key, Layers } from 'lucide-react';
import { PageTabs, PageToolbar, Pill, ToolbarButton, ToolbarSearch, LoadingState } from '../ui';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { useClientFilters } from '../../hooks/useClientFilters';
import { useGridTheme } from '../../hooks/useTheme';
import { fetchTableDefinition } from '../../services/api';
import { formatBytes, formatDateTime, formatNumber } from '../../utils/formatters';
import { ColumnsTab } from './ColumnsTab';
import { type CatalogRow, COLUMN_FILTER_FIELDS, columnSearchText } from './model';
import { EditableComment } from './EditableComment';
import { LineageGraph } from './LineageGraph';
import { UsageTab } from './UsageTab';
import { type DictionaryColumn, type DictionaryTable, type LineageGraphData, SYSTEM_DATABASES, engineTone, fetchColumns, fetchSample, gridDefaults, saveComment } from './api';
import { GRID_OVERLAYS } from '../gridOverlays';

type DetailTab = 'columns' | 'lineage' | 'usage' | 'ddl' | 'sample';

export function TableDetail({
  table,
  lineage,
  lineageError,
  isKnown,
  onNavigate,
  onBack,
  onTableChange,
}: {
  table: CatalogRow;
  lineage: LineageGraphData | null;
  lineageError: string | null;
  isKnown: (database: string, name: string) => boolean;
  onNavigate: (database: string, name: string) => void;
  onBack: () => void;
  // Called after a comment is saved so the catalog row stays in sync
  onTableChange: (patch: Partial<DictionaryTable>) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('columns');
  const [columns, setColumns] = useState<DictionaryColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const canEdit = !SYSTEM_DATABASES.includes(table.database);
  const { database, name } = table;

  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(columns, COLUMN_FILTER_FIELDS, columnSearchText);

  useEffect(() => {
    let cancelled = false;
    fetchColumns(database, name)
      .then(cols => { if (!cancelled) setColumns(cols); })
      .catch(err => { if (!cancelled) setColumnsError(err instanceof Error ? err.message : 'Failed to load columns'); })
      .finally(() => { if (!cancelled) setColumnsLoading(false); });
    return () => { cancelled = true; };
  }, [database, name]);

  const saveTableComment = async (comment: string) => {
    await saveComment(database, name, comment);
    onTableChange({ comment });
  };

  const saveColumnComment = async (column: string, comment: string) => {
    await saveComment(database, name, comment, column);
    const next = columns.map(c => (c.name === column ? { ...c, comment } : c));
    setColumns(next);
    onTableChange({ documented_columns: next.filter(c => c.comment).length });
  };

  const documented = columns.filter(c => c.comment).length;
  const tabs = [
    { id: 'columns' as const, label: `Columns (${columns.length})`, icon: Columns },
    { id: 'lineage' as const, label: 'Lineage', icon: GitBranch },
    { id: 'usage' as const, label: 'Usage', icon: Activity },
    { id: 'ddl' as const, label: 'Definition', icon: FileCode },
    { id: 'sample' as const, label: 'Sample Data', icon: Eye },
  ];

  return (
    <div className="h-full flex flex-col">
      <PageToolbar
        left={
          <>
            <ToolbarButton icon={ArrowLeft} onClick={onBack}>Catalog</ToolbarButton>
            <span className="text-xs font-mono text-gray-400 truncate">
              {database}.<span className="text-white">{name}</span>
            </span>
            <Pill tone={engineTone(table.engine)}>{table.engine}</Pill>
            {tab === 'columns' && (
              <>
                <ClientFilterPanel rows={columns} fields={COLUMN_FILTER_FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
                <ToolbarSearch value={search} onChange={setSearch} placeholder="Search columns..." width="w-48" />
              </>
            )}
          </>
        }
        right={
          tab === 'columns' && (
            <div className="flex items-center gap-4 text-xs">
              <span className="text-gray-400">{documented}/{columns.length} documented</span>
              <span className="text-gray-400"><span className="text-white font-medium">{filtered.length}</span> columns</span>
              {activeCount > 0 && <span className="text-blue-400">{activeCount} filter{activeCount > 1 ? 's' : ''} active</span>}
            </div>
          )
        }
      />

      <div className="px-3 py-3 border-b border-gray-700 shrink-0 space-y-3">
        <EditableComment
          value={table.comment}
          onSave={saveTableComment}
          disabled={!canEdit}
          className="text-sm"
          placeholder="No description yet. Click the pencil to add one (ALTER TABLE ... MODIFY COMMENT)."
        />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <MetaItem label="Rows" value={formatNumber(table.total_rows)} />
          <MetaItem label="Size" value={formatBytes(table.total_bytes)} />
          <MetaItem label="Columns" value={String(table.column_count)} />
          <MetaItem label="Queries 7d" value={table.usage ? formatNumber(table.usage.queries) : table.unused ? 'unused' : '—'} />
          <MetaItem label="Last used" value={table.usage ? formatDateTime(table.usage.last_queried) : '—'} />
          <MetaItem label="Modified" value={formatDateTime(table.metadata_modification_time)} />
          <KeyItem icon={Layers} label="Partition key" value={table.partition_key} />
          <KeyItem icon={ArrowDownUp} label="Sorting key" value={table.sorting_key} />
          <KeyItem icon={Key} label="Primary key" value={table.primary_key} />
        </div>
      </div>

      <PageTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
        {tab === 'columns' && (
          columnsError ? <div className="p-3 text-xs text-red-400">{columnsError}</div> : (
            <ColumnsTab database={database} table={name} columns={filtered} loading={columnsLoading} canEdit={canEdit} onSaveComment={saveColumnComment} />
          )
        )}
        {tab === 'lineage' && (
          lineageError ? <div className="p-3 text-xs text-red-400">{lineageError}</div> : !lineage ? (
            <Spinner label="Loading lineage..." />
          ) : (
            <LineageGraph graph={lineage} current={table} isKnown={isKnown} onNavigate={onNavigate} />
          )
        )}
        {tab === 'usage' && <UsageTab database={database} table={name} summary={table.usage} unused={table.unused} />}
        {tab === 'ddl' && <DefinitionTab database={database} table={name} />}
        {tab === 'sample' && <SampleTab database={database} table={name} />}
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return <LoadingState label={label} />;
}

function DefinitionTab({ database, table }: { database: string; table: string }) {
  const [ddl, setDdl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchTableDefinition(database, table).then(setDdl).catch(() => setDdl('-- Unable to load definition'));
  }, [database, table]);

  return (
    <div className="relative h-full overflow-auto">
      <button
        onClick={() => {
          navigator.clipboard.writeText(ddl);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs"
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="bg-gray-950 border border-gray-700 rounded p-3 text-xs text-green-300 whitespace-pre-wrap">{ddl || 'Loading…'}</pre>
    </div>
  );
}

function SampleTab({ database, table }: { database: string; table: string }) {
  const gridTheme = useGridTheme();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSample(database, table)
      .then(setRows)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load sample'));
  }, [database, table]);

  const columnDefs = useMemo<ColDef[]>(
    () => Object.keys(rows?.[0] || {}).map(k => ({
      field: k,
      headerName: k,
      width: 160,
      tooltipValueGetter: p => p.valueFormatted ?? undefined,
      valueFormatter: p => (p.value === null ? 'NULL' : typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value)),
    })),
    [rows],
  );

  if (error) return <div className="p-3 text-xs text-red-400">{error}</div>;
  if (!rows) return <Spinner label="Loading sample..." />;
  if (rows.length === 0) return <div className="p-3 text-xs text-gray-500">Table is empty.</div>;
  return (
    <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
      <AgGridReact {...GRID_OVERLAYS} theme={gridTheme} rowData={rows} columnDefs={columnDefs} defaultColDef={gridDefaults} enableCellTextSelection tooltipShowDelay={300} />
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xs text-gray-200 font-mono">{value}</div>
    </div>
  );
}

function KeyItem({ icon: Icon, label, value }: { icon: typeof Key; label: string; value: string }) {
  return (
    <div className="min-w-0 max-w-xs">
      <div className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wide">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="text-xs font-mono text-gray-300 truncate" title={value}>{value || '—'}</div>
    </div>
  );
}
