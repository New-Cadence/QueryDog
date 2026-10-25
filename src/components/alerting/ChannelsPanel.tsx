// Notification channels (Slack, email, PagerDuty, webhooks) used by alerting.
// Lives under Settings, so it loads and polls the alerting state itself.
import { useState, useEffect, useCallback } from 'react';
import { Bell, BellOff, Send, Plus, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useClientFilters, type ClientFilterField } from '../../hooks/useClientFilters';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { PageToolbar, Panel, Pill, ToolbarButton, ToolbarSearch, Field, EmptyState, LoadingState } from '../ui';
import { inputClass } from '../uiTokens';
import {
  api, channelMeta, formatAgo, POLL_MS, type Act, type AlertingState, type Channel, type ChannelType, type Delivery,
} from './model';
import { Modal, DeliveryRow } from './widgets';

export function AlertChannelsSettings() {
  const [state, setState] = useState<AlertingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api<AlertingState>('GET', '/state'));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const act: Act = useCallback(async (fn, success) => {
    try {
      await fn();
      if (success) setToast({ ok: true, text: success });
      return true;
    } catch (e) {
      setToast({ ok: false, text: (e as Error).message });
      return false;
    } finally {
      await refresh();
    }
  }, [refresh]);

  if (!state) {
    return loadError
      ? <EmptyState icon={AlertTriangle} title="Could not load notification channels">{loadError}</EmptyState>
      : <LoadingState label="Loading channels…" />;
  }

  return (
    <div className="h-full flex flex-col">
      {toast && (
        <div className={`px-1.5 pt-2 text-xs flex items-center gap-1 ${toast.ok ? 'text-green-400' : 'text-red-400'}`}>
          {toast.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{toast.text}
        </div>
      )}
      <ChannelsList state={state} act={act} />
    </div>
  );
}

const channelFields: ClientFilterField<Channel>[] = [
  { field: 'type', label: 'Type' },
  { field: 'enabled', label: 'Status', getValue: c => (c.enabled ? 'active' : 'paused') },
];
const channelSearchText = (c: Channel) => `${c.name} ${c.target} ${c.type}`;

function ChannelsList({ state, act }: { state: AlertingState; act: Act }) {
  const { channels, rules, deliveries, smtpConfigured } = state;
  const [adding, setAdding] = useState(false);
  const { filters, setFilter, clearAll, search, setSearch, filtered, activeCount } = useClientFilters(channels, channelFields, channelSearchText);
  const shownIds = new Set(filtered.map(c => c.id));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <ClientFilterPanel rows={channels} fields={channelFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Search channels..." />
          </>
        }
        right={
          <>
            <span className="text-xs text-gray-400">{filtered.length} items</span>
            {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filters active</span>}
            <ToolbarButton icon={Plus} variant="primary" onClick={() => setAdding(true)}>Add channel</ToolbarButton>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
        {channels.length === 0 ? (
          <EmptyState icon={Send} title="No notification channels" />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {filtered.map(c => {
              const meta = channelMeta[c.type];
              const Icon = meta.icon;
              const used = rules.filter(r => r.channels.includes(c.id));
              const last = deliveries.find(d => d.channelId === c.id);
              return (
                <div key={c.id} className={`bg-gray-900 border border-gray-700 rounded-lg p-4 ${c.enabled ? '' : 'opacity-60'}`}>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center"><Icon className="w-4 h-4 text-blue-400" /></div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{c.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">{meta.label} · {c.target}</div>
                    </div>
                    <div className="ml-auto"><Pill tone={c.enabled ? 'green' : 'default'}>{c.enabled ? 'active' : 'paused'}</Pill></div>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-3">
                    Routes <span className="text-white">{used.length}</span> checks
                    {used.length > 0 && <span className="text-gray-500"> · {used.filter(r => r.severity === 'critical').length} critical</span>}
                  </div>
                  <div className="text-[11px] mt-1 truncate">
                    {last
                      ? <span className={last.ok ? 'text-gray-500' : 'text-red-400'} title={last.detail || ''}>Last delivery {formatAgo(last.time)}: {last.ok ? 'ok' : last.detail}</span>
                      : <span className="text-gray-600">No deliveries yet</span>}
                  </div>
                  {c.type === 'email' && !smtpConfigured && (
                    <div className="text-[11px] text-yellow-400 mt-1">SMTP is not configured: set SMTP_URL and SMTP_FROM on the server.</div>
                  )}
                  <div className="flex items-center gap-2 mt-3">
                    <ToolbarButton icon={Send} onClick={() => act(async () => {
                      const d = await api<Delivery>('POST', `/channels/${c.id}/test`);
                      if (!d.ok) throw new Error(`Test to ${c.name} failed: ${d.detail}`);
                    }, `Test delivered to ${c.name}`)}>Send test</ToolbarButton>
                    <ToolbarButton icon={c.enabled ? BellOff : Bell} onClick={() => act(() => api('PATCH', `/channels/${c.id}`, { enabled: !c.enabled }))}>
                      {c.enabled ? 'Pause' : 'Resume'}
                    </ToolbarButton>
                    <button onClick={() => { if (confirm(`Remove channel ${c.name}? Checks routed to it will stop notifying it.`)) void act(() => api('DELETE', `/channels/${c.id}`), `Removed ${c.name}`); }}
                      className="ml-auto text-gray-500 hover:text-red-400" title="Remove channel">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Panel title="Recent deliveries" icon={Send} bodyClassName="divide-y divide-gray-800 max-h-80 overflow-y-auto">
          {deliveries.filter(d => shownIds.has(d.channelId)).length === 0
            ? <EmptyState compact title="No notifications sent" />
            : deliveries.filter(d => shownIds.has(d.channelId)).slice(0, 50).map(d => <DeliveryRow key={d.id} d={d} showCheck />)}
        </Panel>
      </div>
      {adding && <ChannelEditor smtpConfigured={smtpConfigured} act={act} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ChannelEditor({ smtpConfigured, act, onClose }: { smtpConfigured: boolean; act: Act; onClose: () => void }) {
  const [draft, setDraft] = useState<{ type: ChannelType; name: string; target: string }>({ type: 'slack', name: '', target: '' });
  const meta = channelMeta[draft.type];

  const save = async () => {
    const ok = await act(() => api('POST', '/channels', draft), `Added ${draft.name}`);
    if (ok) onClose();
  };

  return (
    <Modal title="Add notification channel" icon={Send} width="w-[460px]" onClose={onClose}
      footer={
        <>
          <ToolbarButton onClick={onClose}>Cancel</ToolbarButton>
          <ToolbarButton icon={Plus} variant="primary" onClick={save} disabled={!draft.name.trim() || !draft.target.trim()}>Add channel</ToolbarButton>
        </>
      }>
      <div className="grid grid-cols-4 gap-2">
        {(Object.keys(channelMeta) as ChannelType[]).map(t => {
          const Icon = channelMeta[t].icon;
          return (
            <button key={t} onClick={() => setDraft(d => ({ ...d, type: t }))}
              className={`flex flex-col items-center gap-1 p-2 rounded border text-[11px] ${draft.type === t ? 'border-blue-500 bg-blue-900/40 text-blue-300' : 'border-gray-600 bg-gray-800 text-gray-400 hover:text-white'}`}>
              <Icon className="w-4 h-4" />{channelMeta[t].label}
            </button>
          );
        })}
      </div>
      <Field label="Name"><input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Ops alerts" className={inputClass} /></Field>
      <Field label="Target" hint={meta.hint}>
        <input value={draft.target} onChange={e => setDraft(d => ({ ...d, target: e.target.value }))} placeholder={meta.placeholder} className={inputClass} />
      </Field>
      {draft.type === 'email' && !smtpConfigured && (
        <p className="text-[11px] text-yellow-400">SMTP is not configured on the server, so email deliveries will fail until SMTP_URL and SMTP_FROM are set.</p>
      )}
    </Modal>
  );
}
