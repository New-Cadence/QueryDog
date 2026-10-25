// Guard for endpoints that run user-supplied SQL. ClickHouse executes one
// statement per request, so checking the leading keyword is enough — but only
// after stripping comments, otherwise `/* x */ DROP ...` slips through.
const BLOCKED_KEYWORDS = ['DROP', 'TRUNCATE', 'DELETE', 'ALTER', 'DETACH', 'ATTACH', 'RENAME', 'KILL'];

export function leadingKeyword(sql) {
  let rest = String(sql);
  for (;;) {
    const trimmed = rest.replace(/^[\s(]+/, '');
    if (trimmed.startsWith('--') || trimmed.startsWith('#')) {
      const nl = trimmed.indexOf('\n');
      rest = nl === -1 ? '' : trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      rest = end === -1 ? '' : trimmed.slice(end + 2);
    } else {
      return (trimmed.match(/^[A-Za-z]+/)?.[0] || '').toUpperCase();
    }
  }
}

export function isBlockedStatement(sql) {
  return BLOCKED_KEYWORDS.includes(leadingKeyword(sql));
}
