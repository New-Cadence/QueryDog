// Runs a loader against the connected ClickHouse once per `key` and flags
// when it is slow: an idle ClickHouse Cloud service can take up to a minute
// to wake on the first query.
import { useEffect, useState } from 'react';
import { executeQuery } from '../../services/api';
import { errorMessage } from './costContext';

const SLOW_AFTER_MS = 4000;

export function useLiveQuery<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; slow: boolean }>({ key: '', data: null, error: null, slow: false });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => !cancelled && setState(s => (s.key === key ? s : { ...s, slow: true })), SLOW_AFTER_MS);
    load()
      .then(data => !cancelled && setState({ key, data, error: null, slow: false }))
      .catch(err => !cancelled && setState({ key, data: null, error: errorMessage(err), slow: false }))
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); };
    // `load` is recreated every render; `key` identifies the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current, slow: !current && state.slow };
}

// ClickHouse returns 64-bit integers as strings. Convert numeric strings to
// numbers unless that would lose precision (e.g. query hashes).
function toNumberIfSafe(v: unknown): unknown {
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  const n = Number(v);
  return /^-?\d+$/.test(v) && !Number.isSafeInteger(n) ? v : n;
}

export async function queryRows<T>(sql: string, limit = 10000): Promise<T[]> {
  const r = await executeQuery(sql, limit);
  return r.data.map(row => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = toNumberIfSafe(v);
    return out as T;
  });
}

// Like queryRows but resolves to null when a system table is missing (e.g. no
// part_log or query_log configured on a self-managed server).
export async function optionalRows<T>(sql: string, limit = 10000): Promise<T[] | null> {
  try {
    return await queryRows<T>(sql, limit);
  } catch (err) {
    if (/UNKNOWN_TABLE|doesn't exist|Unknown table/i.test(errorMessage(err))) return null;
    throw err;
  }
}
