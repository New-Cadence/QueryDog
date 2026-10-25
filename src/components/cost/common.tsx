// Small shared components for the Cost tabs: the toolbar, item counts and
// loading / error boxes.
import type { ReactNode } from 'react';
import { PageToolbar, LoadingState } from '../ui';

// The environment and its deployment type are shown in the app footer.
export function CostToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return <PageToolbar left={left} right={right} />;
}

export function FilterCounts({ count, noun = 'items', active }: { count: number; noun?: string; active: number }) {
  return (
    <>
      <span className="text-xs text-gray-400">{count.toLocaleString()} {noun}</span>
      {active > 0 && <span className="text-xs text-blue-400">{active} filter{active > 1 ? 's' : ''} active</span>}
    </>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <LoadingState label={label} />;
}

export function ErrorBox({ error }: { error: string }) {
  return <div className="px-3 py-2 rounded text-xs bg-red-900/50 border border-red-800 text-red-300 shrink-0">{error}</div>;
}

export function InfoBox({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 rounded text-xs bg-blue-900/30 border border-blue-800 text-blue-200 shrink-0">{children}</div>;
}
