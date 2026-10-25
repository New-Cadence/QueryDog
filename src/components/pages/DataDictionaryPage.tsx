import { useCallback, useEffect, useMemo, useState } from 'react';
import { CatalogView } from '../dictionary/CatalogView';
import { joinUsage } from '../dictionary/model';
import { TableDetail } from '../dictionary/TableDetail';
import { type DictionaryTable, type LineageGraphData, type UsageSummary, fetchCatalog, fetchLineage, fetchUsage, tableId } from '../dictionary/api';

// Data Dictionary: a catalog of every table (documentation coverage and
// 7-day usage) and a per-table view with editable comments, column profiling,
// lineage, usage, DDL and sample data.
export function DataDictionaryPage() {
  const [tables, setTables] = useState<DictionaryTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [lineage, setLineage] = useState<LineageGraphData | null>(null);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetchCatalog()
      .then(setTables)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load tables'))
      .finally(() => setLoading(false));
    // Usage is optional: without query_log the catalog simply hides those columns
    fetchUsage().then(setUsage).catch(() => setUsage({ available: false, tables: [] }));
  }, []);

  // Lineage covers the whole instance, so load it once on first table open
  useEffect(() => {
    if (!selectedId || lineage || lineageError) return;
    fetchLineage().then(setLineage).catch(err => setLineageError(err instanceof Error ? err.message : 'Failed to load lineage'));
  }, [selectedId, lineage, lineageError]);

  const rows = useMemo(() => joinUsage(tables, usage), [tables, usage]);
  const selected = rows.find(r => tableId(r) === selectedId) || null;
  const known = useMemo(() => new Set(rows.map(tableId)), [rows]);
  const isKnown = useCallback((database: string, name: string) => known.has(`${database}.${name}`), [known]);
  const navigate = useCallback((database: string, name: string) => setSelectedId(`${database}.${name}`), []);

  return (
    <div className="h-full">
      {/* The catalog stays mounted so its filters and scroll survive a visit to a table */}
      <div className={selected ? 'hidden' : 'h-full'}>
        <CatalogView rows={rows} usage={usage} loading={loading} error={error} onSelect={r => setSelectedId(tableId(r))} />
      </div>
      {selected && (
        <TableDetail
          key={selectedId}
          table={selected}
          lineage={lineage}
          lineageError={lineageError}
          isKnown={isKnown}
          onNavigate={navigate}
          onBack={() => setSelectedId(null)}
          onTableChange={patch =>
            setTables(prev => prev.map(t => (tableId(t) === selectedId ? { ...t, ...patch } : t)))
          }
        />
      )}
    </div>
  );
}
