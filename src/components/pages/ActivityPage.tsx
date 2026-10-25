import { useState, useCallback, useRef } from 'react';
import { Activity, GitMerge, Zap, RefreshCw, Settings, X, HardDrive, Upload, Network } from 'lucide-react';
import { SystemTable, type SystemTableRef } from '../SystemTable';
import { ActivityFilterPanel } from '../ActivityFilterPanel';
import { ProfileEventsModal } from '../ProfileEventsModal';
import { PageTabs, PageToolbar, ToolbarSearch } from '../ui';
import { useQueryStore } from '../../stores/queryStore';
import type { QueryLogEntry } from '../../types/queryLog';
import {
  fetchProcesses,
  fetchProcessesColumns,
  fetchProcessesDistinct,
  fetchMerges,
  fetchMergesColumns,
  fetchMergesDistinct,
  fetchMutations,
  fetchMutationsColumns,
  fetchMutationsDistinct,
  fetchViewRefreshes,
  fetchViewRefreshesColumns,
  fetchViewRefreshesDistinct,
  fetchQueryCache,
  fetchQueryCacheColumns,
  fetchAsyncInserts,
  fetchAsyncInsertsColumns,
  fetchAsyncInsertsDistinct,
  fetchDistributedDDL,
  fetchDistributedDDLColumns,
  fetchDistributedDDLDistinct,
} from '../../services/api';

type ActivityTab = 'processes' | 'merges' | 'mutations' | 'refreshes' | 'queryCache' | 'asyncInserts' | 'distributedDDL';

const PROCESSES_DEFAULT_VISIBLE_FIELDS = [
  'query_id',
  'user',
  'elapsed',
  'read_rows',
  'written_rows',
  'query',
  'current_database',
  'memory_usage',
  'client_name',
  'is_initial_query',
];

const MUTATIONS_DEFAULT_VISIBLE_FIELDS = [
  'create_time',
  'database',
  'table',
  'mutation_id',
  'command',
  'parts_to_do',
  'is_done',
  'latest_fail_reason',
];

const PROCESSES_FILTERABLE_FIELDS = [
  { field: 'user', label: 'User' },
  { field: 'query_kind', label: 'Query Kind' },
  { field: 'current_database', label: 'Database' },
  { field: 'client_name', label: 'Client Name' },
  { field: 'is_initial_query', label: 'Initial Query' },
];

const MERGES_FILTERABLE_FIELDS = [
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table' },
  { field: 'merge_type', label: 'Merge Type' },
  { field: 'merge_algorithm', label: 'Algorithm' },
];

const MUTATIONS_FILTERABLE_FIELDS = [
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table' },
  { field: 'is_done', label: 'Is Done' },
];

const VIEW_REFRESHES_DEFAULT_VISIBLE_FIELDS = [
  'database',
  'view',
  'status',
  'last_success_time',
  'last_refresh_time',
  'next_refresh_time',
  'refresh_count',
  'exception',
];

const VIEW_REFRESHES_FILTERABLE_FIELDS = [
  { field: 'database', label: 'Database' },
  { field: 'view', label: 'View' },
  { field: 'status', label: 'Status' },
];

const ASYNC_INSERTS_DEFAULT_VISIBLE_FIELDS = [
  'database',
  'table',
  'format',
  'first_update',
  'total_bytes',
  'total_rows',
  'entries',
];

const ASYNC_INSERTS_FILTERABLE_FIELDS = [
  { field: 'database', label: 'Database' },
  { field: 'table', label: 'Table' },
  { field: 'format', label: 'Format' },
];

const DISTRIBUTED_DDL_DEFAULT_VISIBLE_FIELDS = [
  'entry',
  'host_name',
  'status',
  'query',
  'initiator',
  'entry_version',
];

const DISTRIBUTED_DDL_FILTERABLE_FIELDS = [
  { field: 'status', label: 'Status' },
  { field: 'host_name', label: 'Host' },
  { field: 'cluster', label: 'Cluster' },
];

export function ActivityPage() {
  const [activeTab, setActiveTab] = useState<ActivityTab>('processes');
  const [search, setSearch] = useState('');
  const { selectedEntry, setSelectedEntry } = useQueryStore();

  // Refs to SystemTables for column toggling
  const processesTableRef = useRef<SystemTableRef>(null);
  const mergesTableRef = useRef<SystemTableRef>(null);
  const mutationsTableRef = useRef<SystemTableRef>(null);
  const refreshesTableRef = useRef<SystemTableRef>(null);
  const queryCacheTableRef = useRef<SystemTableRef>(null);
  const asyncInsertsTableRef = useRef<SystemTableRef>(null);
  const distributedDDLTableRef = useRef<SystemTableRef>(null);

  // Column state for each table type (synced from SystemTable via callback)
  const [processesColumns, setProcessesColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [mergesColumns, setMergesColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [mutationsColumns, setMutationsColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [refreshesColumns, setRefreshesColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [queryCacheColumns, setQueryCacheColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [asyncInsertsColumns, setAsyncInsertsColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);
  const [distributedDDLColumns, setDistributedDDLColumns] = useState<{ field: string; headerName: string; visible: boolean }[]>([]);

  // Column selector state
  const [columnSelectorOpen, setColumnSelectorOpen] = useState(false);

  // Get current columns and toggle function based on active tab
  const getCurrentColumns = () => {
    switch (activeTab) {
      case 'processes': return processesColumns;
      case 'merges': return mergesColumns;
      case 'mutations': return mutationsColumns;
      case 'refreshes': return refreshesColumns;
      case 'queryCache': return queryCacheColumns;
      case 'asyncInserts': return asyncInsertsColumns;
      case 'distributedDDL': return distributedDDLColumns;
    }
  };

  const toggleColumnVisibility = (field: string) => {
    switch (activeTab) {
      case 'processes': processesTableRef.current?.toggleColumnVisibility(field); break;
      case 'merges': mergesTableRef.current?.toggleColumnVisibility(field); break;
      case 'mutations': mutationsTableRef.current?.toggleColumnVisibility(field); break;
      case 'refreshes': refreshesTableRef.current?.toggleColumnVisibility(field); break;
      case 'queryCache': queryCacheTableRef.current?.toggleColumnVisibility(field); break;
      case 'asyncInserts': asyncInsertsTableRef.current?.toggleColumnVisibility(field); break;
      case 'distributedDDL': distributedDDLTableRef.current?.toggleColumnVisibility(field); break;
    }
  };

  const currentColumns = getCurrentColumns();

  // Handler for viewing process details
  const handleProcessAction = useCallback((data: Record<string, unknown>) => {
    // Map process data to QueryLogEntry format for the modal
    const entry: QueryLogEntry = {
      query_id: data.query_id,
      query: data.query,
      memory_usage: data.memory_usage,
      read_rows: data.read_rows,
      read_bytes: data.read_bytes,
      written_rows: data.written_rows,
      written_bytes: data.written_bytes,
      result_rows: data.result_rows,
      result_bytes: data.result_bytes,
      query_duration_ms: data.elapsed ? Number(data.elapsed) * 1000 : 0,
      user: data.user,
      current_database: data.current_database,
      ProfileEvents: data.ProfileEvents || {},
      Settings: data.Settings || {},
    };
    setSelectedEntry(entry);
  }, [setSelectedEntry]);

  // Processes filters
  const [processesFilters, setProcessesFilters] = useState<Record<string, string[]>>({});
  const handleProcessesFilterChange = useCallback((field: string, values: string[]) => {
    setProcessesFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearProcessesFilter = useCallback((field: string) => {
    setProcessesFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllProcessesFilters = useCallback(() => {
    setProcessesFilters({});
  }, []);
  const fetchProcessesWithFilters = useCallback(
    () => fetchProcesses(processesFilters),
    [processesFilters]
  );

  // Merges filters
  const [mergesFilters, setMergesFilters] = useState<Record<string, string[]>>({});
  const handleMergesFilterChange = useCallback((field: string, values: string[]) => {
    setMergesFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearMergesFilter = useCallback((field: string) => {
    setMergesFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllMergesFilters = useCallback(() => {
    setMergesFilters({});
  }, []);
  const fetchMergesWithFilters = useCallback(
    () => fetchMerges(mergesFilters),
    [mergesFilters]
  );

  // Mutations filters - default to showing only not-done mutations
  const [mutationsFilters, setMutationsFilters] = useState<Record<string, string[]>>({ is_done: ['0'] });
  const handleMutationsFilterChange = useCallback((field: string, values: string[]) => {
    setMutationsFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearMutationsFilter = useCallback((field: string) => {
    setMutationsFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllMutationsFilters = useCallback(() => {
    setMutationsFilters({});
  }, []);
  const fetchMutationsWithFilters = useCallback(
    () => fetchMutations(mutationsFilters),
    [mutationsFilters]
  );

  // View Refreshes filters
  const [refreshesFilters, setRefreshesFilters] = useState<Record<string, string[]>>({});
  const handleRefreshesFilterChange = useCallback((field: string, values: string[]) => {
    setRefreshesFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearRefreshesFilter = useCallback((field: string) => {
    setRefreshesFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllRefreshesFilters = useCallback(() => {
    setRefreshesFilters({});
  }, []);
  const fetchRefreshesWithFilters = useCallback(
    () => fetchViewRefreshes(refreshesFilters),
    [refreshesFilters]
  );

  const fetchQueryCacheData = useCallback(
    () => fetchQueryCache(),
    []
  );

  // Async Inserts filters
  const [asyncInsertsFilters, setAsyncInsertsFilters] = useState<Record<string, string[]>>({});
  const handleAsyncInsertsFilterChange = useCallback((field: string, values: string[]) => {
    setAsyncInsertsFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearAsyncInsertsFilter = useCallback((field: string) => {
    setAsyncInsertsFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllAsyncInsertsFilters = useCallback(() => {
    setAsyncInsertsFilters({});
  }, []);
  const fetchAsyncInsertsWithFilters = useCallback(
    () => fetchAsyncInserts(asyncInsertsFilters),
    [asyncInsertsFilters]
  );

  // Distributed DDL filters
  const [distributedDDLFilters, setDistributedDDLFilters] = useState<Record<string, string[]>>({});
  const handleDistributedDDLFilterChange = useCallback((field: string, values: string[]) => {
    setDistributedDDLFilters((prev) => ({ ...prev, [field]: values }));
  }, []);
  const handleClearDistributedDDLFilter = useCallback((field: string) => {
    setDistributedDDLFilters((prev) => {
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  }, []);
  const handleClearAllDistributedDDLFilters = useCallback(() => {
    setDistributedDDLFilters({});
  }, []);
  const fetchDistributedDDLWithFilters = useCallback(
    () => fetchDistributedDDL(distributedDDLFilters),
    [distributedDDLFilters]
  );

  const processesFilterCount = Object.values(processesFilters).filter((v) => v.length > 0).length;
  const mergesFilterCount = Object.values(mergesFilters).filter((v) => v.length > 0).length;
  const mutationsFilterCount = Object.values(mutationsFilters).filter((v) => v.length > 0).length;
  const refreshesFilterCount = Object.values(refreshesFilters).filter((v) => v.length > 0).length;
  const asyncInsertsFilterCount = Object.values(asyncInsertsFilters).filter((v) => v.length > 0).length;
  const distributedDDLFilterCount = Object.values(distributedDDLFilters).filter((v) => v.length > 0).length;

  const tabs: { id: ActivityTab; label: string; icon: typeof Activity }[] = [
    { id: 'processes', label: 'Processes', icon: Activity },
    { id: 'merges', label: 'Merges', icon: GitMerge },
    { id: 'mutations', label: 'Mutations', icon: Zap },
    { id: 'refreshes', label: 'View Refreshes', icon: RefreshCw },
    { id: 'queryCache', label: 'Query Cache', icon: HardDrive },
    { id: 'asyncInserts', label: 'Async Inserts', icon: Upload },
    { id: 'distributedDDL', label: 'DDL Queue', icon: Network },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <PageToolbar
        left={<>
          {activeTab === 'processes' && (
            <ActivityFilterPanel
              filters={processesFilters}
              onFilterChange={handleProcessesFilterChange}
              onClearFilter={handleClearProcessesFilter}
              onClearAll={handleClearAllProcessesFilters}
              fetchDistinct={fetchProcessesDistinct}
              filterableFields={PROCESSES_FILTERABLE_FIELDS}
            />
          )}
          {activeTab === 'merges' && (
            <ActivityFilterPanel
              filters={mergesFilters}
              onFilterChange={handleMergesFilterChange}
              onClearFilter={handleClearMergesFilter}
              onClearAll={handleClearAllMergesFilters}
              fetchDistinct={fetchMergesDistinct}
              filterableFields={MERGES_FILTERABLE_FIELDS}
            />
          )}
          {activeTab === 'mutations' && (
            <ActivityFilterPanel
              filters={mutationsFilters}
              onFilterChange={handleMutationsFilterChange}
              onClearFilter={handleClearMutationsFilter}
              onClearAll={handleClearAllMutationsFilters}
              fetchDistinct={fetchMutationsDistinct}
              filterableFields={MUTATIONS_FILTERABLE_FIELDS}
            />
          )}
          {activeTab === 'refreshes' && (
            <ActivityFilterPanel
              filters={refreshesFilters}
              onFilterChange={handleRefreshesFilterChange}
              onClearFilter={handleClearRefreshesFilter}
              onClearAll={handleClearAllRefreshesFilters}
              fetchDistinct={fetchViewRefreshesDistinct}
              filterableFields={VIEW_REFRESHES_FILTERABLE_FIELDS}
            />
          )}
          {activeTab === 'asyncInserts' && (
            <ActivityFilterPanel
              filters={asyncInsertsFilters}
              onFilterChange={handleAsyncInsertsFilterChange}
              onClearFilter={handleClearAsyncInsertsFilter}
              onClearAll={handleClearAllAsyncInsertsFilters}
              fetchDistinct={fetchAsyncInsertsDistinct}
              filterableFields={ASYNC_INSERTS_FILTERABLE_FIELDS}
            />
          )}
          {activeTab === 'distributedDDL' && (
            <ActivityFilterPanel
              filters={distributedDDLFilters}
              onFilterChange={handleDistributedDDLFilterChange}
              onClearFilter={handleClearDistributedDDLFilter}
              onClearAll={handleClearAllDistributedDDLFilters}
              fetchDistinct={fetchDistributedDDLDistinct}
              filterableFields={DISTRIBUTED_DDL_FILTERABLE_FIELDS}
            />
          )}
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Search loaded rows..." />
        </>}
        right={<div className="flex items-center gap-4 text-xs">
          {activeTab === 'processes' && processesFilterCount > 0 && (
            <span className="text-blue-400">
              {processesFilterCount} filter{processesFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {activeTab === 'merges' && mergesFilterCount > 0 && (
            <span className="text-blue-400">
              {mergesFilterCount} filter{mergesFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {activeTab === 'mutations' && mutationsFilterCount > 0 && (
            <span className="text-blue-400">
              {mutationsFilterCount} filter{mutationsFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {activeTab === 'refreshes' && refreshesFilterCount > 0 && (
            <span className="text-blue-400">
              {refreshesFilterCount} filter{refreshesFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {activeTab === 'asyncInserts' && asyncInsertsFilterCount > 0 && (
            <span className="text-blue-400">
              {asyncInsertsFilterCount} filter{asyncInsertsFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {activeTab === 'distributedDDL' && distributedDDLFilterCount > 0 && (
            <span className="text-blue-400">
              {distributedDDLFilterCount} filter{distributedDDLFilterCount > 1 ? 's' : ''} active
            </span>
          )}
        </div>}
      />

      {/* Tabs */}
      <PageTabs
        tabs={tabs}
        active={activeTab}
        onChange={(id) => { setActiveTab(id); setColumnSelectorOpen(false); setSearch(''); }}
        right={
        <div className="relative">
          <button
            onClick={() => setColumnSelectorOpen(!columnSelectorOpen)}
            className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
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
                  {currentColumns.map((col) => (
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
        }
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
        {activeTab === 'processes' && (
          <SystemTable
            ref={processesTableRef}
            fetchData={fetchProcessesWithFilters}
            fetchColumns={fetchProcessesColumns}
            defaultVisibleFields={PROCESSES_DEFAULT_VISIBLE_FIELDS}
            filters={processesFilters}
            getRowId={(data) => String(data.query_id)}
            onColumnsChange={setProcessesColumns}
            hideTitle
            hideHeader={false}
            search={search}
            showActionColumn
            onRowAction={handleProcessAction}
          />
        )}
        {activeTab === 'merges' && (
          <SystemTable
            ref={mergesTableRef}
            fetchData={fetchMergesWithFilters}
            fetchColumns={fetchMergesColumns}
            filters={mergesFilters}
            getRowId={(data) => `${data.database}-${data.table}-${data.result_part_name}`}
            onColumnsChange={setMergesColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
        {activeTab === 'mutations' && (
          <SystemTable
            ref={mutationsTableRef}
            fetchData={fetchMutationsWithFilters}
            fetchColumns={fetchMutationsColumns}
            defaultVisibleFields={MUTATIONS_DEFAULT_VISIBLE_FIELDS}
            filters={mutationsFilters}
            getRowId={(data) => `${data.database}-${data.table}-${data.mutation_id}`}
            onColumnsChange={setMutationsColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
        {activeTab === 'refreshes' && (
          <SystemTable
            ref={refreshesTableRef}
            fetchData={fetchRefreshesWithFilters}
            fetchColumns={fetchViewRefreshesColumns}
            defaultVisibleFields={VIEW_REFRESHES_DEFAULT_VISIBLE_FIELDS}
            filters={refreshesFilters}
            getRowId={(data) => `${data.database}-${data.view}`}
            onColumnsChange={setRefreshesColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
        {activeTab === 'queryCache' && (
          <SystemTable
            ref={queryCacheTableRef}
            fetchData={fetchQueryCacheData}
            fetchColumns={fetchQueryCacheColumns}
            getRowId={(data) => String(data.key_hash || data.query || JSON.stringify(data))}
            onColumnsChange={setQueryCacheColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
        {activeTab === 'asyncInserts' && (
          <SystemTable
            ref={asyncInsertsTableRef}
            fetchData={fetchAsyncInsertsWithFilters}
            fetchColumns={fetchAsyncInsertsColumns}
            defaultVisibleFields={ASYNC_INSERTS_DEFAULT_VISIBLE_FIELDS}
            filters={asyncInsertsFilters}
            getRowId={(data) => `${data.database}-${data.table}-${data.query_id || Math.random()}`}
            onColumnsChange={setAsyncInsertsColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
        {activeTab === 'distributedDDL' && (
          <SystemTable
            ref={distributedDDLTableRef}
            fetchData={fetchDistributedDDLWithFilters}
            fetchColumns={fetchDistributedDDLColumns}
            defaultVisibleFields={DISTRIBUTED_DDL_DEFAULT_VISIBLE_FIELDS}
            filters={distributedDDLFilters}
            getRowId={(data) => `${data.entry}-${data.host_name || ''}`}
            onColumnsChange={setDistributedDDLColumns}
            hideTitle
            hideHeader={false}
            search={search}
          />
        )}
      </div>

      {/* ProfileEvents Modal for processes */}
      {selectedEntry && <ProfileEventsModal />}
    </div>
  );
}
