// Metadata header shared by every .sql file in the client folders (monitoring,
// performance / testing, data quality): leading `-- key: value` comment lines,
// e.g.
//
//   -- title: Merges waiting too long
//   -- description: Parts waiting to merge
//   -- severity: warning
//   -- category: Merges
//   SELECT ...
//
// Keys are case-insensitive; the header ends at the first other line.
import fs from 'fs';

const HEADER_RE = /^--\s*([a-z_]+):\s?(.*)$/i;
export const SEVERITIES = ['critical', 'warning', 'info'];

export function parseSqlHeader(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const meta = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    if (!m) break;
    meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: lines.slice(i).join('\n').trim() };
}

// The common fields, with a valid severity or null when unset / unknown
export function checkMeta(meta) {
  const severity = String(meta.severity || '').toLowerCase();
  return {
    // Descriptive name of the check, shown first in the grids
    title: meta.title || meta.name || '',
    description: meta.description || '',
    severity: SEVERITIES.includes(severity) ? severity : null,
    // `-- experiment:` is the older name used by the testing queries
    category: meta.category || meta.experiment || '',
  };
}

export function readSqlHeader(filePath) {
  try {
    return parseSqlHeader(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { meta: {}, body: '' };
  }
}

// Duration limits of a performance query, from `-- warn_duration_ms:` and
// `-- fail_duration_ms:`; null when unset or not a number
export function durationLimits(meta) {
  const ms = v => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return { warnDurationMs: ms(meta.warn_duration_ms), failDurationMs: ms(meta.fail_duration_ms) };
}

// Status of a successful run against its limits: fail at or over
// fail_duration_ms, warn at or over warn_duration_ms, else ok
export function durationStatus(durationMs, { warnDurationMs, failDurationMs }) {
  if (failDurationMs != null && durationMs >= failDurationMs) return { status: 'fail', detail: `Took ${durationMs} ms, fail_duration_ms is ${failDurationMs} ms` };
  if (warnDurationMs != null && durationMs >= warnDurationMs) return { status: 'warn', detail: `Took ${durationMs} ms, warn_duration_ms is ${warnDurationMs} ms` };
  return { status: 'ok', detail: null };
}
