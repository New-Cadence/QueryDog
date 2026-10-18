import { useState, useEffect, useCallback } from 'react';
import { Dog, Database, HardDrive, Activity, Server, X, FolderTree, Terminal, FileText, Layers, FileCode, Table, AlertTriangle, Bell, Users, Network, Circle, RefreshCw, Sun, Moon } from 'lucide-react';
import { AutoRefreshToggle } from './components/AutoRefreshToggle';
import { QueriesPage } from './components/pages/QueriesPage';
import { PartsPage } from './components/pages/PartsPage';
import { PartLogPage } from './components/pages/PartLogPage';
import { ActivityPage } from './components/pages/ActivityPage';
import { InstancePage } from './components/pages/InstancePage';
import { UsersPage } from './components/pages/UsersPage';
import { ClusterPage } from './components/pages/ClusterPage';
import { TextLogPage } from './components/pages/TextLogPage';
import { MyQueriesPage } from './components/pages/MyQueriesPage';
import { DataExplorerPage } from './components/pages/DataExplorerPage';
import { AlertsPage } from './components/pages/AlertsPage';
import { ProfileEventsModal } from './components/ProfileEventsModal';
import { DatabaseBrowser } from './components/DatabaseBrowser';
import { DatabaseManager } from './components/DatabaseManager';
import { QueryEditor } from './components/QueryEditor';
import { useQueryStore } from './stores/queryStore';
import { useQueryData } from './hooks/useQueryData';
import { fetchEnvironments, type EnvironmentInfo } from './services/api';

type NavItem = 'queries' | 'textlog' | 'partlog' | 'parts' | 'activity' | 'users' | 'cluster' | 'instance' | 'myqueries' | 'alerts';
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

function App() {
  const [navItem, setNavItem] = useState<NavItem>('queries');
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>('off');
  const [lightMode, setLightMode] = useState(() => {
    const saved = localStorage.getItem('querydog_theme');
    return saved === 'light';
  });

  // Apply theme class to root element
  useEffect(() => {
    if (lightMode) {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('querydog_theme', lightMode ? 'light' : 'dark');
  }, [lightMode]);
  // Show about modal on first visit only (check cookie)
  const [aboutOpen, setAboutOpen] = useState(() => {
    const hasVisited = getCookie('querydog_visited');
    if (!hasVisited) {
      setCookie('querydog_visited', 'true');
      return true;
    }
    return false;
  });
  const [browserOpen, setBrowserOpen] = useState(false);
  const [dataExplorerOpen, setDataExplorerOpen] = useState(false);
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
  const { refresh } = useQueryData(connectionReady);
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
        setActiveEnvIndex(data.active);
        // Show which database we're connecting to
        const activeEnv = data.environments[data.active];
        if (activeEnv) {
          setConnectingToName(activeEnv.name);
        }
        saveCachedEnvironments(data);
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
      setNavItem('queries');
      setActiveTab('queries');
    };
  }, [clearAllFilters, setFieldFilter, setTimeRange, setActiveTab]);

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
      setNavItem('queries');
      setActiveTab('queries');
    };
  }, [clearAllFilters, setFieldFilter, setTimeRange, setActiveTab]);

  // Global auto-refresh
  useEffect(() => {
    if (refreshInterval === 'off') return;
    const interval = setInterval(refresh, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval, refresh]);

  // Close modals on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAboutOpen(false);
        setBrowserOpen(false);
        setDataExplorerOpen(false);
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

  const navItems: { id: NavItem; label: string; icon: typeof Database }[] = [
    { id: 'queries', label: 'Queries', icon: Database },
    ...(hasPartsAccess ? [{ id: 'parts' as const, label: 'Objects', icon: HardDrive }] : []),
    ...(hasPartLogAccess ? [{ id: 'partlog' as const, label: 'Parts Log', icon: Layers }] : []),
    { id: 'activity', label: 'Activity', icon: Activity },
    { id: 'instance', label: 'Instance', icon: Server },
    { id: 'textlog', label: 'Text Log', icon: FileText },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'cluster', label: 'Cluster', icon: Network },
    ...(hasQueriesFolder ? [{ id: 'myqueries' as const, label: 'My Queries', icon: FileCode }] : []),
    ...(hasAlertsFolder ? [{ id: 'alerts' as const, label: 'Alerts', icon: Bell }] : []),
  ];

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-700 px-3 sm:px-4 py-1.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          <button
            onClick={() => {
              setNavItem('queries');
              setActiveTab('queries');
              setChartMetric('count');
              // Reset to last 1 hour
              const end = new Date();
              const start = new Date(end.getTime() - 60 * 60 * 1000);
              setTimeRange({ start, end });
            }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <Dog className="w-5 h-5 text-blue-400" />
            <h1 className="text-base font-bold text-white">Query Dog</h1>
          </button>

          {/* Top Navigation */}
          <nav className="flex items-center gap-1">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setNavItem(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  navItem === id
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setBrowserOpen(true)}
            className="flex items-center gap-1 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs"
            title="Database Browser"
          >
            <FolderTree className="w-3.5 h-3.5" />
            Browse
          </button>
          <button
            onClick={() => setDataExplorerOpen(true)}
            className="flex items-center gap-1 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 text-xs"
            title="Data Explorer"
          >
            <Table className="w-3.5 h-3.5" />
            Data
          </button>
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
            onClick={() => setLightMode(!lightMode)}
            className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 hover:text-white"
            title={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {lightMode ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={refresh}
            className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 hover:text-white"
            title="Refresh data"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <AutoRefreshToggle
            interval={refreshInterval}
            onIntervalChange={setRefreshInterval}
          />
        </div>
      </header>


      {/* Main Content */}
      <main className="flex-1 overflow-hidden px-3 sm:px-4">
        {navItem === 'queries' && <QueriesPage />}
        {navItem === 'textlog' && <TextLogPage />}
        {navItem === 'partlog' && <PartLogPage />}
        {navItem === 'parts' && <PartsPage />}
        {navItem === 'activity' && <ActivityPage />}

        {navItem === 'users' && <UsersPage />}
        {navItem === 'cluster' && <ClusterPage />}
        {navItem === 'instance' && <InstancePage />}
        {navItem === 'alerts' && <AlertsPage />}
        {navItem === 'myqueries' && <MyQueriesPage />}
      </main>

      {/* Footer */}
      <footer className="bg-gray-900 border-t border-gray-700 px-3 sm:px-4 py-1.5 flex items-center justify-between shrink-0">
        <button
          onClick={() => setAboutOpen(true)}
          className="text-xs text-gray-400 hover:text-blue-400 hover:underline cursor-pointer"
        >
          About Query Dog V0.3
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

      {/* Database Browser Modal */}
      {browserOpen && <DatabaseBrowser onClose={() => setBrowserOpen(false)} />}

      {/* Data Explorer Modal */}
      {dataExplorerOpen && <DataExplorerPage onClose={() => setDataExplorerOpen(false)} />}

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
              <Dog className="w-12 h-12 text-blue-400" />
              <h2 className="text-xl font-bold text-white">Query Dog V0.3</h2>
              <p className="text-sm text-gray-300 text-center">
                A tool for analysing the ClickHouse query log.
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
