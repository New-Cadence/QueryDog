import { useRef, useState } from 'react';
import { Database, BarChart3, ChevronLeft, ChevronRight, Activity, Layers, Settings, BarChart2, GitCompare, Pin, X, Table, Eye } from 'lucide-react';
import { EmptyState, PageTabs, PageToolbar, type TabDef } from '../ui';
import { TimeRangeSelector } from '../TimeRangeSelector';
import { SearchBar } from '../SearchBar';
import { TimelineChart } from '../TimelineChart';
import { QueryTable } from '../QueryTable';
import { GroupedQueriesTable } from '../GroupedQueriesTable';
import { HistogramsTab } from '../HistogramsTab';
import { ProfileEventsTable, type ProfileEventsTableRef } from '../ProfileEventsTable';
import { ByTableTable } from '../ByTableTable';
import { QueryViewsLogTable } from '../QueryViewsLogTable';
import { ColumnSelector } from '../ColumnSelector';
import { FilterPanel } from '../FilterPanel';
import { QueryCompareModal } from '../QueryCompareModal';
import { useQueryStore, countActiveFilters } from '../../stores/queryStore';
import { missingTableMessage } from '../../services/api';

type QueriesTab = 'queries' | 'grouped' | 'histograms' | 'profileEvents' | 'byTable' | 'queryViewsLog';

const QUERY_TABS: TabDef<QueriesTab>[] = [
  { id: 'queries', label: 'Queries', icon: Database },
  { id: 'grouped', label: 'Grouped', icon: Layers },
  { id: 'profileEvents', label: 'Profile Events', icon: Activity },
  { id: 'byTable', label: 'By Table', icon: Table },
  { id: 'queryViewsLog', label: 'Views Log', icon: Eye },
  { id: 'histograms', label: 'Histograms', icon: BarChart3 },
];

export function QueriesPage() {
  const { activeTab, setActiveTab, totalCount, fieldFilters, rangeFilters, queryLogMissing, pageSize, currentPage, setCurrentPage, normalizeQueries, setNormalizeQueries, selectedEntries, pinnedEntries, clearPinnedEntries } = useQueryStore();
  const profileEventsRef = useRef<ProfileEventsTableRef>(null);
  const [compareModalOpen, setCompareModalOpen] = useState(false);

  const totalPages = Math.ceil(totalCount / pageSize);
  const startRow = currentPage * pageSize + 1;
  const endRow = Math.min((currentPage + 1) * pageSize, totalCount);

  const activeFilterCount = countActiveFilters(fieldFilters, rangeFilters);

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <PageToolbar
        left={<>
          <FilterPanel />
          <TimeRangeSelector />
          <SearchBar />
        </>}
        right={<div className="flex items-center gap-4 text-xs">
          <span className="text-gray-400">
            Total: <span className="text-white font-medium">{totalCount.toLocaleString()}</span> queries
          </span>
          {activeFilterCount > 0 && (
            <span className="text-blue-400">
              {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active
            </span>
          )}
          {pinnedEntries.length > 0 && (
            <span className="flex items-center gap-1.5 text-blue-400">
              <Pin className="w-3 h-3 fill-current" />
              {pinnedEntries.length} pinned
              <button
                onClick={clearPinnedEntries}
                className="ml-1 p-0.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                title="Clear all pinned"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
        </div>}
      />

      {queryLogMissing ? (
        <EmptyState icon={Database} title="Query log not available">
          {missingTableMessage('system.query_log')}
        </EmptyState>
      ) : (
        <>
        {/* Timeline Chart */}
        <div className="px-1.5 pt-3 shrink-0">
          <TimelineChart />
        </div>

        {/* Tabs */}
        <PageTabs
          tabs={QUERY_TABS}
          active={activeTab}
          onChange={setActiveTab}
          right={(activeTab === 'queries' || activeTab === 'grouped' || activeTab === 'profileEvents') && (
            <div className="flex items-center gap-4">
              {activeTab === 'queries' && (
                <>
                  {selectedEntries.length >= 2 && (
                    <button
                      onClick={() => setCompareModalOpen(true)}
                      className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                      Compare ({selectedEntries.length})
                    </button>
                  )}
                  {selectedEntries.length === 1 && (
                    <span className="text-xs text-gray-400">Select 1 more to compare</span>
                  )}
                  {totalPages > 1 && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400">
                        {startRow.toLocaleString()}-{endRow.toLocaleString()} of {totalCount.toLocaleString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setCurrentPage(currentPage - 1)}
                          disabled={currentPage === 0}
                          className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Previous page"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-gray-300 px-2">
                          {currentPage + 1} / {totalPages}
                        </span>
                        <button
                          onClick={() => setCurrentPage(currentPage + 1)}
                          disabled={currentPage >= totalPages - 1}
                          className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Next page"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                  <ColumnSelector />
                </>
              )}
              {activeTab === 'grouped' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={normalizeQueries}
                    onChange={(e) => setNormalizeQueries(e.target.checked)}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                  />
                  <span className="text-xs text-gray-300">Normalise queries</span>
                </label>
              )}
              {activeTab === 'profileEvents' && (
                <>
                  <button
                    onClick={() => profileEventsRef.current?.openChart()}
                    className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
                    title="Chart profile events"
                  >
                    <BarChart2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => profileEventsRef.current?.openColumnSelector()}
                    className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
                    title="Select columns"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )}
        />

        {/* Main Content */}
        <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
          {activeTab === 'queries' && <QueryTable />}
          {activeTab === 'grouped' && <GroupedQueriesTable />}
          {activeTab === 'profileEvents' && <ProfileEventsTable ref={profileEventsRef} />}
          {activeTab === 'byTable' && <ByTableTable />}
          {activeTab === 'queryViewsLog' && <QueryViewsLogTable />}
          {activeTab === 'histograms' && <HistogramsTab />}
        </div>
        </>
      )}

      {/* Compare Modal */}
      {compareModalOpen && (
        <QueryCompareModal
          entries={selectedEntries}
          onClose={() => setCompareModalOpen(false)}
        />
      )}
    </div>
  );
}
