import { useState, useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { User, Key, Database, AlertTriangle } from 'lucide-react';
import { PageToolbar, ToolbarButton } from '../ui';
import { authTypes, hostSummary, scopeDatabase, isDangerous, type SecurityData } from './model';

type GraphKind = 'user' | 'role' | 'scope';

const graphColors: Record<GraphKind, { bg: string; border: string; text: string; handle: string; icon: typeof User }> = {
  user: { bg: 'bg-amber-600', border: 'border-amber-400', text: 'text-amber-400', handle: '!bg-amber-500', icon: User },
  role: { bg: 'bg-violet-600', border: 'border-violet-400', text: 'text-violet-400', handle: '!bg-violet-500', icon: Key },
  scope: { bg: 'bg-blue-600', border: 'border-blue-400', text: 'text-blue-400', handle: '!bg-blue-500', icon: Database },
};

interface GraphNodeData extends Record<string, unknown> {
  kind: GraphKind;
  label: string;
  sublabel?: string;
  highlighted: boolean;
  dimmed: boolean;
  warning?: boolean;
}

function AccessNode({ data }: { data: GraphNodeData }) {
  const c = graphColors[data.kind];
  const Icon = c.icon;
  return (
    <div
      className={`w-[190px] px-2 py-1.5 rounded border cursor-pointer transition-all ${
        data.highlighted ? `${c.bg} ${c.border} text-white` : `bg-gray-800 ${data.warning ? 'border-red-500' : 'border-gray-600'} text-gray-200`
      } ${data.dimmed ? 'opacity-30' : ''}`}
    >
      {data.kind !== 'user' && <Handle type="target" position={Position.Left} className={c.handle} />}
      {data.kind !== 'scope' && <Handle type="source" position={Position.Right} className={c.handle} />}
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3 h-3 shrink-0 ${data.highlighted ? 'text-white' : c.text}`} />
        <span className="text-[10px] font-semibold truncate">{data.label}</span>
        {data.warning && <AlertTriangle className="w-3 h-3 text-red-400 ml-auto shrink-0" />}
      </div>
      {data.sublabel && <div className={`text-[9px] truncate mt-0.5 ${data.highlighted ? 'text-white/80' : 'text-gray-500'}`}>{data.sublabel}</div>}
    </div>
  );
}

const nodeTypes = { access: AccessNode };

// Column of each role: roles nobody else grants sit in column 0, a role granted
// to another role sits one column right of the deepest role that holds it.
function roleDepths(data: SecurityData): Map<string, number> {
  const depth = new Map<string, number>();
  const parents = (role: string) => data.roleGrants.filter(rg => rg.role_name && rg.granted_role_name === role).map(rg => rg.role_name!);
  const visit = (role: string, stack: Set<string>): number => {
    if (depth.has(role)) return depth.get(role)!;
    if (stack.has(role)) return 0; // cycles are rejected by ClickHouse; guard anyway
    stack.add(role);
    const d = Math.max(-1, ...parents(role).map(p => visit(p, stack))) + 1;
    stack.delete(role);
    depth.set(role, d);
    return d;
  };
  data.roles.forEach(r => visit(r.name, new Set()));
  return depth;
}

export function AccessGraphTab({ data }: { data: SecurityData }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [hideDefault, setHideDefault] = useState(true);

  const { nodes, edges } = useMemo(() => {
    const users = data.users.filter(u => !(hideDefault && u.name === 'default'));
    const userNames = new Set(users.map(u => u.name));
    const depth = roleDepths(data);
    const maxDepth = Math.max(0, ...depth.values());

    const edgeList: { source: string; target: string; label?: string; dangerous?: boolean }[] = [];
    data.roleGrants.forEach(rg => {
      if (rg.user_name && userNames.has(rg.user_name)) edgeList.push({ source: `u:${rg.user_name}`, target: `r:${rg.granted_role_name}` });
      if (rg.role_name) edgeList.push({ source: `r:${rg.role_name}`, target: `r:${rg.granted_role_name}` });
    });
    // principal -> database scope, aggregating privileges per database
    const scopeAgg = new Map<string, Set<string>>();
    data.grants.forEach(g => {
      if (g.is_partial_revoke || (g.user_name && !userNames.has(g.user_name))) return;
      const key = `${g.user_name ? `u:${g.user_name}` : `r:${g.role_name}`}|s:${scopeDatabase(g)}`;
      if (!scopeAgg.has(key)) scopeAgg.set(key, new Set());
      scopeAgg.get(key)!.add(g.access_type);
    });
    scopeAgg.forEach((privs, key) => {
      const [source, target] = key.split('|');
      const list = [...privs];
      edgeList.push({ source, target, label: list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', '), dangerous: list.some(isDangerous) });
    });
    const scopes = [...new Set([...scopeAgg.keys()].map(k => k.split('|')[1]))].sort();

    // Highlight the focused node plus everything downstream and upstream of it
    const highlighted = new Set<string>();
    if (focus) {
      highlighted.add(focus);
      for (const [from, to] of [['source', 'target'], ['target', 'source']] as const) {
        let frontier = [focus];
        while (frontier.length) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const e of edgeList) {
              if (e[from] === id && !highlighted.has(e[to])) { highlighted.add(e[to]); next.push(e[to]); }
            }
          }
          frontier = next;
        }
      }
    }

    const ROW = 56;
    const COL = 280;
    const nodeList: Node<GraphNodeData>[] = [];
    const mk = (id: string, kind: GraphKind, label: string, x: number, y: number, sublabel?: string, warning?: boolean) => {
      nodeList.push({ id, type: 'access', position: { x, y }, data: { kind, label, sublabel, warning, highlighted: highlighted.has(id), dimmed: !!focus && !highlighted.has(id) } });
    };
    users.forEach((u, i) => mk(`u:${u.name}`, 'user', u.name, 0, i * ROW, `${authTypes(u).join(', ')} · ${hostSummary(u)}`, authTypes(u).includes('no_password')));
    for (let d = 0; d <= maxDepth; d++) {
      data.roles.filter(r => (depth.get(r.name) ?? 0) === d).forEach((r, i) => {
        const members = data.roleGrants.filter(rg => rg.granted_role_name === r.name).length;
        mk(`r:${r.name}`, 'role', r.name, COL * (d + 1), i * ROW + 20, `${members} member${members === 1 ? '' : 's'}`);
      });
    }
    scopes.forEach((s, i) => mk(s, 'scope', s === 's:*' ? '*.* (all databases)' : s.slice(2), COL * (maxDepth + 2), i * ROW, undefined, s === 's:*'));

    const edgeObjs: Edge[] = edgeList.map((e, i) => {
      const active = !focus || (highlighted.has(e.source) && highlighted.has(e.target));
      return {
        id: `e${i}`, source: e.source, target: e.target, label: e.label,
        animated: active && !!focus,
        style: { stroke: e.dangerous ? '#ef4444' : e.target.startsWith('r:') ? '#a78bfa' : '#60a5fa', opacity: active ? 1 : 0.15, strokeWidth: active && focus ? 2 : 1 },
        labelStyle: { fill: '#d1d5db', fontSize: 9 },
        labelBgStyle: { fill: '#111827' },
      };
    });
    return { nodes: nodeList, edges: edgeObjs };
  }, [data, focus, hideDefault]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageToolbar
        left={
          <>
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={hideDefault} onChange={e => setHideDefault(e.target.checked)} />
              Hide default user
            </label>
            {focus && <ToolbarButton onClick={() => setFocus(null)}>Clear focus</ToolbarButton>}
            <span className="text-[11px] text-gray-500">Click a node to trace its access paths</span>
          </>
        }
        right={
          <span className="flex items-center gap-3 text-[11px] text-gray-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" />User</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-500" />Role</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500" />Database scope</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-500" />Destructive privilege</span>
          </span>
        }
      />
      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4">
        <div className="h-full bg-gray-900 border border-gray-700 rounded overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            nodesDraggable
            onNodeClick={(_, node) => setFocus(prev => (prev === node.id ? null : node.id))}
            onPaneClick={() => setFocus(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#374151" gap={20} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
