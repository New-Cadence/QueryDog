// Non-component helpers shared by the Security tabs.
import type { RecommendationSeverity } from '../../recommendations/types';
import type { Principal, SecurityData } from './model';

export const GRID_DEFAULT_COL_DEF = { resizable: true, sortable: true, suppressMovable: true };

export const severityTone: Record<RecommendationSeverity, 'red' | 'yellow' | 'blue'> = {
  critical: 'red', high: 'red', medium: 'yellow', low: 'blue',
};

export const selectClass = 'bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500';

export const chartAxis = { fill: '#9ca3af', fontSize: 10 };
export const chartTooltip = { backgroundColor: '#1f2937', border: '1px solid #374151', fontSize: 11 };

// Principals are kept in <select> values as 'user:<name>' / 'role:<name>'
export function parsePrincipalId(id: string): Principal {
  const i = id.indexOf(':');
  return { kind: id.slice(0, i) as Principal['kind'], name: id.slice(i + 1) };
}

export function defaultPrincipalId(data: SecurityData, skip = 0): string {
  const users = data.users.filter(u => u.name !== 'default');
  const u = users[skip] || users[0] || data.users[0];
  return u ? `user:${u.name}` : '';
}
