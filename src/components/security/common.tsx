// Small building blocks shared by the Security tabs.
import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { SecurityData } from './model';
import { selectClass } from './helpers';

// Right-hand side of a list toolbar: "N items" and "X filters active"
export function ListCounts({ count, noun, activeFilters, children }: { count: number; noun: string; activeFilters: number; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 text-xs">
      {children}
      <span className="text-gray-400">
        <span className="text-white font-medium">{count.toLocaleString()}</span> {noun}
      </span>
      {activeFilters > 0 && (
        <span className="text-blue-400">{activeFilters} filter{activeFilters > 1 ? 's' : ''} active</span>
      )}
    </div>
  );
}

// <select> over users and roles; values are 'user:<name>' / 'role:<name>'
export function PrincipalSelect({ data, value, onChange, includeRoles = true }: {
  data: SecurityData; value: string; onChange: (id: string) => void; includeRoles?: boolean;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={selectClass}>
      <optgroup label="Users">
        {data.users.map(u => <option key={u.name} value={`user:${u.name}`}>{u.name}</option>)}
      </optgroup>
      {includeRoles && data.roles.length > 0 && (
        <optgroup label="Roles">
          {data.roles.map(r => <option key={r.name} value={`role:${r.name}`}>{r.name} (role)</option>)}
        </optgroup>
      )}
    </select>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable on insecure origins; the SQL stays selectable
    }
  };
  return (
    <button onClick={copy} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300">
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
