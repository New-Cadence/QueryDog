// Data Quality extension - see server/extensions/index.js for the ctx contract.
//
// Rules describe a check on a database.table (usually one column): not null,
// uniqueness, accepted values, regex, numeric range, string length, freshness,
// row count, referential integrity or custom SQL. SQL for the built-in types
// is generated here: identifiers must match a strict pattern, are checked
// against system.columns and are backtick-quoted; values travel as query
// parameters. Every check runs with readonly=2 and max_execution_time.
//
// Rules are SQL assertions stored as .sql files in the client's dataquality
// folder: a header of `-- key: value` comments, then a query returning the
// failing rows. A file with only SQL is a plain assertion that passes when it
// returns no rows; a `-- rule:` header holds a built-in rule definition (not
// null, unique, ...) instead. Rules are read-only here: change the files in
// the repo. Rules run on demand, from the UI or from the backend scheduler
// (server/scheduler.js). Run history is stored in the Convoy database.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { leadingKeyword } from '../sqlGuard.js';
import { parseSqlHeader } from '../sqlHeader.js';
import { getSetting, setSetting, importJsonFile, recordCheckRun } from '../db.js';

const QUERY_TIMEOUT_S = 60;
const HISTORY_LIMIT = 50;        // runs kept per rule
const SAMPLE_LIMIT = 10;         // failing rows captured per run
const SAMPLE_RUNS = 5;           // only the newest runs of a rule keep their sample
const SAMPLE_VALUE_CHARS = 200;
const STATE_POINTS = 30;         // history points per rule sent with /state
const RUN_CONCURRENCY = 4;
const TREND_DAYS = 30;
const PROFILE_ROWS = 200000;
const PROFILE_COLUMNS = 80;

export const RULE_TYPES = [
  'not_null', 'unique', 'accepted_values', 'regex', 'range', 'length',
  'freshness', 'row_count', 'referential', 'custom_sql',
];
const COLUMN_TYPES = new Set(['not_null', 'accepted_values', 'regex', 'range', 'length', 'freshness', 'referential']);
// Pass/fail checks on the whole table rather than a share of failing rows
const BINARY_TYPES = new Set(['freshness', 'row_count']);
const SEVERITIES = ['critical', 'warning', 'info'];
const SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 };
const CUSTOM_MODES = ['rows', 'count', 'boolean'];
// No quotes, backticks, backslashes or whitespace, so backtick-quoting is always safe
const IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,190}$/;
const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const nowIso = () => new Date().toISOString();
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = name => '`' + name + '`';
const tableRef = (db, table) => `${q(db)}.${q(table)}`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = msg => new HttpError(400, msg);

// ==================== Type helpers ====================

function baseType(type) {
  let t = String(type);
  for (let m; (m = t.match(/^(?:Nullable|LowCardinality)\((.*)\)$/)); ) t = m[1];
  return t;
}
const isNullableType = type => /(^|\()Nullable\(/.test(String(type));
const isNumericType = type => /^(U?Int\d+|Float\d+|Decimal)/.test(baseType(type));
const isUnsignedType = type => /^UInt\d+/.test(baseType(type));
const isDateType = type => /^(Date|Date32|DateTime|DateTime64)\b/.test(baseType(type));
const isStringType = type => /^(String|FixedString)/.test(baseType(type));
// Columns uniq()/min()/toString() make sense on
const isScalarType = type => !/^(Array|Map|Tuple|Nested|JSON|Object|AggregateFunction|SimpleAggregateFunction|Variant|Dynamic)/.test(baseType(type));

// ==================== Validation ====================

function ident(name, what) {
  const s = String(name ?? '').trim();
  if (!IDENT_RE.test(s)) throw bad(`Invalid ${what} name`);
  return s;
}

function optionalNumber(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${what} must be a number`);
  return n;
}

// Optional row filter, spliced in as WHERE (<filter>). It has to be raw SQL, so
// it is limited to a single boolean expression: balanced quotes and brackets,
// no statement separators, comments, subqueries, SETTINGS or FORMAT. Checks
// also run with readonly=2.
function checkFilter(where) {
  const w = String(where ?? '').trim();
  if (!w) return '';
  if (w.length > 2000) throw bad('Filter is too long');
  let depth = 0;
  let quote = null;
  let outside = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; outside += ' '; continue; }
    if (ch === ';' || ch === '#' || (ch === '-' && w[i + 1] === '-') || (ch === '/' && w[i + 1] === '*')) {
      throw bad('Filter may not contain semicolons or comments');
    }
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) throw bad('Filter has unbalanced brackets');
    outside += ch;
  }
  if (quote) throw bad('Filter has an unterminated quote');
  if (depth !== 0) throw bad('Filter has unbalanced brackets');
  if (/\b(SELECT|UNION|EXCEPT|INTERSECT|FORMAT|SETTINGS|INTO|INSERT|FROM)\b/i.test(outside)) {
    throw bad('Filter must be a plain boolean expression (no subqueries, FROM, SETTINGS or FORMAT)');
  }
  return w;
}

// Same guard as alerting: strip comments, then require SELECT or WITH. A single
// statement only, without a trailing FORMAT (the check wraps it in a subquery).
function checkCustomSql(sql) {
  const s = String(sql ?? '').trim().replace(/;+\s*$/, '').replace(/\s+FORMAT\s+\w+\s*$/i, '');
  if (!s) throw bad('Custom SQL is required');
  if (s.length > 20000) throw bad('Custom SQL is too long');
  if (!['SELECT', 'WITH'].includes(leadingKeyword(s))) throw bad('Custom SQL must be a read-only SELECT or WITH query');
  if (s.includes(';')) throw bad('Custom SQL must be a single statement');
  return s;
}

function defaultName(rule) {
  const target = rule.type === 'unique' ? rule.columns.join(', ') : rule.column;
  const label = {
    not_null: rule.params.treatEmptyAsNull ? 'not empty' : 'not null', unique: 'unique', accepted_values: 'accepted values',
    regex: 'matches pattern', range: 'in range', length: 'length', freshness: 'fresh', row_count: 'row count',
    referential: `exists in ${rule.params.refTable}`, custom_sql: 'custom check',
  }[rule.type];
  return `${rule.table}${target ? `.${target}` : ''} ${label}`;
}

// Normalise an incoming rule. Only known fields with valid values survive;
// anything invalid is a 400. The catalog check happens separately (resolve).
function sanitizeRule(body) {
  const b = isObject(body) ? body : {};
  if (!RULE_TYPES.includes(b.type)) throw bad('Unknown rule type');
  const threshold = optionalNumber(b.threshold, 'Threshold') ?? 0;
  if (threshold < 0 || threshold > 100) throw bad('Threshold must be between 0 and 100 (%)');
  const rule = {
    name: String(b.name ?? '').trim().slice(0, 200),
    description: String(b.description ?? '').trim().slice(0, 1000),
    type: b.type,
    database: ident(b.database, 'database'),
    table: ident(b.table, 'table'),
    column: null,
    columns: [],
    params: {},
    where: b.type === 'custom_sql' ? '' : checkFilter(b.where),
    severity: SEVERITIES.includes(b.severity) ? b.severity : 'warning',
    threshold,
    tags: (Array.isArray(b.tags) ? b.tags : []).map(t => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10),
    category: String(b.category ?? '').trim().slice(0, 80),
  };
  const p = isObject(b.params) ? b.params : {};
  if (COLUMN_TYPES.has(rule.type)) rule.column = ident(b.column, 'column');

  switch (rule.type) {
    case 'not_null':
      rule.params = { treatEmptyAsNull: Boolean(p.treatEmptyAsNull) };
      break;
    case 'unique': {
      const cols = Array.isArray(b.columns) && b.columns.length ? b.columns : b.column ? [b.column] : [];
      rule.columns = [...new Set(cols.map(c => ident(c, 'column')))];
      if (!rule.columns.length || rule.columns.length > 8) throw bad('Uniqueness needs 1 to 8 key columns');
      break;
    }
    case 'accepted_values': {
      const values = (Array.isArray(p.values) ? p.values : []).map(v => String(v).slice(0, 500));
      if (!values.length || values.length > 1000) throw bad('Accepted values needs 1 to 1000 values');
      rule.params = { values: [...new Set(values)] };
      break;
    }
    case 'regex': {
      const pattern = String(p.pattern ?? '');
      if (!pattern || pattern.length > 1000) throw bad('A regular expression is required');
      rule.params = { pattern };
      break;
    }
    case 'range': {
      const min = optionalNumber(p.min, 'Minimum');
      const max = optionalNumber(p.max, 'Maximum');
      if (min === null && max === null) throw bad('Set a minimum, a maximum or both');
      if (min !== null && max !== null && min > max) throw bad('Minimum is greater than maximum');
      rule.params = { min, max };
      break;
    }
    case 'length': {
      const minLength = optionalNumber(p.minLength, 'Minimum length');
      const maxLength = optionalNumber(p.maxLength, 'Maximum length');
      if (minLength === null && maxLength === null) throw bad('Set a minimum length, a maximum length or both');
      if ([minLength, maxLength].some(n => n !== null && (n < 0 || !Number.isInteger(n)))) throw bad('Lengths must be whole numbers');
      if (minLength !== null && maxLength !== null && minLength > maxLength) throw bad('Minimum length is greater than maximum length');
      rule.params = { minLength, maxLength };
      break;
    }
    case 'freshness': {
      const maxAgeMinutes = optionalNumber(p.maxAgeMinutes, 'Maximum age');
      if (!maxAgeMinutes || maxAgeMinutes <= 0) throw bad('Maximum age (minutes) must be positive');
      rule.params = { maxAgeMinutes };
      break;
    }
    case 'row_count': {
      const min = optionalNumber(p.min, 'Minimum rows');
      const max = optionalNumber(p.max, 'Maximum rows');
      const maxChangePct = optionalNumber(p.maxChangePct, 'Maximum change');
      if (min === null && max === null && maxChangePct === null) throw bad('Set a minimum, maximum or maximum change');
      if (min !== null && max !== null && min > max) throw bad('Minimum rows is greater than maximum rows');
      if (maxChangePct !== null && maxChangePct <= 0) throw bad('Maximum change must be positive');
      rule.params = { min, max, maxChangePct };
      break;
    }
    case 'referential':
      rule.params = {
        refDatabase: ident(p.refDatabase, 'referenced database'),
        refTable: ident(p.refTable, 'referenced table'),
        refColumn: ident(p.refColumn, 'referenced column'),
      };
      break;
    case 'custom_sql':
      rule.params = { sql: checkCustomSql(p.sql), mode: CUSTOM_MODES.includes(p.mode) ? p.mode : 'rows' };
      break;
  }
  if (!rule.name) rule.name = defaultName(rule);
  return rule;
}

// ==================== SQL generation ====================

// Build the check (and failing-row sample) queries for a rule. `info` holds the
// column types from resolve(). Row-level rules count rows matching a failure
// condition; the others return their own shape and are scored in evaluate().
function buildPlan(rule, info) {
  const from = tableRef(rule.database, rule.table);
  const params = {};
  const where = (...conds) => {
    const all = [rule.where ? `(${rule.where})` : '', ...conds].filter(Boolean);
    return all.length ? `\nWHERE ${all.join('\n  AND ')}` : '';
  };
  const c = rule.column ? q(rule.column) : null;
  const p = rule.params;
  let fail = null;

  switch (rule.type) {
    case 'not_null':
      fail = p.treatEmptyAsNull && isStringType(info.colType) ? `(isNull(${c}) OR empty(${c}))` : `isNull(${c})`;
      break;
    case 'accepted_values':
      params.dq_values = p.values;
      fail = `${c} IS NOT NULL AND NOT has({dq_values:Array(String)}, toString(${c}))`;
      break;
    case 'regex':
      params.dq_pattern = p.pattern;
      fail = `${c} IS NOT NULL AND NOT match(toString(${c}), {dq_pattern:String})`;
      break;
    case 'range': {
      const parts = [];
      if (p.min !== null) { params.dq_min = p.min; parts.push(`toFloat64(${c}) < {dq_min:Float64}`); }
      if (p.max !== null) { params.dq_max = p.max; parts.push(`toFloat64(${c}) > {dq_max:Float64}`); }
      fail = `${c} IS NOT NULL AND (${parts.join(' OR ')})`;
      break;
    }
    case 'length': {
      const parts = [];
      if (p.minLength !== null) { params.dq_min_len = p.minLength; parts.push(`lengthUTF8(toString(${c})) < {dq_min_len:UInt64}`); }
      if (p.maxLength !== null) { params.dq_max_len = p.maxLength; parts.push(`lengthUTF8(toString(${c})) > {dq_max_len:UInt64}`); }
      fail = `${c} IS NOT NULL AND (${parts.join(' OR ')})`;
      break;
    }
    case 'referential': {
      const ref = tableRef(p.refDatabase, p.refTable);
      fail = `${c} IS NOT NULL AND ${c} NOT IN (SELECT ${q(p.refColumn)} FROM ${ref})`;
      break;
    }
    case 'unique': {
      const keys = rule.columns.map(q).join(', ');
      return {
        params,
        check: `SELECT\n  count() AS total,\n  count() - uniqExact(${keys}) AS failing\nFROM ${from}${where()}`,
        sample: `SELECT ${keys}, count() AS duplicate_rows\nFROM ${from}${where()}\nGROUP BY ${keys}\nHAVING duplicate_rows > 1\nORDER BY duplicate_rows DESC\nLIMIT ${SAMPLE_LIMIT}`,
      };
    }
    case 'freshness': {
      const latest = `toDateTime(max(${c}))`;
      return {
        params,
        check: `SELECT\n  count() AS rows,\n  ${latest} AS latest,\n  dateDiff('second', ${latest}, now()) AS age_seconds\nFROM ${from}${where()}`,
        sample: null,
      };
    }
    case 'row_count':
      return { params, check: `SELECT count() AS row_count\nFROM ${from}${where()}`, sample: null };
    case 'custom_sql': {
      const total = rule.table ? `SELECT count() AS total\nFROM ${from}` : null;
      if (p.mode === 'rows') {
        return {
          params, total,
          check: `SELECT count() AS failing\nFROM (\n${p.sql}\n)`,
          sample: `SELECT *\nFROM (\n${p.sql}\n)\nLIMIT ${SAMPLE_LIMIT}`,
        };
      }
      return { params, total: p.mode === 'count' ? total : null, check: p.sql, sample: null };
    }
  }
  return {
    params,
    check: `SELECT\n  count() AS total,\n  countIf(${fail}) AS failing\nFROM ${from}${where()}`,
    sample: `SELECT *\nFROM ${from}${where(`(${fail})`)}\nLIMIT ${SAMPLE_LIMIT}`,
  };
}

// ==================== Rule files ====================

// Parse a rule file (shared header format, see ../sqlHeader.js) into a
// sanitised rule. Throws on invalid content.
function parseRuleFile(id, text) {
  const { meta, body } = parseSqlHeader(text);
  const [database, table] = meta.table ? (meta.table.includes('.') ? meta.table.split(/\.(.*)/s) : ['default', meta.table]) : ['', ''];
  const common = {
    name: meta.title || meta.name || id,
    description: meta.description || '',
    severity: meta.severity,
    threshold: meta.threshold || 0,
    tags: meta.tags ? meta.tags.split(',') : [],
    category: meta.category || '',
  };
  if (meta.rule) throw bad('-- rule: is no longer supported: write the check as SQL that returns the failing rows');
  if (table) return sanitizeRule({ ...common, type: 'custom_sql', database, table, params: { sql: body, mode: 'rows' } });
  // An assertion that isn't tied to one table
  const rule = sanitizeRule({ ...common, type: 'custom_sql', database: 'default', table: 'assertion', params: { sql: body, mode: 'rows' } });
  return { ...rule, database: '', table: '' };
}

// A suggested check as the SQL a check file holds: a query returning the
// failing rows (or one row when a table-level condition fails).
function failingRowsSql(rule, plan) {
  const from = tableRef(rule.database, rule.table);
  const c = rule.column ? q(rule.column) : null;
  if (rule.type === 'freshness') {
    return `SELECT max(${c}) AS latest, dateDiff('minute', latest, now()) AS age_minutes\nFROM ${from}\nHAVING age_minutes > ${Number(rule.params.maxAgeMinutes)}`;
  }
  if (rule.type === 'row_count') {
    const { min, max } = rule.params;
    const conds = [min !== null && min !== undefined ? `row_count < ${Number(min)}` : '', max !== null && max !== undefined ? `row_count > ${Number(max)}` : ''].filter(Boolean);
    return `SELECT count() AS row_count\nFROM ${from}\nHAVING ${conds.join(' OR ') || '0'}`;
  }
  return previewSql(plan.sample, plan.params).replace(/\nLIMIT \d+$/, '');
}

// Inline the query parameters so the UI can show runnable SQL. Display only;
// execution always sends them as parameters.
function previewSql(sql, params) {
  if (!sql) return sql;
  const lit = v => (typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
  return sql.replace(/\{(dq_\w+):[^}]+\}/g, (m, name) => {
    const v = params[name];
    if (v === undefined) return m;
    return Array.isArray(v) ? `[${v.map(lit).join(', ')}]` : lit(v);
  });
}

// Keep sample rows small: long strings are cut and nested values stringified.
function trimSample(rows) {
  return rows.slice(0, SAMPLE_LIMIT).map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const s = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      out[k] = typeof s === 'string' && s.length > SAMPLE_VALUE_CHARS ? `${s.slice(0, SAMPLE_VALUE_CHARS)}…` : s;
    }
    return out;
  });
}

const toNum = v => (v === null || v === undefined || v === '' ? null : Number(v));
const truthy = v => !(v === 0 || v === '0' || v === false || v === 'false' || v === null || v === undefined || v === '');

export function register(app, ctx) {

  // ==================== Persistence ====================

  // Run history used to live in <dataDir>/dataquality.json; rules come from files
  importJsonFile('dataquality', 'dataquality.json', ({ history = {} }) => ({ history }));
  const state = { rules: [], history: getSetting('dataquality', { history: {} }).history || {} };
  const READ_ONLY = 'Read-only: data quality rules are loaded from the client folder in the repo. Change them there.';

  // ---------- Rule files (the client's dataquality folder) ----------

  const rulesDir = () => ctx.getClientFolder('dataquality');
  let dirSignature = null;
  let fileErrors = [];

  function readDir() {
    const dir = rulesDir();
    if (!fs.existsSync(dir)) return { dir, files: [] };
    return { dir, files: fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort() };
  }

  function signature() {
    const { dir, files } = readDir();
    return dir + '|' + files.map(f => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
  }

  // (Re)load rules when files change on disk. Rule ids are file names.
  function refreshRules() {
    const sig = signature();
    if (sig === dirSignature) return;
    const { dir, files } = readDir();
    const rules = [];
    const errors = [];
    for (const file of files) {
      const id = file.replace(/\.sql$/, '');
      try {
        const text = fs.readFileSync(path.join(dir, file), 'utf-8');
        const stat = fs.statSync(path.join(dir, file));
        rules.push({ id, ...parseRuleFile(id, text), file, createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString() });
      } catch (e) {
        errors.push({ file, error: e.message });
        console.error(`[dataquality] skipping ${file}: ${e.message}`);
      }
    }
    state.rules = rules;
    fileErrors = errors;
    dirSignature = sig;
  }

  function save() {
    try {
      setSetting('dataquality', { history: state.history });
    } catch (e) {
      console.error('[dataquality] could not save state:', e.message);
    }
  }

  refreshRules();

  const envName = () => ctx.getActiveEnvironment()?.name || 'default';
  const findRule = id => state.rules.find(r => r.id === id);
  const runsFor = (id, env) => (state.history[id] || []).filter(r => !env || r.environment === env);
  const latestRun = (id, env, pred = () => true) => runsFor(id, env).findLast(pred) || null;

  // ==================== ClickHouse ====================

  async function queryJson(query, query_params = {}) {
    const client = ctx.getClient();
    const run = clickhouse_settings => client.query({
      query, query_params, format: 'JSON', clickhouse_settings,
      request_timeout: (QUERY_TIMEOUT_S + 5) * 1000,
    });
    let result;
    try {
      result = await run({ readonly: '2', max_execution_time: QUERY_TIMEOUT_S, log_comment: 'querydog-dataquality' });
    } catch (e) {
      // Users whose profile is already readonly=1 can't change any setting;
      // they are read-only anyway, so retry without settings
      if (!/Cannot modify '\w+' setting in readonly mode/i.test(e.message)) throw e;
      result = await run({});
    }
    const json = await result.json();
    return { data: json.data || [], meta: json.meta || [], queryId: result.query_id };
  }

  async function tableColumns(database, table) {
    const { data } = await queryJson(
      `SELECT name, type, is_in_primary_key, is_in_sorting_key FROM system.columns
       WHERE database = {database:String} AND table = {table:String} ORDER BY position`,
      { database, table },
    );
    if (!data.length) throw bad(`Table ${database}.${table} not found`);
    return data;
  }

  // Check the rule's table and columns exist and have suitable types.
  async function resolve(rule) {
    if (!rule.table) return { cols: new Map(), colType: null };
    const cols = new Map((await tableColumns(rule.database, rule.table)).map(c => [c.name, c.type]));
    const needed = rule.type === 'unique' ? rule.columns : rule.column ? [rule.column] : [];
    for (const c of needed) {
      if (!cols.has(c)) throw bad(`Column ${c} not found in ${rule.database}.${rule.table}`);
    }
    const colType = rule.column ? cols.get(rule.column) : null;
    if (rule.type === 'range' && !isNumericType(colType)) throw bad(`Range checks need a numeric column (${rule.column} is ${colType})`);
    if (rule.type === 'freshness' && !isDateType(colType)) throw bad(`Freshness needs a Date or DateTime column (${rule.column} is ${colType})`);
    if (rule.type === 'referential') {
      const { refDatabase, refTable, refColumn } = rule.params;
      const refCols = new Map((await tableColumns(refDatabase, refTable)).map(c => [c.name, c.type]));
      if (!refCols.has(refColumn)) throw bad(`Column ${refColumn} not found in ${refDatabase}.${refTable}`);
    }
    return { cols, colType };
  }

  // ==================== Evaluation ====================

  // Run one rule against the current environment. Never throws: failures to
  // run become status 'error' so they show up in history.
  async function executeRule(rule, previous) {
    const startedAt = Date.now();
    const out = {
      status: 'error', total: null, failing: null, failurePct: null, compliance: null,
      detail: null, metric: null, error: null, sample: [], sampleColumns: [], sql: null, queryId: null,
    };
    try {
      const info = await resolve(rule);
      const plan = buildPlan(rule, info);
      out.sql = previewSql(plan.check, plan.params);
      const check = await queryJson(plan.check, plan.params);
      out.queryId = check.queryId;
      const row = check.data[0] || {};
      const p = rule.params;

      if (rule.type === 'freshness') {
        const age = toNum(row.age_seconds);
        out.metric = { latest: row.latest ?? null, ageSeconds: age, rows: toNum(row.rows) };
        out.total = 1;
        out.failing = age === null || age > p.maxAgeMinutes * 60 || !toNum(row.rows) ? 1 : 0;
        out.detail = !toNum(row.rows) ? 'No rows' : `Latest ${row.latest} (${formatAge(age)} old, limit ${formatAge(p.maxAgeMinutes * 60)})`;
      } else if (rule.type === 'row_count') {
        const count = toNum(row.row_count) ?? 0;
        const prev = previous?.metric?.rowCount ?? null;
        const problems = [];
        if (p.min !== null && count < p.min) problems.push(`below minimum ${p.min}`);
        if (p.max !== null && count > p.max) problems.push(`above maximum ${p.max}`);
        let changePct = null;
        if (p.maxChangePct !== null && prev !== null) {
          changePct = prev === 0 ? (count === 0 ? 0 : 100) : ((count - prev) / prev) * 100;
          if (Math.abs(changePct) > p.maxChangePct) problems.push(`changed ${changePct.toFixed(1)}% (limit ±${p.maxChangePct}%)`);
        }
        out.metric = { rowCount: count, previousRowCount: prev, changePct };
        out.total = 1;
        out.failing = problems.length ? 1 : 0;
        out.detail = `${count.toLocaleString()} rows${problems.length ? `: ${problems.join(', ')}` : ''}`;
      } else if (rule.type === 'custom_sql' && p.mode !== 'rows') {
        const first = check.meta[0]?.name;
        const value = first ? row[first] : undefined;
        if (p.mode === 'boolean') {
          out.total = 1;
          out.failing = truthy(value) ? 0 : 1;
          out.detail = `Returned ${value === undefined ? 'no rows' : JSON.stringify(value)}`;
        } else {
          const n = toNum(value);
          if (n === null || !Number.isFinite(n)) throw new Error('Count mode expects the first column of the first row to be a number');
          out.failing = n;
          out.total = toNum((await queryJson(plan.total)).data[0]?.total);
          out.detail = `Returned ${n.toLocaleString()} failing rows`;
        }
        out.metric = { value: value ?? null };
      } else {
        out.failing = toNum(row.failing) ?? 0;
        out.total = plan.total ? toNum((await queryJson(plan.total)).data[0]?.total) : toNum(row.total) ?? 0;
        if (rule.type === 'unique') out.detail = `${out.failing.toLocaleString()} duplicate rows`;
      }

      const binary = BINARY_TYPES.has(rule.type) || (rule.type === 'custom_sql' && p.mode === 'boolean');
      if (binary) {
        out.failurePct = out.failing ? 100 : 0;
        out.status = out.failing ? 'fail' : 'pass';
      } else {
        out.failurePct = out.total > 0 ? Math.min(100, (out.failing / out.total) * 100) : out.failing > 0 ? 100 : 0;
        out.status = out.failing === 0 || out.failurePct <= rule.threshold ? 'pass' : 'fail';
      }
      out.compliance = Math.max(0, 100 - out.failurePct);

      if (out.failing > 0 && plan.sample) {
        try {
          const s = await queryJson(plan.sample, plan.params);
          out.sample = trimSample(s.data);
          out.sampleColumns = s.meta.map(m => m.name);
        } catch (e) {
          out.sampleError = e.message.slice(0, 500);
        }
      }
    } catch (e) {
      out.status = 'error';
      out.error = String(e.message || e).slice(0, 2000);
    }
    out.duration = Date.now() - startedAt;
    return out;
  }

  // One run per rule at a time, so a manual run during a scheduler tick can't
  // record the same check twice
  const inFlight = new Map();
  function runRule(id, trigger) {
    if (!inFlight.has(id)) {
      inFlight.set(id, runOnce(id, trigger).finally(() => inFlight.delete(id)));
    }
    return inFlight.get(id);
  }

  async function runOnce(id, trigger) {
    const rule = findRule(id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    const environment = envName();
    const time = nowIso();
    const previous = latestRun(id, environment, r => r.status !== 'error');
    const result = await executeRule(rule, previous);
    // The rule may have been deleted while it ran
    if (!findRule(id)) return { id: null, ruleId: id, time, environment, trigger, ...result };
    // The backend scheduler calls the same endpoints with a scheduler trigger header
    const runTrigger = ctx.getTrigger?.() === 'scheduler' ? 'scheduled' : trigger;
    const run = { id: newId('run'), ruleId: id, time, environment, trigger: runTrigger, ...result };
    recordCheckRun({
      kind: 'dataquality', checkId: id, environment, trigger: runTrigger === 'scheduled' ? 'scheduler' : 'manual',
      startedAt: time, durationMs: result.duration, status: result.status === 'pass' ? 'ok' : result.status,
      rowCount: result.failing, detail: result.detail, error: result.error, queryId: result.queryId,
    });
    const list = (state.history[id] ||= []);
    list.push(run);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    for (const old of list.slice(0, -SAMPLE_RUNS)) {
      if (old.sample?.length) { old.sample = []; old.sampleTrimmed = true; }
    }
    return run;
  }

  async function runMany(ids, trigger) {
    const queue = [...new Set(ids)];
    const runs = [];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          runs.push(await runRule(id, trigger));
        } catch (e) {
          console.error(`[dataquality] run of ${id} failed:`, e.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, queue.length) }, worker));
    save();
    return runs;
  }


  // ==================== Suggestions ====================

  const NAME_HINTS = {
    id: /^(id|uuid|guid)$|_(id|uuid|guid|key)$/i,
    amount: /(^|_)(amount|price|cost|total|qty|quantity|count|age|balance|revenue|fee|size|duration|weight|score|units)s?(_|$)/i,
    percent: /(^|_)(pct|percent|percentage|ratio|rate)(_|$)/i,
    email: /e?mail/i,
    url: /(^|_)(url|website|link|href)$/i,
    phone: /(^|_)(phone|mobile|tel)(_|$)/i,
    freeText: /comment|description|note|remark|message|extra|middle|suffix|detail|body/i,
    timestamp: /(created|updated|modified|inserted|ingested|loaded|event|timestamp|time|ts|date)/i,
  };

  // Suggested freshness limits (minutes): the first at least twice today's lag
  const FRESHNESS_STEPS = [60, 120, 360, 720, 1440, 2880, 4320, 10080, 20160];

  const PATTERNS = {
    email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
    url: '^https?://',
    phone: '^\\+?[0-9 ().-]{7,20}$',
  };

  function plural(word) {
    if (/y$/.test(word)) return [`${word.slice(0, -1)}ies`, word];
    return [`${word}s`, `${word}es`, word];
  }

  // Profile a sample of the table and turn what we see into rule drafts.
  async function suggest(database, table) {
    const columns = await tableColumns(database, table);
    const profiled = columns.filter(c => isScalarType(c.type)).slice(0, PROFILE_COLUMNS);
    const from = tableRef(database, table);
    const totalRows = toNum((await queryJson(`SELECT count() AS n FROM ${from}`)).data[0]?.n) ?? 0;

    // Null / empty / distinct / min / max over the first PROFILE_ROWS rows
    const exprs = ['count() AS sampled'];
    profiled.forEach((c, i) => {
      const col = q(c.name);
      if (isNullableType(c.type)) exprs.push(`countIf(isNull(${col})) AS n_${i}`);
      if (isStringType(c.type)) exprs.push(`countIf(empty(${col})) AS e_${i}`);
      exprs.push(`uniq(${col}) AS u_${i}`);
      if (isNumericType(c.type)) exprs.push(`toFloat64(min(${col})) AS mn_${i}`, `toFloat64(max(${col})) AS mx_${i}`);
    });
    const sampleFrom = `(SELECT ${profiled.map(c => q(c.name)).join(', ') || '1'} FROM ${from} LIMIT ${PROFILE_ROWS})`;
    const p = profiled.length ? (await queryJson(`SELECT ${exprs.join(', ')} FROM ${sampleFrom}`)).data[0] || {} : {};
    const sampled = toNum(p.sampled) ?? 0;

    const profile = profiled.map((c, i) => ({
      name: c.name,
      type: c.type,
      primaryKey: Boolean(Number(c.is_in_primary_key)),
      nullRate: isNullableType(c.type) && sampled ? toNum(p[`n_${i}`]) / sampled : 0,
      emptyRate: isStringType(c.type) && sampled ? toNum(p[`e_${i}`]) / sampled : null,
      distinct: toNum(p[`u_${i}`]),
      min: isNumericType(c.type) ? toNum(p[`mn_${i}`]) : null,
      max: isNumericType(c.type) ? toNum(p[`mx_${i}`]) : null,
      latest: null,
      ageSeconds: null,
      values: null,
    }));

    // Latest value of date columns over the whole table, for freshness
    const dateCols = profile.filter(c => isDateType(c.type)).slice(0, 6);
    if (dateCols.length && totalRows) {
      const sel = dateCols.map((c, i) => `toDateTime(max(${q(c.name)})) AS l_${i}, dateDiff('second', toDateTime(max(${q(c.name)})), now()) AS a_${i}`);
      const row = (await queryJson(`SELECT ${sel.join(', ')} FROM ${from}`)).data[0] || {};
      dateCols.forEach((c, i) => { c.latest = row[`l_${i}`]; c.ageSeconds = toNum(row[`a_${i}`]); });
    }

    // Observed value sets of low-cardinality text columns, for accepted values
    // (Enum columns are not String, so skipped: the type enforces the set)
    const valueCols = profile.filter(c =>
      isStringType(c.type) && c.distinct > 0 && c.distinct <= 15 && sampled >= 50 && !NAME_HINTS.id.test(c.name) && !NAME_HINTS.freeText.test(c.name),
    ).slice(0, 10);
    if (valueCols.length) {
      const sel = valueCols.map((c, i) => `arraySort(groupUniqArray(16)(toString(${q(c.name)}))) AS v_${i}`);
      const row = (await queryJson(`SELECT ${sel.join(', ')} FROM ${sampleFrom} WHERE 1`)).data[0] || {};
      valueCols.forEach((c, i) => { c.values = row[`v_${i}`] || null; });
    }

    // Tables in the same database, to guess foreign keys (customer_id -> customers.id)
    const siblings = new Map();
    for (const r of (await queryJson(
      'SELECT table, name FROM system.columns WHERE database = {database:String} AND table != {table:String}',
      { database, table },
    )).data) {
      if (!siblings.has(r.table)) siblings.set(r.table, new Set());
      siblings.get(r.table).add(r.name);
    }

    const out = [];
    const add = (confidence, reason, draft) => out.push({
      confidence, reason,
      rule: { database, table, severity: 'warning', threshold: 0, where: '', column: null, columns: [], params: {}, ...draft },
    });
    const pct = n => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;

    if (totalRows > 0) {
      add('high', `Table has ${totalRows.toLocaleString()} rows; alert if it empties or swings by more than half between runs`,
        { type: 'row_count', severity: 'critical', params: { min: 1, max: null, maxChangePct: 50 } });
    }

    const pkCols = profile.filter(c => c.primaryKey);
    for (const c of profile) {
      const ratio = sampled && c.distinct !== null ? c.distinct / sampled : 0;
      const idLike = NAME_HINTS.id.test(c.name) || (pkCols.length === 1 && pkCols[0] === c);

      // Missing values: NULLs, plus empty strings for text columns (one rule
      // covers both). Allow twice today's rate so only a regression fails.
      const textual = c.emptyRate !== null && !NAME_HINTS.freeText.test(c.name);
      const missing = (isNullableType(c.type) ? c.nullRate : 0) + (textual ? c.emptyRate : 0);
      if (sampled && (isNullableType(c.type) || textual) && missing < 0.05) {
        const what = textual ? (isNullableType(c.type) ? 'NULL or empty values' : 'empty strings') : 'NULLs';
        add(missing === 0 ? (isNullableType(c.type) ? 'high' : 'medium') : 'low',
          missing === 0 ? `No ${what} in ${sampled.toLocaleString()} sampled rows` : `${pct(missing)} ${what} today; flag if that more than doubles`,
          {
            type: 'not_null', column: c.name, severity: idLike ? 'critical' : 'warning',
            params: { treatEmptyAsNull: textual }, threshold: missing === 0 ? 0 : Math.ceil(missing * 200 * 100) / 100,
          });
      }

      if (idLike && sampled && ratio >= 0.98) {
        add(ratio >= 0.999 ? 'high' : 'medium', `Looks like a key: ${c.distinct?.toLocaleString()} distinct values in ${sampled.toLocaleString()} rows`,
          { type: 'unique', columns: [c.name], severity: 'critical' });
      }

      const fk = /^(.+)_id$/i.exec(c.name);
      if (fk && ratio < 0.98) {
        const target = plural(fk[1].toLowerCase()).find(t => siblings.has(t));
        if (target) {
          const refColumn = siblings.get(target).has('id') ? 'id' : siblings.get(target).has(c.name) ? c.name : null;
          if (refColumn) {
            add('medium', `${c.name} looks like a reference to ${target}.${refColumn}`,
              { type: 'referential', column: c.name, params: { refDatabase: database, refTable: target, refColumn } });
          }
        }
      }

      if (c.values?.length) {
        add('medium', `Only ${c.values.length} distinct values in the sample`, { type: 'accepted_values', column: c.name, params: { values: c.values } });
      }

      if (isNumericType(c.type) && !isUnsignedType(c.type) && c.min !== null) {
        if (NAME_HINTS.percent.test(c.name) && c.min >= 0 && c.max <= 100) {
          const max = c.max <= 1 ? 1 : 100;
          add('medium', `Values between ${c.min} and ${c.max}; looks like a ${max === 1 ? 'ratio' : 'percentage'}`, { type: 'range', column: c.name, params: { min: 0, max } });
        } else if (NAME_HINTS.amount.test(c.name) && c.min >= 0) {
          add('medium', `No negative values in the sample (min ${c.min})`, { type: 'range', column: c.name, params: { min: 0, max: null } });
        }
      }

      if (isStringType(c.type)) {
        for (const kind of ['email', 'url', 'phone']) {
          if (NAME_HINTS[kind].test(c.name)) {
            add('medium', `Column name suggests ${kind === 'email' ? 'an email address' : kind === 'url' ? 'a URL' : 'a phone number'}`,
              { type: 'regex', column: c.name, params: { pattern: PATTERNS[kind] } });
            break;
          }
        }
      }
    }

    // Freshness on the most recently updated date column, if it moves at all
    const fresh = dateCols
      .filter(c => c.ageSeconds !== null && c.ageSeconds >= 0 && c.ageSeconds < 7 * 86400)
      .sort((a, b) => Number(NAME_HINTS.timestamp.test(b.name)) - Number(NAME_HINTS.timestamp.test(a.name)) || a.ageSeconds - b.ageSeconds)[0];
    if (fresh) {
      const maxAgeMinutes = FRESHNESS_STEPS.find(m => m * 60 >= fresh.ageSeconds * 2) || FRESHNESS_STEPS.at(-1);
      add('high', `Latest ${fresh.name} is ${formatAge(fresh.ageSeconds)} old; alert if nothing new arrives within ${formatAge(maxAgeMinutes * 60)}`,
        { type: 'freshness', column: fresh.name, params: { maxAgeMinutes } });
    }

    // Name each draft and flag the ones an existing rule already covers
    // Checks are SQL files, so a suggestion counts as covered when a check on
    // the table already has its name
    const existing = new Set(state.rules.filter(r => r.database === database && r.table === table).map(r => r.name.toLowerCase()));
    const suggestions = await Promise.all(out.map(async s => {
      const rule = sanitizeRule({ ...s.rule, name: '' });
      const key = `${rule.type}:${rule.type === 'unique' ? rule.columns.join(',') : rule.column || ''}:${rule.params.treatEmptyAsNull ? 'empty' : ''}`;
      const sql = failingRowsSql(rule, buildPlan(rule, await resolve(rule)));
      return { key, confidence: s.confidence, reason: s.reason, exists: existing.has(rule.name.toLowerCase()), rule, sql };
    }));
    return { database, table, totalRows, sampledRows: sampled, columns: profile, suggestions };
  }

  // ==================== Routes ====================

  const runSummary = run => {
    if (!run) return null;
    const rest = { ...run, sampleRows: run.sample?.length || 0 };
    delete rest.sample;
    delete rest.sampleColumns;
    delete rest.sql;
    return rest;
  };

  // Daily scorecard for the environment: the last run of each rule per (UTC)
  // day, scored as the severity-weighted share of rules passing.
  function buildTrend(env) {
    const cutoff = Date.now() - TREND_DAYS * 86400000;
    const days = new Map();
    for (const rule of state.rules) {
      for (const run of runsFor(rule.id, env)) {
        if (new Date(run.time).getTime() < cutoff) continue;
        const day = run.time.slice(0, 10);
        if (!days.has(day)) days.set(day, new Map());
        days.get(day).set(rule, run);
      }
    }
    return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, byRule]) => {
      const t = { day, pass: 0, fail: 0, error: 0, score: null, compliance: null };
      let weight = 0, passed = 0, complianceSum = 0, complianceN = 0;
      for (const [rule, run] of byRule) {
        t[run.status]++;
        if (run.status === 'error') continue;
        const w = SEVERITY_WEIGHT[rule.severity] || 1;
        weight += w;
        if (run.status === 'pass') passed += w;
        complianceSum += run.compliance;
        complianceN++;
      }
      if (weight) t.score = (passed / weight) * 100;
      if (complianceN) t.compliance = complianceSum / complianceN;
      return t;
    });
  }

  function buildState() {
    const env = envName();
    return {
      trend: buildTrend(env),
      environment: env,
      folder: rulesDir(),
      fileErrors,
      running: [...inFlight.keys()],
      rules: state.rules.map(r => {
        const runs = runsFor(r.id, env);
        return {
          ...r,
          lastRun: runSummary(runs.at(-1)),
          history: runs.slice(-STATE_POINTS).map(h => ({
            time: h.time, status: h.status, compliance: h.compliance, failing: h.failing, total: h.total,
          })),
        };
      }),
    };
  }

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error(`[dataquality] ${req.method} ${req.path} failed:`, e);
      res.status(500).json({ error: e.message });
    }
  };

  // Pick up rule files added or edited on disk before handling any request
  app.use('/api/dataquality', (req, res, next) => {
    try {
      refreshRules();
    } catch (e) {
      console.error('[dataquality] could not read rule files:', e.message);
    }
    next();
  });

  app.get('/api/dataquality/state', handle((req, res) => res.json(buildState())));

  // ---------- Catalog (for the rule editor and suggestions) ----------

  app.get('/api/dataquality/catalog', handle(async (req, res) => {
    const { data } = await queryJson(
      `SELECT database, name, engine, toUInt64(ifNull(total_rows, 0)) AS total_rows
       FROM system.tables
       WHERE database NOT IN {system:Array(String)} AND NOT is_temporary AND engine NOT IN ('View', 'MaterializedView', 'Dictionary')
         AND NOT startsWith(name, '.inner')
       ORDER BY database, name`,
      { system: SYSTEM_DATABASES },
    );
    res.json(data.map(t => ({ database: t.database, table: t.name, engine: t.engine, totalRows: toNum(t.total_rows) })));
  }));

  app.get('/api/dataquality/catalog/:database/:table', handle(async (req, res) => {
    const database = ident(req.params.database, 'database');
    const table = ident(req.params.table, 'table');
    const cols = await tableColumns(database, table);
    res.json(cols.map(c => ({ name: c.name, type: c.type, primaryKey: Boolean(Number(c.is_in_primary_key)) })));
  }));

  // ---------- Rules ----------

  // Validate a draft and return its generated SQL, without saving or running it.
  app.post('/api/dataquality/rules/preview', handle(async (req, res) => {
    const rule = sanitizeRule(req.body);
    const plan = buildPlan(rule, await resolve(rule));
    res.json({
      name: rule.name,
      check: previewSql(plan.check, plan.params),
      sample: previewSql(plan.sample, plan.params),
      total: plan.total || null,
    });
  }));

  // Run a draft once without saving it or recording history.
  app.post('/api/dataquality/rules/test', handle(async (req, res) => {
    const rule = sanitizeRule(req.body);
    await resolve(rule);
    res.json(await executeRule(rule, null));
  }));

  // Rules come from the repo; refuse edits (bulk is registered before :id)
  const readOnly = (req, res) => res.status(403).json({ error: READ_ONLY });
  app.post('/api/dataquality/rules', readOnly);
  app.post('/api/dataquality/rules/batch', readOnly);
  app.post('/api/dataquality/rules/bulk', readOnly);
  app.put('/api/dataquality/rules/:id', readOnly);
  app.patch('/api/dataquality/rules/:id', readOnly);
  app.delete('/api/dataquality/rules/:id', readOnly);

  app.post('/api/dataquality/rules/:id/run', handle(async (req, res) => {
    if (!findRule(req.params.id)) throw new HttpError(404, 'Rule not found');
    const run = await runRule(req.params.id, 'manual');
    save();
    res.json(run);
  }));

  app.get('/api/dataquality/rules/:id/history', handle((req, res) => {
    if (!findRule(req.params.id)) throw new HttpError(404, 'Rule not found');
    res.json(runsFor(req.params.id, req.query.all ? null : envName()).slice().reverse());
  }));

  // Run a set of rules: explicit ids, every rule on one table, or every
  // rule. Returns the run summaries.
  app.post('/api/dataquality/run', handle(async (req, res) => {
    const { ids, database, table } = req.body || {};
    let targets;
    if (Array.isArray(ids)) targets = state.rules.filter(r => ids.includes(r.id));
    else if (database) targets = state.rules.filter(r => r.database === database && (!table || r.table === table));
    else targets = state.rules;
    const runs = await runMany(targets.map(r => r.id), 'manual');
    res.json({
      runs: runs.map(runSummary),
      passed: runs.filter(r => r.status === 'pass').length,
      failed: runs.filter(r => r.status === 'fail').length,
      errors: runs.filter(r => r.status === 'error').length,
    });
  }));

  // ---------- Results ----------

  app.get('/api/dataquality/runs', handle((req, res) => {
    const env = req.query.all ? null : envName();
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
    const runs = [];
    for (const rule of state.rules) {
      for (const run of runsFor(rule.id, env)) {
        runs.push({
          ...runSummary(run), ruleName: rule.name, type: rule.type, database: rule.database, table: rule.table,
          column: rule.type === 'unique' ? rule.columns.join(', ') : rule.column, severity: rule.severity,
        });
      }
    }
    runs.sort((a, b) => b.time.localeCompare(a.time));
    res.json(runs.slice(0, limit));
  }));

  app.get('/api/dataquality/runs/:id', handle((req, res) => {
    for (const [ruleId, list] of Object.entries(state.history)) {
      const run = list.find(r => r.id === req.params.id);
      if (run) return res.json({ ...run, rule: findRule(ruleId) || null });
    }
    throw new HttpError(404, 'Run not found');
  }));

  // ---------- Suggestions ----------

  app.get('/api/dataquality/suggest/:database/:table', handle(async (req, res) => {
    res.json(await suggest(ident(req.params.database, 'database'), ident(req.params.table, 'table')));
  }));
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.abs(seconds);
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
