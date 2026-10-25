// Display formatters shared across tables and panels. Accept `unknown`
// because most callers pass ag-grid `valueFormatter` params, which are
// typed loosely.

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatBytes(value: unknown): string {
  const bytes = toFiniteNumber(value);
  if (bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatNumber(value: unknown): string {
  const num = toFiniteNumber(value);
  if (num === null) return '-';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

export function formatDuration(value: unknown): string {
  const ms = toFiniteNumber(value);
  if (ms === null) return '-';
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  return ms.toFixed(0) + 'ms';
}

// ClickHouse DateTime values arrive as naive 'YYYY-MM-DD HH:MM:SS' strings with
// no zone attached. The server pins its session timezone to UTC so they always
// denote UTC, but `new Date(...)` reads that shape as *browser-local* time,
// shifting every timestamp by the viewer's UTC offset. Parse them explicitly so
// a viewer in any timezone sees the same instant, rendered in their own zone.
// Values that already carry a zone (ISO strings ending in Z or +hh:mm) and epoch
// numbers are passed through untouched.
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseServerTime(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string' || value === '') return new Date(NaN);
  const s = value.trim();
  return NAIVE_TIMESTAMP.test(s) ? new Date(`${s.replace(' ', 'T')}Z`) : new Date(s);
}

// datetime-local inputs are read back by the browser as local wall-clock time,
// so they must be *written* as local wall-clock too. toISOString() would write
// UTC into a local-time field, shifting the range on every round trip.
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// The app's date style is 25-Dec-2026, with times as 24-hour HH:MM:SS
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

// A bare 'YYYY-MM-DD' is a calendar day, not an instant: read and print it
// in UTC so no timezone moves it to a neighbouring day
const toDisplayDate = (value: unknown): { d: Date; utc: boolean } | null => {
  if (value === null || value === undefined || value === '') return null;
  const utc = typeof value === 'string' && DATE_ONLY.test(value.trim());
  const d = utc ? new Date(`${(value as string).trim()}T00:00:00Z`) : parseServerTime(value);
  return Number.isNaN(d.getTime()) ? null : { d, utc };
};

const dayMonth = (d: Date, utc: boolean) =>
  `${pad2(utc ? d.getUTCDate() : d.getDate())}-${MONTHS[utc ? d.getUTCMonth() : d.getMonth()]}`;

// 25-Dec-2026
export function formatDate(value: unknown, fallback = '-'): string {
  const v = toDisplayDate(value);
  if (!v) return fallback;
  return `${dayMonth(v.d, v.utc)}-${v.utc ? v.d.getUTCFullYear() : v.d.getFullYear()}`;
}

// 25-Dec, for chart axes where the year would crowd the ticks
export function formatDayMonth(value: unknown, fallback = '-'): string {
  const v = toDisplayDate(value);
  return v ? dayMonth(v.d, v.utc) : fallback;
}

// Dec-2026
export function formatMonthYear(value: unknown, fallback = '-'): string {
  const v = toDisplayDate(value);
  if (!v) return fallback;
  return `${MONTHS[v.utc ? v.d.getUTCMonth() : v.d.getMonth()]}-${v.utc ? v.d.getUTCFullYear() : v.d.getFullYear()}`;
}

// 18:42 / 18:42:17 / 18:42:17.123 in the viewer's timezone
export function formatTime(value: unknown, { seconds = true, ms = false }: { seconds?: boolean; ms?: boolean } = {}, fallback = '-'): string {
  const v = toDisplayDate(value);
  if (!v) return fallback;
  const d = v.d;
  let out = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (seconds || ms) out += `:${pad2(d.getSeconds())}`;
  if (ms) out += `.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return out;
}

// 25-Dec-2026 18:42:17
export function formatDateTime(value: unknown, opts: { seconds?: boolean; ms?: boolean } = {}, fallback = '-'): string {
  const v = toDisplayDate(value);
  if (!v) return fallback;
  return `${formatDate(v.d)} ${formatTime(v.d, opts)}`;
}
