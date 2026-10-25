import { useState, useEffect } from 'react';
import { Filter, X, ChevronDown, ChevronRight } from 'lucide-react';
import { useQueryStore, countActiveFilters } from '../stores/queryStore';
import { fetchDistinctValues } from '../services/api';
import { formatBytes, formatDuration } from '../utils/formatters';
import { LoadingState } from './ui';

// Range filter configuration
const RANGE_FILTERS = [
  { field: 'query_duration_ms', label: 'Duration', unit: 'ms', presets: [100, 500, 1000, 5000, 10000] },
  { field: 'memory_usage', label: 'Memory', unit: 'bytes', presets: [1048576, 10485760, 104857600, 1073741824] }, // 1MB, 10MB, 100MB, 1GB
];

// Include both scalar and array fields for filtering
const FILTERABLE_FIELDS = [
  { field: 'client_name', label: 'Client Name', isArray: false },
  { field: 'user', label: 'User', isArray: false },
  { field: 'type', label: 'Query Type', isArray: false },
  { field: 'query_kind', label: 'Query Kind', isArray: false },
  { field: 'current_database', label: 'Database', isArray: false },
  { field: 'client_hostname', label: 'Client Hostname', isArray: false },
  { field: 'databases', label: 'Databases (used)', isArray: true },
  { field: 'tables', label: 'Tables (used)', isArray: true },
  { field: 'used_functions', label: 'Functions', isArray: true },
  { field: 'used_aggregate_functions', label: 'Aggregate Functions', isArray: true },
  { field: 'used_table_functions', label: 'Table Functions', isArray: true },
];

const FILTERABLE_FIELD_NAMES = new Set(FILTERABLE_FIELDS.map((f) => f.field));

// Filters set from elsewhere in the UI (e.g. "List All" on a grouped query)
// that have no picker of their own; listed so they can be seen and cleared.
const HIDDEN_FILTER_LABELS: Record<string, string> = {
  query: 'Exact Query',
  normalized_query_hash: 'Query Pattern',
  primary_table: 'Primary Table',
};

// Range inputs only accept whole, non-negative numbers (the server binds them as UInt64)
function parseRangeInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

// Keep currently selected values visible even when they fall outside the
// loaded distinct values, so they can always be unticked.
function withSelected(values: string[], selected: string[]): string[] {
  const missing = selected.filter((v) => !values.includes(v));
  return missing.length ? [...missing, ...values] : values;
}

export function FilterPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string[]>>({});
  const [loadingField, setLoadingField] = useState<string | null>(null);
  const { timeRange, fieldFilters, rangeFilters, setFieldFilter, setRangeFilter, clearFieldFilter, clearRangeFilter, clearAllFilters } = useQueryStore();

  const activeFilterCount = countActiveFilters(fieldFilters, rangeFilters);
  const hiddenFilters = Object.entries(fieldFilters).filter(([field, values]) => !FILTERABLE_FIELD_NAMES.has(field) && values.length > 0);

  const loadFieldValues = async (field: string) => {
    if (fieldValues[field]) return;

    setLoadingField(field);
    try {
      // Offer values from at least the last 24 hours so options aren't limited by a
      // narrow selection, while still covering the whole range when it is wider or older
      const now = Date.now();
      const widerTimeRange = {
        start: new Date(Math.min(timeRange.start.getTime(), now - 24 * 60 * 60 * 1000)),
        end: new Date(Math.max(timeRange.end.getTime(), now)),
      };
      const values = await fetchDistinctValues(field, widerTimeRange);
      setFieldValues((prev) => ({ ...prev, [field]: values }));
    } catch (error) {
      console.error('Failed to load field values:', error);
    } finally {
      setLoadingField(null);
    }
  };

  const toggleField = (field: string) => {
    if (expandedField === field) {
      setExpandedField(null);
    } else {
      setExpandedField(field);
      loadFieldValues(field);
    }
  };

  const toggleValue = (field: string, value: string) => {
    const current = fieldFilters[field] || [];
    if (current.includes(value)) {
      setFieldFilter(field, current.filter((v) => v !== value));
    } else {
      setFieldFilter(field, [...current, value]);
    }
  };

  // Clear cached values when panel opens to get fresh data
  useEffect(() => {
    if (isOpen) {
      setFieldValues({});
    }
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
          activeFilterCount > 0 ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
        }`}
      >
        <Filter className="w-3 h-3" />
        <span>Filters</span>
        {activeFilterCount > 0 && (
          <span className="bg-white/20 px-1 rounded text-xs">{activeFilterCount}</span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[280px]">
            <div className="flex items-center justify-between p-2 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-300">Filters</span>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <button
                    onClick={clearAllFilters}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Clear all
                  </button>
                )}
                <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {hiddenFilters.map(([field, values]) => (
                <div key={field} className="flex items-center justify-between gap-2 p-2 border-b border-gray-700/50">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-300">{HIDDEN_FILTER_LABELS[field] || field}</div>
                    <div className="text-[10px] text-gray-500 font-mono truncate max-w-[220px]" title={values.join(', ')}>
                      {values.join(', ')}
                    </div>
                  </div>
                  <button onClick={() => clearFieldFilter(field)} className="text-xs text-red-400 hover:text-red-300 shrink-0">
                    Clear
                  </button>
                </div>
              ))}

              {/* Range Filters */}
              {RANGE_FILTERS.map(({ field, label, unit, presets }) => {
                const rangeFilter = rangeFilters[field] || {};
                const isExpanded = expandedField === field;
                const hasFilter = rangeFilter.min !== undefined || rangeFilter.max !== undefined;

                return (
                  <div key={field} className="border-b border-gray-700/50">
                    <button
                      onClick={() => setExpandedField(isExpanded ? null : field)}
                      className="w-full flex items-center justify-between p-2 hover:bg-gray-700/50"
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-gray-400" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-gray-400" />
                        )}
                        <span className="text-xs text-gray-300">{label}</span>
                        <span className="text-[9px] text-gray-500 bg-gray-700 px-1 rounded">range</span>
                      </div>
                      {hasFilter && (
                        <span className="bg-blue-600 px-1.5 py-0.5 rounded text-xs text-white">
                          {rangeFilter.min !== undefined && rangeFilter.max !== undefined
                            ? `${unit === 'bytes' ? formatBytes(rangeFilter.min) : formatDuration(rangeFilter.min)} - ${unit === 'bytes' ? formatBytes(rangeFilter.max) : formatDuration(rangeFilter.max)}`
                            : rangeFilter.min !== undefined
                            ? `≥ ${unit === 'bytes' ? formatBytes(rangeFilter.min) : formatDuration(rangeFilter.min)}`
                            : `≤ ${unit === 'bytes' ? formatBytes(rangeFilter.max!) : formatDuration(rangeFilter.max!)}`}
                        </span>
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-2 pb-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-8">Min:</span>
                          <input
                            type="number"
                            value={rangeFilter.min ?? ''}
                            min={0}
                            step={1}
                            onChange={(e) => setRangeFilter(field, { ...rangeFilter, min: parseRangeInput(e.target.value) })}
                            className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
                            placeholder={unit === 'bytes' ? 'bytes' : 'ms'}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-8">Max:</span>
                          <input
                            type="number"
                            value={rangeFilter.max ?? ''}
                            min={0}
                            step={1}
                            onChange={(e) => setRangeFilter(field, { ...rangeFilter, max: parseRangeInput(e.target.value) })}
                            className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
                            placeholder={unit === 'bytes' ? 'bytes' : 'ms'}
                          />
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {presets.map((preset) => (
                            <button
                              key={preset}
                              onClick={() => setRangeFilter(field, { ...rangeFilter, min: preset })}
                              className="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                            >
                              ≥ {unit === 'bytes' ? formatBytes(preset) : formatDuration(preset)}
                            </button>
                          ))}
                        </div>
                        {hasFilter && (
                          <button
                            onClick={() => clearRangeFilter(field)}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Value Filters */}
              {FILTERABLE_FIELDS.map(({ field, label, isArray }) => {
                const selectedValues = fieldFilters[field] || [];
                const isExpanded = expandedField === field;
                const values = withSelected(fieldValues[field] || [], selectedValues);

                return (
                  <div key={field} className="border-b border-gray-700/50 last:border-0">
                    <button
                      onClick={() => toggleField(field)}
                      className="w-full flex items-center justify-between p-2 hover:bg-gray-700/50"
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-gray-400" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-gray-400" />
                        )}
                        <span className="text-xs text-gray-300">{label}</span>
                        {isArray && (
                          <span className="text-[9px] text-gray-500 bg-gray-700 px-1 rounded">array</span>
                        )}
                      </div>
                      {selectedValues.length > 0 && (
                        <span className="bg-blue-600 px-1.5 py-0.5 rounded text-xs text-white">
                          {selectedValues.length}
                        </span>
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-2 pb-2">
                        {loadingField === field ? (
                          <LoadingState compact />
                        ) : values.length === 0 ? (
                          <div className="text-xs text-gray-400 py-2 text-center">No values</div>
                        ) : (
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {values.map((value) => (
                              <label
                                key={value}
                                className="flex items-center gap-2 p-1 hover:bg-gray-700 rounded cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedValues.includes(value)}
                                  onChange={() => toggleValue(field, value)}
                                  className="w-3 h-3 rounded border-gray-500 bg-gray-700 text-blue-500"
                                />
                                <span className="text-xs text-gray-300 truncate" title={value}>
                                  {value || '(empty)'}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                        {selectedValues.length > 0 && (
                          <button
                            onClick={() => clearFieldFilter(field)}
                            className="mt-1 text-xs text-red-400 hover:text-red-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
