// Shows the login screen until there is a session, when querydog.yml has
// `auth:` users. Any API call answered 401 (an expired session) brings the
// login screen back.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { LoadingState } from '../components/ui';
import { inputClass } from '../components/uiTokens';
import { AuthContext } from './authContext';

type Status = { state: 'checking' } | { state: 'open' } | { state: 'login' } | { state: 'in'; user: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ state: 'checking' });

  useEffect(() => {
    let live = true;
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((me: { authEnabled: boolean; user: string | null }) => {
        if (!live) return;
        setStatus(!me.authEnabled ? { state: 'open' } : me.user ? { state: 'in', user: me.user } : { state: 'login' });
      })
      .catch(() => live && setStatus({ state: 'open' }));
    return () => { live = false; };
  }, []);

  // Watch every API response for an expired session
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) setStatus(s => (s.state === 'in' ? { state: 'login' } : s));
      return res;
    };
    return () => { window.fetch = realFetch; };
  }, []);

  const logout = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => window.location.reload());
  }, []);

  if (status.state === 'checking') return <div className="h-screen flex bg-gray-950"><LoadingState /></div>;
  if (status.state === 'login') return <LoginScreen onLoggedIn={user => setStatus({ state: 'in', user })} />;
  return (
    <AuthContext.Provider value={{ authEnabled: status.state === 'in', user: status.state === 'in' ? status.user : null, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: (user: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Login failed');
      onLoggedIn(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-gray-950 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-[13px] h-[13px] bg-[var(--brand-accent)]" aria-hidden="true" />
          <h1 className="text-[17px] font-bold text-white">Convoy</h1>
        </div>
        <label className="block space-y-1">
          <span className="text-[11px] text-gray-400 uppercase tracking-wide">Username</span>
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoFocus className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-gray-400 uppercase tracking-wide">Password</span>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className={inputClass} />
        </label>
        {error && <div className="px-3 py-2 rounded text-xs bg-red-900/50 border border-red-800 text-red-300">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          Log in
        </button>
      </form>
    </div>
  );
}
