import { useMemo } from 'react';
import { ReactFlow, type Node, type Edge, Background, BackgroundVariant, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { BookOpen, Database, Eye, GitBranch, Layers, Share2, Table } from 'lucide-react';
import { EmptyState } from '../ui';
import type { LineageGraphData, LineageKind } from './api';

const MAX_DEPTH = 4;

const KIND_LABEL: Record<LineageKind, string> = {
  materialized_view: 'MV',
  mv_target: 'TO',
  view: 'view',
  distributed: 'distributed',
  dictionary: 'dictionary',
};

const KIND_COLOR: Record<LineageKind, string> = {
  materialized_view: '#22c55e',
  mv_target: '#22c55e',
  view: '#14b8a6',
  distributed: '#ef4444',
  dictionary: '#f59e0b',
};

function EngineIcon({ engine, className }: { engine: string; className: string }) {
  if (engine === 'MaterializedView') return <Layers className={className} />;
  if (engine === 'View') return <Eye className={className} />;
  if (engine === 'Dictionary') return <BookOpen className={className} />;
  if (engine === 'Distributed') return <Share2 className={className} />;
  if (engine === 'unknown') return <Database className={className} />;
  return <Table className={className} />;
}

interface LineageNodeData extends Record<string, unknown> {
  database: string;
  name: string;
  engine: string;
  current: boolean;
  onClick?: () => void;
}

// Same compact look as the DatabaseBrowser graph nodes.
function LineageNode({ data }: { data: LineageNodeData }) {
  return (
    <div
      onClick={data.onClick}
      title={data.onClick ? `Open ${data.database}.${data.name}` : 'Not in the catalog'}
      className={`w-[200px] px-2 py-1.5 rounded border transition-all ${data.onClick ? 'cursor-pointer' : 'cursor-default opacity-70'} ${
        data.current ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-blue-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-green-500" />
      <div className="flex items-center gap-1.5 min-w-0">
        <EngineIcon engine={data.engine} className={`w-3 h-3 shrink-0 ${data.current ? 'text-white' : 'text-blue-400'}`} />
        <div className="min-w-0">
          <div className={`text-[9px] truncate ${data.current ? 'text-blue-100' : 'text-gray-500'}`}>{data.database} · {data.engine}</div>
          <div className="text-[11px] font-mono truncate">{data.name}</div>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { lineage: LineageNode };

// Walks the instance-wide lineage graph from `current` in both directions and
// lays the reachable tables out in columns by distance (upstream on the left).
export function LineageGraph({
  graph,
  current,
  isKnown,
  onNavigate,
}: {
  graph: LineageGraphData;
  current: { database: string; name: string };
  isKnown: (database: string, name: string) => boolean;
  onNavigate: (database: string, name: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const start = graph.nodes.find(n => n.database === current.database && n.name === current.name);
    if (!start) return { nodes: [], edges: [] };

    const depth = new Map<string, number>([[start.id, 0]]);
    const walk = (dir: 1 | -1) => {
      let frontier = [start.id];
      for (let d = 1; d <= MAX_DEPTH && frontier.length; d++) {
        const next: string[] = [];
        for (const e of graph.edges) {
          const [from, to] = dir === 1 ? [e.from, e.to] : [e.to, e.from];
          if (frontier.includes(from) && !depth.has(to)) {
            depth.set(to, d * dir);
            next.push(to);
          }
        }
        frontier = next;
      }
    };
    walk(1);
    walk(-1);

    const rowInColumn = new Map<number, number>();
    const flowNodes: Node<LineageNodeData>[] = [...depth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, d]) => {
        const n = byId.get(id)!;
        const row = rowInColumn.get(d) || 0;
        rowInColumn.set(d, row + 1);
        const known = isKnown(n.database, n.name);
        return {
          id,
          type: 'lineage',
          position: { x: d * 260, y: row * 70 },
          data: {
            database: n.database,
            name: n.name,
            engine: n.engine,
            current: d === 0,
            onClick: known && d !== 0 ? () => onNavigate(n.database, n.name) : undefined,
          },
        };
      });
    const flowEdges: Edge[] = graph.edges
      .filter(e => depth.has(e.from) && depth.has(e.to))
      .map(e => ({
        id: `${e.from}|${e.to}|${e.kind}`,
        source: e.from,
        target: e.to,
        label: KIND_LABEL[e.kind],
        labelStyle: { fill: '#9ca3af', fontSize: 9 },
        labelBgStyle: { fill: '#111827' },
        style: { stroke: KIND_COLOR[e.kind] },
        markerEnd: { type: MarkerType.ArrowClosed, color: KIND_COLOR[e.kind] },
      }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, current, isKnown, onNavigate]);

  if (nodes.length <= 1) {
    return (
      <EmptyState icon={GitBranch} title="No lineage found for this table" />
    );
  }

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex items-center gap-4 text-[11px] text-gray-500 shrink-0">
        <span>Data flows left to right. Click a node to open it.</span>
        {(Object.keys(KIND_LABEL) as LineageKind[]).filter(k => k !== 'mv_target').map(k => (
          <span key={k} className="flex items-center gap-1">
            <span className="w-3 h-0.5" style={{ backgroundColor: KIND_COLOR[k] }} />
            {k === 'materialized_view' ? 'materialized view / TO target' : k}
          </span>
        ))}
      </div>
      <div className="flex-1 bg-gray-900 border border-gray-700 rounded overflow-hidden">
        <ReactFlow
          // Remount per table so fitView re-centres on the new neighbourhood
          key={`${current.database}.${current.name}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1.3 }}
          minZoom={0.3}
          maxZoom={2}
          nodesConnectable={false}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#374151" />
          <Controls
            showInteractive={false}
            className="!bg-gray-800 !border-gray-600 !rounded [&>button]:!bg-gray-700 [&>button]:!border-gray-600 [&>button]:!text-gray-300 [&>button:hover]:!bg-gray-600 [&>button>svg]:!fill-gray-300"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
