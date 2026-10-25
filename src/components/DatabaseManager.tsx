import { useState, useEffect, useCallback } from 'react';
import { X, Database, Play, AlertCircle, Loader2, Shield, ShieldOff } from 'lucide-react';
import {
  fetchFullEnvironments,
  switchEnvironment,
  type FullEnvironmentInfo,
} from '../services/api';
import { LoadingState } from './ui';

interface DatabaseManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (result: { name: string; host: string; port: number; connected: boolean; error?: string }, envIndex: number) => void;
  connectedEnvIndex: number | null;
}

export function DatabaseManager({ isOpen, onClose, onConnect, connectedEnvIndex }: DatabaseManagerProps) {
  const [environments, setEnvironments] = useState<FullEnvironmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEnvironments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchFullEnvironments();
      setEnvironments(data.environments);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadEnvironments();
    }
  }, [isOpen, loadEnvironments]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleConnect = async (index: number) => {
    try {
      setConnecting(index);
      const result = await switchEnvironment(index);
      onConnect(result, index);
      if (result.connected) {
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(null);
    }
  };

  // Only show the Organisation column when some environment sets one
  const showOrganisation = environments.some(e => e.organisation);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 p-6 w-[1000px] max-w-[95vw] max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <Database className="w-8 h-8 text-blue-400" />
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Database Connections</h2>
            <p className="text-xs text-gray-400">
              Select a ClickHouse database to connect to
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-sm text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="space-y-3">
          {loading ? (
            <LoadingState label="Loading connections…" />
          ) : environments.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              No connections configured. Add environments to your querydog.yml file.
            </div>
          ) : (
            <div className="bg-gray-800 rounded max-h-[30rem] overflow-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="sticky top-0 bg-gray-800">
                  <tr className="border-b border-gray-700">
                    {showOrganisation && <th className="text-left p-2 text-gray-400">Organisation</th>}
                    <th className="text-left p-2 text-gray-400">Environment</th>
                    <th className="text-left p-2 text-gray-400">Host</th>
                    <th className="text-left p-2 text-gray-400">User</th>
                    <th className="text-center p-2 text-gray-400 w-16">TLS</th>
                    <th className="text-right p-2 text-gray-400 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {environments.map((env) => (
                    <tr
                      key={env.index}
                      className={`border-b border-gray-700/50 hover:bg-gray-700/30 ${connectedEnvIndex === env.index ? 'bg-blue-900/20' : ''}`}
                    >
                      {showOrganisation && <td className="p-2 text-gray-300" title={env.name}>{env.organisation || <span className="italic text-gray-500">Unspecified</span>}</td>}
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span className="text-blue-300 font-medium" title={env.name}>{env.environment || env.name}</span>
                          {connectedEnvIndex === env.index && (
                            <span className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded">Connected</span>
                          )}
                        </div>
                      </td>
                      <td className="p-2 text-gray-300 font-mono text-[11px]">{env.host}:{env.port}</td>
                      <td className="p-2 text-gray-400">{env.user}</td>
                      <td className="p-2 text-center">
                        {env.secure ? (
                          <Shield className="w-4 h-4 text-green-400 mx-auto" />
                        ) : (
                          <ShieldOff className="w-4 h-4 text-yellow-400 mx-auto" />
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex items-center justify-end">
                          <button
                            onClick={() => handleConnect(env.index)}
                            disabled={connecting !== null}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-1.5"
                            title="Connect"
                          >
                            {connecting === env.index ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            Connect
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
