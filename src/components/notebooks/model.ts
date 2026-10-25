// Notebook data model and the pure helpers that turn a cell into runnable SQL.

export type CellType = 'sql' | 'markdown' | 'param';
export type OutputView = 'table' | 'bar' | 'line' | 'area';
export type ParamKind = 'text' | 'number' | 'date' | 'dropdown';

export interface QueryStats {
  query_duration_ms: number | string;
  read_rows: number | string;
  read_bytes: number | string;
  result_rows: number | string;
  memory_usage: number | string;
}

export interface CellResult {
  data: Record<string, unknown>[];
  rowCount: number;
  truncated?: boolean;
  duration: number;
  ranAt: string;
  queryId?: string;
  stats?: QueryStats | null;
}

export interface NotebookCell {
  id: string;
  type: CellType;
  name: string; // referenced from SQL cells as {{name}}
  source: string; // SQL / markdown text; for a parameter cell, its current value
  view: OutputView;
  xKey?: string;
  yKeys?: string[];
  collapsed?: boolean;
  result?: CellResult | null;
  error?: string | null;
  // Parameter cells only
  paramKind?: ParamKind;
  options?: string[]; // dropdown choices
  optionsSql?: string; // optional query whose first column supplies dropdown choices
}

export interface Notebook {
  id: string;
  title: string;
  updatedAt: string;
  template?: string;
  cells: NotebookCell[];
}

export interface NotebookSummary {
  id: string;
  title: string;
  updatedAt: string;
  template: string | null;
  cellCount: number;
  cellTypes: CellType[];
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const CELL_NAME_PATTERN = /[^a-zA-Z0-9_]/g;
const REFERENCE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const DEFAULTS: Record<CellType, { prefix: string; source: string }> = {
  sql: { prefix: 'query', source: 'SELECT 1' },
  markdown: { prefix: 'text', source: '## New section\n\nWrite **markdown** here.' },
  param: { prefix: 'param', source: '' },
};

export function newCell(type: CellType, existing: NotebookCell[]): NotebookCell {
  const { prefix, source } = DEFAULTS[type];
  const names = new Set(existing.map(c => c.name));
  let n = existing.filter(c => c.type === type).length + 1;
  while (names.has(`${prefix}_${n}`)) n++;
  return { id: uid(), type, name: `${prefix}_${n}`, source, view: 'table', ...(type === 'param' ? { paramKind: 'text' as const } : {}) };
}

export function summarize(nb: Notebook): NotebookSummary {
  return {
    id: nb.id,
    title: nb.title,
    updatedAt: nb.updatedAt,
    template: nb.template || null,
    cellCount: nb.cells.length,
    cellTypes: [...new Set(nb.cells.map(c => c.type))],
  };
}

// Render a parameter value as a SQL literal. Numbers are validated so they can
// be used unquoted (e.g. INTERVAL {{hours}} HOUR); everything else is a quoted
// string literal with backslashes and quotes escaped.
export function paramLiteral(cell: NotebookCell): string {
  const value = cell.source;
  if (cell.paramKind === 'number') {
    if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Parameter {{${cell.name}}} must be a number`);
    return String(Number(value));
  }
  if (cell.paramKind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Parameter {{${cell.name}}} needs a date`);
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Expand {{name}} references: parameter cells become literals, SQL cells are
// inlined as subqueries (recursively). Cycles are reported with their path.
export function resolveSql(sql: string, cells: NotebookCell[], stack: string[] = []): string {
  return sql.replace(REFERENCE, (_, name: string) => {
    const ref = cells.find(c => c.name === name && c.type !== 'markdown');
    if (!ref) throw new Error(`Unknown cell reference {{${name}}}`);
    if (ref.type === 'param') return paramLiteral(ref);
    if (stack.includes(name)) throw new Error(`Circular cell reference: ${[...stack, name].join(' → ')}`);
    return `(${resolveSql(stripSemicolon(ref.source), cells, [...stack, name])})`;
  });
}

export const stripSemicolon = (sql: string) => sql.trim().replace(/;+\s*$/, '');

// Names referenced directly by a piece of SQL.
export function referencedNames(sql: string): string[] {
  return [...sql.matchAll(REFERENCE)].map(m => m[1]);
}

// SQL cells that depend on `name`, directly or through other SQL cells, in notebook order.
export function dependentCells(name: string, cells: NotebookCell[]): NotebookCell[] {
  const affected = new Set([name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cells) {
      if (c.type === 'sql' && !affected.has(c.name) && referencedNames(c.source).some(n => affected.has(n))) {
        affected.add(c.name);
        grew = true;
      }
    }
  }
  return cells.filter(c => c.type === 'sql' && affected.has(c.name) && c.name !== name);
}

// A column is numeric when every non-null value is a number or a numeric string
// (ClickHouse serialises 64-bit integers and decimals as strings in JSON).
export function numericColumns(rows: Record<string, unknown>[]): string[] {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  return keys.filter(k => {
    let seen = false;
    for (const r of rows) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') { seen = true; continue; }
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { seen = true; continue; }
      return false;
    }
    return seen;
  });
}

// Keep the user's chart axes if they still exist, otherwise pick the first
// non-numeric column for X and up to three numeric columns for Y.
export function chartAxes(cell: NotebookCell, rows: Record<string, unknown>[]): Pick<NotebookCell, 'xKey' | 'yKeys'> {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const numeric = numericColumns(rows);
  const xKey = cell.xKey && keys.includes(cell.xKey) ? cell.xKey : keys.find(k => !numeric.includes(k)) || keys[0];
  const kept = cell.yKeys?.filter(k => keys.includes(k) && k !== xKey) || [];
  return { xKey, yKeys: kept.length ? kept : numeric.filter(k => k !== xKey).slice(0, 3) };
}

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  return [keys.map(csvValue).join(','), ...rows.map(r => keys.map(k => csvValue(r[k])).join(','))].join('\n');
}

// The notebook as one runnable script: references and parameters are resolved,
// markdown and parameter values become comments.
export function toSqlScript(nb: Notebook): string {
  const header = `-- ${nb.title}\n-- Exported from Convoy on ${new Date().toISOString()}`;
  const parts = nb.cells.map(c => {
    if (c.type === 'markdown') return c.source.split('\n').map(l => `-- ${l}`).join('\n');
    if (c.type === 'param') return `-- Parameter ${c.name} = ${c.source}`;
    try {
      return `-- ${c.name}\n${resolveSql(stripSemicolon(c.source), nb.cells)};`;
    } catch (err) {
      return `-- ${c.name}: could not resolve (${err instanceof Error ? err.message : err})\n-- ${c.source.split('\n').join('\n-- ')}`;
    }
  });
  return [header, ...parts].join('\n\n') + '\n';
}

export function downloadFile(filename: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fileSlug = (title: string) => title.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'notebook';

// Accepts an exported notebook file and returns a fresh copy (new ids, no outputs).
export function parseImportedNotebook(text: string): Notebook {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cells)) throw new Error('Not a notebook file (missing cells)');
  const types: CellType[] = ['sql', 'markdown', 'param'];
  const cells: NotebookCell[] = raw.cells.map((c: Partial<NotebookCell>) => {
    if (!c || !types.includes(c.type as CellType)) throw new Error('Notebook contains an unknown cell type');
    return { ...c, id: uid(), name: String(c.name || 'cell').replace(CELL_NAME_PATTERN, '_'), source: String(c.source ?? ''), view: c.view || 'table', result: null, error: null };
  });
  return { id: uid(), title: String(raw.title || 'Imported notebook'), updatedAt: new Date().toISOString(), template: raw.template, cells };
}
