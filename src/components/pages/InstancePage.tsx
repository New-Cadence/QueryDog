import { useState, useMemo, useEffect, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import { Settings, HardDrive, Database, BarChart2, Clock, Zap, AlertTriangle, AlertCircle, LayoutDashboard } from 'lucide-react';
import { SystemTable } from '../SystemTable';
import { ToolbarSlot } from '../ToolbarSlot';
import { PageTabs, PageToolbar, ToolbarSearch } from '../ui';
import { DashboardTab } from './DashboardTab';
import {
  fetchSettings,
  fetchSettingsColumns,
  fetchDisks,
  fetchDisksColumns,
  fetchStoragePolicies,
  fetchStoragePoliciesColumns,
  fetchMetrics,
  fetchAsyncMetrics,
  fetchEvents,
  fetchErrors,
  fetchErrorsColumns,
  fetchWarnings,
  fetchWarningsColumns,
} from '../../services/api';
import { useGridTheme } from '../../hooks/useTheme';

ModuleRegistry.registerModules([AllCommunityModule]);

type InstanceTab = 'dashboard' | 'metrics' | 'async' | 'events' | 'errors' | 'warnings' | 'settings' | 'disks' | 'storagePolicies';

interface MetricRow {
  metric: string;
  value: number | string;
  description: string;
}

interface EventRow {
  event: string;
  value: number | string;
  description: string;
}

function formatValue(value: number | string): string {
  if (typeof value === 'string') return value;
  if (Math.abs(value) >= 1000000000) return (value / 1000000000).toFixed(2) + 'B';
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(2) + 'K';
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

const DISKS_DEFAULT_VISIBLE_FIELDS = [
  'name',
  'path',
  'free_space',
  'total_space',
  'unreserved_space',
  'keep_free_space',
  'type',
];

const STORAGE_POLICIES_DEFAULT_VISIBLE_FIELDS = [
  'policy_name',
  'volume_name',
  'volume_priority',
  'disks',
  'max_data_part_size',
  'move_factor',
];

export function InstancePage() {
  const gridTheme = useGridTheme();
  const [activeTab, setActiveTab] = useState<InstanceTab>('dashboard');
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [asyncMetrics, setAsyncMetrics] = useState<MetricRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dashboardFilterBarEl, setDashboardFilterBarEl] = useState<HTMLDivElement | null>(null);
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);

  const loadMetricsData = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const [m, am, ev] = await Promise.all([fetchMetrics(), fetchAsyncMetrics(), fetchEvents()]);
      setMetrics(m as unknown as MetricRow[]);
      setAsyncMetrics(am as unknown as MetricRow[]);
      setEvents(ev as unknown as EventRow[]);
    } catch (err) {
      console.error('Failed to load metrics:', err);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMetricsData();
  }, [loadMetricsData]);

  const isMetricsTab = activeTab === 'metrics' || activeTab === 'async' || activeTab === 'events';
  const isDashboardTab = activeTab === 'dashboard';

  const currentData = activeTab === 'events' ? events : (activeTab === 'metrics' ? metrics : asyncMetrics);
  const nameField = activeTab === 'events' ? 'event' : 'metric';

  const filteredData = useMemo(() => {
    if (!isMetricsTab || !search) return currentData;
    const lowerSearch = search.toLowerCase();
    return currentData.filter(row => {
      const name = (row as MetricRow).metric || (row as EventRow).event || '';
      return name.toLowerCase().includes(lowerSearch) ||
        row.description.toLowerCase().includes(lowerSearch);
    });
  }, [currentData, search, isMetricsTab]);

  const columnDefs = useMemo((): ColDef<MetricRow | EventRow>[] => [
    {
      headerName: activeTab === 'events' ? 'Event' : 'Metric',
      field: nameField as 'metric' | 'event',
      sortable: true,
      resizable: true,
      width: 300,
    },
    {
      headerName: 'Value',
      field: 'value',
      sortable: true,
      resizable: true,
      width: 150,
      sort: 'desc',
      cellStyle: { textAlign: 'right', color: '#60a5fa' } as const,
      valueFormatter: (params) => formatValue(params.value),
      comparator: (a, b) => Number(a) - Number(b),
    },
    {
      headerName: 'Description',
      field: 'description',
      sortable: true,
      resizable: true,
      flex: 1,
      cellStyle: { color: '#9ca3af' } as const,
    },
  ], [activeTab, nameField]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  const tabs: { id: InstanceTab; label: string; icon: typeof Settings }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'metrics', label: 'Metrics', icon: BarChart2 },
    { id: 'async', label: 'Async Metrics', icon: Clock },
    { id: 'events', label: 'Events', icon: Zap },
    { id: 'errors', label: 'Errors', icon: AlertTriangle },
    { id: 'warnings', label: 'Warnings', icon: AlertCircle },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'disks', label: 'Disks', icon: HardDrive },
    { id: 'storagePolicies', label: 'Storage Policies', icon: Database },
  ];


  return (
    <div className="h-full flex flex-col">
      {/* Filter bar - the dashboard and system tables fill their own */}
      {isDashboardTab ? (
        <div className="bg-gray-900/50 border-b border-gray-700 px-1.5 h-9 flex items-center justify-between shrink-0">
          <div ref={setDashboardFilterBarEl} className="flex items-center justify-between w-full" />
        </div>
      ) : isMetricsTab ? (
        <PageToolbar
          left={<ToolbarSearch value={search} onChange={setSearch} placeholder={`Search ${activeTab === 'events' ? 'events' : 'metrics'}...`} />}
          right={<>
            <span className="text-xs text-gray-400">
              <span className="text-white font-medium">{filteredData.length.toLocaleString()}</span>
              {filteredData.length !== currentData.length && ` of ${currentData.length.toLocaleString()}`} {activeTab === 'events' ? 'events' : 'metrics'}
            </span>
          </>}
        />
      ) : (
        <ToolbarSlot ref={setToolbarEl} />
      )}

      <PageTabs tabs={tabs} active={activeTab} onChange={(id) => { setActiveTab(id); setSearch(''); }} />

      <div className={`flex-1 overflow-hidden ${isDashboardTab ? '' : 'px-1.5 pt-3 pb-4'}`}>
        {isDashboardTab && <DashboardTab filterBarContainer={dashboardFilterBarEl} />}
        {isMetricsTab && (
          <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
            <AgGridReact<MetricRow | EventRow>
              theme={gridTheme}
              rowData={filteredData}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              loading={metricsLoading}
              animateRows={false}
              suppressCellFocus={true}
              enableCellTextSelection={true}
              getRowId={(params) => (params.data as MetricRow).metric || (params.data as EventRow).event}
            />
          </div>
        )}
        {activeTab === 'errors' && (
          <SystemTable
            fetchData={fetchErrors}
            fetchColumns={fetchErrorsColumns}
            getRowId={(data) => `${data.name}-${data.code}-${data.last_error_time}`}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}
        {activeTab === 'settings' && (
          <SystemTable
            fetchData={fetchSettings}
            fetchColumns={fetchSettingsColumns}
            getRowId={(data) => String(data.name)}
            hideHeader
            columnWidthOverrides={{ name: 400 }}
            toolbarContainer={toolbarEl}
          />
        )}
        {activeTab === 'disks' && (
          <SystemTable
            fetchData={fetchDisks}
            fetchColumns={fetchDisksColumns}
            defaultVisibleFields={DISKS_DEFAULT_VISIBLE_FIELDS}
            getRowId={(data) => String(data.name)}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}
        {activeTab === 'storagePolicies' && (
          <SystemTable
            fetchData={fetchStoragePolicies}
            fetchColumns={fetchStoragePoliciesColumns}
            defaultVisibleFields={STORAGE_POLICIES_DEFAULT_VISIBLE_FIELDS}
            getRowId={(data) => `${data.policy_name}-${data.volume_name}`}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}
        {activeTab === 'warnings' && (
          <SystemTable
            fetchData={fetchWarnings}
            fetchColumns={fetchWarningsColumns}
            getRowId={(data) => String(data.message)}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}
      </div>
    </div>
  );
}
