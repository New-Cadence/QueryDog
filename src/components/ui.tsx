// Shared layout primitives for the Convoy pages. These mirror the
// patterns established by the original Observability screens (toolbar strip,
// underline tabs, bordered panels) so every mode looks and behaves the same.
import { Children, createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Inbox, Loader2, Search, X, type LucideIcon } from 'lucide-react';

const ToolbarTarget = createContext<HTMLElement | null>(null);
// The right end of the page's tab row, which PageTabs registers
const TabsRightTarget = createContext<{ el: HTMLElement | null; setEl: (el: HTMLElement | null) => void } | null>(null);

// Wrap a tabbed page in this to show the active tab's PageToolbar at the very
// top, above the tabs, the way the Observability and Testing screens do. It
// also lets a tab put controls (e.g. a column selector) level with the tabs.
export function ToolbarHost({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [tabsEl, setTabsEl] = useState<HTMLElement | null>(null);
  return (
    <ToolbarTarget.Provider value={el}>
      <TabsRightTarget.Provider value={{ el: tabsEl, setEl: setTabsEl }}>
        <div ref={setEl} className="shrink-0 empty:hidden" />
        {children}
      </TabsRightTarget.Provider>
    </ToolbarTarget.Provider>
  );
}

// Renders at the right of the page's tab row (inside a ToolbarHost), or in
// place when there is none
export function InTabsRight({ children }: { children: ReactNode }) {
  const target = useContext(TabsRightTarget)?.el;
  return target ? createPortal(children, target) : children;
}

// Renders into the nearest ToolbarHost, or in place when there is none
export function InToolbarHost({ children }: { children: ReactNode }) {
  const target = useContext(ToolbarTarget);
  return target ? createPortal(children, target) : children;
}

// The thin strip at the top of every page: search/filters on the left,
// counts and actions on the right.
export function PageToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <InToolbarHost>
      <div className="bg-gray-900/50 border-b border-gray-700 px-1.5 h-9 flex items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">{left}</div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </InToolbarHost>
  );
}

export function ToolbarSearch({
  value,
  onChange,
  placeholder = 'Search...',
  width = 'w-64',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: string;
}) {
  return (
    <div className="relative flex items-center">
      <Search className="absolute left-2 w-3 h-3 text-gray-400" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`bg-gray-800 border border-gray-600 rounded pl-6 pr-6 py-0.5 text-white text-xs ${width} focus:outline-none focus:border-blue-500`}
      />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-2 text-gray-400 hover:text-white">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  secondary: 'bg-gray-700 hover:bg-gray-600 text-gray-300',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
  success: 'bg-green-700 hover:bg-green-600 text-white',
};

export function ToolbarButton({
  icon: Icon,
  children,
  onClick,
  disabled,
  variant = 'secondary',
  title,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${buttonVariants[variant]}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  badge?: ReactNode;
}

// Underline-style tabs used inside a page (matches UsersPage / InstancePage).
export function PageTabs<T extends string>({
  tabs,
  active,
  onChange,
  right,
  nested = false,
}: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  right?: ReactNode;
  // Tabs inside a modal or panel: don't take over the page's InTabsRight slot
  nested?: boolean;
}) {
  const tabsRight = useContext(TabsRightTarget)?.setEl;
  const registerTabsRight = nested ? undefined : tabsRight;
  return (
    <div className="border-b border-gray-700 px-1.5 pt-3 flex items-center gap-1 shrink-0">
      {tabs.map(({ id, label, icon: Icon, badge }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
            active === id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          {Icon && <Icon className="w-3 h-3" />}
          {label}
          {badge}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {right}
        {registerTabsRight && <div ref={registerTabsRight} className="flex items-center gap-2 empty:hidden" />}
      </div>
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = 'p-3',
}: {
  title?: ReactNode;
  // Accepted for existing callers but not drawn: panel titles are text only
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={`bg-gray-900 border border-gray-700 rounded-lg overflow-hidden flex flex-col ${className}`}>
      {title && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-gray-200">
            {title}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </div>
  );
}

type Tone = 'default' | 'blue' | 'green' | 'yellow' | 'red';

const toneText: Record<Tone, string> = {
  default: 'text-white',
  blue: 'text-blue-400',
  green: 'text-green-400',
  yellow: 'text-yellow-400',
  red: 'text-red-400',
};

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  title?: string;
}) {
  // `sub` is shown as a hover hint rather than a second line, to keep the cards quiet
  const hint = title ?? (typeof sub === 'string' ? sub : undefined);
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 min-w-0" title={hint}>
      <div className="flex items-center gap-1.5 text-[11px] text-gray-500 uppercase tracking-wide">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </div>
      <div className={`text-xl font-semibold mt-1 truncate ${toneText[tone]}`}>{value}</div>
    </div>
  );
}

const pillTones: Record<Tone, string> = {
  default: 'text-gray-300 bg-gray-800 border-gray-600',
  blue: 'text-blue-400 bg-blue-900/40 border-blue-800',
  green: 'text-green-400 bg-green-900/40 border-green-800',
  yellow: 'text-yellow-400 bg-yellow-900/40 border-yellow-800',
  red: 'text-red-400 bg-red-900/40 border-red-800',
};

// Labels read as "Info", "Warning", "Firing": the first text in a pill is capitalised
function capitaliseFirstText(children: ReactNode): ReactNode {
  let done = false;
  return Children.map(children, child => {
    if (done || typeof child !== 'string' || !child.trim()) return child;
    done = true;
    return child.replace(/^(\s*)(\S)/, (_, space: string, first: string) => space + first.toUpperCase());
  });
}

export function Pill({ children, tone = 'default', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-px rounded border font-medium whitespace-nowrap ${pillTones[tone]}`}>
      {capitaliseFirstText(children)}
    </span>
  );
}

// The one "nothing here" state used everywhere. Full size fills a page or tab;
// `compact` is for inside panels, drawers and grid overlays.
export function EmptyState({ icon: Icon = Inbox, title, children, compact = false }: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`flex-1 h-full flex flex-col items-center justify-center text-gray-500 text-center font-sans ${compact ? 'gap-1.5 px-3 py-5' : 'gap-3 p-6'}`}>
      <Icon className={compact ? 'w-5 h-5 text-gray-600' : 'w-12 h-12 text-gray-600'} />
      <p className={compact ? 'text-xs' : 'text-sm'}>{title}</p>
      {children && <div className="text-xs text-gray-600 max-w-md">{children}</div>}
    </div>
  );
}

// ag-grid overlays matching the above (spread GRID_OVERLAYS from gridOverlays.ts into a grid)
export function GridLoadingOverlay() {
  return <LoadingState />;
}

export function GridNoRowsOverlay({ title = 'No data' }: { title?: string }) {
  return <EmptyState compact title={title} />;
}

// The one loading indicator used everywhere: a spinner with a short label,
// centred in the space the content will occupy. `compact` is for inline spots
// such as filter value lists and side-panel sections.
export function LoadingState({ label = 'Loading…', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`flex items-center justify-center gap-2 text-xs text-gray-400 ${compact ? 'py-2' : 'flex-1 h-full min-h-24 p-4'}`}>
      <Loader2 className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} animate-spin text-blue-400`} />
      {label}
    </div>
  );
}

// Small banner used to flag screens that display simulated / illustrative data.
export function PreviewBanner({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1.5 rounded text-xs bg-yellow-900/40 border border-yellow-800 text-yellow-300">
      {children}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-gray-500 mt-0.5">{hint}</span>}
    </label>
  );
}
