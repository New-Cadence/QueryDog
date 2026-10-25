import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, RowClassParams } from 'ag-grid-community';
import { Download } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { ToolbarButton, ToolbarSearch } from '../ui';
import { CostToolbar, ErrorBox, FilterCounts, Spinner } from './common';
import { downloadCsv, gridDefaults, money, rightAlign, useCost } from './costContext';
import { CostRangeSelector, CostTimelineChart, type CostSplit } from './CostTimeline';
import { bucketStart, bucketTitle, type CostBucket } from './costRange';
import { METRIC_GROUPS, sumGroups, USAGE_FILTER_FIELDS, usageSearchText, type GroupTotals, type UsageRow } from './usage';
import type { CloudData } from './useCloudData';
import { GRID_OVERLAYS } from '../gridOverlays';

const FIELDS: ClientFilterField<UsageRow>[] = [
  ...USAGE_FILTER_FIELDS,
  { field: 'month', label: 'Month', getValue: r => r.date.slice(0, 7) },
  { field: 'locked', label: 'Status', getValue: r => (r.locked ? 'final' : 'may still change') },
];

// One table row: usage rolled up to the chart's bucket, and per service when
// the chart is split by service
interface UsageBucketRow extends GroupTotals {
  date: string;
  service: string;
  own: boolean;
  total: number;
  locked: boolean;
}

function bucketUsage(rows: UsageRow[], bucket: CostBucket, split: CostSplit): UsageBucketRow[] {
  const out = new Map<string, UsageBucketRow>();
  for (const r of rows) {
    const date = bucketStart(r.date, bucket);
    const key = split === 'service' ? `${date}|${r.service}` : date;
    let cur = out.get(key);
    if (!cur) {
      cur = { ...sumGroups([]), date, service: split === 'service' ? r.service : '', own: split === 'service' && r.own, locked: true };
      out.set(key, cur);
    }
    for (const g of METRIC_GROUPS) cur[g] += r[g];
    cur.total += r.total;
    cur.locked &&= r.locked;
  }
  return [...out.values()];
}

const isTotalRow = (p: { node?: { rowPinned?: string | null } | null }) => !!p.node?.rowPinned;

// Usage from the usageCost API, rolled up to match the chart: per category,
// per service or as a total, by the selected day / week / month bucket.
export function CloudUsageTab({ data }: { data: CloudData }) {
  const gridTheme = useGridTheme();
  const { view } = useCost();
  const { from, to } = view.range;
  const { bucket } = view;
  const [split, setSplit] = useState<CostSplit>('category');
  const { filters, setFilter, clearAll, search, setSearch, filtered: matching, activeCount } = useClientFilters(data.rows, FIELDS, usageSearchText);
  const filtered = useMemo(() => matching.filter(r => r.date >= from && r.date <= to), [matching, from, to]);
  const totals = sumGroups(filtered);
  const tableRows = useMemo(() => bucketUsage(filtered, bucket, split), [filtered, bucket, split]);
  const totalRow = useMemo((): UsageBucketRow[] => [{ ...totals, date: '', service: '', own: false, locked: tableRows.every(r => r.locked) }], [totals, tableRows]);
  const pending = data.loading && (data.from > from || !data.rows.length);

  const cols = useMemo((): ColDef<UsageBucketRow>[] => {
    const money3 = (v: number) => (v ? money(v, 3) : '');
    return [
      {
        headerName: bucket === 'day' ? 'Date' : bucket === 'week' ? 'Week' : 'Month', field: 'date', width: 170, sort: 'desc',
        valueFormatter: p => (isTotalRow(p) ? 'Total' : bucketTitle(p.value, bucket)),
      },
      ...(split === 'service' ? [{
        headerName: 'Service', field: 'service', flex: 1, minWidth: 180,
        cellStyle: p => ({ color: p.data?.own ? '#93c5fd' : '#f3f4f6', fontWeight: p.data?.own ? 600 : 400 }),
      } as ColDef<UsageBucketRow>] : []),
      ...(split === 'total' ? [] : METRIC_GROUPS.map((g): ColDef<UsageBucketRow> => ({ headerName: g, field: g, width: 115, cellStyle: rightAlign, valueFormatter: p => money3(p.value) }))),
      { headerName: 'Total', field: 'total', width: 110, cellStyle: { ...rightAlign, color: '#fbbf24', fontWeight: 600 }, valueFormatter: p => money(p.value, 3) },
      { headerName: 'Final', field: 'locked', width: 70, valueFormatter: p => (p.value ? 'yes' : 'no'), headerTooltip: 'Unlocked records can still change until ClickHouse Cloud locks them' },
    ];
  }, [bucket, split]);

  const exportCsv = () => downloadCsv(
    `clickhouse-cloud-usage-${split}-${bucket}-${from}-${to}.csv`,
    [bucket, ...(split === 'service' ? ['service'] : []), ...(split === 'total' ? [] : METRIC_GROUPS), 'total_chc', 'final'],
    tableRows.map(r => [r.date, ...(split === 'service' ? [r.service] : []), ...(split === 'total' ? [] : METRIC_GROUPS.map(g => r[g])), r.total, r.locked ? 'yes' : 'no']),
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CostToolbar
        left={<>
          <ClientFilterPanel rows={data.rows} fields={FIELDS} filters={filters} onChange={setFilter} onClearAll={clearAll} />
          <CostRangeSelector />
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search usage..." width="w-48" />
        </>}
        right={<>
          <span className="text-xs text-gray-400">Total <span className="text-white font-semibold">{money(totals.total, 2)}</span></span>
          <FilterCounts count={tableRows.length} noun="rows" active={activeCount} />
          <ToolbarButton icon={Download} onClick={exportCsv} disabled={!tableRows.length}>CSV</ToolbarButton>
        </>}
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {data.error && <ErrorBox error={data.error} />}
        <CostTimelineChart rows={matching} loading={pending} split={split} onSplitChange={setSplit} />
        <div className="flex-1 min-h-48 bg-gray-900 border border-gray-700 rounded overflow-hidden">
          {pending ? <Spinner /> : (
            <AgGridReact<UsageBucketRow>
              {...GRID_OVERLAYS} theme={gridTheme} rowData={tableRows} columnDefs={cols} defaultColDef={gridDefaults} suppressCellFocus
              pinnedBottomRowData={tableRows.length ? totalRow : []}
              getRowStyle={(p: RowClassParams<UsageBucketRow>) => (p.node.rowPinned ? { fontWeight: 600 } : undefined)}
            />
          )}
        </div>
        <p className="text-[11px] text-gray-500 shrink-0">
          Amounts are ClickHouse Credits (CHC) from the usageCost API, {from} to {to} (UTC days, the finest granularity the API offers). Warehouse storage and backup are attributed to the warehouse's primary service.
        </p>
      </div>
    </div>
  );
}
