// Databases / tables / columns of the connected server, for scope pickers.
import { useEffect, useState } from 'react';
import { executeQuery } from '../../services/api';

const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function useNames(sql: string | null): string[] {
  const [result, setResult] = useState<{ sql: string; names: string[] } | null>(null);
  useEffect(() => {
    if (!sql) return;
    let cancelled = false;
    executeQuery(sql, 10000)
      .then(r => { if (!cancelled) setResult({ sql, names: r.data.map(row => String(row.name)) }); })
      .catch(() => { if (!cancelled) setResult({ sql, names: [] }); });
    return () => { cancelled = true; };
  }, [sql]);
  return sql && result?.sql === sql ? result.names : [];
}

export function useDatabases(): string[] {
  return useNames('SELECT name FROM system.databases ORDER BY name');
}

export function useTables(database: string): string[] {
  return useNames(database ? `SELECT name FROM system.tables WHERE database = ${lit(database)} ORDER BY name` : null);
}

export function useColumns(database: string, table: string): string[] {
  return useNames(database && table ? `SELECT name FROM system.columns WHERE database = ${lit(database)} AND table = ${lit(table)} ORDER BY position` : null);
}
