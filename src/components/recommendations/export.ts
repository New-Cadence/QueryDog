// Markdown and CSV exports of the currently filtered recommendations.
import { CATEGORY_META, formatMoney } from './meta';
import type { RecommendationRow } from './types';

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function exportMarkdown(rows: RecommendationRow[], env: string) {
  const savings = rows.reduce((s, r) => s + (r.estimatedMonthlySaving || 0), 0);
  const lines = [
    `# ClickHouse recommendations: ${env}`,
    '',
    `Generated ${new Date().toLocaleString()} - ${rows.length} recommendation(s)` + (savings ? `, potential savings ${formatMoney(savings)}/month` : ''),
    '',
    '| Severity | Category | Title | Target | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.severity} | ${CATEGORY_META[r.category].label} | ${r.title.replace(/\|/g, '\\|')} | ${(r.target || '').replace(/\|/g, '\\|')} | ${r.status} |`),
    '',
  ];
  for (const r of rows) {
    lines.push(`## [${r.severity.toUpperCase()}] ${r.title}`, '');
    lines.push(`- **Category:** ${CATEGORY_META[r.category].label}`);
    if (r.target) lines.push(`- **Target:** ${r.target}`);
    if (r.impact) lines.push(`- **Impact:** ${r.impact}`);
    if (r.estimatedMonthlySaving) lines.push(`- **Estimated saving:** ${formatMoney(r.estimatedMonthlySaving)}/month`);
    lines.push(`- **Status:** ${r.status}${r.reason ? ` (${r.reason})` : ''}`, '', r.detail, '');
    if (r.remediation) lines.push('```sql', r.remediation, '```', '');
  }
  download(`recommendations-${stamp()}.md`, lines.join('\n'), 'text/markdown');
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(rows: RecommendationRow[]) {
  const header = ['id', 'category', 'severity', 'status', 'title', 'target', 'impact', 'estimated_monthly_saving', 'detail', 'remediation', 'first_seen', 'last_seen', 'reason'];
  const body = rows.map(r =>
    [r.id, r.category, r.severity, r.status, r.title, r.target, r.impact, r.estimatedMonthlySaving, r.detail, r.remediation, r.firstSeen, r.lastSeen, r.reason]
      .map(csvCell)
      .join(','),
  );
  download(`recommendations-${stamp()}.csv`, [header.join(','), ...body].join('\n'), 'text/csv');
}
