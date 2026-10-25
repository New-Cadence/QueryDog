// One notice, used on every screen that loads files from the client folder
// (monitoring, alerts, performance, data quality), so a missing folder or
// missing files are reported the same way everywhere.
import { useEffect, useState } from 'react';
import { FolderOpen, AlertTriangle } from 'lucide-react';

type ClientFolderKind = 'monitoring' | 'alerts' | 'performance' | 'dataquality';

interface FolderInfo { path: string; exists: boolean; files: number }
interface ClientInfo { client: string; path: string; folders: Record<ClientFolderKind, FolderInfo> }

// What each folder is expected to hold
const FILES: Record<ClientFolderKind, string> = {
  monitoring: '.sql files',
  alerts: 'rules.yml',
  performance: '.sql files',
  dataquality: '.sql files',
};

// Folder info changes only on redeploy; one request serves every screen until a reload
let cached: Promise<ClientInfo> | null = null;
function loadClientInfo(): Promise<ClientInfo> {
  cached ??= fetch('/api/client').then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).catch(e => { cached = null; throw e; });
  return cached;
}

function useClientFolders() {
  const [info, setInfo] = useState<ClientInfo | null>(null);
  useEffect(() => {
    let live = true;
    loadClientInfo().then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return info;
}

// Problems loading individual files, e.g. data quality files that failed to parse
interface FileError { file: string; error: string }

// onlyProblems: render nothing while the folder is fine (for secondary folders)
export function ClientFolderNotice({ kind, errors = [], onlyProblems = false, className = '' }: {
  kind: ClientFolderKind; errors?: FileError[]; onlyProblems?: boolean; className?: string;
}) {
  const info = useClientFolders();
  const folder = info?.folders[kind];
  if (!folder) return null;
  const problem = !folder.exists
    ? `The ${kind} folder was not found at ${folder.path}.`
    : folder.files === 0
      ? `No ${FILES[kind]} found in ${folder.path}.`
      : null;
  if (onlyProblems && !problem && !errors.length) return null;

  return (
    <div className={`space-y-1.5 shrink-0 ${className}`}>
      <div className={`px-3 py-1.5 rounded text-xs border flex items-start gap-2 ${
        problem ? 'bg-yellow-900/30 border-yellow-800 text-yellow-300' : 'bg-gray-900 border-gray-700 text-gray-400'
      }`}>
        {problem ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> : <FolderOpen className="w-3.5 h-3.5 shrink-0 mt-px" />}
        <span>
          {problem ?? <><span className="text-gray-300">{folder.files} {kind === 'alerts' ? 'rules file' : `file${folder.files === 1 ? '' : 's'}`}</span> from <code className="text-gray-300">{folder.path}</code></>}
        </span>
      </div>
      {errors.length > 0 && (
        <div className="px-3 py-1.5 rounded text-xs bg-red-900/40 border border-red-800 text-red-300">
          {errors.length} file{errors.length === 1 ? '' : 's'} in the {kind} folder could not be loaded:
          {errors.map(e => <div key={e.file} className="font-mono text-[11px]">{e.file}: {e.error}</div>)}
        </div>
      )}
    </div>
  );
}
