// Contract shared by every recommendation provider. Each area of Mission
// Control (cost, security, performance, ...) contributes a provider; the
// Recommendations mode aggregates, filters and tracks them in one place.

export type RecommendationCategory = 'cost' | 'security' | 'performance' | 'schema' | 'reliability' | 'documentation' | 'dataquality';

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Recommendation {
  // Stable across runs so dismissals survive refreshes, e.g. 'security:no-password:legacy_app'
  id: string;
  category: RecommendationCategory;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
  // The object it applies to: a table, user, service, query hash...
  target?: string;
  // SQL or a concrete action the user can take
  remediation?: string;
  // Short human readable impact, e.g. 'Saves ~$420/month' or 'Cuts p95 by ~40%'
  impact?: string;
  // Used to rank cost recommendations and total potential savings
  estimatedMonthlySaving?: number;
  // 'code' shows the remediation as monospace text to copy, e.g. a file for
  // the repo; by default SQL-looking text gets Open in Query Editor
  remediationFormat?: 'code';
}

export interface RecommendationProvider {
  category: RecommendationCategory;
  label: string;
  // Providers query ClickHouse through the existing API helpers and must not
  // throw for missing system tables / permissions: return [] instead.
  run: () => Promise<Recommendation[]>;
}
