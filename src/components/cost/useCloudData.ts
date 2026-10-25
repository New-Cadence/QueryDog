// Loads everything the Cloud tabs need from the ClickHouse Cloud API in one
// go: 90 days of usage (this month, the previous months for comparison and
// a full window for forecasting), services, organisation credits and live
// per-replica metrics. None of these calls wake an idle service.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchCloudMetrics, fetchCloudServices, fetchOrganization, fetchUsage,
  type CloudService, type OrganizationInfo, type ServiceMetrics, type UsageRecord,
} from './costApi';
import { errorMessage } from './costContext';
import { MAX_RANGE_DAYS } from './costRange';
import { addDays, toUsageRows, type UsageRow } from './usage';

// Always loaded: enough for the forecast, comparisons and 30-day figures.
// A longer range picked in the toolbar widens the window (it never shrinks).
export const USAGE_DAYS = 90;

export interface CloudData {
  from: string;
  to: string;
  services: CloudService[];
  records: UsageRecord[];
  rows: UsageRow[];
  org: OrganizationInfo | null;
  metrics: ServiceMetrics[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCloudData(enabled: boolean, ownServiceId: string | null, today: string, neededFrom: string): CloudData {
  const to = today;
  const earliest = addDays(to, -(MAX_RANGE_DAYS - 1));
  const wanted = neededFrom < earliest ? earliest : neededFrom;
  const [from, setFrom] = useState(() => addDays(to, -(USAGE_DAYS - 1)));
  const [services, setServices] = useState<CloudService[]>([]);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [org, setOrg] = useState<OrganizationInfo | null>(null);
  const [metrics, setMetrics] = useState<ServiceMetrics[]>([]);
  // The window and reload a request finished for; loading until it matches
  const [done, setDone] = useState<{ from: string; reload: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  if (wanted < from) setFrom(wanted);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = reload > 0;
    Promise.all([
      fetchUsage(from, to, refresh),
      fetchCloudServices(refresh),
      // Credits and metrics are extras: a key without access to them still shows billing
      fetchOrganization(refresh).catch(() => null),
      fetchCloudMetrics(refresh).then(m => m.services).catch(() => []),
    ])
      .then(([usage, svcs, orgInfo, live]) => {
        if (cancelled) return;
        setRecords(usage.costs);
        setServices(svcs);
        setOrg(orgInfo);
        setMetrics(live);
        setError(null);
      })
      .catch(err => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setDone({ from, reload }));
    return () => { cancelled = true; };
  }, [enabled, from, to, reload]);

  const rows = useMemo(() => toUsageRows(records, services, ownServiceId), [records, services, ownServiceId]);
  const refresh = useCallback(() => setReload(n => n + 1), []);
  const loading = enabled && (done?.from !== from || done.reload !== reload);

  // `from` is the start of the data actually loaded, so tabs can tell whether it covers their range
  return { from: done?.from ?? from, to, services, records, rows, org, metrics, loading, error, refresh };
}
