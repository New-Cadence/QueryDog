import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Table2, BarChart3, LineChart as LineIcon, AreaChart as AreaIcon, Download, Rows3, Clock, HardDrive, MemoryStick, ScanLine } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { formatBytes, formatDuration, formatNumber } from '../../utils/formatters';
import { CHART_COLORS } from '../uiTokens';
import { downloadFile, numericColumns, toCsv, type NotebookCell, type OutputView } from './model';
import { GRID_OVERLAYS } from '../gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

const VIEWS: { id: OutputView; icon: typeof Table2; label: string }[] = [
  { id: 'table', icon: Table2, label: 'Table' },
  { id: 'bar', icon: BarChart3, label: 'Bar' },
  { id: 'line', icon: LineIcon, label: 'Line' },
  { id: 'area', icon: AreaIcon, label: 'Area' },
];

const formatCell = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Stat({ icon: Icon, label, value, tone = 'text-gray-400' }: { icon: typeof Clock; label: string; value: string; tone?: string }) {
  return <span className={`flex items-center gap-1 ${tone}`} title={label}><Icon className="w-3 h-3" />{value}</span>;
}

export function CellOutput({ cell, onChange }: { cell: NotebookCell; onChange: (patch: Partial<NotebookCell>) => void }) {
  const gridTheme = useGridTheme();
  const result = cell.result!;
  const keys = useMemo(() => (result.data[0] ? Object.keys(result.data[0]) : []), [result]);
  const numeric = useMemo(() => numericColumns(result.data), [result]);
  const columnDefs = useMemo((): ColDef[] => keys.map(k => ({
    field: k,
    headerName: k,
    type: numeric.includes(k) ? 'rightAligned' : undefined,
    valueFormatter: p => formatCell(p.value),
  })), [keys, numeric]);
  const chartData = useMemo(() => result.data.map(r => {
    const row: Record<string, unknown> = { ...r };
    cell.yKeys?.forEach(k => { row[k] = Number(r[k]); });
    return row;
  }), [result, cell.yKeys]);

  const saved = result.data.length < result.rowCount; // reloaded output is capped by the server
  const { stats } = result;

  const header = (
    <div className="flex items-center gap-3 px-2 py-1 bg-gray-800/30 text-[10px] text-gray-500 flex-wrap">
      <Stat icon={Rows3} label="Rows returned" value={`${formatNumber(result.rowCount)} rows${result.truncated ? ' (limit reached)' : ''}`} />
      <Stat icon={Clock} label="Round-trip time" value={formatDuration(result.duration)} tone="text-green-400" />
      {stats && (
        <>
          <Stat icon={ScanLine} label="Rows read (system.query_log)" value={`${formatNumber(stats.read_rows)} read`} />
          <Stat icon={HardDrive} label="Bytes read (system.query_log)" value={formatBytes(stats.read_bytes)} />
          <Stat icon={MemoryStick} label="Peak memory (system.query_log)" value={formatBytes(stats.memory_usage)} />
          <Stat icon={Clock} label="Server elapsed (system.query_log)" value={`${formatDuration(stats.query_duration_ms)} server`} />
        </>
      )}
      {stats === null && <span title="No system.query_log entry was found for this run">query_log stats unavailable</span>}
      {saved && <span className="text-yellow-400" title="Saved notebooks keep the first 500 rows of each output; run the cell again for the full result">showing first {formatNumber(result.data.length)} saved rows</span>}
      <span className="ml-auto">Ran {new Date(result.ranAt).toLocaleString()}</span>
      {result.data.length > 0 && (
        <button onClick={() => downloadFile(`${cell.name}.csv`, toCsv(result.data), 'text/csv')} title="Download output as CSV"
          className="flex items-center gap-1 px-1.5 py-px rounded border border-gray-600 text-gray-400 hover:text-white hover:border-blue-500">
          <Download className="w-3 h-3" />CSV
        </button>
      )}
    </div>
  );

  if (result.data.length === 0) {
    return <div className="border-t border-gray-700">{header}<div className="px-3 py-2 text-xs text-gray-500">Query returned no rows.</div></div>;
  }

  const Chart = cell.view === 'bar' ? BarChart : cell.view === 'line' ? LineChart : AreaChart;

  return (
    <div className="border-t border-gray-700">
      {header}
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-800/30 border-t border-gray-800">
        <div className="flex items-center bg-gray-800 rounded border border-gray-600">
          {VIEWS.map(({ id, icon: Icon, label }, i) => (
            <button key={id} onClick={() => onChange({ view: id })}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] transition-colors ${i === 0 ? 'rounded-l' : ''} ${i === VIEWS.length - 1 ? 'rounded-r' : ''} ${
                cell.view === id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}>
              <Icon className="w-3 h-3" />{label}
            </button>
          ))}
        </div>
        {cell.view !== 'table' && (
          <>
            <span className="text-[11px] text-gray-500 ml-2">X</span>
            <select value={cell.xKey} onChange={e => onChange({ xKey: e.target.value, yKeys: cell.yKeys?.filter(k => k !== e.target.value) })}
              className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[11px] text-white">
              {keys.map(k => <option key={k}>{k}</option>)}
            </select>
            <span className="text-[11px] text-gray-500">Y</span>
            <div className="flex flex-wrap gap-1">
              {keys.filter(k => k !== cell.xKey).map(k => {
                const active = cell.yKeys?.includes(k);
                return (
                  <button key={k} onClick={() => onChange({ yKeys: active ? cell.yKeys!.filter(y => y !== k) : [...(cell.yKeys || []), k] })}
                    title={numeric.includes(k) ? undefined : 'Not a numeric column'}
                    className={`px-1.5 py-px rounded border text-[10px] font-mono ${active ? 'border-blue-500 text-blue-300 bg-blue-900/40' : 'border-gray-600 text-gray-500 hover:text-gray-300'} ${numeric.includes(k) ? '' : 'opacity-50'}`}>
                    {k}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
      {cell.view === 'table' ? (
        <div style={{ height: Math.min(360, 32 + result.data.length * 26 + 4) }}>
          <AgGridReact {...GRID_OVERLAYS} theme={gridTheme} rowData={result.data} columnDefs={columnDefs} suppressCellFocus enableCellTextSelection
            defaultColDef={{ resizable: true, sortable: true, suppressMovable: true, minWidth: 100, flex: 1 }} />
        </div>
      ) : !cell.yKeys?.length ? (
        <div className="px-3 py-6 text-xs text-gray-500 text-center">Pick one or more numeric Y columns to chart.</div>
      ) : (
        <div className="h-72 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <Chart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey={cell.xKey} tick={{ fill: '#9ca3af', fontSize: 10 }} stroke="#4b5563" />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} stroke="#4b5563" tickFormatter={v => formatNumber(v)} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', fontSize: 11 }} />
              {cell.yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {cell.yKeys.map((k, i) => {
                const color = CHART_COLORS[i % CHART_COLORS.length];
                if (cell.view === 'bar') return <Bar key={k} dataKey={k} fill={color} radius={[2, 2, 0, 0]} />;
                if (cell.view === 'line') return <Line key={k} dataKey={k} stroke={color} dot={false} strokeWidth={2} />;
                return <Area key={k} dataKey={k} stroke={color} fill={color} fillOpacity={0.25} />;
              })}
            </Chart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
