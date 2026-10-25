import { useState, useEffect } from 'react';
import { Database, Table, Loader2, AlertCircle, Play, X, ChevronDown, ChevronRight, BarChart3 } from 'lucide-react';
import { fetchBrowserDatabases, fetchBrowserTables, fetchBrowserColumns, type BrowserDatabase, type BrowserTable, type BrowserColumn } from '../../services/api';
import { formatNumber, formatDuration } from '../../utils/formatters';
import { LoadingState, EmptyState } from '../ui';

interface ExploreResult {
  columns: string[];
  data: Record<string, unknown>[];
  rowCount: number;
  duration: number;
}

interface ColumnProfile {
  column: string;
  type: string | null;
  total: number;
  nullCount: number;
  nullPercent: string;
  cardinality: number;
  cardinalityPercent: string;
  min: unknown;
  max: unknown;
  avg: unknown;
  topValues: { value: string; count: number }[];
  error?: string;
}

interface ProfileResult {
  database: string;
  table: string;
  totalRows: number;
  sampleSize: number;
  profiles: ColumnProfile[];
}

async function exploreTableData(
  database: string,
  table: string,
  selectedColumns: string[],
  groupByColumns: string[],
  limit: number
): Promise<ExploreResult> {
  const response = await fetch('/api/explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ database, table, selectedColumns, groupByColumns, limit }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to explore table data');
  }

  return response.json();
}

async function profileTable(
  database: string,
  table: string,
  columns: { name: string; type: string }[]
): Promise<ProfileResult> {
  const response = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ database, table, columns }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to profile table');
  }

  return response.json();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') {
    return value.toLocaleString();
  }
  return String(value);
}

interface DataExplorerPageProps {
  onClose?: () => void;
}

export function DataExplorerPage({ onClose }: DataExplorerPageProps) {
  const [databases, setDatabases] = useState<BrowserDatabase[]>([]);
  const [tables, setTables] = useState<BrowserTable[]>([]);
  const [columns, setColumns] = useState<BrowserColumn[]>([]);

  const [selectedDatabase, setSelectedDatabase] = useState<string>('');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [groupByColumns, setGroupByColumns] = useState<string[]>([]);
  const [limit, setLimit] = useState<number>(100);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExploreResult | null>(null);

  const [showResults, setShowResults] = useState(true);
  const [showProfile, setShowProfile] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileResult, setProfileResult] = useState<ProfileResult | null>(null);

  // Add CSS for styling select dropdowns
  useEffect(() => {
    const styleId = 'data-explorer-select-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        select.data-explorer-select option {
          background-color: #111827;
          color: #d1d5db;
          padding: 8px 12px;
        }
        select.data-explorer-select option:checked {
          background: linear-gradient(0deg, #3b82f6 0%, #3b82f6 100%);
          color: white;
          font-weight: 500;
        }
      `;
      document.head.appendChild(style);
    }
    return () => {
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, []);

  // Load databases on mount
  useEffect(() => {
    fetchBrowserDatabases()
      .then(setDatabases)
      .catch(err => setError(err.message));
  }, []);

  // Load tables when database changes
  useEffect(() => {
    if (!selectedDatabase) {
      setTables([]);
      setSelectedTable('');
      return;
    }

    fetchBrowserTables(selectedDatabase)
      .then(setTables)
      .catch(err => setError(err.message));
  }, [selectedDatabase]);

  // Load columns when table changes
  useEffect(() => {
    if (!selectedDatabase || !selectedTable) {
      setColumns([]);
      setSelectedColumns([]);
      setGroupByColumns([]);
      return;
    }

    // Clear previous state when switching tables
    setColumns([]);
    setSelectedColumns([]);
    setGroupByColumns([]);
    setError(null);
    setResult(null);
    setProfileResult(null);

    fetchBrowserColumns(selectedDatabase, selectedTable)
      .then(cols => {
        // Sort columns: PK first, then sort key, then others
        const sortedCols = [...cols].sort((a, b) => {
          const aIsPK = a.is_in_primary_key === 1;
          const bIsPK = b.is_in_primary_key === 1;
          const aIsSort = a.is_in_sorting_key === 1;
          const bIsSort = b.is_in_sorting_key === 1;

          if (aIsPK && !bIsPK) return -1;
          if (!aIsPK && bIsPK) return 1;
          if (aIsSort && !bIsSort) return -1;
          if (!aIsSort && bIsSort) return 1;
          return 0;
        });

        setColumns(sortedCols);
        // Auto-select all columns by default
        setSelectedColumns(sortedCols.map(c => c.name));
      })
      .catch(err => setError(err.message));
  }, [selectedDatabase, selectedTable]);

  const handleExplore = async () => {
    if (!selectedDatabase || !selectedTable) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setProfileResult(null);
    setProfileError(null);

    try {
      // Fetch data and profile in parallel
      const [exploreRes] = await Promise.all([
        exploreTableData(
          selectedDatabase,
          selectedTable,
          selectedColumns.length > 0 ? selectedColumns : columns.map(c => c.name),
          groupByColumns,
          limit
        ),
      ]);
      setResult(exploreRes);

      // Start profile loading
      setProfileLoading(true);
      try {
        const colsForProfile = columns.map(c => ({ name: c.name, type: c.type }));
        const profileRes = await profileTable(selectedDatabase, selectedTable, colsForProfile);
        setProfileResult(profileRes);
      } catch (profErr) {
        setProfileError(profErr instanceof Error ? profErr.message : 'Failed to profile table');
      } finally {
        setProfileLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to explore data');
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <div className={`bg-gray-900 border border-gray-700 rounded-lg overflow-hidden flex flex-col ${onClose ? 'w-[95vw] h-[90vh]' : 'w-full h-full'}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-3">
          <Table className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-semibold text-white">Data Explorer</h2>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Selection Controls */}
      <div className="p-4 border-b border-gray-700 shrink-0">
        <div className="grid grid-cols-4 gap-3">
          {/* Database Selector */}
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">Database</label>
            <div className="relative">
              <Database className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-blue-400 pointer-events-none z-10" />
              <select
                value={selectedDatabase}
                onChange={(e) => setSelectedDatabase(e.target.value)}
                className="data-explorer-select w-full pl-10 pr-8 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-gray-300 font-medium shadow-sm appearance-none cursor-pointer
                  hover:bg-gray-750 hover:border-blue-500 hover:text-white
                  focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 focus:text-white
                  transition-all duration-150"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.5rem center',
                  backgroundSize: '1.25rem'
                }}
              >
                <option value="">Select database...</option>
                {databases.map(db => (
                  <option key={db.name} value={db.name}>{db.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Table Selector */}
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">Table</label>
            <div className="relative">
              <Table className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-blue-400 pointer-events-none z-10" />
              <select
                value={selectedTable}
                onChange={(e) => setSelectedTable(e.target.value)}
                disabled={!selectedDatabase}
                className="data-explorer-select w-full pl-10 pr-8 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-gray-300 font-medium shadow-sm appearance-none
                  enabled:cursor-pointer enabled:hover:bg-gray-750 enabled:hover:border-blue-500 enabled:hover:text-white
                  focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 focus:text-white
                  disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-900/50
                  transition-all duration-150"
                style={{
                  backgroundImage: selectedDatabase ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")` : 'none',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.5rem center',
                  backgroundSize: '1.25rem'
                }}
              >
                <option value="">Select table...</option>
                {tables.map(tbl => (
                  <option key={tbl.name} value={tbl.name}>{tbl.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Limit */}
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">Limit</label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Math.min(10000, Math.max(1, parseInt(e.target.value) || 100)))}
              min="1"
              max="10000"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Execute Button */}
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">&nbsp;</label>
            <button
              onClick={handleExplore}
              disabled={!selectedDatabase || !selectedTable || loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-white text-sm font-medium"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Explore
            </button>
          </div>
        </div>
      </div>

      {/* Results and Profile Panels */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Results Panel */}
        <div className="flex-1 min-h-0 flex flex-col border-b border-gray-700 overflow-hidden">
          <button
            onClick={() => setShowResults(!showResults)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-300 text-xs font-medium hover:bg-gray-750 shrink-0"
          >
            {showResults ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Results
            {result && (
              <span className="text-gray-500 ml-2">
                {result.rowCount.toLocaleString()} rows in {formatDuration(result.duration)}
              </span>
            )}
          </button>

          {showResults && (
            <div className="flex-1 overflow-hidden p-2">
              {/* Error Display */}
              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Loading State */}
              {loading && (
                <LoadingState label="Running query…" />
              )}

              {/* Empty State */}
              {!loading && !error && !result && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
                  <Table className="w-12 h-12 opacity-50" />
                  <p className="text-sm">Select a database and table, then click Explore</p>
                </div>
              )}

              {/* Results Table */}
              {!loading && !error && result && result.data.length > 0 && (
                <div className="h-full overflow-auto border border-gray-700 rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800 sticky top-0 z-10">
                      <tr>
                        {result.columns.map(col => (
                          <th key={col} className="px-3 py-2 text-left text-gray-400 font-medium border-b border-gray-700 whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.map((row, idx) => (
                        <tr
                          key={idx}
                          className={`border-b border-gray-800 hover:bg-gray-800/50 ${
                            idx % 2 === 0 ? 'bg-gray-900/30' : ''
                          }`}
                        >
                          {result.columns.map(col => (
                            <td
                              key={col}
                              className="px-3 py-2 text-gray-300 font-mono whitespace-nowrap max-w-[300px] truncate"
                              title={formatValue(row[col])}
                            >
                              {formatValue(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* No Results */}
              {!loading && !error && result && result.data.length === 0 && (
                <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                  Query returned no results
                </div>
              )}
            </div>
          )}
        </div>

        {/* Profile Panel */}
        <div
          className={`flex flex-col overflow-hidden border-t border-gray-700 ${
            showProfile ? 'h-[35vh] min-h-[200px] max-h-[400px]' : ''
          }`}
        >
          <button
            onClick={() => setShowProfile(!showProfile)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-300 text-xs font-medium hover:bg-gray-750 shrink-0"
          >
            {showProfile ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <BarChart3 className="w-3 h-3" />
            Profile
            {profileResult && (
              <span className="text-gray-500 ml-2">
                {profileResult.profiles.length} columns | {formatNumber(profileResult.totalRows)} total rows
              </span>
            )}
          </button>

          {showProfile && (
            <div className="flex-1 overflow-auto p-2">
              {!result && !profileLoading && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm gap-2">
                  <BarChart3 className="w-8 h-8 opacity-50" />
                  <p>Explore data to see column profiles</p>
                </div>
              )}

              {profileLoading && (
                <LoadingState label="Profiling…" />
              )}

              {profileError && (
                <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{profileError}</span>
                </div>
              )}

              {profileResult && !profileLoading && (
                <div className="grid grid-cols-3 gap-3">
                  {profileResult.profiles.map((profile) => {
                    const COLORS = ['#7dd3fc', '#38bdf8', '#60a5fa', '#93c5fd', '#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#228be6', '#1c7ed6'];
                    const maxCount = profile.topValues && profile.topValues.length > 0
                      ? Math.max(...profile.topValues.map(tv => tv.count), 1)
                      : 1;

                    return (
                      <div key={profile.column} className="bg-gray-900 border border-gray-700 rounded p-3 h-[300px] flex flex-col">
                        {/* Header */}
                        <div className="mb-3 shrink-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-xs font-semibold text-gray-400 truncate" title={profile.column}>
                              {profile.column}
                            </h3>
                            <span className="text-[10px] text-gray-600 font-mono">{profile.type}</span>
                          </div>
                          <div className="flex items-center gap-3 text-[10px]">
                            <span className="text-gray-500">
                              Cardinality: <span className="text-gray-300">{formatNumber(profile.cardinality)}</span>
                              <span className="text-gray-600"> ({profile.cardinalityPercent}%)</span>
                            </span>
                            <span className="text-gray-500">
                              Nulls: <span className={parseFloat(profile.nullPercent) > 50 ? 'text-yellow-400' : 'text-gray-300'}>{profile.nullPercent}%</span>
                            </span>
                          </div>
                        </div>

                        {/* Horizontal Histogram Bars */}
                        <div className="flex-1 overflow-hidden">
                          {profile.topValues && profile.topValues.length > 0 ? (
                            <div className="space-y-1">
                              {profile.topValues.slice(0, 10).map((item, index) => {
                                const widthPercent = (item.count / maxCount) * 100;
                                const displayName = item.value || '(empty)';
                                const truncatedName = displayName.length > 14 ? displayName.substring(0, 14) + '...' : displayName;

                                return (
                                  <div
                                    key={index}
                                    className="flex items-center gap-2 hover:bg-gray-800/50 rounded px-1 py-0.5"
                                    title={`${item.value}: ${item.count.toLocaleString()}`}
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
                          ) : (
                            <EmptyState compact title="No data" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // If onClose is provided, render as a modal
  if (onClose) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
        <div onClick={(e) => e.stopPropagation()}>
          {content}
        </div>
      </div>
    );
  }

  // Otherwise render inline
  return <div className="h-full py-3">{content}</div>;
}
