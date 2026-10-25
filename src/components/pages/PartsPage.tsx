import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { HardDrive, ChevronLeft, ChevronRight, Layers, Grid3X3, BarChart2, Settings, X, Eye, Search, Sparkles, Zap, Server, Loader2, FileCode, BookOpen } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, FirstDataRenderedEvent } from 'ag-grid-community';
import { SystemTable, type SystemTableRef } from '../SystemTable';
import { PartsFilterPanel } from '../PartsFilterPanel';
import { PartsHistogramsTab } from '../PartsHistogramsTab';
import { ProjectionsTab } from '../ProjectionsTab';
import { DataSkippingIndexesTab } from '../DataSkippingIndexesTab';
import { ViewsTab } from '../ViewsTab';
import { DictionariesTab } from '../DictionariesTab';
import { fetchParts, fetchPartsColumns, fetchPartsCount, fetchPartitionsSummary, fetchPartitionsSummaryColumns, fetchPartitionsSummaryCount, fetchGroupedParts, fetchTablePartitions, fetchPartitionParts, fetchTableCompression, fetchBrowserColumns, fetchBrowserSampleData, fetchBrowserTables, fetchMergeTreeIndex, fetchTableDefinition, fetchDatabasesSummary, type GroupedPartsEntry, type TablePartitionEntry, type PartitionPartEntry, type ColumnCompressionEntry, type BrowserColumn, type BrowserTable, type MergeTreeIndexEntry, type DatabaseSummary } from '../../services/api';
import { useQueryStore } from '../../stores/queryStore';
import { useGridTheme } from '../../hooks/useTheme';
import { formatBytes, formatNumber, parseServerTime, formatDateTime, formatDate } from '../../utils/formatters';
import { LoadingState, EmptyState } from '../ui';
import { GRID_OVERLAYS } from '../gridOverlays';

ModuleRegistry.registerModules([AllCommunityModule]);

type PartsTab = 'databases' | 'parts' | 'partitions' | 'grouped' | 'views' | 'dictionaries' | 'projections' | 'secondary-indexes' | 'histograms';

const PARTS_DEFAULT_VISIBLE_FIELDS = [
  'database',
  'table',
  'partition',
  'name',
  'rows',
  'bytes_on_disk',
  'data_compressed_bytes',
  'modification_time',
  'active',
  'marks',
];

// Numeric comparator for AG Grid sorting - handles null values and ensures numeric sorting
function numericComparator(valueA: unknown, valueB: unknown): number {
  const a = valueA === null || valueA === undefined ? null : Number(valueA);
  const b = valueB === null || valueB === undefined ? null : Number(valueB);
  if (a === null && b === null) return 0;
  if (a === null) return 1;  // nulls go to bottom
  if (b === null) return -1;
  if (isNaN(a) && isNaN(b)) return 0;
  if (isNaN(a)) return 1;
  if (isNaN(b)) return -1;
  return a - b;
}

export function PartsPage() {
  const gridTheme = useGridTheme();
  const {
    partsTotalCount,
    partsPageSize,
    partsCurrentPage,
    setPartsTotalCount,
    setPartsCurrentPage,
    partitionsTotalCount,
    partitionsPageSize,
    partitionsCurrentPage,
    setPartitionsTotalCount,
    setPartitionsCurrentPage,
    setHasPartsAccess,
  } = useQueryStore();
  const [activeTab, setActiveTab] = useState<PartsTab>('databases');
  const [databasesData, setDatabasesData] = useState<DatabaseSummary[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [groupedData, setGroupedData] = useState<GroupedPartsEntry[]>([]);
  const [groupedLoading, setGroupedLoading] = useState(false);
  const partsTableRef = useRef<SystemTableRef>(null);
  const partitionsTableRef = useRef<SystemTableRef>(null);
  const [partsColumnSelectorOpen, setPartsColumnSelectorOpen] = useState(false);
  const [partitionsColumnSelectorOpen, setPartitionsColumnSelectorOpen] = useState(false);
  const [groupedColumnSelectorOpen, setGroupedColumnSelectorOpen] = useState(false);
  const [databasesColumnSelectorOpen, setDatabasesColumnSelectorOpen] = useState(false);

  // Hidden columns state for AG Grid tables
  const [groupedHiddenColumns, setGroupedHiddenColumns] = useState<Set<string>>(new Set());
  const [databasesHiddenColumns, setDatabasesHiddenColumns] = useState<Set<string>>(new Set());

  // Search state
  const [partsSearch, setPartsSearch] = useState('');
  const [localSearch, setLocalSearch] = useState('');

  // Database filter state - shared across all tabs
  const [databaseFilter, setDatabaseFilter] = useState<string>('');

  // Apply database filter to partsFilters when it changes
  useEffect(() => {
    if (databaseFilter) {
      setPartsFilters(prev => ({ ...prev, database: [databaseFilter] }));
    } else {
      setPartsFilters(prev => {
        const updated = { ...prev };
        delete updated.database;
        return updated;
      });
    }
  }, [databaseFilter]);


  // Modal state for partition details
  const [selectedTable, setSelectedTable] = useState<{ database: string; table: string } | null>(null);
  const [partitionDetails, setPartitionDetails] = useState<TablePartitionEntry[]>([]);
  const [partitionDetailsLoading, setPartitionDetailsLoading] = useState(false);
  const [tableDetailsTab, setTableDetailsTab] = useState<'definition' | 'partitions' | 'sample' | 'index' | 'compression' | 'stats'>('definition');

  // Schema state for table details modal (setters used for data loading)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_schemaColumns, setSchemaColumns] = useState<BrowserColumn[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_schemaLoading, setSchemaLoading] = useState(false);

  // Table definition state
  const [tableDefinition, setTableDefinition] = useState<string>('');
  const [definitionLoading, setDefinitionLoading] = useState(false);

  // Database info modal state
  const [selectedDatabaseInfo, setSelectedDatabaseInfo] = useState<DatabaseSummary | null>(null);
  const [databaseTables, setDatabaseTables] = useState<BrowserTable[]>([]);
  const [loadingDatabaseTables, setLoadingDatabaseTables] = useState(false);

  // Load tables when database info modal opens
  useEffect(() => {
    if (selectedDatabaseInfo) {
      setLoadingDatabaseTables(true);
      fetchBrowserTables(selectedDatabaseInfo.database)
        .then(setDatabaseTables)
        .catch(console.error)
        .finally(() => setLoadingDatabaseTables(false));
    } else {
      setDatabaseTables([]);
    }
  }, [selectedDatabaseInfo]);

  // Handle Escape key to close database info modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedDatabaseInfo) {
        setSelectedDatabaseInfo(null);
        setDatabaseTables([]);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedDatabaseInfo]);

  // Sample data state for table details modal
  const [sampleData, setSampleData] = useState<Record<string, unknown>[]>([]);
  const [sampleDataLoading, setSampleDataLoading] = useState(false);

  // MergeTree index state for table details modal
  const [mergeTreeIndexData, setMergeTreeIndexData] = useState<MergeTreeIndexEntry[]>([]);
  const [mergeTreeIndexLoading, setMergeTreeIndexLoading] = useState(false);
  const [compressionData, setCompressionData] = useState<ColumnCompressionEntry[]>([]);
  const [compressionLoading, setCompressionLoading] = useState(false);
  const [statsData, setStatsData] = useState<Array<{ column: string; null_percent: number; cardinality: number; is_nullable: boolean; is_low_cardinality: boolean }>>([]);
  const [statsLoading, setStatsLoading] = useState(false);

  // Modal state for partition parts (parts within a partition)
  const [selectedPartition, setSelectedPartition] = useState<{ database: string; table: string; partitionId: string } | null>(null);
  const [partitionParts, setPartitionParts] = useState<PartitionPartEntry[]>([]);
  const [partitionPartsLoading, setPartitionPartsLoading] = useState(false);

  // Modal state for single part details
  const [selectedPart, setSelectedPart] = useState<Record<string, unknown> | null>(null);

  // Modal state for compression details
  const [compressionTable, setCompressionTable] = useState<{ database: string; table: string } | null>(null);
  const [compressionDetails, setCompressionDetails] = useState<ColumnCompressionEntry[]>([]);

  // Close modals on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (compressionTable) setCompressionTable(null);
        else if (selectedPart) setSelectedPart(null);
        else if (selectedPartition) setSelectedPartition(null);
        else if (selectedTable) setSelectedTable(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedTable, selectedPartition, selectedPart, compressionTable]);

  // Parts pagination
  const partsTotalPages = Math.ceil(partsTotalCount / partsPageSize);
  const partsStartRow = partsCurrentPage * partsPageSize + 1;
  const partsEndRow = Math.min((partsCurrentPage + 1) * partsPageSize, partsTotalCount);

  // Partitions pagination
  const partitionsTotalPages = Math.ceil(partitionsTotalCount / partitionsPageSize);
  const partitionsStartRow = partitionsCurrentPage * partitionsPageSize + 1;
  const partitionsEndRow = Math.min((partitionsCurrentPage + 1) * partitionsPageSize, partitionsTotalCount);

  const [partsFilters, setPartsFilters] = useState<Record<string, string[]>>({ active: ['1'] });

  const handlePartsFilterChange = useCallback((field: string, values: string[]) => {
    setPartsFilters((prev) => ({ ...prev, [field]: values }));
  }, []);

  const handleClearPartsFilter = useCallback((field: string) => {
    setPartsFilters((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const handleClearAllPartsFilters = useCallback(() => {
    setPartsFilters({ active: ['1'] });
    setPartsSearch('');
    setLocalSearch('');
    setDatabaseFilter('');
  }, []);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setPartsSearch(localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch]);

  // Navigate to partitions tab with search for a specific partition
  const handlePartitionClick = useCallback((database: string, table: string, partitionId: string) => {
    // Set filters for database, table, and partition
    setPartsFilters({ database: [database], table: [table], partition_id: [partitionId] });
    // Clear search
    setLocalSearch('');
    setPartsSearch('');
    // Switch to partitions tab
    setActiveTab('partitions');
    // Close modal
    setSelectedTable(null);
    setPartitionDetails([]);
  }, []);

  const fetchPartsWithFilters = useCallback(
    (filters?: Record<string, string[]>) => fetchParts(
      'modification_time',
      'DESC',
      filters || partsFilters,
      partsPageSize,
      partsCurrentPage * partsPageSize,
      partsSearch
    ),
    [partsFilters, partsPageSize, partsCurrentPage, partsSearch]
  );

  const partsFilterCount = Object.values(partsFilters).filter((v) => v.length > 0).length;

  // The Databases tab follows the same Database filter and search as the other tabs
  const filteredDatabasesData = useMemo(() => {
    const databases = partsFilters.database ?? [];
    const term = partsSearch.trim().toLowerCase();
    return databasesData.filter(db =>
      (databases.length === 0 || databases.includes(db.database)) &&
      (!term || db.database.toLowerCase().includes(term))
    );
  }, [databasesData, partsFilters.database, partsSearch]);

  // Partitions uses aggregated endpoint (grouped by partition_id)
  const fetchPartitionsWithFilters = useCallback(
    (filters?: Record<string, string[]>) => fetchPartitionsSummary(
      'latest_modification',
      'DESC',
      filters || partsFilters,
      partitionsPageSize,
      partitionsCurrentPage * partitionsPageSize,
      partsSearch
    ),
    [partsFilters, partitionsPageSize, partitionsCurrentPage, partsSearch]
  );

  // Fetch counts when filters or search change
  useEffect(() => {
    fetchPartsCount(partsFilters, partsSearch).then(setPartsTotalCount);
  }, [partsFilters, partsSearch, setPartsTotalCount]);

  useEffect(() => {
    fetchPartitionsSummaryCount(partsFilters, partsSearch)
      .then(setPartitionsTotalCount)
      .catch((error: any) => {
        if (error?.status === 403 || error?.type === 'permission') {
          console.info('Parts access denied - hiding parts/objects features');
          setHasPartsAccess(false);
        }
      });
  }, [partsFilters, partsSearch, setPartitionsTotalCount, setHasPartsAccess]);

  // Fetch databases data
  useEffect(() => {
    if (activeTab === 'databases') {
      setDatabasesLoading(true);
      fetchDatabasesSummary()
        .then(setDatabasesData)
        .catch((error: any) => {
          if (error?.status === 403 || error?.type === 'permission') {
            console.info('Parts access denied - hiding parts/objects features');
            setHasPartsAccess(false);
          }
        })
        .finally(() => setDatabasesLoading(false));
    }
  }, [activeTab, setHasPartsAccess]);

  // Fetch grouped data
  useEffect(() => {
    if (activeTab === 'grouped') {
      setGroupedLoading(true);
      fetchGroupedParts(partsFilters, partsSearch)
        .then(setGroupedData)
        .catch((error: any) => {
          if (error?.status === 403 || error?.type === 'permission') {
            console.info('Parts access denied - hiding parts/objects features');
            setHasPartsAccess(false);
          }
        })
        .finally(() => setGroupedLoading(false));
    }
  }, [activeTab, partsFilters, partsSearch, setHasPartsAccess]);

  // Reset page when filters or search change
  useEffect(() => {
    setPartsCurrentPage(0);
    setPartitionsCurrentPage(0);
  }, [partsFilters, partsSearch, setPartsCurrentPage, setPartitionsCurrentPage]);

  // Handle viewing partition details
  const handleViewPartitions = useCallback(async (database: string, table: string) => {
    setSelectedTable({ database, table });
    setPartitionDetailsLoading(true);
    setSchemaLoading(true);
    setSampleDataLoading(true);
    setMergeTreeIndexLoading(true);
    setDefinitionLoading(true);
    try {
      const [partitionData, schemaData, sampleDataResult, mergeTreeIndexResult, definitionResult] = await Promise.allSettled([
        fetchTablePartitions(database, table),
        fetchBrowserColumns(database, table),
        fetchBrowserSampleData(database, table),
        fetchMergeTreeIndex(database, table),
        fetchTableDefinition(database, table),
      ]);
      setPartitionDetails(partitionData.status === 'fulfilled' ? partitionData.value : []);

      // Sort schema columns: PK first, then sort key, then others
      const unsortedSchema = schemaData.status === 'fulfilled' ? schemaData.value : [];
      const sortedSchema = [...unsortedSchema].sort((a, b) => {
        const aIsPK = a.is_in_primary_key === 1;
        const bIsPK = b.is_in_primary_key === 1;
        const aIsSort = a.is_in_sorting_key === 1;
        const bIsSort = b.is_in_sorting_key === 1;

        // Primary key columns first
        if (aIsPK && !bIsPK) return -1;
        if (!aIsPK && bIsPK) return 1;

        // Then sorting key columns
        if (aIsSort && !bIsSort) return -1;
        if (!aIsSort && bIsSort) return 1;

        // Keep original order for others
        return 0;
      });
      setSchemaColumns(sortedSchema);

      setSampleData(sampleDataResult.status === 'fulfilled' ? sampleDataResult.value : []);
      setMergeTreeIndexData(mergeTreeIndexResult.status === 'fulfilled' ? mergeTreeIndexResult.value : []);
      setTableDefinition(definitionResult.status === 'fulfilled' ? definitionResult.value : '');

      // Load compression data
      setCompressionLoading(true);
      fetchTableCompression(database, table)
        .then(setCompressionData)
        .catch(console.error)
        .finally(() => setCompressionLoading(false));
    } catch (error) {
      console.error('Error fetching table details:', error);
      setPartitionDetails([]);
      setSchemaColumns([]);
      setSampleData([]);
      setMergeTreeIndexData([]);
    } finally {
      setPartitionDetailsLoading(false);
      setSchemaLoading(false);
      setSampleDataLoading(false);
      setMergeTreeIndexLoading(false);
      setDefinitionLoading(false);
    }
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedTable(null);
    setPartitionDetails([]);
    setSchemaColumns([]);
    setSampleData([]);
    setMergeTreeIndexData([]);
    setCompressionData([]);
    setStatsData([]);
    setTableDefinition('');
    setTableDetailsTab('definition');
  }, []);

  // Handle Escape key to close table details modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedTable) {
        handleCloseModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedTable, handleCloseModal]);

  // Handle viewing parts for a specific partition
  const handleViewPartitionParts = useCallback(async (database: string, table: string, partitionId: string) => {
    setSelectedPartition({ database, table, partitionId });
    setPartitionPartsLoading(true);
    try {
      const data = await fetchPartitionParts(database, table, partitionId);
      setPartitionParts(data);
    } catch (error) {
      console.error('Error fetching partition parts:', error);
      setPartitionParts([]);
    } finally {
      setPartitionPartsLoading(false);
    }
  }, []);

  const handleClosePartsModal = useCallback(() => {
    setSelectedPartition(null);
    setPartitionParts([]);
  }, []);

  // Handle Escape key to close partition parts modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedPartition) {
        handleClosePartsModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedPartition, handleClosePartsModal]);

  // Handle viewing single part details
  const handleViewPartDetails = useCallback((data: Record<string, unknown>) => {
    setSelectedPart(data);
  }, []);

  const handleClosePartDetails = useCallback(() => {
    setSelectedPart(null);
  }, []);

  // Handle viewing compression details for a table
  const handleViewCompression = useCallback(async (database: string, table: string) => {
    setCompressionTable({ database, table });
    setCompressionLoading(true);
    try {
      const data = await fetchTableCompression(database, table);
      setCompressionDetails(data);
    } catch (error) {
      console.error('Error fetching compression details:', error);
      setCompressionDetails([]);
    } finally {
      setCompressionLoading(false);
    }
  }, []);

  const handleCloseCompressionModal = useCallback(() => {
    setCompressionTable(null);
    setCompressionDetails([]);
  }, []);

  // Drill down from partition parts modal to Parts tab
  const handleDrillDownToPart = useCallback((database: string, table: string, partitionId: string, partName: string) => {
    // Close the modal
    setSelectedPartition(null);
    setPartitionParts([]);
    // Set filters including name
    setPartsFilters({ database: [database], table: [table], partition_id: [partitionId], name: [partName] });
    // Clear search
    setPartsSearch('');
    setLocalSearch('');
    // Navigate to Parts tab
    setActiveTab('parts');
  }, []);

  // Column definitions for grouped table
  const groupedColumnDefs = useMemo((): ColDef<GroupedPartsEntry>[] => [
    {
      headerName: '',
      field: 'database' as const,
      width: 50,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: (params: ICellRendererParams<GroupedPartsEntry>) => {
        if (!params.data) return null;
        return (
          <button
            onClick={() => handleViewPartitions(params.data!.database, params.data!.table)}
            className="p-1.5 hover:bg-gray-700 rounded text-gray-300 hover:text-blue-400 transition-colors"
            title="View partition details"
          >
            <Eye className="w-4 h-4" />
          </button>
        );
      },
    },
    {
      headerName: 'Database',
      field: 'database',
      width: 150,
      sortable: true,
      cellStyle: { color: '#93c5fd', cursor: 'pointer' },
      onCellClicked: (params) => {
        if (params.data) {
          const currentDb = partsFilters.database?.[0];
          if (currentDb === params.data.database) {
            setPartsFilters(prev => {
              const { database, ...rest } = prev;
              return rest;
            });
          } else {
            setPartsFilters(prev => ({ ...prev, database: [params.data!.database] }));
          }
        }
      },
    },
    {
      headerName: 'Table',
      field: 'table',
      width: 250,
      sortable: true,
      cellStyle: { color: '#93c5fd', cursor: 'pointer' },
      onCellClicked: (params) => {
        if (params.data) {
          const currentTable = partsFilters.table?.[0];
          if (currentTable === params.data.table) {
            setPartsFilters(prev => {
              const { table, ...rest } = prev;
              return rest;
            });
          } else {
            setPartsFilters(prev => ({ ...prev, database: [params.data!.database], table: [params.data!.table] }));
          }
        }
      },
    },
    {
      headerName: 'Engine',
      field: 'engine_full',
      width: 250,
      sortable: true,
      cellStyle: { color: '#a5b4fc' },
      valueFormatter: (params) => {
        const val = params.value || '-';
        return val.length > 30 ? val.substring(0, 30) + '...' : val;
      },
      tooltipValueGetter: (params) => params.value || '',
    },
    {
      headerName: 'Partitions',
      field: 'partition_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Parts',
      field: 'part_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Total Rows',
      field: 'total_rows',
      width: 120,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Total Size',
      field: 'total_bytes',
      width: 120,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Uncompressed',
      field: 'uncompressed_bytes',
      width: 120,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Compressed',
      field: 'compressed_bytes',
      width: 110,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value),
      comparator: numericComparator,
    },
    {
      headerName: 'Savings',
      field: 'savings_pct',
      width: 90,
      sortable: true,
      comparator: numericComparator,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' },
      cellRenderer: (params: ICellRendererParams<GroupedPartsEntry>) => {
        if (!params.data) return null;
        const pct = params.value as number;
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-yellow-300">{pct != null && pct >= 0 ? `${pct.toFixed(0)}%` : '-'}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleViewCompression(params.data!.database, params.data!.table);
              }}
              className="p-0.5 hover:bg-gray-700 rounded text-gray-400 hover:text-blue-400 transition-colors"
              title="View column compression details"
            >
              <Search className="w-3 h-3" />
            </button>
          </div>
        );
      },
    },
    {
      headerName: 'Last Modified',
      field: 'last_modification_time',
      flex: 1,
      sortable: true,
      cellStyle: { color: '#fca5a5' },
      valueFormatter: (params) => {
        if (!params.value) return '-';
        return formatDateTime(params.value);
      },
    },
  ], [handleViewPartitions, handleViewCompression]);

  // Eye icon cell renderer for databases
  const EyeButtonRenderer = useCallback((params: ICellRendererParams<DatabaseSummary>) => {
    return (
      <button
        onClick={() => setSelectedDatabaseInfo(params.data || null)}
        className="flex items-center justify-center w-full h-full hover:bg-gray-700/50 transition-colors"
        title="View database details"
      >
        <Eye className="w-3.5 h-3.5 text-gray-400 hover:text-blue-400" />
      </button>
    );
  }, []);

  // Column definitions for databases table
  const databasesColumnDefs = useMemo((): ColDef<DatabaseSummary>[] => [
    {
      headerName: '',
      field: 'database',
      width: 50,
      sortable: false,
      cellRenderer: EyeButtonRenderer,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    },
    {
      headerName: 'Database',
      field: 'database',
      width: 200,
      sortable: true,
      cellStyle: { color: '#93c5fd', fontWeight: 'bold', cursor: 'pointer' },
      onCellClicked: (params) => {
        if (params.data) {
          setDatabaseFilter(params.data.database === databaseFilter ? '' : params.data.database);
        }
      },
    },
    {
      headerName: 'Engine',
      field: 'engine',
      width: 120,
      sortable: true,
      cellStyle: { color: '#c4b5fd' },
    },
    {
      headerName: 'Tables',
      field: 'table_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Partitions',
      field: 'partition_count',
      width: 110,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Parts',
      field: 'part_count',
      width: 100,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Total Rows',
      field: 'total_rows',
      width: 120,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatNumber(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Size on Disk',
      field: 'bytes_on_disk',
      width: 130,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Uncompressed',
      field: 'uncompressed_bytes',
      width: 130,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Compressed',
      field: 'compressed_bytes',
      width: 120,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#86efac' },
      valueFormatter: (params) => formatBytes(params.value || 0),
      comparator: numericComparator,
    },
    {
      headerName: 'Compression',
      field: 'compression_ratio',
      width: 110,
      sortable: true,
      cellStyle: { textAlign: 'right', color: '#fcd34d' },
      valueFormatter: (params) => params.value != null && params.value >= 0 ? `${params.value.toFixed(0)}%` : '-',
      comparator: numericComparator,
    },
    {
      headerName: 'Last Modified',
      field: 'latest_modification',
      flex: 1,
      sortable: true,
      cellStyle: { color: '#fca5a5' },
      valueFormatter: (params) => {
        if (!params.value) return '-';
        return formatDateTime(params.value);
      },
    },
  ], [EyeButtonRenderer]);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    suppressMovable: true,
    sortingOrder: ['desc', 'asc'],
  }), []);

  // Auto-size columns on first data render
  const onFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    const allColumns = event.api.getColumns();
    if (allColumns) {
      const columnsToSize = allColumns.map(col => col.getColId());
      event.api.autoSizeColumns(columnsToSize);
    }
  }, []);

  const tabs: { id: PartsTab; label: string; icon: typeof HardDrive }[] = [
    { id: 'databases', label: 'Databases', icon: Server },
    { id: 'grouped', label: 'Tables', icon: Grid3X3 },
    { id: 'views', label: 'Views', icon: FileCode },
    { id: 'dictionaries', label: 'Dictionaries', icon: BookOpen },
    { id: 'partitions', label: 'Partitions', icon: Layers },
    { id: 'parts', label: 'Parts', icon: HardDrive },
    { id: 'projections', label: 'Projections', icon: Sparkles },
    { id: 'secondary-indexes', label: 'Secondary Indexes', icon: Zap },
    { id: 'histograms', label: 'Histograms', icon: BarChart2 },
  ];

  // Column selector component for Parts/Partitions
  const renderColumnSelector = (
    isOpen: boolean,
    setIsOpen: (open: boolean) => void,
    tableRef: React.RefObject<SystemTableRef | null>
  ) => {
    const columns = tableRef.current?.columns || [];
    const toggleVisibility = tableRef.current?.toggleColumnVisibility;

    if (columns.length === 0) return null;

    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
          title="Configure columns"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[200px]">
              <div className="flex items-center justify-between p-2 border-b border-gray-700">
                <span className="text-xs font-semibold text-gray-300">Columns</span>
                <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {columns.map((col) => (
                  <label key={col.field} className="flex items-center gap-2 p-1.5 hover:bg-gray-700 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.visible}
                      onChange={() => toggleVisibility?.(col.field)}
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
    );
  };

  // Column selector for AG Grid tables (databases, grouped/tables)
  const renderAgGridColumnSelector = (
    isOpen: boolean,
    setIsOpen: (open: boolean) => void,
    columns: { field: string; headerName: string }[],
    hiddenColumns: Set<string>,
    setHiddenColumns: (update: (prev: Set<string>) => Set<string>) => void
  ) => {
    if (columns.length === 0) return null;

    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
          title="Configure columns"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[200px]">
              <div className="flex items-center justify-between p-2 border-b border-gray-700">
                <span className="text-xs font-semibold text-gray-300">Columns</span>
                <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {columns.map((col) => (
                  <label key={col.field} className="flex items-center gap-2 p-1.5 hover:bg-gray-700 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.has(col.field)}
                      onChange={() => {
                        setHiddenColumns(prev => {
                          const next = new Set(prev);
                          if (next.has(col.field)) {
                            next.delete(col.field);
                          } else {
                            next.add(col.field);
                          }
                          return next;
                        });
                      }}
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
    );
  };

  // Column info for AG Grid column selectors
  const groupedColumnInfo = useMemo(() =>
    groupedColumnDefs
      .filter(col => col.field && col.headerName)
      .map(col => ({ field: col.field as string, headerName: col.headerName as string })),
    [groupedColumnDefs]
  );

  const databasesColumnInfo = useMemo(() =>
    databasesColumnDefs
      .filter(col => col.field && col.headerName)
      .map(col => ({ field: col.field as string, headerName: col.headerName as string })),
    [databasesColumnDefs]
  );

  // Filter column definitions based on hidden columns
  const visibleGroupedColumnDefs = useMemo(() =>
    groupedColumnDefs.filter(col => !col.field || !groupedHiddenColumns.has(col.field as string)),
    [groupedColumnDefs, groupedHiddenColumns]
  );

  const visibleDatabasesColumnDefs = useMemo(() =>
    databasesColumnDefs.filter(col => !col.field || !databasesHiddenColumns.has(col.field as string)),
    [databasesColumnDefs, databasesHiddenColumns]
  );

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="bg-gray-900/50 border-b border-gray-700 px-1.5 h-9 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <PartsFilterPanel
            filters={partsFilters}
            onFilterChange={handlePartsFilterChange}
            onClearFilter={handleClearPartsFilter}
            onClearAll={handleClearAllPartsFilters}
          />
          {/* Search bar */}
          <div className="relative flex items-center">
            <Search className="absolute left-2 w-3 h-3 text-gray-400" />
            <input
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Search table, database, partition..."
              className="bg-gray-800 border border-gray-600 rounded pl-6 pr-6 py-0.5 text-white text-xs w-64"
            />
            {localSearch && (
              <button
                onClick={() => { setLocalSearch(''); setPartsSearch(''); }}
                className="absolute right-2 text-gray-400 hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          {(partsFilterCount > 0 || partsSearch) && (
            <span className="text-blue-400">
              {partsFilterCount > 0 && `${partsFilterCount} filter${partsFilterCount > 1 ? 's' : ''} active`}
              {partsFilterCount > 0 && partsSearch && ', '}
              {partsSearch && 'search active'}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700 px-1.5 pt-3 flex items-center justify-between shrink-0">
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setActiveTab(id);
                setPartsColumnSelectorOpen(false);
                setPartitionsColumnSelectorOpen(false);
                // Set active=1 filter when switching to Parts tab
                if (id === 'parts' && !partsFilters.active?.includes('1')) {
                  setPartsFilters({ ...partsFilters, active: ['1'] });
                }
              }}
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
        </div>
        {/* Column selector and pagination */}
        <div className="flex items-center gap-3">
          {databaseFilter && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-blue-400">Database: {databaseFilter}</span>
              <button
                onClick={() => setDatabaseFilter('')}
                className="text-gray-400 hover:text-white"
                title="Clear database filter"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {activeTab === 'databases' && (
            <>
              <span className="text-gray-400 text-xs">
                {filteredDatabasesData.length.toLocaleString()} {filteredDatabasesData.length !== databasesData.length && `of ${databasesData.length}`} databases
              </span>
              {renderAgGridColumnSelector(databasesColumnSelectorOpen, setDatabasesColumnSelectorOpen, databasesColumnInfo, databasesHiddenColumns, setDatabasesHiddenColumns)}
            </>
          )}
          {activeTab === 'grouped' && (
            <>
              <span className="text-gray-400 text-xs">
                {groupedData.length.toLocaleString()} tables
              </span>
              {renderAgGridColumnSelector(groupedColumnSelectorOpen, setGroupedColumnSelectorOpen, groupedColumnInfo, groupedHiddenColumns, setGroupedHiddenColumns)}
            </>
          )}
          {activeTab === 'parts' && (
            <>
              {partsTotalPages > 1 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400">
                    {partsStartRow.toLocaleString()}-{partsEndRow.toLocaleString()} of {partsTotalCount.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPartsCurrentPage(partsCurrentPage - 1)}
                      disabled={partsCurrentPage === 0}
                      className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Previous page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-gray-300 px-2">
                      {partsCurrentPage + 1} / {partsTotalPages}
                    </span>
                    <button
                      onClick={() => setPartsCurrentPage(partsCurrentPage + 1)}
                      disabled={partsCurrentPage >= partsTotalPages - 1}
                      className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Next page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
              {renderColumnSelector(partsColumnSelectorOpen, setPartsColumnSelectorOpen, partsTableRef)}
            </>
          )}
          {activeTab === 'partitions' && (
            <>
              {partitionsTotalPages > 1 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400">
                    {partitionsStartRow.toLocaleString()}-{partitionsEndRow.toLocaleString()} of {partitionsTotalCount.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPartitionsCurrentPage(partitionsCurrentPage - 1)}
                      disabled={partitionsCurrentPage === 0}
                      className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Previous page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-gray-300 px-2">
                      {partitionsCurrentPage + 1} / {partitionsTotalPages}
                    </span>
                    <button
                      onClick={() => setPartitionsCurrentPage(partitionsCurrentPage + 1)}
                      disabled={partitionsCurrentPage >= partitionsTotalPages - 1}
                      className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Next page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
              {renderColumnSelector(partitionsColumnSelectorOpen, setPartitionsColumnSelectorOpen, partitionsTableRef)}
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
        {activeTab === 'databases' && (
          <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
            <AgGridReact<DatabaseSummary> {...GRID_OVERLAYS}
              key={`databases-${databaseFilter}-${databasesHiddenColumns.size}`}
              theme={gridTheme}
              rowData={filteredDatabasesData}
              columnDefs={visibleDatabasesColumnDefs}
              defaultColDef={defaultColDef}
              loading={databasesLoading}
              animateRows={false}
              suppressCellFocus={true}
              enableCellTextSelection={true}
              onFirstDataRendered={onFirstDataRendered}
              getRowId={(params) => params.data.database}
              initialState={{
                sort: {
                  sortModel: [{ colId: 'database', sort: 'asc' }]
                }
              }}
            />
          </div>
        )}
        {activeTab === 'grouped' && (
          <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
            <AgGridReact<GroupedPartsEntry> {...GRID_OVERLAYS}
              key={`grouped-${JSON.stringify(partsFilters)}-${partsSearch}-${groupedHiddenColumns.size}`}
              theme={gridTheme}
              rowData={groupedData}
              columnDefs={visibleGroupedColumnDefs}
              defaultColDef={defaultColDef}
              loading={groupedLoading}
              animateRows={false}
              suppressCellFocus={true}
              enableCellTextSelection={true}
              onFirstDataRendered={onFirstDataRendered}
              getRowId={(params) => `${params.data.database}-${params.data.table}`}
              onCellClicked={(event) => {
                if (event.colDef.field === 'database' && event.data) {
                  setDatabaseFilter(event.data.database === databaseFilter ? '' : event.data.database);
                }
              }}
              initialState={{
                sort: {
                  sortModel: [{ colId: 'database', sort: 'asc' }, { colId: 'table', sort: 'asc' }]
                }
              }}
            />
          </div>
        )}
        {activeTab === 'parts' && (
          <SystemTable
            ref={partsTableRef}
            fetchData={fetchPartsWithFilters}
            fetchColumns={fetchPartsColumns}
            defaultVisibleFields={PARTS_DEFAULT_VISIBLE_FIELDS}
            filters={partsFilters}
            getRowId={(data) => `${data.database}-${data.table}-${data.name}`}
            hideTitle
            showActionColumn
            onRowAction={handleViewPartDetails}
            onCellClick={(field, value, data) => {
              const strValue = String(value);
              if (field === 'database') {
                const currentDb = partsFilters.database?.[0];
                if (currentDb === strValue) {
                  setPartsFilters(prev => {
                    const { database, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [strValue] }));
                }
              } else if (field === 'table') {
                const currentTable = partsFilters.table?.[0];
                if (currentTable === strValue) {
                  setPartsFilters(prev => {
                    const { table, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [String(data.database)], table: [strValue] }));
                }
              } else if (field === 'partition_id' || field === 'partition') {
                const partitionIdValue = data.partition_id != null ? String(data.partition_id) : strValue;
                const currentPartition = partsFilters.partition_id?.[0];
                if (currentPartition === partitionIdValue) {
                  setPartsFilters(prev => {
                    const { partition_id, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [String(data.database)], table: [String(data.table)], partition_id: [partitionIdValue] }));
                }
              }
            }}
            defaultSort={[
              { colId: 'database', sort: 'asc' },
              { colId: 'table', sort: 'asc' },
              { colId: 'partition', sort: 'asc' },
              { colId: 'name', sort: 'asc' }
            ]}
          />
        )}
        {activeTab === 'partitions' && (
          <SystemTable
            ref={partitionsTableRef}
            fetchData={fetchPartitionsWithFilters}
            fetchColumns={fetchPartitionsSummaryColumns}
            defaultVisibleFields={['database', 'table', 'partition', 'parts_count', 'total_rows', 'total_bytes', 'total_compressed', 'total_uncompressed', 'savings_pct', 'latest_modification', 'min_block', 'max_block']}
            filters={partsFilters}
            getRowId={(data) => `${data.database}-${data.table}-${data.partition_id}`}
            hideTitle
            showActionColumn
            onRowAction={(data) => handleViewPartitionParts(String(data.database), String(data.table), String(data.partition_id))}
            onCellClick={(field, value, data) => {
              const strValue = String(value);
              if (field === 'database') {
                const currentDb = partsFilters.database?.[0];
                if (currentDb === strValue) {
                  setPartsFilters(prev => {
                    const { database, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [strValue] }));
                }
              } else if (field === 'table') {
                const currentTable = partsFilters.table?.[0];
                if (currentTable === strValue) {
                  setPartsFilters(prev => {
                    const { table, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [String(data.database)], table: [strValue] }));
                }
              } else if (field === 'partition' || field === 'partition_id') {
                const partitionIdValue = data.partition_id != null ? String(data.partition_id) : strValue;
                const currentPartition = partsFilters.partition_id?.[0];
                if (currentPartition === partitionIdValue) {
                  setPartsFilters(prev => {
                    const { partition_id, ...rest } = prev;
                    return rest;
                  });
                } else {
                  setPartsFilters(prev => ({ ...prev, database: [String(data.database)], table: [String(data.table)], partition_id: [partitionIdValue] }));
                }
              }
            }}
            defaultSort={[
              { colId: 'database', sort: 'asc' },
              { colId: 'table', sort: 'asc' },
              { colId: 'partition', sort: 'asc' }
            ]}
          />
        )}
        {activeTab === 'views' && (
          <ViewsTab
            filters={Object.fromEntries(Object.entries(partsFilters).filter(([k]) => k !== 'active'))}
            search={partsSearch}
          />
        )}
        {activeTab === 'dictionaries' && (
          <DictionariesTab
            filters={Object.fromEntries(Object.entries(partsFilters).filter(([k]) => k !== 'active'))}
            search={partsSearch}
          />
        )}
        {activeTab === 'projections' && (
          <ProjectionsTab
            filters={Object.fromEntries(Object.entries(partsFilters).filter(([k]) => k !== 'active'))}
            search={partsSearch}
          />
        )}
        {activeTab === 'secondary-indexes' && (
          <DataSkippingIndexesTab
            filters={Object.fromEntries(Object.entries(partsFilters).filter(([k]) => k !== 'active'))}
            search={partsSearch}
          />
        )}
        {activeTab === 'histograms' && (
          <PartsHistogramsTab
            filters={partsFilters}
            onFilterChange={handlePartsFilterChange}
          />
        )}
      </div>

      {/* Partition Details Modal */}
      {selectedTable && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[1650px] h-[95vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Table Details</h2>
                <p className="text-xs text-gray-400 font-mono">{selectedTable.database}.{selectedTable.table}</p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto flex flex-col">
              {partitionDetailsLoading ? (
                <div className="h-32 flex"><LoadingState /></div>
              ) : partitionDetails.length === 0 ? (
                <EmptyState compact title="No partitions found" />
              ) : (
                <>
                  {/* Stats Panel */}
                  <div className="p-3 border-b border-gray-700">
                    <div className="grid grid-cols-4 gap-2">
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Rows</div>
                      <div className="text-sm font-semibold text-cyan-400">
                        {partitionDetails.reduce((sum, p) => sum + Number(p.total_rows), 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Size on Disk</div>
                      <div className="text-sm font-semibold text-green-400">
                        {formatBytes(partitionDetails.reduce((sum, p) => sum + Number(p.total_bytes), 0))}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Block Range</div>
                      <div className="text-sm font-semibold text-white">
                        {Math.min(...partitionDetails.map(p => p.min_block))} - {Math.max(...partitionDetails.map(p => p.max_block))}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Last Modified</div>
                      <div className="text-sm font-semibold text-white">
                        {formatDate(new Date(Math.max(...partitionDetails.map(p => parseServerTime(p.newest_part).getTime()))))}
                      </div>
                    </div>
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="border-b border-gray-700 px-3 flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setTableDetailsTab('definition')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'definition'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Definition
                    </button>
                    <button
                      onClick={() => setTableDetailsTab('partitions')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'partitions'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Partitions
                    </button>
                    <button
                      onClick={() => setTableDetailsTab('sample')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'sample'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Sample Data
                    </button>
                    <button
                      onClick={() => setTableDetailsTab('index')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'index'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Primary Index
                    </button>
                    <button
                      onClick={() => setTableDetailsTab('compression')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'compression'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Compression
                    </button>
                    <button
                      onClick={() => setTableDetailsTab('stats')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        tableDetailsTab === 'stats'
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      Stats
                    </button>
                  </div>

                  {/* Tab Content */}
                  <div className="flex-1 overflow-auto p-3 flex flex-col">
                    {/* Definition Section */}
                    {tableDetailsTab === 'definition' && (
                      <div className="flex flex-col flex-1">
                    <h3 className="text-xs font-semibold text-gray-300 mb-2">Table Definition</h3>
                    {definitionLoading ? (
                      <div className="h-20 flex"><LoadingState label="Loading definition…" /></div>
                    ) : !tableDefinition ? (
                      <EmptyState compact title="No definition found" />
                    ) : (
                      <div className="bg-gray-800 rounded p-3 flex-1 overflow-y-auto">
                        <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap">{tableDefinition}</pre>
                      </div>
                    )}
                      </div>
                    )}

                    {/* Partitions Section */}
                    {tableDetailsTab === 'partitions' && (
                      <div className="flex flex-col flex-1">
                    <h3 className="text-xs font-semibold text-gray-300 mb-2">Partitions ({partitionDetails.length})</h3>
                    <div className="bg-gray-800 rounded flex-1 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-gray-800">
                          <tr className="border-b border-gray-700">
                            <th className="text-left p-1.5 text-gray-400 w-[200px]">Partition ID</th>
                            <th className="text-right p-1.5 text-gray-400 w-[80px]">Parts</th>
                            <th className="text-right p-1.5 text-gray-400 w-[100px]">Rows</th>
                            <th className="text-right p-1.5 text-gray-400 w-[100px]">Size</th>
                            <th className="text-right p-1.5 text-gray-400 w-[150px]">Block Range</th>
                            <th className="text-right p-1.5 text-gray-400">Newest Part</th>
                          </tr>
                        </thead>
                        <tbody>
                          {partitionDetails.map((partition) => (
                            <tr key={partition.partition_id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                              <td className="p-1.5 font-mono">
                                <button
                                  onClick={() => selectedTable && handlePartitionClick(selectedTable.database, selectedTable.table, partition.partition_id || '')}
                                  className="text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
                                  title="View in Partitions tab"
                                >
                                  {partition.partition_id || '(all)'}
                                </button>
                              </td>
                              <td className="p-1.5 text-right text-green-400 font-mono">{partition.parts_count.toLocaleString()}</td>
                              <td className="p-1.5 text-right text-green-400 font-mono">{Number(partition.total_rows).toLocaleString()}</td>
                              <td className="p-1.5 text-right text-green-400 font-mono">{formatBytes(Number(partition.total_bytes))}</td>
                              <td className="p-1.5 text-right text-gray-300 font-mono">{partition.min_block} - {partition.max_block}</td>
                              <td className="p-1.5 text-right text-red-300 font-mono">
                                {partition.newest_part
                                  ? formatDateTime(partition.newest_part)
                                  : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                      </div>
                    )}

                    {/* Sample Data Section */}
                    {tableDetailsTab === 'sample' && (
                      <div className="flex flex-col flex-1">
                    <h3 className="text-xs font-semibold text-gray-300 mb-2">Sample Data ({sampleData.length} rows)</h3>
                    {sampleDataLoading ? (
                      <div className="h-20 flex"><LoadingState label="Loading sample data…" /></div>
                    ) : sampleData.length === 0 ? (
                      <EmptyState compact title="No data available" />
                    ) : (
                      <div className="bg-gray-800 rounded flex-1 overflow-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-gray-800">
                            <tr className="border-b border-gray-700">
                              {Object.keys(sampleData[0]).map((key) => (
                                <th key={key} className="text-left p-2 text-gray-400 whitespace-nowrap">{key}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sampleData.map((row, idx) => (
                              <tr key={idx} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                {Object.values(row).map((value, colIdx) => {
                                  const strValue = value === null ? 'NULL' : String(value);
                                  const truncated = strValue.length > 50 ? strValue.substring(0, 50) + '...' : strValue;
                                  return (
                                    <td key={colIdx} className="p-2 text-gray-300 font-mono whitespace-nowrap" title={strValue}>
                                      {value === null ? <span className="text-gray-500 italic">NULL</span> : truncated}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                      </div>
                    )}

                    {/* MergeTree Index Granules Section */}
                    {tableDetailsTab === 'index' && (
                      <div className="flex flex-col flex-1">
                    <h3 className="text-xs font-semibold text-gray-300 mb-2">MergeTree Index Granules ({mergeTreeIndexData.length}) <span className="text-gray-500 font-normal">(limit 50)</span></h3>
                    {mergeTreeIndexLoading ? (
                      <div className="h-20 flex"><LoadingState label="Loading index granules…" /></div>
                    ) : mergeTreeIndexData.length === 0 ? (
                      <EmptyState compact title="No index data available" />
                    ) : (
                      <div className="bg-gray-800 rounded flex-1 overflow-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-gray-800">
                            <tr className="border-b border-gray-700">
                              {Object.keys(mergeTreeIndexData[0]).map((key) => (
                                <th key={key} className="text-left p-1.5 text-gray-400 whitespace-nowrap">{key}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {mergeTreeIndexData.map((row, idx) => (
                              <tr key={idx} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                {Object.entries(row).map(([, value], colIdx) => {
                                  const strValue = value === null ? 'NULL' : String(value);
                                  return (
                                    <td
                                      key={colIdx}
                                      className="p-1.5 text-gray-300 font-mono whitespace-nowrap"
                                      title={strValue}
                                    >
                                      {value === null ? <span className="text-gray-500 italic">NULL</span> : strValue}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                      </div>
                    )}

                    {/* Compression Section */}
                    {tableDetailsTab === 'compression' && (
                      <div className="flex flex-col flex-1">
                    <h3 className="text-xs font-semibold text-gray-300 mb-2">Column Compression ({compressionData.length} columns)</h3>
                    {compressionLoading ? (
                      <div className="h-20 flex"><LoadingState label="Loading compression data…" /></div>
                    ) : compressionData.length === 0 ? (
                      <EmptyState compact title="No compression data available" />
                    ) : (
                      <div className="bg-gray-800 rounded flex-1 overflow-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-gray-800">
                            <tr className="border-b border-gray-700">
                              <th className="text-left p-1.5 text-gray-400 w-[200px]">Column</th>
                              <th className="text-left p-1.5 text-gray-400 w-[160px]">Type</th>
                              <th className="text-right p-1.5 text-gray-400 w-[120px]">Compressed</th>
                              <th className="text-right p-1.5 text-gray-400 w-[120px]">Uncompressed</th>
                              <th className="text-right p-1.5 text-gray-400 w-[100px]">Ratio</th>
                              <th className="text-right p-1.5 text-gray-400 w-[80px]">Savings</th>
                            </tr>
                          </thead>
                          <tbody>
                            {compressionData.map((col, idx) => {
                              const ratio = col.uncompressed_bytes > 0
                                ? col.uncompressed_bytes / col.compressed_bytes
                                : 0;
                              const savings = col.uncompressed_bytes > 0
                                ? ((col.uncompressed_bytes - col.compressed_bytes) / col.uncompressed_bytes * 100)
                                : 0;
                              return (
                                <tr key={idx} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  <td className="p-1.5 text-blue-300 font-mono">{col.name}</td>
                                  <td className="p-1.5 text-gray-400 font-mono">{col.type || '-'}</td>
                                  <td className="p-1.5 text-right text-green-400 font-mono">{formatBytes(col.compressed_bytes)}</td>
                                  <td className="p-1.5 text-right text-gray-300 font-mono">{formatBytes(col.uncompressed_bytes)}</td>
                                  <td className="p-1.5 text-right text-cyan-400 font-mono">{ratio.toFixed(2)}x</td>
                                  <td className="p-1.5 text-right text-green-400 font-mono">{savings.toFixed(1)}%</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                      </div>
                    )}

                    {/* Stats Section */}
                    {tableDetailsTab === 'stats' && (
                      <div className="flex flex-col flex-1">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-gray-300">Column Statistics</h3>
                      <button
                        onClick={async () => {
                          if (!selectedTable) return;
                          setStatsLoading(true);
                          try {
                            const response = await fetch('/api/table-stats', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                database: selectedTable.database,
                                table: selectedTable.table,
                              }),
                            });
                            if (!response.ok) throw new Error('Failed to fetch stats');
                            const data = await response.json();
                            setStatsData(data);
                          } catch (error) {
                            console.error('Error fetching stats:', error);
                          } finally {
                            setStatsLoading(false);
                          }
                        }}
                        disabled={statsLoading}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded text-white text-xs font-medium flex items-center gap-1"
                      >
                        {statsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Analyze'}
                      </button>
                    </div>
                    {statsLoading ? (
                      <div className="flex items-center justify-center h-20 text-gray-400">Analyzing table statistics...</div>
                    ) : statsData.length === 0 ? (
                      <div></div>
                    ) : (
                      <div className="bg-gray-800 rounded flex-1 overflow-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-gray-800">
                            <tr className="border-b border-gray-700">
                              <th className="text-left p-1.5 text-gray-400 w-[200px]">Column</th>
                              <th className="text-center p-1.5 text-gray-400 w-[80px]">Nullable</th>
                              <th className="text-center p-1.5 text-gray-400 w-[100px]">Low Card.</th>
                              <th className="text-right p-1.5 text-gray-400 w-[100px]">% Null</th>
                              <th className="text-right p-1.5 text-gray-400 w-[120px]">Cardinality</th>
                            </tr>
                          </thead>
                          <tbody>
                            {statsData.map((stat, idx) => (
                              <tr key={idx} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                <td className="p-1.5 text-blue-300 font-mono">{stat.column}</td>
                                <td className="p-1.5 text-center">
                                  {stat.is_nullable ? (
                                    <span className="text-green-400">✓</span>
                                  ) : (
                                    <span className="text-gray-600">-</span>
                                  )}
                                </td>
                                <td className="p-1.5 text-center">
                                  {stat.is_low_cardinality ? (
                                    <span className="text-green-400">✓</span>
                                  ) : (
                                    <span className="text-gray-600">-</span>
                                  )}
                                </td>
                                <td className="p-1.5 text-right text-yellow-400 font-mono">{stat.null_percent.toFixed(2)}%</td>
                                <td className="p-1.5 text-right text-cyan-400 font-mono">{formatNumber(stat.cardinality)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Partition Parts Modal */}
      {selectedPartition && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleClosePartsModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[1000px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Active Parts</h2>
                <p className="text-xs text-gray-400 font-mono">
                  {selectedPartition.database}.{selectedPartition.table} / {selectedPartition.partitionId || '(all)'}
                </p>
              </div>
              <button onClick={handleClosePartsModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {partitionPartsLoading ? (
                <div className="h-32 flex"><LoadingState /></div>
              ) : partitionParts.length === 0 ? (
                <EmptyState compact title="No parts found" />
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-gray-400">Total Parts</div>
                        <button
                          onClick={() => {
                            setPartsFilters({ database: [selectedPartition.database], table: [selectedPartition.table], partition_id: [selectedPartition.partitionId], active: ['1'] });
                            setActiveTab('parts');
                            handleClosePartsModal();
                          }}
                          className="text-gray-400 hover:text-blue-400 transition-colors"
                          title="View all parts for this partition"
                        >
                          <Search className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="text-sm font-semibold text-white">{partitionParts.length.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Total Rows</div>
                      <div className="text-sm font-semibold text-green-400">
                        {partitionParts.reduce((sum, p) => sum + Number(p.rows), 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Total Size</div>
                      <div className="text-sm font-semibold text-green-400">
                        {formatBytes(partitionParts.reduce((sum, p) => sum + Number(p.bytes_on_disk), 0))}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Total Marks</div>
                      <div className="text-sm font-semibold text-white">
                        {partitionParts.reduce((sum, p) => sum + Number(p.marks), 0).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded max-h-[calc(80vh-220px)] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-800">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400">Name</th>
                          <th className="text-right p-2 text-gray-400">Rows</th>
                          <th className="text-right p-2 text-gray-400">Size</th>
                          <th className="text-right p-2 text-gray-400">Marks</th>
                          <th className="text-right p-2 text-gray-400">Level</th>
                          <th className="text-right p-2 text-gray-400">Block Range</th>
                          <th className="text-right p-2 text-gray-400">Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partitionParts.map((part) => (
                          <tr key={part.name} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="p-2 font-mono">
                              <button
                                onClick={() => selectedPartition && handleDrillDownToPart(
                                  selectedPartition.database,
                                  selectedPartition.table,
                                  selectedPartition.partitionId,
                                  part.name
                                )}
                                className="text-blue-400 hover:text-blue-300 hover:underline text-left"
                                title="View in Parts tab"
                              >
                                {part.name}
                              </button>
                            </td>
                            <td className="p-2 text-right text-green-400">{Number(part.rows).toLocaleString()}</td>
                            <td className="p-2 text-right text-green-400">{formatBytes(Number(part.bytes_on_disk))}</td>
                            <td className="p-2 text-right text-green-400">{Number(part.marks).toLocaleString()}</td>
                            <td className="p-2 text-right text-gray-300">{part.level}</td>
                            <td className="p-2 text-right text-gray-300">{part.min_block_number} - {part.max_block_number}</td>
                            <td className="p-2 text-right text-red-300">
                              {part.modification_time
                                ? formatDateTime(part.modification_time)
                                : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Single Part Details Modal */}
      {selectedPart && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleClosePartDetails}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[500px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Part Details</h2>
                <p className="text-xs text-gray-400 font-mono">{String(selectedPart.name || '')}</p>
              </div>
              <button onClick={handleClosePartDetails} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Database</div>
                  <div className="text-sm font-semibold text-blue-300">{String(selectedPart.database || '-')}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Table</div>
                  <div className="text-sm font-semibold text-blue-300">{String(selectedPart.table || '-')}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Partition ID</div>
                  <div className="text-sm font-semibold text-blue-300">{String(selectedPart.partition_id || '-')}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Active</div>
                  <div className="text-sm font-semibold text-white">{selectedPart.active ? 'Yes' : 'No'}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Rows</div>
                  <div className="text-sm font-semibold text-green-400">{Number(selectedPart.rows || 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Marks</div>
                  <div className="text-sm font-semibold text-green-400">{Number(selectedPart.marks || 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Size on Disk</div>
                  <div className="text-sm font-semibold text-green-400">{formatBytes(Number(selectedPart.bytes_on_disk || 0))}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Compressed</div>
                  <div className="text-sm font-semibold text-green-400">{formatBytes(Number(selectedPart.data_compressed_bytes || 0))}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Uncompressed</div>
                  <div className="text-sm font-semibold text-green-400">{formatBytes(Number(selectedPart.data_uncompressed_bytes || 0))}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded">
                  <div className="text-xs text-gray-400">Primary Key Memory</div>
                  <div className="text-sm font-semibold text-green-400">{formatBytes(Number(selectedPart.primary_key_bytes_in_memory || 0))}</div>
                </div>
                <div className="bg-gray-800 p-2 rounded col-span-2">
                  <div className="text-xs text-gray-400">Modification Time</div>
                  <div className="text-sm font-semibold text-red-300">
                    {selectedPart.modification_time
                      ? parseServerTime(String(selectedPart.modification_time)).toLocaleString()
                      : '-'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compression Details Modal */}
      {compressionTable && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={handleCloseCompressionModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[700px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h2 className="text-sm font-semibold text-white">Compression Details</h2>
                <p className="text-xs text-gray-400 font-mono">{compressionTable.database}.{compressionTable.table}</p>
              </div>
              <button onClick={handleCloseCompressionModal} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {compressionLoading ? (
                <div className="h-32 flex"><LoadingState /></div>
              ) : compressionDetails.length === 0 ? (
                <EmptyState compact title="No compression data found" />
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Columns</div>
                      <div className="text-sm font-semibold text-green-300">{compressionDetails.length}</div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Uncompressed</div>
                      <div className="text-sm font-semibold text-green-300">
                        {formatBytes(compressionDetails.reduce((sum, c) => sum + Number(c.uncompressed_bytes), 0))}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Compressed</div>
                      <div className="text-sm font-semibold text-green-300">
                        {formatBytes(compressionDetails.reduce((sum, c) => sum + Number(c.compressed_bytes), 0))}
                      </div>
                    </div>
                    <div className="bg-gray-800 p-2 rounded">
                      <div className="text-xs text-gray-400">Total Savings</div>
                      <div className="text-sm font-semibold text-yellow-300">
                        {(() => {
                          const totalCompressed = compressionDetails.reduce((sum, c) => sum + Number(c.compressed_bytes), 0);
                          const totalUncompressed = compressionDetails.reduce((sum, c) => sum + Number(c.uncompressed_bytes), 0);
                          return totalUncompressed > 0 ? `${((totalUncompressed - totalCompressed) / totalUncompressed * 100).toFixed(0)}%` : '-';
                        })()}
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded max-h-[calc(80vh-200px)] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-800">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400">Column</th>
                          <th className="text-left p-2 text-gray-400">Type</th>
                          <th className="text-right p-2 text-gray-400">Uncompressed</th>
                          <th className="text-right p-2 text-gray-400">Compressed</th>
                          <th className="text-right p-2 text-gray-400">Savings</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compressionDetails.map((column) => (
                          <tr key={column.name} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="p-2 font-mono text-blue-300">{column.name}</td>
                            <td className="p-2 text-gray-400">{column.type}</td>
                            <td className="p-2 text-right text-green-300">{formatBytes(Number(column.uncompressed_bytes))}</td>
                            <td className="p-2 text-right text-green-300">{formatBytes(Number(column.compressed_bytes))}</td>
                            <td className="p-2 text-right text-yellow-300">{column.savings_pct != null && Number(column.savings_pct) >= 0 ? `${Number(column.savings_pct).toFixed(0)}%` : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Database Info Modal */}
      {selectedDatabaseInfo && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => {
          setSelectedDatabaseInfo(null);
          setDatabaseTables([]);
        }}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[1200px] max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <div>
                <h3 className="text-sm font-semibold text-white">Database Details</h3>
                <p className="text-xs text-gray-400 font-mono">{selectedDatabaseInfo.database}</p>
              </div>
              <button onClick={() => {
                setSelectedDatabaseInfo(null);
                setDatabaseTables([]);
              }} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {/* Key Stats */}
              <div className="grid grid-cols-6 gap-3 mb-4">
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Tables</div>
                  <div className="text-lg font-semibold text-cyan-400">{formatNumber(selectedDatabaseInfo.table_count)}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Total Rows</div>
                  <div className="text-lg font-semibold text-cyan-400">{formatNumber(selectedDatabaseInfo.part_rows)}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Size on Disk</div>
                  <div className="text-lg font-semibold text-green-400">{formatBytes(selectedDatabaseInfo.bytes_on_disk)}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Partitions</div>
                  <div className="text-lg font-semibold text-cyan-400">{formatNumber(selectedDatabaseInfo.partition_count)}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Parts</div>
                  <div className="text-lg font-semibold text-cyan-400">{formatNumber(selectedDatabaseInfo.part_count)}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                  <div className="text-xs text-gray-400 mb-1">Compression</div>
                  <div className="text-lg font-semibold text-white">{selectedDatabaseInfo.compression_ratio.toFixed(1)}</div>
                </div>
              </div>

              {/* Tables Section */}
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-gray-400 mb-2">
                  Tables ({selectedDatabaseInfo.table_count})
                </h3>

                {loadingDatabaseTables ? (
                  <div className="bg-gray-800 rounded p-4"><LoadingState label="Loading tables…" /></div>
                ) : databaseTables.length > 0 ? (
                  <div className="bg-gray-800 rounded max-h-96 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-800">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-1.5 text-gray-400">Table</th>
                          <th className="text-left p-1.5 text-gray-400">Engine</th>
                          <th className="text-right p-1.5 text-gray-400">Partitions</th>
                          <th className="text-right p-1.5 text-gray-400">Rows</th>
                          <th className="text-right p-1.5 text-gray-400">Size</th>
                          <th className="text-left p-1.5 text-gray-400">Last Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {databaseTables.map((table) => (
                          <tr key={table.name} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="p-1.5 text-blue-300 font-mono">{table.name}</td>
                            <td className="p-1.5 text-gray-300 font-mono">{table.engine}</td>
                            <td className="p-1.5 text-right text-cyan-400 font-mono">{formatNumber(table.partition_count)}</td>
                            <td className="p-1.5 text-right text-green-300 font-mono">{formatNumber(table.total_rows)}</td>
                            <td className="p-1.5 text-right text-green-300 font-mono">{formatBytes(table.total_bytes)}</td>
                            <td className="p-1.5 text-gray-300 font-mono text-xs">{table.metadata_modification_time}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="bg-gray-800 rounded p-8 text-center">
                    <EmptyState compact title="No tables found" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
