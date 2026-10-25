import { useEffect, useState } from 'react';
import { Palette, KeyRound, Send, CircleDollarSign, PiggyBank, Users, CalendarClock, Sun, Moon, Plus, Trash2, Copy, Check, X } from 'lucide-react';
import { AlertChannelsSettings } from '../alerting/ChannelsPanel';
import { SchedulerSettings } from '../SchedulerSettings';
import { CostSettingsSection } from '../cost/CostSettingsSection';
import { PageTabs, Panel, ToolbarButton, EmptyState, PreviewBanner, Field, type TabDef } from '../ui';
import { formatDate } from '../../utils/formatters';

type SettingsTab = 'appearance' | 'apikeys' | 'channels' | 'costs' | 'budget' | 'allocation' | 'scheduler';

const TABS: TabDef<SettingsTab>[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'apikeys', label: 'API Keys', icon: KeyRound },
  { id: 'channels', label: 'Notification channels', icon: Send },
  { id: 'costs', label: 'Costs', icon: CircleDollarSign },
  { id: 'budget', label: 'Budget', icon: PiggyBank },
  { id: 'allocation', label: 'Cost allocation', icon: Users },
  { id: 'scheduler', label: 'Scheduler', icon: CalendarClock },
];

export function SettingsPage({ lightMode, onLightModeChange }: { lightMode: boolean; onLightModeChange: (light: boolean) => void }) {
  const [tab, setTab] = useState<SettingsTab>('appearance');
  return (
    <div className="h-full flex flex-col">
      <PageTabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'channels' ? (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col"><AlertChannelsSettings /></div>
      ) : tab === 'costs' ? (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col"><CostSettingsSection /></div>
      ) : tab === 'budget' || tab === 'allocation' ? (
        <div className="flex-1 min-h-0 overflow-auto"><CostSettingsSection key={tab} section={tab} /></div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto py-3">
          {tab === 'appearance' && <AppearanceTab lightMode={lightMode} onLightModeChange={onLightModeChange} />}
          {tab === 'apikeys' && <ApiKeysTab />}
          {tab === 'scheduler' && <SchedulerSettings />}
        </div>
      )}
    </div>
  );
}

// Fixed colours so each preview shows its own theme whichever one is active
const THEME_PREVIEWS = {
  dark: { page: '#030712', panel: '#111827', border: '#374151', line: '#4b5563', text: '#e5e7eb', bar: '#3b82f6' },
  light: { page: '#f3f4f6', panel: '#ffffff', border: '#e5e7eb', line: '#d1d5db', text: '#1f2937', bar: '#2563eb' },
};

function ThemePreview({ theme }: { theme: keyof typeof THEME_PREVIEWS }) {
  const c = THEME_PREVIEWS[theme];
  const bars = [40, 65, 30, 80, 55, 70, 45, 90, 60];
  return (
    <div className="rounded-md overflow-hidden border" style={{ background: c.page, borderColor: c.border }}>
      <div className="h-5 flex items-center gap-1.5 px-2" style={{ background: '#0e0c22' }}>
        <span className="w-2 h-2" style={{ background: '#fbbf24' }} />
        <span className="w-10 h-1 rounded-full bg-white/70" />
        <span className="ml-3 w-6 h-1 rounded-full bg-white/30" />
        <span className="w-6 h-1 rounded-full bg-white/30" />
      </div>
      <div className="p-2 space-y-1.5">
        <div className="grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-7 rounded border p-1 space-y-1" style={{ background: c.panel, borderColor: c.border }}>
              <div className="w-6 h-0.5 rounded-full" style={{ background: c.line }} />
              <div className="w-8 h-1.5 rounded-sm" style={{ background: c.text }} />
            </div>
          ))}
        </div>
        <div className="h-16 rounded border px-1.5 pt-1.5 flex items-end gap-1" style={{ background: c.panel, borderColor: c.border }}>
          {bars.map((h, i) => <div key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%`, background: c.bar, opacity: 0.85 }} />)}
        </div>
      </div>
    </div>
  );
}

function AppearanceTab({ lightMode, onLightModeChange }: { lightMode: boolean; onLightModeChange: (light: boolean) => void }) {
  const options = [
    { light: false, theme: 'dark' as const, label: 'Dark', icon: Moon },
    { light: true, theme: 'light' as const, label: 'Light', icon: Sun },
  ];
  return (
    <div className="px-1.5">
      <h3 className="text-xs font-semibold text-gray-200 mb-2">Theme</h3>
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Theme">
        {options.map(({ light, theme, label, icon: Icon }) => {
          const selected = lightMode === light;
          return (
            <button
              key={label}
              role="radio"
              aria-checked={selected}
              onClick={() => onLightModeChange(light)}
              className={`w-64 p-2 rounded-lg border-2 text-left transition-colors ${
                selected ? 'border-blue-500' : 'border-gray-800 hover:border-gray-600'
              }`}
            >
              <ThemePreview theme={theme} />
              <span className="mt-2 flex items-center gap-2 px-0.5">
                <Icon className={`w-3.5 h-3.5 ${selected ? 'text-blue-400' : 'text-gray-500'}`} />
                <span className={`text-xs font-medium ${selected ? 'text-white' : 'text-gray-300'}`}>{label}</span>
                <span className={`ml-auto w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-blue-500 bg-blue-500' : 'border-gray-600'}`}>
                  {selected && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// API keys are saved in the Convoy database (only the prefix is kept
// once a key is created) but are not checked by the backend yet.
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Never', days: null },
];

async function loadKeys(): Promise<ApiKey[]> {
  const res = await fetch('/api/settings/api_keys');
  if (!res.ok) throw new Error(`Could not load API keys (HTTP ${res.status})`);
  return (await res.json()).value ?? [];
}

async function saveKeys(keys: ApiKey[]) {
  const res = await fetch('/api/settings/api_keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: keys }),
  });
  if (!res.ok) throw new Error(`Could not save API keys (HTTP ${res.status})`);
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'qd_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadKeys().then(setKeys).catch(e => setError(e.message));
  }, []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const update = (next: ApiKey[]) => {
    setKeys(next);
    saveKeys(next).then(() => setError(null)).catch(e => setError(e.message));
  };

  const create = () => {
    const secret = generateSecret();
    const now = new Date();
    const key: ApiKey = {
      id: crypto.randomUUID(),
      name: name.trim(),
      prefix: secret.slice(0, 10),
      createdAt: now.toISOString(),
      expiresAt: expiryDays === null ? null : new Date(now.getTime() + expiryDays * 864e5).toISOString(),
    };
    update([key, ...keys]);
    setNewSecret(secret);
    setCopied(false);
    setCreating(false);
    setName('');
    setExpiryDays(90);
  };

  const copy = async () => {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
    } catch {
      // Clipboard blocked; the key is still selectable in the box
    }
  };

  return (
    <div className="max-w-4xl space-y-3">
      <PreviewBanner>API keys are not enforced by the server yet.</PreviewBanner>
      {error && <div className="px-3 py-1.5 rounded text-xs bg-red-900/40 border border-red-800 text-red-300">{error}</div>}

      {newSecret && (
        <div className="p-3 rounded-lg border border-green-800 bg-green-900/20 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-green-400">Copy your new API key now. You won't be able to see it again.</span>
            <button onClick={() => setNewSecret(null)} className="text-gray-400 hover:text-white" title="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 select-all">{newSecret}</code>
            <ToolbarButton icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</ToolbarButton>
          </div>
        </div>
      )}

      <Panel
        title="API Keys"
        icon={KeyRound}
        actions={!creating && <ToolbarButton icon={Plus} variant="primary" onClick={() => setCreating(true)}>New key</ToolbarButton>}
        bodyClassName=""
      >
        {creating && (
          <div className="p-3 border-b border-gray-700 flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[12rem]">
              <Field label="Name" hint="What will use this key, e.g. CI pipeline">
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && name.trim() && create()}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </Field>
            </div>
            <Field label="Expires">
              <select
                value={expiryDays ?? ''}
                onChange={e => setExpiryDays(e.target.value === '' ? null : Number(e.target.value))}
                className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
              >
                {EXPIRY_OPTIONS.map(o => <option key={o.label} value={o.days ?? ''}>{o.label}</option>)}
              </select>
            </Field>
            <div className="flex items-center gap-2 pb-0.5">
              <ToolbarButton variant="primary" onClick={create} disabled={!name.trim()}>Create</ToolbarButton>
              <ToolbarButton onClick={() => { setCreating(false); setName(''); }}>Cancel</ToolbarButton>
            </div>
          </div>
        )}

        {keys.length === 0 ? (
          <div className="h-48 flex">
            <EmptyState icon={KeyRound} title="No API keys" />
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-gray-500 border-b border-gray-700">
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="px-3 py-1.5 font-medium">Key</th>
                <th className="px-3 py-1.5 font-medium">Created</th>
                <th className="px-3 py-1.5 font-medium">Expires</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {keys.map(k => {
                const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
                return (
                  <tr key={k.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/40">
                    <td className="px-3 py-1.5 text-gray-200">{k.name}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-400">{k.prefix}…</td>
                    <td className="px-3 py-1.5 text-gray-400">{formatDate(k.createdAt)}</td>
                    <td className={`px-3 py-1.5 ${expired ? 'text-red-400' : 'text-gray-400'}`}>
                      {k.expiresAt ? `${expired ? 'Expired ' : ''}${formatDate(k.expiresAt)}` : 'Never'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => update(keys.filter(x => x.id !== k.id))}
                        className="text-gray-500 hover:text-red-400"
                        title="Revoke key"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
