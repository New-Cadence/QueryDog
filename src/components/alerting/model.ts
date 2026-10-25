// Alerting model and API helper shared by the Alerting page, the Checks grid
// and the notification channels in Settings.
import { useEffect } from 'react';
import { Slack, Mail, Webhook, PhoneCall } from 'lucide-react';

// ==================== Model (mirrors server/extensions/alerting.js) ====================

export type { Severity } from '../checks/model';
import type { Severity } from '../checks/model';
export type ChannelType = 'slack' | 'email' | 'pagerduty' | 'webhook';
export type IncidentStatus = 'firing' | 'acknowledged' | 'resolved';
export type Operator = '>' | '>=' | '=' | '<';
export type EvalState = 'ok' | 'pending' | 'firing' | 'error';

export interface HistoryPoint { time: string; rows: number | null; duration: number; fired: boolean; error?: string }

export interface AlertRule {
  check: string;
  description: string;
  // From the check file's `-- category:` header
  category: string;
  custom: boolean;
  severity: Severity;
  operator: Operator;
  threshold: number;
  forMinutes: number;
  channels: string[];
  lastEvaluatedAt: string | null;
  lastResult: { rowCount: number | null; duration: number; state: EvalState; environment: string } | null;
  lastError: string | null;
  pendingSince: string | null;
  history: HistoryPoint[];
}

export interface Channel { id: string; type: ChannelType; name: string; target: string; enabled: boolean; createdAt: string }

export interface TimelineEntry { time: string; type: string; message: string }

export interface Incident {
  id: string;
  check: string;
  severity: Severity;
  status: IncidentStatus;
  environment: string;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rowCount: number;
  peakRows: number;
  timeline: TimelineEntry[];
}

export interface Delivery {
  id: string; time: string; incidentId: string; check: string; event: string;
  channelId: string; channelName: string; channelType: ChannelType; ok: boolean; detail: string | null;
}

export interface Silence { id: string; check: string | null; until: string; reason: string; createdAt: string }

export interface AlertingState {
  environment: string;
  smtpConfigured: boolean;
  rules: AlertRule[];
  channels: Channel[];
  incidents: Incident[];
  deliveries: Delivery[];
  silences: Silence[];
}


// Runs an API call, shows the outcome as a toast and refreshes state.
export type Act = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;

export const API = '/api/alerting';
export const POLL_MS = 10000;

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

export const channelMeta: Record<ChannelType, { icon: typeof Slack; label: string; placeholder: string; hint: string }> = {
  slack: { icon: Slack, label: 'Slack', placeholder: 'https://hooks.slack.com/services/...', hint: 'Slack incoming-webhook URL' },
  email: { icon: Mail, label: 'Email', placeholder: 'oncall@example.com, dba@example.com', hint: 'Comma-separated recipients, sent via SMTP_URL' },
  pagerduty: { icon: PhoneCall, label: 'PagerDuty', placeholder: 'Events API v2 routing key', hint: 'Triggers on fire and resolves on clear' },
  webhook: { icon: Webhook, label: 'Webhook', placeholder: 'https://hooks.example.com/alerts', hint: 'Receives a JSON POST for every event' },
};

export { severityTone } from '../checks/model';
export const stateTone: Record<EvalState, 'green' | 'yellow' | 'red'> = { ok: 'green', pending: 'yellow', firing: 'red', error: 'red' };
export const statusTone: Record<IncidentStatus, 'red' | 'yellow' | 'green'> = { firing: 'red', acknowledged: 'yellow', resolved: 'green' };

export function formatAgo(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.max(secs, 0)}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function durationBetween(start: string, end?: string | null): string {
  const mins = Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

export const silenceFor = (silences: Silence[], check: string) => silences.find(s => !s.check || s.check === check);
export const checkLabel = (check: string) => check.replace(/\.sql$/, '');

export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
