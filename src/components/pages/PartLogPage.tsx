import { FileText, ChevronLeft, ChevronRight, BarChart2 } from 'lucide-react';
import { PartLogTable } from '../PartLogTable';
import { PartLogColumnSelector } from '../PartLogColumnSelector';
import { PartLogFilterPanel } from '../PartLogFilterPanel';
import { TimeRangeSelector } from '../TimeRangeSelector';
import { PartLogTimelineChart } from '../PartLogTimelineChart';
import { PartLogHistogramsTab } from '../PartLogHistogramsTab';
import { useQueryStore } from '../../stores/queryStore';
import { useState } from 'react';

type PartLogTab = 'partlog' | 'histograms';

export function PartLogPage() {
  const {
    partLogTotalCount,
    partLogFieldFilters,
    partLogPageSize,
    partLogCurrentPage,
    setPartLogCurrentPage,
  } = useQueryStore();
  const [activeTab, setActiveTab] = useState<PartLogTab>('partlog');

  // Part Log pagination
  const partLogTotalPages = Math.ceil(partLogTotalCount / partLogPageSize);
  const partLogStartRow = partLogCurrentPage * partLogPageSize + 1;
  const partLogEndRow = Math.min((partLogCurrentPage + 1) * partLogPageSize, partLogTotalCount);
  const activeFilterCount = Object.values(partLogFieldFilters).filter((v) => v.length > 0).length;

  const tabs: { id: PartLogTab; label: string; icon: typeof FileText }[] = [
    { id: 'partlog', label: 'Part Log', icon: FileText },
    { id: 'histograms', label: 'Histograms', icon: BarChart2 },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="bg-gray-900/50 border-b border-gray-700 px-1.5 h-9 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <PartLogFilterPanel />
          <TimeRangeSelector usePartLogMetric />
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-gray-400">
            Total: <span className="text-white font-medium">{partLogTotalCount.toLocaleString()}</span> events
          </span>
          {activeFilterCount > 0 && (
            <span className="text-blue-400">
              {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active
            </span>
          )}
        </div>
      </div>

      {/* Timeline Chart */}
      <div className="px-1.5 pt-3 shrink-0">
        <PartLogTimelineChart />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700 px-1.5 pt-3 flex items-center gap-1 shrink-0">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
        {activeTab === 'partlog' && (
          <div className="ml-auto flex items-center gap-4">
            {partLogTotalPages > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">
                  {partLogStartRow.toLocaleString()}-{partLogEndRow.toLocaleString()} of {partLogTotalCount.toLocaleString()}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPartLogCurrentPage(partLogCurrentPage - 1)}
                    disabled={partLogCurrentPage === 0}
                    className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Previous page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-gray-300 px-2">
                    {partLogCurrentPage + 1} / {partLogTotalPages}
                  </span>
                  <button
                    onClick={() => setPartLogCurrentPage(partLogCurrentPage + 1)}
                    disabled={partLogCurrentPage >= partLogTotalPages - 1}
                    className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Next page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
            <PartLogColumnSelector />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
        {activeTab === 'partlog' && <PartLogTable />}
        {activeTab === 'histograms' && <PartLogHistogramsTab />}
      </div>
    </div>
  );
}
