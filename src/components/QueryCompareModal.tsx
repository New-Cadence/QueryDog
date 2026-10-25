import { useState, useEffect, useMemo } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import type { QueryLogEntry } from '../types/queryLog';
import { formatBytes, formatNumber, formatDuration } from '../utils/formatters';
import { EmptyState } from './ui';

interface QueryCompareModalProps {
  entries: QueryLogEntry[];
  onClose: () => void;
}

// Color palette for query column headers
const HEADER_COLORS = [
  'text-blue-400',
  'text-green-400',
  'text-purple-400',
  'text-orange-400',
  'text-pink-400',
  'text-cyan-400',
  'text-yellow-400',
  'text-red-400',
  'text-indigo-400',
  'text-teal-400',
];

interface MetricConfig {
  field: string;
  label: string;
  format: (value: number) => string;
  higherIsBetter?: boolean;
}

const METRICS: MetricConfig[] = [
  { field: 'query_duration_ms', label: 'Duration', format: formatDuration, higherIsBetter: false },
  { field: 'memory_usage', label: 'Memory', format: formatBytes, higherIsBetter: false },
  { field: 'read_rows', label: 'Read Rows', format: formatNumber, higherIsBetter: false },
  { field: 'read_bytes', label: 'Read Bytes', format: formatBytes, higherIsBetter: false },
  { field: 'written_rows', label: 'Written Rows', format: formatNumber },
  { field: 'written_bytes', label: 'Written Bytes', format: formatBytes },
  { field: 'result_rows', label: 'Result Rows', format: formatNumber },
  { field: 'result_bytes', label: 'Result Bytes', format: formatBytes },
];

export function QueryCompareModal({ entries, onClose }: QueryCompareModalProps) {
  const [expandedSections, setExpandedSections] = useState({
    metrics: true,
    profileEvents: true,
    settings: false,
  });

  // Calculate column widths for consistent alignment across all tables
  const labelColWidth = entries.length <= 2 ? 'w-[500px]' : entries.length <= 4 ? 'w-[400px]' : 'w-[300px]';
  const queryColWidth = entries.length <= 2 ? 'w-[250px]' : entries.length <= 4 ? 'w-[200px]' : 'w-[150px]';

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Get all unique ProfileEvents keys across all entries
  const allProfileEvents = useMemo(() => {
    const eventSet = new Set<string>();
    entries.forEach(entry => {
      const events = (entry.ProfileEvents || {}) as Record<string, number>;
      Object.keys(events).forEach(key => eventSet.add(key));
    });
    return Array.from(eventSet).sort();
  }, [entries]);

  // Get all unique Settings keys across all entries
  const allSettings = useMemo(() => {
    const settingsSet = new Set<string>();
    entries.forEach(entry => {
      const settings = (entry.Settings || {}) as Record<string, string>;
      Object.keys(settings).forEach(key => settingsSet.add(key));
    });
    return Array.from(settingsSet).sort();
  }, [entries]);

  // Check if ProfileEvent values differ across queries
  const getProfileEventDiff = (eventName: string) => {
    const values = entries.map(entry => {
      const events = (entry.ProfileEvents || {}) as Record<string, number>;
      return events[eventName] ?? 0;
    });
    const allSame = values.every(v => v === values[0]);
    return { values, hasDiff: !allSame };
  };

  // Check if Setting values differ across queries
  const getSettingDiff = (settingName: string) => {
    const values = entries.map(entry => {
      const settings = (entry.Settings || {}) as Record<string, string>;
      return settings[settingName] ?? '';
    });
    const allSame = values.every(v => v === values[0]);
    return { values, hasDiff: !allSame };
  };

  // Filter to only show ProfileEvents with differences or non-zero values
  const profileEventsWithValues = useMemo(() => {
    return allProfileEvents.filter(eventName => {
      const { values } = getProfileEventDiff(eventName);
      return values.some(v => v !== 0);
    });
  }, [allProfileEvents, entries]);

  // Count ProfileEvents with differences
  const profileEventsWithDiffs = useMemo(() => {
    return profileEventsWithValues.filter(eventName => {
      const { hasDiff } = getProfileEventDiff(eventName);
      return hasDiff;
    });
  }, [profileEventsWithValues, entries]);

  // Filter to show settings that differ
  const settingsWithDiffs = useMemo(() => {
    return allSettings.filter(settingName => {
      const { hasDiff } = getSettingDiff(settingName);
      return hasDiff;
    });
  }, [allSettings, entries]);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Get min/max for a metric to highlight best/worst
  const getMetricMinMax = (field: string) => {
    const values = entries.map(e => Number(e[field]) || 0);
    return { min: Math.min(...values), max: Math.max(...values) };
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-[95vw] max-w-[1600px] max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-gray-700">
          <div>
            <h2 className="text-sm font-semibold text-white">Compare Queries</h2>
            <p className="text-xs text-gray-400">Comparing {entries.length} queries - differences highlighted in yellow</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {/* Performance Metrics Section */}
          <div className="mb-4">
            <button
              onClick={() => toggleSection('metrics')}
              className="flex items-center gap-1 text-xs font-semibold text-gray-400 mb-2 hover:text-white"
            >
              {expandedSections.metrics ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Performance Metrics
            </button>
            {expandedSections.metrics && (
              <div className="bg-gray-800 rounded overflow-y-auto">
                <table className="text-xs table-fixed w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="border-b border-gray-700">
                      <th className={`text-left p-1.5 text-gray-400 ${labelColWidth}`}>Metric</th>
                      {entries.map((entry, idx) => (
                        <th
                          key={idx}
                          className={`text-right p-1.5 ${HEADER_COLORS[idx % HEADER_COLORS.length]} ${queryColWidth}`}
                        >
                          Q{idx + 1}
                          <div className="text-[9px] text-gray-500 truncate" title={String(entry.query_id || '')}>
                            {String(entry.query_id || '').substring(0, 12)}...
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {METRICS.map(metric => {
                      const { min, max } = getMetricMinMax(metric.field);
                      const values = entries.map(e => Number(e[metric.field]) || 0);
                      const hasDiff = !values.every(v => v === values[0]);

                      return (
                        <tr key={metric.field} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                          <td className="p-1.5 text-blue-300 font-mono">{metric.label}</td>
                          {entries.map((entry, idx) => {
                            const value = Number(entry[metric.field]) || 0;
                            const isBest = metric.higherIsBetter !== undefined &&
                              (metric.higherIsBetter ? value === max : value === min) &&
                              hasDiff && min !== max;
                            const isWorst = metric.higherIsBetter !== undefined &&
                              (metric.higherIsBetter ? value === min : value === max) &&
                              hasDiff && min !== max;

                            return (
                              <td
                                key={idx}
                                className={`p-1.5 text-right font-mono ${
                                  isBest ? 'text-green-400' :
                                  isWorst ? 'text-red-400' :
                                  'text-green-300'
                                }`}
                              >
                                {metric.format(value)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ProfileEvents Section */}
          <div className="mb-4">
            <button
              onClick={() => toggleSection('profileEvents')}
              className="flex items-center gap-1 text-xs font-semibold text-gray-400 mb-2 hover:text-white"
            >
              {expandedSections.profileEvents ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              ProfileEvents ({profileEventsWithDiffs.length} different, {profileEventsWithValues.length} with values)
            </button>
            {expandedSections.profileEvents && (
              <div className="bg-gray-800 rounded max-h-80 overflow-y-auto">
                <table className="text-xs table-fixed w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="border-b border-gray-700">
                      <th className={`text-left p-1.5 text-gray-400 ${labelColWidth}`}>Event</th>
                      {entries.map((entry, idx) => (
                        <th
                          key={idx}
                          className={`text-right p-1.5 ${HEADER_COLORS[idx % HEADER_COLORS.length]} ${queryColWidth}`}
                        >
                          Q{idx + 1}
                          <div className="text-[9px] text-gray-500 truncate" title={String(entry.query_id || '')}>
                            {String(entry.query_id || '').substring(0, 12)}...
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {profileEventsWithValues.map(eventName => {
                      const { values } = getProfileEventDiff(eventName);
                      const isBytes = eventName.toLowerCase().includes('bytes');

                      return (
                        <tr key={eventName} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                          <td className="p-1.5 text-blue-300 font-mono">{eventName}</td>
                          {values.map((value, idx) => (
                            <td key={idx} className="p-1.5 text-right text-green-300 font-mono">
                              {isBytes ? formatBytes(value) : formatNumber(value)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Settings Section */}
          <div className="mb-4">
            <button
              onClick={() => toggleSection('settings')}
              className="flex items-center gap-1 text-xs font-semibold text-gray-400 mb-2 hover:text-white"
            >
              {expandedSections.settings ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Settings ({settingsWithDiffs.length} different, {allSettings.length} total)
            </button>
            {expandedSections.settings && (
              <div className="bg-gray-800 rounded max-h-80 overflow-y-auto">
                {allSettings.length === 0 ? (
                  <EmptyState compact title="No settings recorded" />
                ) : (
                  <table className="text-xs table-fixed w-full">
                    <thead className="sticky top-0 bg-gray-800">
                      <tr className="border-b border-gray-700">
                        <th className={`text-left p-1.5 text-gray-400 ${labelColWidth}`}>Setting</th>
                        {entries.map((entry, idx) => (
                          <th
                            key={idx}
                            className={`text-right p-1.5 ${HEADER_COLORS[idx % HEADER_COLORS.length]} ${queryColWidth}`}
                          >
                            Q{idx + 1}
                            <div className="text-[9px] text-gray-500 truncate" title={String(entry.query_id || '')}>
                              {String(entry.query_id || '').substring(0, 12)}...
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allSettings.map(settingName => {
                        const { values } = getSettingDiff(settingName);

                        return (
                          <tr key={settingName} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="p-1.5 text-blue-300 font-mono">{settingName}</td>
                            {values.map((value, idx) => (
                              <td key={idx} className="p-1.5 text-right text-green-300 font-mono truncate" title={value}>
                                {value || <span className="text-gray-500">-</span>}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
