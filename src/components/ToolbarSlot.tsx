import type { Ref } from 'react';
import { InToolbarHost } from './ui';

// An empty page toolbar strip (same look as ui.tsx PageToolbar) that a child
// component, such as SystemTable, fills via a portal with its own filters,
// search and counts.
export function ToolbarSlot({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <InToolbarHost>
      <div ref={ref} className="bg-gray-900/50 border-b border-gray-700 px-1.5 h-9 flex items-center justify-between shrink-0 gap-3" />
    </InToolbarHost>
  );
}
