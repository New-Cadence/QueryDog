// Display metadata for recommendation categories and severities, matching
// the colours and icons of the corresponding Convoy modes.
import { BadgeCheck, BookOpen, CircleDollarSign, Gauge, HeartPulse, ShieldCheck, Table2, type LucideIcon } from 'lucide-react';
import type { RecommendationCategory, RecommendationSeverity } from '../../recommendations';
import type { TriageStatus } from './triage';

export const CATEGORY_META: Record<RecommendationCategory, { label: string; icon: LucideIcon; text: string; color: string }> = {
  security: { label: 'Security', icon: ShieldCheck, text: 'text-red-400', color: '#ef4444' },
  cost: { label: 'Cost', icon: CircleDollarSign, text: 'text-emerald-400', color: '#10b981' },
  performance: { label: 'Performance', icon: Gauge, text: 'text-blue-400', color: '#3b82f6' },
  schema: { label: 'Schema', icon: Table2, text: 'text-cyan-400', color: '#06b6d4' },
  reliability: { label: 'Reliability', icon: HeartPulse, text: 'text-orange-400', color: '#f97316' },
  documentation: { label: 'Documentation', icon: BookOpen, text: 'text-teal-400', color: '#14b8a6' },
  dataquality: { label: 'Data quality', icon: BadgeCheck, text: 'text-sky-400', color: '#0ea5e9' },
};

export const CATEGORIES = Object.keys(CATEGORY_META) as RecommendationCategory[];

export const SEVERITY_RANK: Record<RecommendationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const SEVERITY_TONE: Record<RecommendationSeverity, 'red' | 'yellow' | 'blue' | 'default'> = {
  critical: 'red',
  high: 'red',
  medium: 'yellow',
  low: 'blue',
};

export const STATUS_TONE: Record<TriageStatus, 'default' | 'blue' | 'yellow' | 'green'> = {
  open: 'default',
  acknowledged: 'blue',
  snoozed: 'yellow',
  dismissed: 'default',
  resolved: 'green',
};

// Remediation text that starts like a SQL statement gets the SQL treatment
// (monospace block, Open in Query Editor).
export const looksLikeSql = (text: string) =>
  /^\s*(--|SELECT|WITH|ALTER|CREATE|DROP|SYSTEM|SET|KILL|OPTIMIZE|GRANT|REVOKE|EXPLAIN|INSERT|BACKUP|RENAME|TRUNCATE|DETACH|ATTACH|SHOW|COMMENT)\b/i.test(text);

export const formatMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
