import { useState, useEffect, useCallback, useRef } from 'react';
import { LogOut, Database, HardDrive, Activity, Server, X, FolderTree, Terminal, FileText, Layers, Table, AlertTriangle, Network, Circle, RefreshCw, Settings, Radar, Lightbulb, FlaskConical, Zap, BookOpen, ShieldCheck, BellRing, NotebookPen, CircleDollarSign, BadgeCheck, KeyRound, Gauge } from 'lucide-react';
import { AutoRefreshToggle } from './components/AutoRefreshToggle';
import { QueriesPage } from './components/pages/QueriesPage';
import { PartsPage } from './components/pages/PartsPage';
import { PartLogPage } from './components/pages/PartLogPage';
import { ActivityPage } from './components/pages/ActivityPage';
import { InstancePage } from './components/pages/InstancePage';
import { ClusterPage } from './components/pages/ClusterPage';
import { TextLogPage } from './components/pages/TextLogPage';
import { MyQueriesPage } from './components/pages/MyQueriesPage';
import { DataExplorerPage } from './components/pages/DataExplorerPage';
import { AlertingPage } from './components/pages/AlertingPage';
import { DataDictionaryPage } from './components/pages/DataDictionaryPage';
import { DataQualityPage } from './components/pages/DataQualityPage';
import { SecurityPage } from './components/pages/SecurityPage';
import { NotebooksPage } from './components/pages/NotebooksPage';
import { LoadTestingPage } from './components/pages/LoadTestingPage';
import { CostPage } from './components/pages/CostPage';
import { RecommendationsPage } from './components/pages/RecommendationsPage';
import { SettingsPage } from './components/pages/SettingsPage';
import { ClientFolderNotice } from './components/ClientFolderNotice';
import { ProfileEventsModal } from './components/ProfileEventsModal';
import { DatabaseBrowser } from './components/DatabaseBrowser';
import { DatabaseManager } from './components/DatabaseManager';
import { QueryEditor } from './components/QueryEditor';
import { useQueryStore } from './stores/queryStore';
import { useQueryData } from './hooks/useQueryData';
import { fetchEnvironments, switchEnvironment, type EnvironmentInfo } from './services/api';
import { useAuth } from './auth/authContext';

// 'settings' is opened from the header gear button rather than the mode nav
type Mode = 'observability' | 'recommendations' | 'checks' | 'dictionary' | 'security' | 'alerting' | 'notebooks' | 'cost' | 'settings';
type NavItem =
  // Observability
  | 'queries' | 'textlog' | 'partlog' | 'parts' | 'activity' | 'cluster' | 'instance'
  // Checks
  | 'testing' | 'dataquality' | 'loadtesting'
  // Data Dictionary
  | 'dictionary' | 'browser' | 'explorer'
  // Security
  | 'security' | 'access' | 'quotas';

// Each mode carries a full set of accent classes (spelled out so Tailwind picks them up)
interface ModeDef {
  id: Mode;
  label: string;
  icon: typeof Database;
  description: string;
  text: string;
  tile: string;
  bar: string;
  // Kept in the code but not shown in the nav
  hidden?: boolean;
}

const MODES: ModeDef[] = [
  { id: 'observability', label: 'Observability', icon: Radar, description: 'Queries, parts, activity and instance health', text: 'text-blue-400', tile: 'bg-blue-500/15', bar: 'bg-blue-500' },
  { id: 'alerting', label: 'Monitoring', icon: BellRing, description: 'Checks, rules, incidents and notification channels', text: 'text-orange-400', tile: 'bg-orange-500/15', bar: 'bg-orange-500' },
  { id: 'checks', label: 'Testing', icon: FlaskConical, description: 'Query performance, data quality and load testing', text: 'text-green-400', tile: 'bg-green-500/15', bar: 'bg-green-500' },
  { id: 'security', label: 'Security', icon: ShieldCheck, description: 'Role-based access control and posture', text: 'text-red-400', tile: 'bg-red-500/15', bar: 'bg-red-500' },
  { id: 'cost', label: 'Cost', icon: CircleDollarSign, description: 'ClickHouse Cloud spend and forecasts', text: 'text-emerald-400', tile: 'bg-emerald-500/15', bar: 'bg-emerald-500' },
  { id: 'notebooks', label: 'Notebooks', icon: NotebookPen, description: 'Interactive SQL notebooks', text: 'text-violet-400', tile: 'bg-violet-500/15', bar: 'bg-violet-500', hidden: true },
  { id: 'dictionary', label: 'Data Dictionary', icon: BookOpen, description: 'Catalogue of databases, tables and columns', text: 'text-teal-400', tile: 'bg-teal-500/15', bar: 'bg-teal-500' },
  { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, description: 'Prioritised fixes across cost, security, performance and schema', text: 'text-amber-400', tile: 'bg-amber-500/15', bar: 'bg-amber-500' },
];

// Default sub-page for modes that have a secondary navigation row
const DEFAULT_NAV: Partial<Record<Mode, NavItem>> = {
  observability: 'queries',
  checks: 'testing',
  dictionary: 'dictionary',
  security: 'security',
};
type RefreshInterval = 'off' | 5 | 10 | 60 | 600;

interface ConnectionInfo {
  name: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
}

// Helper to get a cookie value by name
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

// Helper to set a cookie
function setCookie(name: string, value: string, days: number = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/`;
}


// Resolve ?env=<name|index> from the current URL. Case-insensitive on name,
// accepts a 0-based index, returns -1 when nothing matches so callers can
// cleanly fall back to the server's active index.
function resolveEnvFromUrl(envs: EnvironmentInfo[]): number {
  if (typeof window === 'undefined') return -1;
  const raw = new URLSearchParams(window.location.search).get('env');
  if (!raw) return -1;
  const trimmed = raw.trim();
  if (trimmed === '') return -1;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < envs.length) {
    return asNumber;
  }
  const target = trimmed.toLowerCase();
  const byName = envs.findIndex(e => e.name.toLowerCase() === target);
  return byName;
}

function App() {
  const { authEnabled, user, logout } = useAuth();
  // Always land on Observability > Queries when the app starts
  const [mode, setModeState] = useState<Mode>('observability');
  const [navItem, setNavItem] = useState<NavItem>('queries');
  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    const nav = DEFAULT_NAV[next];
    if (nav) setNavItem(nav);
  }, []);
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>('off');
  const [lightMode, setLightMode] = useState(() => {
    const saved = localStorage.getItem('querydog_theme');
    return saved === 'light';
  });

  // Apply theme class to root element. The theme is saved in the database
  // (Settings > Appearance); localStorage only avoids a flash on load.
  useEffect(() => {
    if (lightMode) {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('querydog_theme', lightMode ? 'light' : 'dark');
  }, [lightMode]);
  useEffect(() => {
    fetch('/api/settings/appearance')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.value?.theme) setLightMode(d.value.theme === 'light'); })
      .catch(() => {});
  }, []);
  const changeTheme = useCallback((light: boolean) => {
    setLightMode(light);
    fetch('/api/settings/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { theme: light ? 'light' : 'dark' } }),
    }).catch(() => {});
  }, []);
  // Show about modal on first visit only (check cookie)
  const [aboutOpen, setAboutOpen] = useState(() => {
    const hasVisited = getCookie('querydog_visited');
    if (!hasVisited) {
      setCookie('querydog_visited', 'true');
      return true;
    }
    return false;
  });
  const [queryEditorOpen, setQueryEditorOpen] = useState(false);
  const [queryEditorInitialQuery, setQueryEditorInitialQuery] = useState('');
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [backendError, setBackendError] = useState<{ message: string; envName?: string; isBackendServer?: boolean } | null>(null);
  const [hasQueriesFolder, setHasQueriesFolder] = useState(false);
  const [hasAlertsFolder, setHasAlertsFolder] = useState(false);
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [activeEnvIndex, setActiveEnvIndex] = useState(0);
  const [connectedEnvIndex, setConnectedEnvIndex] = useState<number | null>(null);
  const [environmentsFetched, setEnvironmentsFetched] = useState(false);
  const [switching] = useState(false);
  const [connecting] = useState(false);
  const [connectingToName, setConnectingToName] = useState<string | null>(null);
  const {
    error,
    hasPartLogAccess,
    hasPartsAccess,
    setActiveTab,
    setChartMetric,
    setTimeRange,
    setFieldFilter,
    clearAllFilters,
    setError,
  } = useQueryStore();
  const connectionReady = !!connectionInfo && !backendError;
  // Observability data only loads (and auto-refreshes) while that mode is open
  // The header Refresh reloads whatever screen is open: the page is remounted
  // so it fetches again, and the query log data held here is reloaded too
  const [refreshCount, setRefreshCount] = useState(0);
  const { refresh } = useQueryData(connectionReady && mode === 'observability', connectedEnvIndex);
  const refreshAll = useCallback(() => {
    setRefreshCount(c => c + 1);
    if (mode === 'observability') refresh();
  }, [mode, refresh]);
  const activeEnvName = environments[activeEnvIndex]?.name;
  const [initialConnectOpen, setInitialConnectOpen] = useState(true);
  const [checkedExistingConnection, setCheckedExistingConnection] = useState(false);

  const ENV_CACHE_KEY = 'querydog_envs';

  const loadCachedEnvironments = useCallback(() => {
    try {
      const cached = localStorage.getItem(ENV_CACHE_KEY);
      if (!cached) return null;
      const parsed = JSON.parse(cached) as { active: number; environments: EnvironmentInfo[] };
      if (!parsed?.environments?.length) return null;
      return parsed;
    } catch {
      return null;
    }
  }, []);

  const saveCachedEnvironments = useCallback((data: { active: number; environments: EnvironmentInfo[] }) => {
    try {
      localStorage.setItem(ENV_CACHE_KEY, JSON.stringify(data));
    } catch {
      // Ignore cache failures
    }
  }, []);

  const fetchConfigEnvironmentsWithTimeout = useCallback(async (timeoutMs: number) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/config/environments', { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to fetch config environments: ${response.statusText}`);
      return response.json() as Promise<{ active: number; environments: EnvironmentInfo[] }>;
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // Load environments list on mount (read directly from YAML first)
  useEffect(() => {
    let isMounted = true;
    (async () => {
      const cached = loadCachedEnvironments();
      if (cached && isMounted) {
        setEnvironments(cached.environments);
        setActiveEnvIndex(cached.active);
        const cachedActiveEnv = cached.environments[cached.active];
        if (cachedActiveEnv) {
          setConnectingToName(cachedActiveEnv.name);
        }
      }

      let data: { active: number; environments: EnvironmentInfo[] } | null = null;
      const maxAttempts = 10;
      const retryDelayMs = 1000;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          data = await fetchConfigEnvironmentsWithTimeout(2000);
          break;
        } catch {
          if (attempt === 1) {
            // Fallback for older backends on first failure
            try {
              data = await fetchEnvironments();
              break;
            } catch {
              data = null;
            }
          }
          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      if (!isMounted) return;
      if (data) {
        setEnvironments(data.environments);
        // Honour a ?env=<name|index> URL param so an outer app can deep-link
        // into a specific environment without the user re-picking from the
        // switcher. Falls back to the server's active index when the param
        // is absent or doesn't match any configured env.
        const requested = resolveEnvFromUrl(data.environments);
        const effectiveIndex = requested >= 0 ? requested : data.active;
        setActiveEnvIndex(effectiveIndex);
        const activeEnv = data.environments[effectiveIndex];
        if (activeEnv) {
          setConnectingToName(activeEnv.name);
        }
        if (requested >= 0 && requested !== data.active) {
          // Server state is global, so tell it to switch too; otherwise
          // subsequent SQL calls would run against data.active.
          switchEnvironment(requested).catch(err =>
            console.warn('[querydog] failed to switch via URL param:', err),
          );
        }
        saveCachedEnvironments({ active: effectiveIndex, environments: data.environments });
        setEnvironmentsFetched(true);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  // On mount, check if server already has an active connection (survives page refresh)
  useEffect(() => {
    if (!environmentsFetched || checkedExistingConnection) return;
    setCheckedExistingConnection(true);
    (async () => {
      try {
        const res = await fetch('/api/connection-info');
        const data = await res.json();
        if (data.connected) {
          setConnectionInfo({
            name: data.name,
            host: data.host,
            port: String(data.port),
            secure: data.secure,
            user: data.user,
          });
          // Find the matching environment index
          const matchIdx = environments.findIndex(e => e.name === data.name);
          if (matchIdx >= 0) {
            setActiveEnvIndex(matchIdx);
            setConnectedEnvIndex(matchIdx);
          }
          setInitialConnectOpen(false);
          refresh();
          return;
        }
      } catch {
        // Server not reachable, fall through to show modal
      }
      // No active connection - show the connect modal
      setInitialConnectOpen(true);
    })();
  }, [environmentsFetched, checkedExistingConnection, environments, refresh]);

  // Check if queries folder exists
  useEffect(() => {
    fetch('/api/my-queries/exists')
      .then(res => res.json())
      .then(data => setHasQueriesFolder(data.exists))
      .catch(() => setHasQueriesFolder(false));
  }, []);

  useEffect(() => {
    fetch('/api/alerts/exists')
      .then(res => res.json())
      .then(data => setHasAlertsFolder(data.exists))
      .catch(() => setHasAlertsFolder(false));
  }, []);

  // Expose function to open query editor with a query (for use by ProfileEventsModal)
  useEffect(() => {
    (window as unknown as { openQueryEditor: (query: string) => void }).openQueryEditor = (query: string) => {
      // Strip off FORMAT JSON/JSONEachRow/etc from the end (added by ClickHouse for remote queries)
      const cleanedQuery = query.replace(/\s+FORMAT\s+\w+\s*$/i, '').trim();
      setQueryEditorInitialQuery(cleanedQuery);
      setQueryEditorOpen(true);
    };
  }, []);

  // Expose mode navigation so pages can link to each other (e.g. to Recommendations)
  useEffect(() => {
    (window as unknown as { navigateToMode: (mode: Mode) => void }).navigateToMode = (next: Mode) => {
      if (MODES.some(m => m.id === next)) setMode(next);
    };
  }, [setMode]);

  // Expose function to navigate to Queries page filtered by query_id
  useEffect(() => {
    (window as unknown as { navigateToQueryId: (queryId: string) => void }).navigateToQueryId = (queryId: string) => {
      // Clear existing filters and set query_id filter
      clearAllFilters();
      setFieldFilter('query_id', [queryId]);
      // Set time range to last 24 hours
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      setTimeRange({ start, end });
      // Navigate to queries page
      setMode('observability');
      setNavItem('queries');
      setActiveTab('queries');
    };
  }, [clearAllFilters, setFieldFilter, setTimeRange, setActiveTab, setMode]);

  // Expose function to navigate to Queries page filtered by multiple query_ids
  useEffect(() => {
    (window as unknown as { navigateToQueryIds: (queryIds: string[]) => void }).navigateToQueryIds = (queryIds: string[]) => {
      if (queryIds.length === 0) return;
      // Clear existing filters and set query_id filter with all IDs
      clearAllFilters();
      setFieldFilter('query_id', queryIds);
      // Set time range to last 24 hours
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      setTimeRange({ start, end });
      // Navigate to queries page
      setMode('observability');
      setNavItem('queries');
      setActiveTab('queries');
    };
  }, [clearAllFilters, setFieldFilter, setTimeRange, setActiveTab, setMode]);

  // Global auto-refresh
  useEffect(() => {
    if (refreshInterval === 'off' || mode !== 'observability') return;
    const interval = setInterval(refresh, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval, refresh, mode]);

  // Close modals on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAboutOpen(false);
        setQueryEditorOpen(false);
        setError(null);
        setBackendError(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  // If a backend connection error is showing, clear any generic error to avoid double modals
  useEffect(() => {
    if (backendError) {
      setError(null);
    }
  }, [backendError, setError]);

  const navItemsByMode: Partial<Record<Mode, { id: NavItem; label: string; icon: typeof Database; description: string }[]>> = {
    observability: [
      { id: 'queries', label: 'Queries', icon: Database, description: 'Query log timeline, grouping and profiling' },
      ...(hasPartsAccess ? [{ id: 'parts' as const, label: 'Objects', icon: HardDrive, description: 'Tables, partitions, parts and indexes' }] : []),
      ...(hasPartLogAccess ? [{ id: 'partlog' as const, label: 'Parts Log', icon: Layers, description: 'Merges, mutations and part events' }] : []),
      { id: 'activity', label: 'Activity', icon: Activity, description: 'Running queries, merges and background jobs' },
      { id: 'instance', label: 'Instance', icon: Server, description: 'Metrics, settings, disks and errors' },
      { id: 'textlog', label: 'Text Log', icon: FileText, description: 'Server log messages' },
      { id: 'cluster', label: 'Cluster', icon: Network, description: 'Replicas and cluster topology' },
    ],
    checks: [
      { id: 'testing', label: 'Query Performance', icon: FlaskConical, description: 'Track saved query performance over time' },
      { id: 'dataquality', label: 'Data Quality', icon: BadgeCheck, description: 'Data quality checks and dataset compliance' },
      { id: 'loadtesting', label: 'Load Testing', icon: Zap, description: 'Simulate concurrent workloads' },
    ],
    security: [
      { id: 'security', label: 'Security', icon: ShieldCheck, description: 'Posture and access changes' },
      { id: 'access', label: 'Access', icon: KeyRound, description: 'Who can access what, and logins' },
      { id: 'quotas', label: 'Quotas', icon: Gauge, description: 'Row policies, quotas and settings profiles' },
    ],
    dictionary: [
      { id: 'dictionary', label: 'Catalog', icon: BookOpen, description: 'Documented tables and columns' },
      { id: 'browser', label: 'Database Browser', icon: FolderTree, description: 'Tree and graph of every object' },
      { id: 'explorer', label: 'Data Explorer', icon: Table, description: 'Slice and group table data' },
    ],
  };

  // Header dropdown menus
  const [openMenu, setOpenMenu] = useState<Mode | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenMenu(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">
      {/* Header: modes, with dropdowns for modes that contain several pages */}
      <header className="bg-[var(--brand-surface)] border-b border-[var(--brand-surface-border)] px-3 sm:px-4 h-14 flex items-stretch justify-between gap-4 shrink-0">
        <div className="flex items-stretch gap-5 min-w-0">
          <button
            onClick={() => {
              setMode('observability');
              setNavItem('queries');
              setActiveTab('queries');
              setChartMetric('count');
              // Reset to last 1 hour
              const end = new Date();
              const start = new Date(end.getTime() - 60 * 60 * 1000);
              setTimeRange({ start, end });
            }}
            className="self-center flex items-start gap-2 hover:opacity-80 transition-opacity shrink-0"
          >
            <span className="w-[13px] h-[13px] mt-px bg-[var(--brand-accent)] shrink-0" aria-hidden="true" />
            <span className="flex flex-col items-start leading-none">
              <h1 className="text-[17px] font-bold text-white whitespace-nowrap">Convoy</h1>
              <span className="text-[10px] text-gray-500 font-medium tracking-tight mt-0.5">by New Cadence</span>
            </span>
          </button>

          <div className="w-px bg-[var(--brand-surface-border)] my-4" />

          <nav ref={menuRef} className="flex items-stretch gap-1 min-w-0">
            {MODES.filter(m => !m.hidden).map(m => {
              const active = mode === m.id;
              const items = navItemsByMode[m.id] || [];
              const hasMenu = items.length > 0;
              return (
                <div key={m.id} className="relative flex items-stretch">
                  <button
                    onClick={() => {
                      if (hasMenu) setOpenMenu(prev => (prev === m.id ? null : m.id));
                      else { setMode(m.id); setOpenMenu(null); }
                    }}
                    onMouseEnter={() => openMenu && hasMenu && setOpenMenu(m.id)}
                    aria-haspopup={hasMenu ? 'menu' : undefined}
                    aria-expanded={hasMenu ? openMenu === m.id : undefined}
                    className={`relative flex items-center gap-2 px-3 text-sm font-semibold tracking-tight whitespace-nowrap transition-colors rounded-t ${
                      active ? 'text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                    } ${openMenu === m.id ? 'bg-gray-800/60' : ''}`}
                  >
                    <span className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${active ? m.tile : ''}`}>
                      <m.icon className={`w-4 h-4 ${m.text}`} />
                    </span>
                    <span className="hidden xl:inline">{m.label}</span>
                    {active && <span className={`absolute left-1.5 right-1.5 -bottom-px h-0.5 rounded-full ${m.bar}`} />}
                  </button>
                  {openMenu === m.id && (
                    <div role="menu" className="absolute left-0 top-full mt-1 z-50 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl p-1.5">
                      <div className={`px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider ${m.text}`}>{m.label}</div>
                      {items.map(item => {
                        const selected = active && navItem === item.id;
                        return (
                          <button
                            key={item.id}
                            role="menuitem"
                            onClick={() => {
                              setMode(m.id);
                              setNavItem(item.id);
                              setOpenMenu(null);
                            }}
                            aria-current={selected ? 'page' : undefined}
                            className={`relative w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors ${
                              selected ? 'bg-gray-800' : 'hover:bg-gray-800/70'
                            }`}
                          >
                            {selected && <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${m.bar}`} />}
                            <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${selected ? m.tile : 'bg-gray-800'}`}>
                              <item.icon className={`w-3.5 h-3.5 ${selected ? m.text : 'text-gray-400'}`} />
                            </span>
                            <span className="min-w-0">
                              <span className={`block text-xs font-medium ${selected ? 'text-white' : 'text-gray-200'}`}>{item.label}</span>
                              <span className="block text-[11px] text-gray-500 truncate">{item.description}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        <div className="flex items-stretch gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setQueryEditorInitialQuery('');
              setQueryEditorOpen(true);
            }}
            className="flex items-center gap-1 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs"
            title="Query Editor"
          >
            <Terminal className="w-3.5 h-3.5" />
            Query
          </button>
          <button
            onClick={refreshAll}
            className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
            title="Refresh: reload the data on this screen"
            aria-label="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {mode === 'observability' && (
            <AutoRefreshToggle
              interval={refreshInterval}
              onIntervalChange={setRefreshInterval}
            />
          )}
        </div>

          <div className="w-px bg-[var(--brand-surface-border)] my-4" />

          {/* Settings sits apart from the modes, styled as a top-level nav tab */}
          <button
            onClick={() => { setMode('settings'); setOpenMenu(null); }}
            aria-current={mode === 'settings' ? 'page' : undefined}
            className={`relative flex items-center gap-2 px-3 text-sm font-semibold tracking-tight whitespace-nowrap transition-colors rounded-t ${
              mode === 'settings' ? 'text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
            }`}
            title="Settings"
            aria-label="Settings"
          >
            <span className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${mode === 'settings' ? 'bg-gray-500/20' : ''}`}>
              <Settings className="w-4 h-4 text-gray-400" />
            </span>
            {mode === 'settings' && <span className="absolute left-1.5 right-1.5 -bottom-px h-0.5 rounded-full bg-gray-400" />}
          </button>
          {authEnabled && (
            <button
              onClick={logout}
              className="flex items-center px-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 rounded-t transition-colors"
              title={`Log out ${user}`}
              aria-label="Log out"
            >
              <span className="w-6 h-6 rounded-md flex items-center justify-center"><LogOut className="w-4 h-4" /></span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      {/* Keyed on the connected environment so every page reloads its data after a switch */}
      <main key={`${connectedEnvIndex ?? -1}:${refreshCount}`} className="flex-1 overflow-hidden px-3 sm:px-4">
        {mode === 'observability' && (
          <>
            {navItem === 'queries' && <QueriesPage />}
            {navItem === 'textlog' && <TextLogPage />}
            {navItem === 'partlog' && <PartLogPage />}
            {navItem === 'parts' && <PartsPage />}
            {navItem === 'activity' && <ActivityPage />}
            {navItem === 'cluster' && <ClusterPage />}
            {navItem === 'instance' && <InstancePage />}
          </>
        )}
        {mode === 'recommendations' && <RecommendationsPage />}
        {mode === 'alerting' && <AlertingPage hasAlertsFolder={hasAlertsFolder} />}
        {mode === 'checks' && navItem === 'testing' && (
          hasQueriesFolder ? <MyQueriesPage /> : (
            <ClientFolderNotice kind="performance" className="m-1.5 mt-3" />
          )
        )}
        {mode === 'checks' && navItem === 'loadtesting' && <LoadTestingPage />}
        {mode === 'checks' && navItem === 'dataquality' && <DataQualityPage />}
        {mode === 'dictionary' && (
          <>
            {navItem === 'dictionary' && <DataDictionaryPage />}
            {navItem === 'browser' && <DatabaseBrowser embedded />}
            {navItem === 'explorer' && <DataExplorerPage />}
          </>
        )}
        {mode === 'security' && (navItem === 'security' || navItem === 'access' || navItem === 'quotas') && <SecurityPage key={navItem} section={navItem} />}
        {mode === 'notebooks' && <NotebooksPage />}
        {mode === 'cost' && <CostPage />}
        {mode === 'settings' && <SettingsPage lightMode={lightMode} onLightModeChange={changeTheme} />}
      </main>

      {/* Footer */}
      <footer className="bg-gray-900 border-t border-gray-700 px-3 sm:px-4 py-1.5 flex items-center justify-between shrink-0">
        <button
          onClick={() => setAboutOpen(true)}
          className="text-xs text-gray-400 hover:text-blue-400 hover:underline cursor-pointer"
        >
          Convoy V0.4 · New Cadence
        </button>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          {(connecting || switching) && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400 font-mono">
              <Circle className="w-2 h-2 fill-yellow-500 text-yellow-500 animate-pulse" />
              Connecting to {connectingToName || activeEnvName || 'database'}...
            </span>
          )}
          {!connecting && !switching && connectionInfo && !backendError && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400 font-mono">
              <Circle className="w-2 h-2 fill-green-500 text-green-500" />
              {connectionInfo.name}: {connectionInfo.user}@{connectionInfo.host}:{connectionInfo.port}
              {environments[connectedEnvIndex ?? activeEnvIndex]?.deployment === 'cloud' ? (
                <span className="ml-1 px-1.5 py-px rounded border text-[10px] font-sans font-medium text-blue-400 bg-blue-900/40 border-blue-800">ClickHouse Cloud</span>
              ) : environments[connectedEnvIndex ?? activeEnvIndex] && (
                <span className="ml-1 px-1.5 py-px rounded border text-[10px] font-sans font-medium text-green-400 bg-green-900/40 border-green-800">Open Source</span>
              )}
            </span>
          )}
          {!connecting && !switching && backendError && (
            <span className="flex items-center gap-1.5 text-xs text-red-400 font-mono">
              <Circle className="w-2 h-2 fill-red-500 text-red-500" />
              {backendError.envName || 'Not connected'}
            </span>
          )}
          {/* Connect button */}
          <button
            onClick={() => {
              if (connectedEnvIndex !== null) {
                setActiveEnvIndex(connectedEnvIndex);
              }
              setInitialConnectOpen(true);
            }}
            disabled={environments.length === 0}
            title={environments.length === 0 ? 'No environments configured' : 'Connect to database'}
            className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Network className="w-4 h-4" />
          </button>
        </div>
      </footer>

      {/* Profile Events Modal */}
      <ProfileEventsModal />

      {/* Query Editor Modal */}
      {queryEditorOpen && (
        <QueryEditor
          initialQuery={queryEditorInitialQuery}
          onClose={() => {
            setQueryEditorOpen(false);
            setQueryEditorInitialQuery('');
          }}
        />
      )}

      {/* About Modal */}
      {aboutOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setAboutOpen(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 p-6 w-[520px] max-w-[90vw]">
            <button
              onClick={() => setAboutOpen(false)}
              className="absolute top-3 right-3 text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex flex-col items-center gap-4">
              <span className="w-10 h-10 bg-[var(--brand-accent)]" aria-hidden="true" />
              <h2 className="text-xl font-bold text-white">Convoy V0.4</h2>
              <p className="text-sm text-gray-300 text-center">
                Monitor, test, secure and manage ClickHouse. Formerly Query Dog.
              </p>
              <p className="text-sm text-gray-400 text-center italic">
                🎵 Who let the logs out... 🎵
              </p>
              <a
                href="https://newcadence.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                By New Cadence
              </a>
              <button
                onClick={() => setAboutOpen(false)}
                className="mt-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm font-medium"
              >
                Dismiss
              </button>
            </div>
          </div>
        </>
      )}

      {/* Error Modal - only show if no backend error (to avoid double modals) */}
      {error && !backendError && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setError(null)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-950 border border-red-700 rounded-lg shadow-xl z-50 p-6 w-[520px] max-w-[90vw]">
            <button
              onClick={() => setError(null)}
              className="absolute top-3 right-3 text-red-200 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex flex-col items-center gap-4">
              <AlertTriangle className="w-12 h-12 text-red-400" />
              <h2 className="text-lg font-semibold text-red-100">Error</h2>
              {environments[activeEnvIndex] && (
                <div className="bg-red-900/50 border border-red-700 rounded px-4 py-2 w-full text-center">
                  <span className="text-red-300 text-sm font-mono">{environments[activeEnvIndex].name}</span>
                </div>
              )}
              <p className="text-sm text-red-200 text-center whitespace-pre-wrap break-words">
                {error}
              </p>
              <button
                onClick={() => setError(null)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm font-medium"
              >
                Dismiss
              </button>
            </div>
          </div>
        </>
      )}

      {/* Connection Error Modal */}
      {backendError && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-50"
            onClick={() => {
              const hadConnection = !!connectionInfo;
              setBackendError(null);
              if (!hadConnection) {
                setInitialConnectOpen(true);
              }
            }}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-950 border border-red-700 rounded-lg shadow-xl z-50 p-6 w-[520px] max-w-[90vw]">
            <button
              onClick={() => {
                const hadConnection = !!connectionInfo;
                setBackendError(null);
                if (!hadConnection) {
                  setInitialConnectOpen(true);
                }
              }}
              className="absolute top-3 right-3 text-red-200 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex flex-col items-center gap-4">
              <AlertTriangle className="w-12 h-12 text-red-400" />
              <h2 className="text-lg font-semibold text-red-100">
                {backendError.isBackendServer ? 'Backend Server Unavailable' : 'Database Connection Failed'}
              </h2>
              {!backendError.isBackendServer && backendError.envName && (
                <div className="bg-red-900/50 border border-red-700 rounded px-4 py-2 w-full text-center">
                  <span className="text-red-300 text-sm font-mono">{backendError.envName}</span>
                </div>
              )}
              <p className="text-sm text-red-200 text-center">
                {backendError.message}
              </p>

              <div className="flex gap-3 mt-2">
                <button
                  onClick={() => {
                    const hadConnection = !!connectionInfo;
                    setBackendError(null);
                    if (!hadConnection) {
                      setInitialConnectOpen(true);
                    }
                  }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm font-medium"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Database Manager Modal */}
      <DatabaseManager
        isOpen={initialConnectOpen && !aboutOpen}
        onClose={() => setInitialConnectOpen(false)}
        onConnect={(result, envIndex) => {
          if (result.connected) {
            setConnectionInfo({
              name: result.name,
              host: result.host,
              port: String(result.port),
              secure: false,
              user: environments[envIndex]?.user || 'default',
            });
            setConnectedEnvIndex(envIndex);
            setActiveEnvIndex(envIndex);
            setBackendError(null);
            refresh();
          } else {
            setBackendError({
              message: result.error || 'Connection failed',
              envName: result.name
            });
          }
        }}
        connectedEnvIndex={connectedEnvIndex}
      />
    </div>
  );
}

export default App;
