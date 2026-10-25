import { useState, useEffect } from 'react';
import { useQueryStore } from '../stores/queryStore';
import { fetchPartLogHistogram } from '../services/api';
import type { HistogramData } from '../types/queryLog';
import { LoadingState, EmptyState } from './ui';

const COLORS = ['#7dd3fc', '#38bdf8', '#60a5fa', '#93c5fd', '#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#228be6', '#1c7ed6'];

const PART_LOG_HISTOGRAM_FIELDS = [
  { field: 'table', label: 'Table' },
  { field: 'event_type', label: 'Event Type' },
  { field: 'merge_reason', label: 'Merge Reason' },
];

interface HistogramCardProps {
  field: string;
  label: string;
  data: HistogramData[];
  loading: boolean;
  onFilterClick: (field: string, value: string) => void;
}

const MAX_ITEMS = 10;

function HistogramCard({ field, label, data, loading, onFilterClick }: HistogramCardProps) {
  const displayData = data.slice(0, MAX_ITEMS);
  const maxCount = Math.max(...displayData.map(d => d.count), 1);

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded p-3 h-[300px]">
        <h3 className="text-xs font-semibold text-gray-400 mb-2">{label}</h3>
        <div className="h-[250px] flex"><LoadingState /></div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded p-3 h-[300px]">
        <h3 className="text-xs font-semibold text-gray-400 mb-2">{label}</h3>
        <EmptyState compact title="No data" />
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 h-[300px]">
      <h3 className="text-xs font-semibold text-gray-400 mb-3">{label}</h3>
      <div className="space-y-1">
        {displayData.map((item, index) => {
          const widthPercent = (item.count / maxCount) * 100;
          const displayName = String(item.name || '(empty)');
          const truncatedName = displayName.length > 14 ? displayName.substring(0, 14) + '...' : displayName;

          return (
            <div
              key={index}
              className="flex items-center gap-2 cursor-pointer hover:bg-gray-800/50 rounded px-1 py-0.5"
              onClick={() => onFilterClick(field, item.name)}
              title={displayName}
            >
              <span className="text-[10px] text-gray-300 w-20 truncate text-right flex-shrink-0">
                {truncatedName}
              </span>
              <div className="flex-1 h-4 bg-gray-800 rounded overflow-hidden">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${widthPercent}%`,
                    backgroundColor: COLORS[index % COLORS.length],
                  }}
                />
              </div>
              <span className="text-[10px] text-gray-400 w-12 text-right flex-shrink-0">
                {item.count.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PartLogHistogramsTab() {
  const { timeRange, partLogFieldFilters, setPartLogFieldFilter } = useQueryStore();
  const [histogramData, setHistogramData] = useState<Record<string, HistogramData[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const loadHistograms = async () => {
      const newLoading: Record<string, boolean> = {};
      PART_LOG_HISTOGRAM_FIELDS.forEach((f) => (newLoading[f.field] = true));
      setLoading(newLoading);

      const results: Record<string, HistogramData[]> = {};

      await Promise.all(
        PART_LOG_HISTOGRAM_FIELDS.map(async ({ field }) => {
          try {
            const data = await fetchPartLogHistogram(field, timeRange, partLogFieldFilters);
            results[field] = data;
          } catch (error) {
            console.error(`Failed to load histogram for ${field}:`, error);
            results[field] = [];
          }
        })
      );

      setHistogramData(results);
      setLoading({});
    };

    loadHistograms();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange.start.getTime(), timeRange.end.getTime(), partLogFieldFilters]);

  const handleFilterClick = (field: string, value: string) => {
    const current = partLogFieldFilters[field] || [];
    if (!current.includes(value)) {
      setPartLogFieldFilter(field, [...current, value]);
    }
  };

  return (
    <div className="p-3 overflow-auto h-full">
      <div className="grid grid-cols-3 gap-3">
        {PART_LOG_HISTOGRAM_FIELDS.map(({ field, label }) => (
          <HistogramCard
            key={field}
            field={field}
            label={label}
            data={histogramData[field] || []}
            loading={loading[field] || false}
            onFilterClick={handleFilterClick}
          />
        ))}
      </div>
    </div>
  );
}
