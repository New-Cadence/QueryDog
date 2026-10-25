import { useState, useEffect } from 'react';
import {
  ReactFlow,
  type Node,
  type Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X, Database, Table, Layers, Box, ChevronRight, ChevronDown, Loader2, Users, User, Columns, FileText, Sparkles, Zap, Info, Key, Shield, HardDrive, GitBranch, List } from 'lucide-react';
import {
  fetchBrowserDatabases,
  fetchBrowserTables,
  fetchBrowserPartitions,
  fetchBrowserParts,
  fetchBrowserColumns,
  fetchBrowserProjections,
  fetchBrowserProjectionParts,
  fetchBrowserIndexes,
  fetchUsers,
  fetchRoles,
  fetchGrants,
  fetchRoleGrants,
  fetchDisks,
  fetchStoragePolicies,
  type BrowserDatabase,
  type BrowserTable,
  type BrowserPartition,
  type BrowserPart,
  type BrowserColumn,
  type BrowserProjection,
  type BrowserProjectionPart,
  type BrowserIndex,
} from '../services/api';
import { formatBytes, formatNumber } from '../utils/formatters';

interface BrowserUser {
  name: string;
  id: string;
  storage: string;
  auth_type: string;
  auth_params: string;
  host_ip: string[];
  host_names: string[];
  host_names_regexp: string[];
  host_names_like: string[];
  default_roles_all: number;
  default_roles_list: string[];
  default_roles_except: string[];
  grantees_any: number;
  grantees_list: string[];
  grantees_except: string[];
  default_database: string;
}

interface BrowserRole {
  name: string;
  id: string;
  storage: string;
}

interface BrowserGrant {
  user_name: string;
  role_name: string;
  access_type: string;
  database: string;
  table: string;
  column: string;
  is_partial_revoke: number;
  grant_option: number;
}

interface BrowserRoleGrant {
  user_name: string;
  role_name: string;
  granted_role_name: string;
  with_admin_option: number;
}

interface BrowserDisk {
  name: string;
  path: string;
  free_space: number;
  total_space: number;
  type: string;
}

interface BrowserStoragePolicy {
  policy_name: string;
  volume_name: string;
  volume_priority: number;
  disks: string[];
  max_data_part_size: number;
  move_factor: number;
}

// Fixed width and height for all nodes
const nodeWidth = 'w-[180px]';
const nodeHeight = 'py-1.5';

// Info icon button component
function InfoButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute top-0.5 right-0.5 w-3.5 h-3.5 bg-gray-700/80 hover:bg-gray-600 rounded-full flex items-center justify-center z-10"
      title="View details"
    >
      <Info className="w-2.5 h-2.5 text-gray-400" />
    </button>
  );
}

// Root category node (Databases, Users, Roles, Storage)
function RootNode({ data }: { data: { label: string; icon: 'databases' | 'users' | 'roles' | 'storage'; selected: boolean; onClick: () => void } }) {
  const Icon = data.icon === 'databases' ? Database : data.icon === 'users' ? Users : data.icon === 'roles' ? Key : HardDrive;
  const colorMap = {
    databases: { bg: 'bg-blue-600', border: 'border-blue-400', hoverBorder: 'hover:border-blue-500', handle: '!bg-blue-500', text: 'text-blue-400' },
    users: { bg: 'bg-amber-600', border: 'border-amber-400', hoverBorder: 'hover:border-amber-500', handle: '!bg-amber-500', text: 'text-amber-400' },
    roles: { bg: 'bg-violet-600', border: 'border-violet-400', hoverBorder: 'hover:border-violet-500', handle: '!bg-violet-500', text: 'text-violet-400' },
    storage: { bg: 'bg-teal-600', border: 'border-teal-400', hoverBorder: 'hover:border-teal-500', handle: '!bg-teal-500', text: 'text-teal-400' },
  };
  const colors = colorMap[data.icon];

  return (
    <div
      onClick={data.onClick}
      className={`${nodeWidth} px-2 py-1.5 rounded border cursor-pointer transition-all ${
        data.selected
          ? `${colors.bg} ${colors.border} text-white`
          : `bg-gray-800 border-gray-600 text-gray-200 ${colors.hoverBorder}`
      }`}
    >
      <Handle type="source" position={Position.Right} className={colors.handle} />
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3 h-3 shrink-0 ${colors.text}`} />
        <span className="text-[9px] font-semibold uppercase tracking-wide">{data.label}</span>
      </div>
    </div>
  );
}

// User node
function UserNode({ data }: { data: { label: string; authType: string; storage: string; selected: boolean; onClick: () => void } }) {
  const tooltip = `Auth: ${data.authType} | Storage: ${data.storage}`;
  return (
    <div
      onClick={data.onClick}
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all ${
        data.selected
          ? 'bg-amber-600 border-amber-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-amber-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-amber-500" />
      <Handle type="source" position={Position.Right} className="!bg-amber-500" />
      <div className="flex items-center gap-1">
        <User className="w-2.5 h-2.5 text-amber-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Role node
function RoleNode({ data }: { data: { label: string; storage: string; selected: boolean; onClick: () => void } }) {
  const tooltip = `Storage: ${data.storage}`;
  return (
    <div
      onClick={data.onClick}
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all ${
        data.selected
          ? 'bg-violet-600 border-violet-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-violet-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-violet-500" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500" />
      <div className="flex items-center gap-1">
        <Key className="w-2.5 h-2.5 text-violet-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Grant node
function GrantNode({ data }: { data: { label: string; accessType: string; database: string; table: string; grantOption: boolean } }) {
  const scope = data.database ? (data.table ? `${data.database}.${data.table}` : data.database) : '*';
  const tooltip = `${data.accessType} ON ${scope}${data.grantOption ? ' (WITH GRANT OPTION)' : ''}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200`}
    >
      <Handle type="target" position={Position.Left} className="!bg-emerald-500" />
      <div className="flex items-center gap-1">
        <Shield className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
        <span className="text-[8px] font-medium tracking-wide truncate">{data.label}</span>
        {data.grantOption && <span className="text-[7px] text-yellow-400 ml-auto">GO</span>}
      </div>
    </div>
  );
}

// Disk node
function DiskNode({ data }: { data: { label: string; path: string; freeSpace: number; totalSpace: number; diskType: string } }) {
  const usedPercent = data.totalSpace > 0 ? Math.round((1 - data.freeSpace / data.totalSpace) * 100) : 0;
  const tooltip = `Path: ${data.path} | Type: ${data.diskType} | Used: ${usedPercent}%`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200`}
    >
      <Handle type="target" position={Position.Left} className="!bg-teal-500" />
      <div className="flex items-center gap-1">
        <HardDrive className="w-2.5 h-2.5 text-teal-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
        <span className="text-[7px] text-gray-500 ml-auto">{usedPercent}%</span>
      </div>
    </div>
  );
}

// Storage Policy node
function StoragePolicyNode({ data }: { data: { label: string; volumeName: string; disks: string[] } }) {
  const tooltip = `Volume: ${data.volumeName} | Disks: ${data.disks.join(', ')}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200`}
    >
      <Handle type="target" position={Position.Left} className="!bg-teal-500" />
      <div className="flex items-center gap-1">
        <Layers className="w-2.5 h-2.5 text-teal-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Custom node components
function DatabaseNode({ data }: { data: { label: string; engine: string; selected: boolean; onClick: () => void; onInfo: (e: React.MouseEvent) => void } }) {
  return (
    <div
      onClick={data.onClick}
      title={data.engine}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all relative ${
        data.selected
          ? 'bg-blue-600 border-blue-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-blue-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
      <InfoButton onClick={data.onInfo} />
      <div className="flex items-center gap-1">
        <Database className="w-2.5 h-2.5 text-blue-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

function TableNode({ data }: { data: { label: string; engine: string; rows: number; bytes: number; selected: boolean; onClick: () => void; onInfo: (e: React.MouseEvent) => void } }) {
  const tooltip = `${data.engine} | ${formatNumber(data.rows)} rows | ${formatBytes(data.bytes)}`;
  return (
    <div
      onClick={data.onClick}
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all relative ${
        data.selected
          ? 'bg-green-600 border-green-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-green-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-green-500" />
      <InfoButton onClick={data.onInfo} />
      <div className="flex items-center gap-1">
        <Table className="w-2.5 h-2.5 text-green-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

function PartitionNode({ data }: { data: { label: string; partCount: number; rows: number; bytes: number; selected: boolean; onClick: () => void; onInfo: (e: React.MouseEvent) => void } }) {
  const tooltip = `${data.partCount} parts | ${formatNumber(data.rows)} rows`;
  return (
    <div
      onClick={data.onClick}
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all relative ${
        data.selected
          ? 'bg-purple-600 border-purple-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-purple-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-green-500" />
      <Handle type="source" position={Position.Right} className="!bg-purple-500" />
      <InfoButton onClick={data.onInfo} />
      <div className="flex items-center gap-1">
        <Layers className="w-2.5 h-2.5 text-purple-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

function PartNode({ data }: { data: { label: string; rows: number; bytes: number; level: number; onInfo: (e: React.MouseEvent) => void } }) {
  const tooltip = `L${data.level} | ${formatNumber(data.rows)} rows | ${formatBytes(data.bytes)}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 py-1 rounded border bg-gray-800 border-gray-600 text-gray-200 relative`}
    >
      <Handle type="target" position={Position.Left} className="!bg-purple-500" />
      <InfoButton onClick={data.onInfo} />
      <div className="flex items-center gap-1">
        <Box className="w-2.5 h-2.5 text-orange-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Category node (Partitions, Columns, Projections, Indexes under a table)
function CategoryNode({ data }: { data: { label: string; category: 'partitions' | 'columns' | 'projections' | 'indexes'; count: number; selected: boolean; onClick: () => void } }) {
  const Icon = data.category === 'partitions' ? Layers : data.category === 'projections' ? Sparkles : data.category === 'indexes' ? Zap : Columns;
  const colorClass = data.category === 'partitions' ? 'purple' : data.category === 'projections' ? 'pink' : data.category === 'indexes' ? 'amber' : 'cyan';
  return (
    <div
      onClick={data.onClick}
      title={`${data.count} ${data.label.toLowerCase()}`}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all ${
        data.selected
          ? `bg-${colorClass}-600 border-${colorClass}-400 text-white`
          : `bg-gray-800 border-gray-600 text-gray-200 hover:border-${colorClass}-500`
      }`}
      style={{
        backgroundColor: data.selected ? (colorClass === 'purple' ? '#9333ea' : colorClass === 'pink' ? '#db2777' : colorClass === 'amber' ? '#d97706' : '#0891b2') : undefined,
        borderColor: data.selected ? (colorClass === 'purple' ? '#a855f7' : colorClass === 'pink' ? '#ec4899' : colorClass === 'amber' ? '#f59e0b' : '#22d3ee') : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-green-500" />
      <Handle type="source" position={Position.Right} style={{ backgroundColor: colorClass === 'purple' ? '#a855f7' : colorClass === 'pink' ? '#ec4899' : colorClass === 'amber' ? '#f59e0b' : '#22d3ee' }} />
      <div className="flex items-center gap-1">
        <Icon className={`w-2.5 h-2.5 shrink-0`} style={{ color: colorClass === 'purple' ? '#c084fc' : colorClass === 'pink' ? '#f472b6' : colorClass === 'amber' ? '#fbbf24' : '#67e8f9' }} />
        <span className="text-[8px] font-medium uppercase tracking-wide">{data.label}</span>
        <span className="text-[8px] text-gray-500">({data.count})</span>
      </div>
    </div>
  );
}

// Projection node
function ProjectionNode({ data }: { data: { label: string; type: string; sortingKey: string; selected: boolean; onClick: () => void } }) {
  const tooltip = `Type: ${data.type} | Sort: ${data.sortingKey || 'none'}`;
  return (
    <div
      onClick={data.onClick}
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border cursor-pointer transition-all ${
        data.selected
          ? 'bg-pink-600 border-pink-400 text-white'
          : 'bg-gray-800 border-gray-600 text-gray-200 hover:border-pink-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-pink-500" />
      <Handle type="source" position={Position.Right} className="!bg-pink-500" />
      <div className="flex items-center gap-1">
        <Sparkles className="w-2.5 h-2.5 text-pink-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Projection Part node
function ProjectionPartNode({ data }: { data: { label: string; rows: number; bytes: number; parentPart: string } }) {
  const tooltip = `${formatNumber(data.rows)} rows | ${formatBytes(data.bytes)} | Parent: ${data.parentPart}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200`}
    >
      <Handle type="target" position={Position.Left} className="!bg-pink-500" />
      <div className="flex items-center gap-1">
        <Box className="w-2.5 h-2.5 text-pink-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Index node
function IndexNode({ data }: { data: { label: string; type: string; expr: string; granularity: number } }) {
  const tooltip = `Type: ${data.type} | Expr: ${data.expr} | Granularity: ${data.granularity}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200`}
    >
      <Handle type="target" position={Position.Left} className="!bg-amber-500" />
      <div className="flex items-center gap-1">
        <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
        <span className="text-[8px] font-medium uppercase tracking-wide truncate">{data.label}</span>
      </div>
    </div>
  );
}

// Column node
function ColumnNode({ data }: { data: { label: string; type: string; isPrimaryKey: boolean; isPartitionKey: boolean; isSortingKey: boolean; onInfo: (e: React.MouseEvent) => void } }) {
  const badges: string[] = [];
  if (data.isPartitionKey) badges.push('PART');
  if (data.isSortingKey) badges.push('SORT');
  const tooltip = `${data.type}${badges.length > 0 ? ' | ' + badges.join(', ') : ''}`;
  return (
    <div
      title={tooltip}
      className={`${nodeWidth} px-2 ${nodeHeight} rounded border bg-gray-800 border-gray-600 text-gray-200 relative`}
    >
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <InfoButton onClick={data.onInfo} />
      <div className="flex items-center gap-1">
        <FileText className="w-2.5 h-2.5 shrink-0 text-cyan-400" />
        <span className="text-[8px] font-medium tracking-wide truncate">{data.label}</span>
        {badges.length > 0 && (
          <span className="text-[7px] text-yellow-400 ml-auto">{badges[0]}</span>
        )}
      </div>
    </div>
  );
}

const nodeTypes = {
  root: RootNode,
  database: DatabaseNode,
  table: TableNode,
  category: CategoryNode,
  partition: PartitionNode,
  part: PartNode,
  column: ColumnNode,
  user: UserNode,
  role: RoleNode,
  grant: GrantNode,
  disk: DiskNode,
  storagePolicy: StoragePolicyNode,
  projection: ProjectionNode,
  projectionPart: ProjectionPartNode,
  index: IndexNode,
};

// Tree view components
function TreeNode({ icon, label, labelClass, sublabel, expanded, onClick, loading, onInfo, children }: {
  icon: React.ReactNode;
  label: string;
  labelClass?: string;
  sublabel?: string;
  expanded: boolean;
  onClick: () => void;
  loading?: boolean;
  onInfo?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div
        onClick={onClick}
        className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-gray-800 group"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
        )}
        {icon}
        <span className={`text-xs font-medium uppercase tracking-wide ${labelClass || 'text-gray-200'}`}>{label}</span>
        {sublabel && <span className="text-[10px] text-gray-500 ml-1">{sublabel}</span>}
        {loading && <Loader2 className="w-3 h-3 text-blue-400 animate-spin ml-1" />}
        {onInfo && (
          <button
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            className="w-4 h-4 bg-gray-700/80 hover:bg-gray-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 ml-auto"
            title="View details"
          >
            <Info className="w-2.5 h-2.5 text-gray-400" />
          </button>
        )}
      </div>
      {expanded && children && (
        <div className="ml-4 border-l border-gray-700/50 pl-1">
          {children}
        </div>
      )}
    </div>
  );
}

function TreeLeaf({ icon, label, sublabel, badges, onInfo }: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  badges?: string[];
  onInfo?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-gray-800 group">
      <span className="w-3 shrink-0" />
      {icon}
      <span className="text-xs font-medium tracking-wide text-gray-300">{label}</span>
      {badges && badges.map((b) => (
        <span key={b} className="text-[8px] text-yellow-400 bg-yellow-400/10 px-1 rounded">{b}</span>
      ))}
      {sublabel && <span className="text-[10px] text-gray-500 ml-1">{sublabel}</span>}
      {onInfo && (
        <button
          onClick={(e) => { e.stopPropagation(); onInfo(); }}
          className="w-4 h-4 bg-gray-700/80 hover:bg-gray-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 ml-auto"
          title="View details"
        >
          <Info className="w-2.5 h-2.5 text-gray-400" />
        </button>
      )}
    </div>
  );
}

interface DatabaseBrowserProps {
  onClose?: () => void;
  // Render inline (e.g. inside the Data Dictionary mode) instead of as a modal
  embedded?: boolean;
}

export function DatabaseBrowser({ onClose, embedded = false }: DatabaseBrowserProps) {
  const [viewMode, setViewMode] = useState<'tree' | 'graph'>('tree');
  const [databases, setDatabases] = useState<BrowserDatabase[]>([]);
  const [users, setUsers] = useState<BrowserUser[]>([]);
  const [roles, setRoles] = useState<BrowserRole[]>([]);
  const [grants, setGrants] = useState<BrowserGrant[]>([]);
  const [roleGrants, setRoleGrants] = useState<BrowserRoleGrant[]>([]);
  const [disks, setDisks] = useState<BrowserDisk[]>([]);
  const [storagePolicies, setStoragePolicies] = useState<BrowserStoragePolicy[]>([]);
  const [tables, setTables] = useState<BrowserTable[]>([]);
  const [partitions, setPartitions] = useState<BrowserPartition[]>([]);
  const [parts, setParts] = useState<BrowserPart[]>([]);
  const [columns, setColumns] = useState<BrowserColumn[]>([]);
  const [projections, setProjections] = useState<BrowserProjection[]>([]);
  const [projectionParts, setProjectionParts] = useState<BrowserProjectionPart[]>([]);
  const [indexes, setIndexes] = useState<BrowserIndex[]>([]);

  const [selectedRoot, setSelectedRoot] = useState<'databases' | 'users' | 'roles' | 'storage' | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState<string | null>(null);
  const [selectedDatabaseCategory, setSelectedDatabaseCategory] = useState<'tables' | 'views' | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedTableCategory, setSelectedTableCategory] = useState<'partitions' | 'columns' | 'projections' | 'indexes' | null>(null);
  const [selectedPartition, setSelectedPartition] = useState<string | null>(null);
  const [selectedProjection, setSelectedProjection] = useState<string | null>(null);
  const [selectedPartitionsCategory, setSelectedPartitionsCategory] = useState<boolean>(false);
  const [selectedPartCategory, setSelectedPartCategory] = useState<boolean>(false);

  // Info modal state
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoModalData, setInfoModalData] = useState<{ title: string; data: Record<string, unknown> } | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingPartitions, setLoadingPartitions] = useState(false);
  const [loadingParts, setLoadingParts] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [loadingProjections, setLoadingProjections] = useState(false);
  const [loadingProjectionParts, setLoadingProjectionParts] = useState(false);
  const [loadingIndexes, setLoadingIndexes] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Load databases when Databases root is selected
  useEffect(() => {
    if (selectedRoot !== 'databases') {
      setDatabases([]);
      setSelectedDatabase(null);
      return;
    }
    setLoading(true);
    fetchBrowserDatabases()
      .then((dbs) => {
        // Deduplicate case-insensitive (e.g., INFORMATION_SCHEMA vs information_schema)
        const seen = new Set<string>();
        return dbs.filter((db) => {
          const lower = db.name.toLowerCase();
          if (seen.has(lower)) return false;
          seen.add(lower);
          return true;
        });
      })
      .then(setDatabases)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedRoot]);

  // Load users when Users root is selected
  useEffect(() => {
    if (selectedRoot !== 'users') {
      setUsers([]);
      setSelectedUser(null);
      setGrants([]);
      return;
    }
    setLoading(true);
    setSelectedUser(null);
    setGrants([]);
    fetchUsers()
      .then((data) => setUsers(data as unknown as BrowserUser[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedRoot]);

  // Load grants when a user is selected
  useEffect(() => {
    if (!selectedUser) {
      setGrants([]);
      return;
    }
    fetchGrants()
      .then((data) => {
        const userGrants = (data as unknown as BrowserGrant[]).filter(
          g => g.user_name === selectedUser
        );
        setGrants(userGrants);
      })
      .catch(console.error);
  }, [selectedUser]);

  // Load roles when Roles root is selected
  useEffect(() => {
    if (selectedRoot !== 'roles') {
      setRoles([]);
      setSelectedRole(null);
      setRoleGrants([]);
      return;
    }
    setLoading(true);
    setSelectedRole(null);
    setRoleGrants([]);
    fetchRoles()
      .then((data) => setRoles(data as unknown as BrowserRole[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedRoot]);

  // Load role grants when a role is selected
  useEffect(() => {
    if (!selectedRole) {
      setRoleGrants([]);
      return;
    }
    fetchRoleGrants()
      .then((data) => {
        const filteredGrants = (data as unknown as BrowserRoleGrant[]).filter(
          g => g.role_name === selectedRole || g.granted_role_name === selectedRole
        );
        setRoleGrants(filteredGrants);
      })
      .catch(console.error);
  }, [selectedRole]);

  // Load storage (disks and policies) when Storage root is selected
  useEffect(() => {
    if (selectedRoot !== 'storage') {
      setDisks([]);
      setStoragePolicies([]);
      return;
    }
    setLoading(true);
    Promise.all([fetchDisks(), fetchStoragePolicies()])
      .then(([disksData, policiesData]) => {
        setDisks(disksData as unknown as BrowserDisk[]);
        setStoragePolicies(policiesData as unknown as BrowserStoragePolicy[]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedRoot]);

  // Load tables when database selected
  useEffect(() => {
    if (!selectedDatabase) {
      setTables([]);
      setSelectedTable(null);
      setSelectedDatabaseCategory(null);
      return;
    }
    setLoadingTables(true);
    setSelectedTable(null);
    setSelectedDatabaseCategory(null);
    setSelectedTableCategory(null);
    setSelectedPartitionsCategory(false);
    setPartitions([]);
    setColumns([]);
    setParts([]);
    fetchBrowserTables(selectedDatabase)
      .then(setTables)
      .catch(console.error)
      .finally(() => setLoadingTables(false));
  }, [selectedDatabase]);

  // Load partitions, columns, projections, and indexes when table selected
  useEffect(() => {
    if (!selectedDatabase || !selectedTable) {
      setPartitions([]);
      setColumns([]);
      setProjections([]);
      setIndexes([]);
      setSelectedTableCategory(null);
      setSelectedPartition(null);
      setSelectedProjection(null);
      setSelectedPartitionsCategory(false);
      setParts([]);
      setProjectionParts([]);
      return;
    }
    // Load all four when table is selected
    setLoadingPartitions(true);
    setLoadingColumns(true);
    setLoadingProjections(true);
    setLoadingIndexes(true);
    setSelectedTableCategory(null);
    setSelectedPartition(null);
    setSelectedProjection(null);
    setSelectedPartitionsCategory(false);
    setParts([]);
    setProjectionParts([]);

    // Use Promise.allSettled so one failing endpoint doesn't break others
    // (e.g., system.projections may not exist in older ClickHouse versions)
    Promise.allSettled([
      fetchBrowserPartitions(selectedDatabase, selectedTable),
      fetchBrowserColumns(selectedDatabase, selectedTable),
      fetchBrowserProjections(selectedDatabase, selectedTable),
      fetchBrowserIndexes(selectedDatabase, selectedTable),
    ])
      .then(([partResult, colResult, projResult, idxResult]) => {
        if (partResult.status === 'fulfilled') {
          setPartitions(partResult.value);
        } else {
          console.error('Failed to fetch partitions:', partResult.reason);
          setPartitions([]);
        }
        if (colResult.status === 'fulfilled') {
          setColumns(colResult.value);
        } else {
          console.error('Failed to fetch columns:', colResult.reason);
          setColumns([]);
        }
        if (projResult.status === 'fulfilled') {
          setProjections(projResult.value);
        } else {
          console.error('Failed to fetch projections:', projResult.reason);
          setProjections([]);
        }
        if (idxResult.status === 'fulfilled') {
          setIndexes(idxResult.value);
        } else {
          console.error('Failed to fetch indexes:', idxResult.reason);
          setIndexes([]);
        }
      })
      .finally(() => {
        setLoadingPartitions(false);
        setLoadingColumns(false);
        setLoadingProjections(false);
        setLoadingIndexes(false);
      });
  }, [selectedDatabase, selectedTable]);

  // Load parts when partition selected
  useEffect(() => {
    if (!selectedDatabase || !selectedTable || !selectedPartition) {
      setParts([]);
      return;
    }
    setLoadingParts(true);
    fetchBrowserParts(selectedDatabase, selectedTable, selectedPartition)
      .then(setParts)
      .catch(console.error)
      .finally(() => setLoadingParts(false));
  }, [selectedDatabase, selectedTable, selectedPartition]);

  // Load projection parts when projection selected
  useEffect(() => {
    if (!selectedDatabase || !selectedTable || !selectedProjection) {
      setProjectionParts([]);
      return;
    }
    setLoadingProjectionParts(true);
    fetchBrowserProjectionParts(selectedDatabase, selectedTable, selectedProjection)
      .then(setProjectionParts)
      .catch(console.error)
      .finally(() => setLoadingProjectionParts(false));
  }, [selectedDatabase, selectedTable, selectedProjection]);

  // Build nodes and edges
  useEffect(() => {
    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];

    const columnX = [20, 230, 440, 650, 860, 1070, 1280, 1490];
    const nodeSpacing = 75;

    // Root nodes (always visible)
    newNodes.push({
      id: 'root-databases',
      type: 'root',
      position: { x: columnX[0], y: 50 },
      data: {
        label: 'Databases',
        icon: 'databases',
        selected: selectedRoot === 'databases',
        onClick: () => setSelectedRoot(selectedRoot === 'databases' ? null : 'databases'),
      },
    });

    newNodes.push({
      id: 'root-users',
      type: 'root',
      position: { x: columnX[0], y: 50 + nodeSpacing },
      data: {
        label: 'Users',
        icon: 'users',
        selected: selectedRoot === 'users',
        onClick: () => setSelectedRoot(selectedRoot === 'users' ? null : 'users'),
      },
    });

    newNodes.push({
      id: 'root-roles',
      type: 'root',
      position: { x: columnX[0], y: 50 + nodeSpacing * 2 },
      data: {
        label: 'Roles',
        icon: 'roles',
        selected: selectedRoot === 'roles',
        onClick: () => setSelectedRoot(selectedRoot === 'roles' ? null : 'roles'),
      },
    });

    newNodes.push({
      id: 'root-storage',
      type: 'root',
      position: { x: columnX[0], y: 50 + nodeSpacing * 3 },
      data: {
        label: 'Storage',
        icon: 'storage',
        selected: selectedRoot === 'storage',
        onClick: () => setSelectedRoot(selectedRoot === 'storage' ? null : 'storage'),
      },
    });

    // Database nodes (when Databases root is selected)
    if (selectedRoot === 'databases' && databases.length > 0) {
      databases.forEach((db, i) => {
        newNodes.push({
          id: `db-${db.name}`,
          type: 'database',
          position: { x: columnX[1], y: 50 + i * nodeSpacing },
          data: {
            label: db.name,
            engine: db.engine,
            selected: selectedDatabase === db.name,
            onClick: () => setSelectedDatabase(db.name === selectedDatabase ? null : db.name),
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `Database: ${db.name}`,
                data: {
                  'Name': db.name,
                  'Engine': db.engine,
                  'Data Path': db.data_path || 'N/A',
                  'Metadata Path': db.metadata_path || 'N/A',
                  'UUID': db.uuid || 'N/A',
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-root-db-${db.name}`,
          source: 'root-databases',
          target: `db-${db.name}`,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // User nodes (when Users root is selected)
    if (selectedRoot === 'users' && users.length > 0) {
      users.forEach((user, i) => {
        newNodes.push({
          id: `user-${user.name}`,
          type: 'user',
          position: { x: columnX[1], y: 50 + i * nodeSpacing },
          data: {
            label: user.name,
            authType: user.auth_type || 'N/A',
            storage: user.storage || 'N/A',
            selected: selectedUser === user.name,
            onClick: () => setSelectedUser(selectedUser === user.name ? null : user.name),
          },
        });
        newEdges.push({
          id: `edge-root-user-${user.name}`,
          source: 'root-users',
          target: `user-${user.name}`,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Grant nodes (when a user is selected)
    if (selectedUser && grants.length > 0) {
      grants.forEach((grant, i) => {
        const scope = grant.database ? (grant.table ? `${grant.database}.${grant.table}` : grant.database) : '*';
        const label = `${grant.access_type} on ${scope}`;
        newNodes.push({
          id: `grant-${i}`,
          type: 'grant',
          position: { x: columnX[2], y: 50 + i * nodeSpacing },
          data: {
            label: label.length > 25 ? label.substring(0, 22) + '...' : label,
            accessType: grant.access_type,
            database: grant.database || '',
            table: grant.table || '',
            grantOption: grant.grant_option === 1,
          },
        });
        newEdges.push({
          id: `edge-user-grant-${i}`,
          source: `user-${selectedUser}`,
          target: `grant-${i}`,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Role nodes (when Roles root is selected)
    if (selectedRoot === 'roles' && roles.length > 0) {
      roles.forEach((role, i) => {
        newNodes.push({
          id: `role-${role.name}`,
          type: 'role',
          position: { x: columnX[1], y: 50 + i * nodeSpacing },
          data: {
            label: role.name,
            storage: role.storage || 'N/A',
            selected: selectedRole === role.name,
            onClick: () => setSelectedRole(selectedRole === role.name ? null : role.name),
          },
        });
        newEdges.push({
          id: `edge-root-role-${role.name}`,
          source: 'root-roles',
          target: `role-${role.name}`,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Role grant nodes (when a role is selected - show granted roles)
    if (selectedRole && roleGrants.length > 0) {
      roleGrants.forEach((rg, i) => {
        const label = rg.granted_role_name === selectedRole
          ? `← ${rg.role_name || rg.user_name}`
          : `→ ${rg.granted_role_name}`;
        newNodes.push({
          id: `role-grant-${i}`,
          type: 'grant',
          position: { x: columnX[2], y: 50 + i * nodeSpacing },
          data: {
            label: label,
            accessType: 'ROLE',
            database: '',
            table: '',
            grantOption: rg.with_admin_option === 1,
          },
        });
        newEdges.push({
          id: `edge-role-grant-${i}`,
          source: `role-${selectedRole}`,
          target: `role-grant-${i}`,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Storage nodes (when Storage root is selected)
    if (selectedRoot === 'storage') {
      // Disks category
      if (disks.length > 0) {
        newNodes.push({
          id: 'cat-disks',
          type: 'category',
          position: { x: columnX[1], y: 50 },
          data: {
            label: 'Disks',
            category: 'columns',
            count: disks.length,
            selected: false,
            onClick: () => {},
          },
        });
        newEdges.push({
          id: 'edge-storage-disks',
          source: 'root-storage',
          target: 'cat-disks',
          animated: false,
          style: { stroke: '#4b5563' },
        });

        disks.forEach((disk, i) => {
          newNodes.push({
            id: `disk-${disk.name}`,
            type: 'disk',
            position: { x: columnX[2], y: 50 + i * nodeSpacing },
            data: {
              label: disk.name,
              path: disk.path || '',
              freeSpace: disk.free_space || 0,
              totalSpace: disk.total_space || 0,
              diskType: disk.type || 'local',
            },
          });
          newEdges.push({
            id: `edge-disks-${disk.name}`,
            source: 'cat-disks',
            target: `disk-${disk.name}`,
            animated: false,
            style: { stroke: '#4b5563' },
          });
        });
      }

      // Storage Policies category
      if (storagePolicies.length > 0) {
        const uniquePolicies = [...new Set(storagePolicies.map(p => p.policy_name))];
        newNodes.push({
          id: 'cat-policies',
          type: 'category',
          position: { x: columnX[1], y: 50 + nodeSpacing },
          data: {
            label: 'Policies',
            category: 'projections',
            count: uniquePolicies.length,
            selected: false,
            onClick: () => {},
          },
        });
        newEdges.push({
          id: 'edge-storage-policies',
          source: 'root-storage',
          target: 'cat-policies',
          animated: false,
          style: { stroke: '#4b5563' },
        });

        storagePolicies.forEach((policy, i) => {
          const policyDisks = Array.isArray(policy.disks) ? policy.disks : [];
          newNodes.push({
            id: `policy-${policy.policy_name}-${policy.volume_name}`,
            type: 'storagePolicy',
            position: { x: columnX[2], y: 50 + nodeSpacing + i * nodeSpacing },
            data: {
              label: `${policy.policy_name}/${policy.volume_name}`,
              volumeName: policy.volume_name,
              disks: policyDisks,
            },
          });
          newEdges.push({
            id: `edge-policies-${policy.policy_name}-${policy.volume_name}`,
            source: 'cat-policies',
            target: `policy-${policy.policy_name}-${policy.volume_name}`,
            animated: false,
            style: { stroke: '#4b5563' },
          });
        });
      }
    }

    // Tables and Views category nodes (when database is selected)
    if (selectedDatabase && tables.length > 0) {
      const regularTables = tables.filter(t => !['View', 'MaterializedView'].includes(t.engine));
      const views = tables.filter(t => ['View', 'MaterializedView'].includes(t.engine));

      // Tables category node
      if (regularTables.length > 0) {
        newNodes.push({
          id: 'cat-tables',
          type: 'category',
          position: { x: columnX[2], y: 50 },
          data: {
            label: 'Tables',
            category: 'columns',
            count: regularTables.length,
            selected: selectedDatabaseCategory === 'tables',
            onClick: () => setSelectedDatabaseCategory(selectedDatabaseCategory === 'tables' ? null : 'tables'),
          },
        });
        newEdges.push({
          id: `edge-db-${selectedDatabase}-tables`,
          source: `db-${selectedDatabase}`,
          target: 'cat-tables',
          animated: false,
          style: { stroke: '#4b5563' },
        });
      }

      // Views category node
      if (views.length > 0) {
        newNodes.push({
          id: 'cat-views',
          type: 'category',
          position: { x: columnX[2], y: 50 + nodeSpacing },
          data: {
            label: 'Views',
            category: 'projections',
            count: views.length,
            selected: selectedDatabaseCategory === 'views',
            onClick: () => setSelectedDatabaseCategory(selectedDatabaseCategory === 'views' ? null : 'views'),
          },
        });
        newEdges.push({
          id: `edge-db-${selectedDatabase}-views`,
          source: `db-${selectedDatabase}`,
          target: 'cat-views',
          animated: false,
          style: { stroke: '#4b5563' },
        });
      }
    }

    // Individual Table nodes (when Tables category is selected)
    if (selectedDatabaseCategory === 'tables') {
      const regularTables = tables.filter(t => !['View', 'MaterializedView'].includes(t.engine));
      regularTables.forEach((tbl, i) => {
        const nodeId = `tbl-${tbl.name}`;
        newNodes.push({
          id: nodeId,
          type: 'table',
          position: { x: columnX[3], y: 50 + i * nodeSpacing },
          data: {
            label: tbl.name,
            engine: tbl.engine,
            rows: tbl.total_rows || 0,
            bytes: tbl.total_bytes || 0,
            selected: selectedTable === tbl.name,
            onClick: () => setSelectedTable(tbl.name === selectedTable ? null : tbl.name),
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `Table: ${tbl.name}`,
                data: {
                  'Name': tbl.name,
                  'Engine': tbl.engine,
                  'Total Rows': formatNumber(tbl.total_rows || 0),
                  'Total Bytes': formatBytes(tbl.total_bytes || 0),
                  'Last Modified': tbl.metadata_modification_time || 'N/A',
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-cat-tables-${tbl.name}`,
          source: 'cat-tables',
          target: nodeId,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Individual View nodes (when Views category is selected)
    if (selectedDatabaseCategory === 'views') {
      const views = tables.filter(t => ['View', 'MaterializedView'].includes(t.engine));
      views.forEach((tbl, i) => {
        const nodeId = `view-${tbl.name}`;
        newNodes.push({
          id: nodeId,
          type: 'table',
          position: { x: columnX[3], y: 50 + i * nodeSpacing },
          data: {
            label: tbl.name,
            engine: tbl.engine,
            rows: tbl.total_rows || 0,
            bytes: tbl.total_bytes || 0,
            selected: selectedTable === tbl.name,
            onClick: () => setSelectedTable(tbl.name === selectedTable ? null : tbl.name),
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `View: ${tbl.name}`,
                data: {
                  'Name': tbl.name,
                  'Engine': tbl.engine,
                  'Total Rows': formatNumber(tbl.total_rows || 0),
                  'Total Bytes': formatBytes(tbl.total_bytes || 0),
                  'Last Modified': tbl.metadata_modification_time || 'N/A',
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-cat-views-${tbl.name}`,
          source: 'cat-views',
          target: nodeId,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // "Columns" category node (when table is selected and has columns)
    if (selectedTable && columns.length > 0) {
      newNodes.push({
        id: 'cat-columns',
        type: 'category',
        position: { x: columnX[4], y: 50 },
        data: {
          label: 'Columns',
          category: 'columns',
          count: columns.length,
          selected: selectedTableCategory === 'columns',
          onClick: () => setSelectedTableCategory(selectedTableCategory === 'columns' ? null : 'columns'),
        },
      });
      newEdges.push({
        id: `edge-table-${selectedTable}-columns`,
        source: selectedDatabaseCategory === 'views' ? `view-${selectedTable}` : `tbl-${selectedTable}`,
        target: 'cat-columns',
        animated: false,
        style: { stroke: '#4b5563' },
      });
    }

    // "Partitions" category node (when table is selected and has partitions)
    if (selectedTable && partitions.length > 0) {
      newNodes.push({
        id: 'cat-partitions',
        type: 'category',
        position: { x: columnX[4], y: 50 + nodeSpacing },
        data: {
          label: 'Partitions',
          category: 'partitions',
          count: partitions.length,
          selected: selectedTableCategory === 'partitions',
          onClick: () => setSelectedTableCategory(selectedTableCategory === 'partitions' ? null : 'partitions'),
        },
      });
      newEdges.push({
        id: `edge-table-${selectedTable}-partitions`,
        source: selectedDatabaseCategory === 'views' ? `view-${selectedTable}` : `tbl-${selectedTable}`,
        target: 'cat-partitions',
        animated: false,
        style: { stroke: '#4b5563' },
      });
    }

    // Individual Column nodes (when Columns category is selected)
    if (selectedTableCategory === 'columns' && columns.length > 0) {
      columns.forEach((col, i) => {
        const nodeId = `col-${col.name}`;
        newNodes.push({
          id: nodeId,
          type: 'column',
          position: { x: columnX[5], y: 50 + i * nodeSpacing },
          data: {
            label: col.name,
            type: col.type,
            isPrimaryKey: col.is_in_primary_key === 1,
            isSortingKey: col.is_in_sorting_key === 1,
            isPartitionKey: col.is_in_partition_key === 1,
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `Column: ${col.name}`,
                data: {
                  'Column Name': col.name,
                  'Type': col.type,
                  'Default Kind': col.default_kind || '-',
                  'Default Expression': col.default_expression || '-',
                  'Compression Codec': col.compression_codec || '-',
                  'Comment': col.comment || '-',
                  'Is in Primary Key': col.is_in_primary_key === 1 ? 'Yes' : 'No',
                  'Is in Sorting Key': col.is_in_sorting_key === 1 ? 'Yes' : 'No',
                  'Is in Partition Key': col.is_in_partition_key === 1 ? 'Yes' : 'No',
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-cat-columns-${col.name}`,
          source: 'cat-columns',
          target: nodeId,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // Individual Partition nodes (when Partitions category is selected)
    if (selectedTableCategory === 'partitions' && partitions.length > 0) {
      partitions.forEach((part, i) => {
        const nodeId = `part-${part.partition_id}`;
        newNodes.push({
          id: nodeId,
          type: 'partition',
          position: { x: columnX[5], y: 50 + i * nodeSpacing },
          data: {
            label: part.partition_id || 'all',
            partCount: part.part_count,
            rows: part.total_rows || 0,
            bytes: part.total_bytes || 0,
            selected: selectedPartition === part.partition_id,
            onClick: () => setSelectedPartition(part.partition_id === selectedPartition ? null : part.partition_id),
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `Partition: ${part.partition_id || 'all'}`,
                data: {
                  'Partition ID': part.partition_id || 'all',
                  'Part Count': part.part_count,
                  'Total Rows': formatNumber(part.total_rows || 0),
                  'Total Bytes': formatBytes(part.total_bytes || 0),
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-cat-partitions-${part.partition_id}`,
          source: 'cat-partitions',
          target: nodeId,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    // "Parts" category node (when partition is selected)
    if (selectedPartition) {
      newNodes.push({
        id: 'cat-parts',
        type: 'category',
        position: { x: columnX[6], y: 50 },
        data: {
          label: 'Parts',
          category: 'partitions',
          count: parts.length,
          selected: selectedPartCategory,
          onClick: () => setSelectedPartCategory(!selectedPartCategory),
        },
      });
      newEdges.push({
        id: `edge-partition-${selectedPartition}-parts`,
        source: `part-${selectedPartition}`,
        target: 'cat-parts',
        animated: false,
        style: { stroke: '#4b5563' },
      });
    }

    // Individual Part nodes (when Parts category is selected)
    if (selectedPartCategory && parts.length > 0) {
      parts.forEach((p, i) => {
        const nodeId = `prt-${p.name}`;
        newNodes.push({
          id: nodeId,
          type: 'part',
          position: { x: columnX[7], y: 50 + i * nodeSpacing },
          data: {
            label: p.name,
            rows: p.rows || 0,
            bytes: p.bytes_on_disk || 0,
            level: p.level,
            onInfo: (e: React.MouseEvent) => {
              e.stopPropagation();
              setInfoModalData({
                title: `Part: ${p.name}`,
                data: {
                  'Name': p.name,
                  'Rows': formatNumber(p.rows || 0),
                  'Bytes on Disk': formatBytes(p.bytes_on_disk || 0),
                  'Level': p.level,
                  'Modification Time': p.modification_time || 'N/A',
                },
              });
              setInfoModalOpen(true);
            },
          },
        });
        newEdges.push({
          id: `edge-parts-${p.name}`,
          source: 'cat-parts',
          target: nodeId,
          animated: false,
          style: { stroke: '#4b5563' },
        });
      });
    }

    setNodes(newNodes);
    setEdges(newEdges);
  }, [databases, users, roles, grants, roleGrants, disks, storagePolicies, tables, partitions, parts, columns, projections, projectionParts, indexes, selectedRoot, selectedDatabase, selectedDatabaseCategory, selectedTable, selectedTableCategory, selectedPartition, selectedProjection, selectedPartitionsCategory, selectedPartCategory, selectedUser, selectedRole, setNodes, setEdges]);

  const isLoading = loading || loadingTables || loadingPartitions || loadingParts || loadingColumns || loadingProjections || loadingProjectionParts || loadingIndexes;

  return (
    <div className={embedded ? 'h-full py-3' : 'fixed inset-0 bg-black/70 flex items-center justify-center z-50'} onClick={onClose}>
      <div
        className={`bg-gray-900 border border-gray-700 rounded-lg overflow-hidden flex flex-col ${embedded ? 'w-full h-full' : 'w-[95vw] h-[90vh]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-blue-400" />
            <h2 className="text-sm font-semibold text-white">Database Browser</h2>
            {isLoading && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
            <div className="flex items-center bg-gray-800 rounded border border-gray-600 ml-2">
              <button
                onClick={() => setViewMode('tree')}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-l transition-colors ${
                  viewMode === 'tree' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                <List className="w-3 h-3" />
                Tree
              </button>
              <button
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-r transition-colors ${
                  viewMode === 'graph' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                <GitBranch className="w-3 h-3" />
                Graph
              </button>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Breadcrumb */}
        <div className="px-4 py-2 border-b border-gray-700 flex items-center gap-2 text-xs shrink-0">
          <span className="text-gray-400">Path:</span>
          <div className="flex items-center gap-1">
            {selectedRoot ? (
              <>
                <span className={selectedRoot === 'databases' ? 'text-blue-400' : 'text-amber-400'}>
                  {selectedRoot === 'databases' ? 'Databases' : 'Users'}
                </span>
                {selectedRoot === 'databases' && selectedDatabase && (
                  <>
                    <ChevronRight className="w-3 h-3 text-gray-500" />
                    <span className="text-blue-400">{selectedDatabase}</span>
                  </>
                )}
                {selectedTable && (
                  <>
                    <ChevronRight className="w-3 h-3 text-gray-500" />
                    <span className="text-green-400">{selectedTable}</span>
                  </>
                )}
                {selectedPartition && (
                  <>
                    <ChevronRight className="w-3 h-3 text-gray-500" />
                    <span className="text-purple-400">{selectedPartition}</span>
                  </>
                )}
              </>
            ) : (
              <span className="text-gray-500">Select a category to browse</span>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="px-4 py-2 border-b border-gray-700 flex items-center gap-4 text-xs shrink-0 flex-wrap">
          <div className="flex items-center gap-1">
            <Database className="w-3 h-3 text-blue-400" />
            <span className="text-gray-400">Database</span>
          </div>
          <div className="flex items-center gap-1">
            <Table className="w-3 h-3 text-green-400" />
            <span className="text-gray-400">Table</span>
          </div>
          <div className="flex items-center gap-1">
            <Layers className="w-3 h-3 text-purple-400" />
            <span className="text-gray-400">Partition</span>
          </div>
          <div className="flex items-center gap-1">
            <Box className="w-3 h-3 text-orange-400" />
            <span className="text-gray-400">Part</span>
          </div>
          <div className="flex items-center gap-1">
            <Columns className="w-3 h-3 text-cyan-400" />
            <span className="text-gray-400">Column</span>
          </div>
          <div className="flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-pink-400" />
            <span className="text-gray-400">Projection</span>
          </div>
          <div className="flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-400" />
            <span className="text-gray-400">Index</span>
          </div>
          <div className="flex items-center gap-1">
            <User className="w-3 h-3 text-amber-400" />
            <span className="text-gray-400">User</span>
          </div>
          <div className="flex items-center gap-1">
            <Key className="w-3 h-3 text-violet-400" />
            <span className="text-gray-400">Role</span>
          </div>
          <div className="flex items-center gap-1">
            <Shield className="w-3 h-3 text-emerald-400" />
            <span className="text-gray-400">Grant</span>
          </div>
          <div className="flex items-center gap-1">
            <HardDrive className="w-3 h-3 text-teal-400" />
            <span className="text-gray-400">Disk</span>
          </div>
        </div>

        {/* Graph View */}
        {viewMode === 'graph' && (
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              defaultViewport={{ x: 20, y: 20, zoom: 1.3 }}
              minZoom={0.5}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#374151" />
              <Controls
                className="!bg-gray-800 !border-gray-600 !rounded [&>button]:!bg-gray-700 [&>button]:!border-gray-600 [&>button]:!text-gray-300 [&>button:hover]:!bg-gray-600 [&>button>svg]:!fill-gray-300"
              />
            </ReactFlow>
          </div>
        )}

        {/* Tree View */}
        {viewMode === 'tree' && (
          <div className="flex-1 overflow-auto p-4">
            <div className="space-y-0.5">
              {/* Databases */}
              <TreeNode
                icon={<Database className="w-3.5 h-3.5 text-blue-400" />}
                label="Databases"
                labelClass="text-blue-400 font-semibold"
                expanded={selectedRoot === 'databases'}
                onClick={() => setSelectedRoot(selectedRoot === 'databases' ? null : 'databases')}
                loading={loading && selectedRoot === 'databases'}
              >
                {databases.map((db) => (
                  <TreeNode
                    key={db.name}
                    icon={<Database className="w-3 h-3 text-blue-400" />}
                    label={db.name}
                    sublabel={db.engine}
                    expanded={selectedDatabase === db.name}
                    onClick={() => setSelectedDatabase(selectedDatabase === db.name ? null : db.name)}
                    loading={loadingTables && selectedDatabase === db.name}
                    onInfo={() => { setInfoModalData({ title: db.name, data: db as unknown as Record<string, unknown> }); setInfoModalOpen(true); }}
                  >
                    {tables.map((t) => (
                      <TreeNode
                        key={t.name}
                        icon={<Table className="w-3 h-3 text-green-400" />}
                        label={t.name}
                        sublabel={`${t.engine} | ${formatNumber(t.total_rows)} rows | ${formatBytes(t.total_bytes)}`}
                        expanded={selectedTable === t.name}
                        onClick={() => setSelectedTable(selectedTable === t.name ? null : t.name)}
                        loading={(loadingPartitions || loadingColumns) && selectedTable === t.name}
                        onInfo={() => { setInfoModalData({ title: t.name, data: t as unknown as Record<string, unknown> }); setInfoModalOpen(true); }}
                      >
                        {/* Columns */}
                        <TreeNode
                          icon={<Columns className="w-3 h-3 text-cyan-400" />}
                          label={`Columns (${columns.length})`}
                          labelClass="text-cyan-400"
                          expanded={selectedTableCategory === 'columns'}
                          onClick={() => setSelectedTableCategory(selectedTableCategory === 'columns' ? null : 'columns')}
                        >
                          {columns.map((col) => {
                            const badges: string[] = [];
                            if (col.is_in_partition_key) badges.push('PART');
                            if (col.is_in_sorting_key) badges.push('SORT');
                            return (
                              <TreeLeaf
                                key={col.name}
                                icon={<FileText className="w-3 h-3 text-cyan-400" />}
                                label={col.name}
                                sublabel={col.type}
                                badges={badges}
                                onInfo={() => { setInfoModalData({ title: col.name, data: col as unknown as Record<string, unknown> }); setInfoModalOpen(true); }}
                              />
                            );
                          })}
                        </TreeNode>

                        {/* Partitions */}
                        <TreeNode
                          icon={<Layers className="w-3 h-3 text-purple-400" />}
                          label={`Partitions (${partitions.length})`}
                          labelClass="text-purple-400"
                          expanded={selectedTableCategory === 'partitions'}
                          onClick={() => setSelectedTableCategory(selectedTableCategory === 'partitions' ? null : 'partitions')}
                        >
                          {partitions.map((p) => (
                            <TreeNode
                              key={p.partition}
                              icon={<Layers className="w-3 h-3 text-purple-400" />}
                              label={p.partition}
                              sublabel={`${p.part_count} parts | ${formatNumber(p.total_rows)} rows`}
                              expanded={selectedPartition === p.partition}
                              onClick={() => setSelectedPartition(selectedPartition === p.partition ? null : p.partition)}
                              loading={loadingParts && selectedPartition === p.partition}
                              onInfo={() => { setInfoModalData({ title: `Partition ${p.partition}`, data: p as unknown as Record<string, unknown> }); setInfoModalOpen(true); }}
                            >
                              {parts.map((part) => (
                                <TreeLeaf
                                  key={part.name}
                                  icon={<Box className="w-3 h-3 text-orange-400" />}
                                  label={part.name}
                                  sublabel={`L${part.level} | ${formatNumber(part.rows)} rows | ${formatBytes(part.bytes_on_disk)}`}
                                  onInfo={() => { setInfoModalData({ title: part.name, data: part as unknown as Record<string, unknown> }); setInfoModalOpen(true); }}
                                />
                              ))}
                            </TreeNode>
                          ))}
                        </TreeNode>

                        {/* Projections */}
                        {projections.length > 0 && (
                          <TreeNode
                            icon={<Sparkles className="w-3 h-3 text-pink-400" />}
                            label={`Projections (${projections.length})`}
                            labelClass="text-pink-400"
                            expanded={selectedTableCategory === 'projections'}
                            onClick={() => setSelectedTableCategory(selectedTableCategory === 'projections' ? null : 'projections')}
                          >
                            {projections.map((proj) => (
                              <TreeNode
                                key={proj.name}
                                icon={<Sparkles className="w-3 h-3 text-pink-400" />}
                                label={proj.name}
                                sublabel={proj.type}
                                expanded={selectedProjection === proj.name}
                                onClick={() => setSelectedProjection(selectedProjection === proj.name ? null : proj.name)}
                                loading={loadingProjectionParts && selectedProjection === proj.name}
                              >
                                {projectionParts.map((pp) => (
                                  <TreeLeaf
                                    key={pp.name}
                                    icon={<Box className="w-3 h-3 text-pink-400" />}
                                    label={pp.name}
                                    sublabel={`${formatNumber(pp.rows)} rows | ${formatBytes(pp.bytes_on_disk)}`}
                                  />
                                ))}
                              </TreeNode>
                            ))}
                          </TreeNode>
                        )}

                        {/* Indexes */}
                        {indexes.length > 0 && (
                          <TreeNode
                            icon={<Zap className="w-3 h-3 text-amber-400" />}
                            label={`Indexes (${indexes.length})`}
                            labelClass="text-amber-400"
                            expanded={selectedTableCategory === 'indexes'}
                            onClick={() => setSelectedTableCategory(selectedTableCategory === 'indexes' ? null : 'indexes')}
                          >
                            {indexes.map((idx) => (
                              <TreeLeaf
                                key={idx.name}
                                icon={<Zap className="w-3 h-3 text-amber-400" />}
                                label={idx.name}
                                sublabel={`${idx.type} | ${idx.expr} | granularity: ${idx.granularity}`}
                              />
                            ))}
                          </TreeNode>
                        )}
                      </TreeNode>
                    ))}
                  </TreeNode>
                ))}
              </TreeNode>

              {/* Users */}
              <TreeNode
                icon={<Users className="w-3.5 h-3.5 text-amber-400" />}
                label="Users"
                labelClass="text-amber-400 font-semibold"
                expanded={selectedRoot === 'users'}
                onClick={() => setSelectedRoot(selectedRoot === 'users' ? null : 'users')}
                loading={loading && selectedRoot === 'users'}
              >
                {users.map((u) => (
                  <TreeNode
                    key={u.name}
                    icon={<User className="w-3 h-3 text-amber-400" />}
                    label={u.name}
                    sublabel={`Auth: ${u.auth_type}`}
                    expanded={selectedUser === u.name}
                    onClick={() => setSelectedUser(selectedUser === u.name ? null : u.name)}
                  >
                    {grants.map((g, i) => (
                      <TreeLeaf
                        key={i}
                        icon={<Shield className="w-3 h-3 text-emerald-400" />}
                        label={g.access_type}
                        sublabel={`${g.database || '*'}.${g.table || '*'}${g.grant_option ? ' (WITH GRANT)' : ''}`}
                      />
                    ))}
                  </TreeNode>
                ))}
              </TreeNode>

              {/* Roles */}
              <TreeNode
                icon={<Key className="w-3.5 h-3.5 text-violet-400" />}
                label="Roles"
                labelClass="text-violet-400 font-semibold"
                expanded={selectedRoot === 'roles'}
                onClick={() => setSelectedRoot(selectedRoot === 'roles' ? null : 'roles')}
                loading={loading && selectedRoot === 'roles'}
              >
                {roles.map((r) => (
                  <TreeNode
                    key={r.name}
                    icon={<Key className="w-3 h-3 text-violet-400" />}
                    label={r.name}
                    sublabel={r.storage}
                    expanded={selectedRole === r.name}
                    onClick={() => setSelectedRole(selectedRole === r.name ? null : r.name)}
                  >
                    {roleGrants.map((rg, i) => (
                      <TreeLeaf
                        key={i}
                        icon={<Shield className="w-3 h-3 text-emerald-400" />}
                        label={rg.granted_role_name}
                        sublabel={rg.with_admin_option ? 'WITH ADMIN' : ''}
                      />
                    ))}
                  </TreeNode>
                ))}
              </TreeNode>

              {/* Storage */}
              <TreeNode
                icon={<HardDrive className="w-3.5 h-3.5 text-teal-400" />}
                label="Storage"
                labelClass="text-teal-400 font-semibold"
                expanded={selectedRoot === 'storage'}
                onClick={() => setSelectedRoot(selectedRoot === 'storage' ? null : 'storage')}
                loading={loading && selectedRoot === 'storage'}
              >
                {disks.length > 0 && (
                  <TreeNode
                    icon={<HardDrive className="w-3 h-3 text-teal-400" />}
                    label={`Disks (${disks.length})`}
                    labelClass="text-teal-400"
                    expanded={true}
                    onClick={() => {}}
                  >
                    {disks.map((d) => {
                      const usedPercent = d.total_space > 0 ? Math.round((1 - d.free_space / d.total_space) * 100) : 0;
                      return (
                        <TreeLeaf
                          key={d.name}
                          icon={<HardDrive className="w-3 h-3 text-teal-400" />}
                          label={d.name}
                          sublabel={`${d.type} | ${d.path} | ${usedPercent}% used`}
                        />
                      );
                    })}
                  </TreeNode>
                )}
                {storagePolicies.length > 0 && (
                  <TreeNode
                    icon={<Layers className="w-3 h-3 text-teal-400" />}
                    label={`Storage Policies (${storagePolicies.length})`}
                    labelClass="text-teal-400"
                    expanded={true}
                    onClick={() => {}}
                  >
                    {storagePolicies.map((sp, i) => (
                      <TreeLeaf
                        key={i}
                        icon={<Layers className="w-3 h-3 text-teal-400" />}
                        label={sp.policy_name}
                        sublabel={`Volume: ${sp.volume_name} | Disks: ${Array.isArray(sp.disks) ? sp.disks.join(', ') : sp.disks}`}
                      />
                    ))}
                  </TreeNode>
                )}
              </TreeNode>
            </div>
          </div>
        )}
      </div>

      {/* Info Modal */}
      {infoModalOpen && infoModalData && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={() => setInfoModalOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-[600px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-700">
              <h3 className="text-sm font-semibold text-white">{infoModalData.title}</h3>
              <button onClick={() => setInfoModalOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <div className="bg-gray-800 rounded max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="border-b border-gray-700">
                      <th className="text-left p-1.5 text-gray-400">Property</th>
                      <th className="text-right p-1.5 text-gray-400">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(infoModalData.data).map(([key, value]) => (
                      <tr key={key} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="p-1.5 text-blue-300 font-mono">{key}</td>
                        <td className="p-1.5 text-right text-green-300 font-mono">{String(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
