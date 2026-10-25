import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { BarChart3, X } from 'lucide-react';
import { Panel, Pill, ToolbarButton, LoadingState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { useGridTheme } from '../../hooks/useTheme';
import { formatNumber } from '../../utils/formatters';
import { EditableComment } from './EditableComment';
import { type ColumnProfile, type DictionaryColumn, fetchColumnProfile, gridDefaults } from './api';
import { columnKeys } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

const KEY_TONES: Record<string, 'yellow' | 'blue' | 'green'> = { Primary: 'yellow', Sorting: 'blue', Partition: 'green' };

export function ColumnsTab({
  database,
  table,
  columns,
  loading,
  canEdit,
  onSaveComment,
}: {
  database: string;
  table: string;
  columns: DictionaryColumn[];
  loading: boolean;
  canEdit: boolean;
  onSaveComment: (column: string, comment: string) => Promise<void>;
}) {
  const gridTheme = useGridTheme();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const selected = columns.find(c => c.name === selectedName) || null;

  const columnDefs = useMemo<ColDef<DictionaryColumn>[]>(() => [
    { field: 'name', headerName: 'Column', width: 180, cellClass: 'text-white' },
    { field: 'type', headerName: 'Type', width: 200, cellClass: 'text-blue-300', tooltipField: 'type' },
    {
      colId: 'keys', headerName: 'Keys', width: 150,
      valueGetter: p => (p.data ? columnKeys(p.data).filter(k => k !== 'None').join(', ') : ''),
      cellRenderer: (p: { data?: DictionaryColumn }) => (
        <div className="flex gap-1 items-center h-full">
          {p.data && columnKeys(p.data).filter(k => k !== 'None').map(k => <Pill key={k} tone={KEY_TONES[k]}>{k}</Pill>)}
        </div>
      ),
    },
    {
      field: 'comment', headerName: 'Description', flex: 1, minWidth: 240, tooltipField: 'comment',
      editable: canEdit, cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
      cellRenderer: (p: { value: string }) => (p.value ? <span>{p.value}</span> : <span className="text-gray-600 italic">{canEdit ? 'double-click to document' : '—'}</span>),
    },
    {
      colId: 'default', headerName: 'Default', width: 160,
      valueGetter: p => (p.data?.default_kind ? `${p.data.default_kind} ${p.data.default_expression}` : ''),
    },
    { field: 'compression_codec', headerName: 'Codec', width: 120 },
  ], [canEdit]);

  return (
    <div className="h-full flex gap-3">
      <div className="flex-1 flex flex-col gap-2 min-w-0">
      {gridError && (
        <div className="flex items-start gap-2 px-3 py-1.5 rounded text-xs bg-red-900/40 border border-red-800 text-red-300 shrink-0">
          <span className="flex-1 break-words">Could not save comment: {gridError}</span>
          <button onClick={() => setGridError(null)} className="hover:text-white"><X className="w-3 h-3" /></button>
        </div>
      )}
      <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
        {loading ? (
          <LoadingState label="Loading columns…" />
        ) : (
          <AgGridReact<DictionaryColumn> {...GRID_OVERLAYS}
            theme={gridTheme}
            rowData={columns}
            columnDefs={columnDefs}
            defaultColDef={gridDefaults}
            getRowId={p => p.data.name}
            onRowClicked={e => e.data && setSelectedName(e.data.name)}
            rowClass="cursor-pointer"
            tooltipShowDelay={300}
            onCellValueChanged={e => {
              // Inline edit: persist, and roll the cell back if ClickHouse rejects it
              if (e.colDef.field !== 'comment' || !e.data || e.source === 'rollback' || e.newValue === e.oldValue) return;
              setGridError(null);
              onSaveComment(e.data.name, String(e.newValue ?? '').trim()).catch(err => {
                setGridError(err instanceof Error ? err.message : String(err));
                e.node.setDataValue('comment', e.oldValue, 'rollback');
              });
            }}
          />
        )}
      </div>
      </div>
      {selected && (
        <ColumnPanel
          key={selected.name}
          database={database}
          table={table}
          column={selected}
          canEdit={canEdit}
          onClose={() => setSelectedName(null)}
          onSaveComment={comment => onSaveComment(selected.name, comment)}
        />
      )}
    </div>
  );
}

function ColumnPanel({
  database,
  table,
  column,
  canEdit,
  onClose,
  onSaveComment,
}: {
  database: string;
  table: string;
  column: DictionaryColumn;
  canEdit: boolean;
  onClose: () => void;
  onSaveComment: (comment: string) => Promise<void>;
}) {
  const [profile, setProfile] = useState<ColumnProfile | null>(null);
  const [profiling, setProfiling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runProfile = () => {
    setProfiling(true);
    setError(null);
    fetchColumnProfile(database, table, column.name)
      .then(setProfile)
      .catch(err => setError(err instanceof Error ? err.message : 'Profiling failed'))
      .finally(() => setProfiling(false));
  };

  const nullPct = profile && profile.sampled_rows ? (profile.null_count / profile.sampled_rows) * 100 : 0;
  const chartData = (profile?.top || []).map(t => ({ value: t.value === null ? 'NULL' : t.value === '' ? '(empty)' : t.value, count: t.count }));

  return (
    <Panel
      className="w-96 shrink-0"
      bodyClassName="p-3 overflow-y-auto space-y-3"
      title={<span className="font-mono">{column.name}</span>}
      actions={<button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-mono text-blue-300 break-all">{column.type}</span>
        {columnKeys(column).filter(k => k !== 'None').map(k => <Pill key={k} tone={KEY_TONES[k]}>{k}</Pill>)}
      </div>
      <div>
        <div className="text-[11px] text-gray-500 mb-1">Description</div>
        <EditableComment value={column.comment} onSave={onSaveComment} disabled={!canEdit} />
      </div>

      <div className="border-t border-gray-700 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-gray-400 font-semibold">Profile</span>
          <ToolbarButton icon={BarChart3} onClick={runProfile} disabled={profiling} variant={profile ? 'secondary' : 'primary'}>
            {profiling ? 'Profiling...' : profile ? 'Re-run' : 'Profile column'}
          </ToolbarButton>
        </div>
        {error && <div className="text-[11px] text-red-400 break-words">{error}</div>}
        {!profile && !error && (
          <p className="text-[11px] text-gray-500">Computes null %, distinct count, min/max and top values over a sample of up to 1M rows.</p>
        )}
        {profile && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <ProfileStat label="Null %" value={`${nullPct.toFixed(nullPct > 0 && nullPct < 1 ? 2 : 1)}%`} sub={`${formatNumber(profile.null_count)} nulls`} />
              <ProfileStat label="Distinct (≈)" value={formatNumber(profile.distinct_count)} sub={profile.sampled_rows ? `${((profile.distinct_count / profile.sampled_rows) * 100).toFixed(1)}% of rows` : ''} />
              {profile.min !== null && <ProfileStat label="Min" value={profile.min} />}
              {profile.max !== null && <ProfileStat label="Max" value={profile.max} />}
            </div>
            <div className="text-[10px] text-gray-500">
              Sampled {formatNumber(profile.sampled_rows)} of {formatNumber(profile.total_rows)} rows ({profile.method})
            </div>
            {chartData.length > 0 && (
              <div>
                <div className="text-[11px] text-gray-400 mb-1">Top values</div>
                <div style={{ height: Math.max(80, chartData.length * 22 + 20) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="#374151" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={v => formatNumber(v)} />
                      <YAxis type="category" dataKey="value" interval={0} width={110} tick={{ fill: '#9ca3af', fontSize: 10 }}
                        tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
                      <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', fontSize: 11 }} formatter={v => formatNumber(v)} />
                      <Bar dataKey="count" name="Rows" fill={CHART_COLORS[0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ProfileStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded px-2 py-1.5 min-w-0">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xs font-mono text-gray-200 truncate" title={value}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}
