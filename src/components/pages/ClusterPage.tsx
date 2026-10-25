import { useState } from 'react';
import { Network, RefreshCw, Server, GitBranch, Clock, Database, Send } from 'lucide-react';
import { SystemTable } from '../SystemTable';
import { ToolbarSlot } from '../ToolbarSlot';
import { PageTabs } from '../ui';
import {
  fetchReplicationQueue,
  fetchReplicationQueueColumns,
  fetchReplicationQueueGrouped,
  fetchReplicas,
  fetchReplicasColumns,
  fetchClusters,
  fetchClustersColumns,
  fetchReplicatedFetches,
  fetchReplicatedFetchesColumns,
  fetchDistributedDdlQueue,
  fetchDistributedDdlQueueColumns,
  fetchDistributionQueue,
  fetchDistributionQueueColumns,
  fetchZookeeper,
  fetchZookeeperColumns,
  fetchZookeeperConnection,
  fetchZookeeperConnectionColumns,
  fetchZookeeperConnectionLog,
  fetchZookeeperConnectionLogColumns,
} from '../../services/api';

type ClusterTab = 'replication-queue' | 'replicas' | 'clusters' | 'fetches' | 'distributed-ddl' | 'distribution-queue' | 'zookeeper';
type ReplicationQueueSubTab = 'detailed' | 'grouped';
type ZookeeperSubTab = 'zookeeper' | 'connection' | 'connection-log';

export function ClusterPage() {
  const [activeTab, setActiveTab] = useState<ClusterTab>('clusters');
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const [replicationSubTab, setReplicationSubTab] = useState<ReplicationQueueSubTab>('detailed');
  const [zookeeperSubTab, setZookeeperSubTab] = useState<ZookeeperSubTab>('zookeeper');

  const tabs: { id: ClusterTab; label: string; icon: typeof Network }[] = [
    { id: 'clusters', label: 'Clusters', icon: Network },
    { id: 'replicas', label: 'Replicas', icon: Server },
    { id: 'replication-queue', label: 'Replication Queue', icon: RefreshCw },
    { id: 'fetches', label: 'Fetches', icon: GitBranch },
    { id: 'distributed-ddl', label: 'Distributed DDL', icon: Clock },
    { id: 'distribution-queue', label: 'Distribution Queue', icon: Send },
    { id: 'zookeeper', label: 'ZooKeeper', icon: Database },
  ];

  const replicationSubTabs: { id: ReplicationQueueSubTab; label: string }[] = [
    { id: 'detailed', label: 'Detailed' },
    { id: 'grouped', label: 'Grouped by Error' },
  ];

  const zookeeperSubTabs: { id: ZookeeperSubTab; label: string }[] = [
    { id: 'zookeeper', label: 'ZooKeeper' },
    { id: 'connection', label: 'Connection' },
    { id: 'connection-log', label: 'Connection Log' },
  ];

  return (
    <div className="h-full flex flex-col">
      <ToolbarSlot ref={setToolbarEl} />
      <PageTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 overflow-hidden px-1.5 pt-3 pb-4 flex flex-col">
        {activeTab === 'replication-queue' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-1 mb-2">
              {replicationSubTabs.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setReplicationSubTab(id)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                    replicationSubTab === id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-hidden">
              {replicationSubTab === 'detailed' && (
                <SystemTable
                  fetchData={fetchReplicationQueue}
                  fetchColumns={fetchReplicationQueueColumns}
                  getRowId={(data) => `${data.database}-${data.table}-${data.replica_name}-${data.position}`}
                  hideHeader
                  toolbarContainer={toolbarEl}
                  defaultVisibleFields={['database', 'table', 'replica_name', 'is_leader', 'is_readonly', 'future_parts', 'parts_to_check', 'queue_size', 'last_queue_update_exception']}
                />
              )}
              {replicationSubTab === 'grouped' && (
                <SystemTable
                  fetchData={fetchReplicationQueueGrouped}
                  getRowId={(data) => `${data.table}-${data.last_exception}-${data.postpone_reason}`}
                  hideHeader
                  toolbarContainer={toolbarEl}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'replicas' && (
          <SystemTable
            fetchData={fetchReplicas}
            fetchColumns={fetchReplicasColumns}
            getRowId={(data) => `${data.database}-${data.table}-${data.replica_name}`}
            hideHeader
            toolbarContainer={toolbarEl}
            defaultVisibleFields={['database', 'table', 'replica_name', 'is_leader', 'is_readonly', 'future_parts', 'parts_to_check', 'queue_size', 'inserts_in_queue', 'merges_in_queue', 'last_queue_update_exception']}
          />
        )}

        {activeTab === 'clusters' && (
          <SystemTable
            fetchData={fetchClusters}
            fetchColumns={fetchClustersColumns}
            getRowId={(data) => `${data.cluster}-${data.shard_num}-${data.replica_num}`}
            hideHeader
            toolbarContainer={toolbarEl}
            defaultVisibleFields={['cluster', 'shard_num', 'replica_num', 'host_name', 'host_address', 'port', 'shard_weight', 'internal_replication', 'is_local']}
          />
        )}

        {activeTab === 'fetches' && (
          <SystemTable
            fetchData={fetchReplicatedFetches}
            fetchColumns={fetchReplicatedFetchesColumns}
            getRowId={(data) => `${data.database}-${data.table}-${data.result_part_name}`}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}

        {activeTab === 'distributed-ddl' && (
          <SystemTable
            fetchData={fetchDistributedDdlQueue}
            fetchColumns={fetchDistributedDdlQueueColumns}
            getRowId={(data) => String(data.entry)}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}

        {activeTab === 'distribution-queue' && (
          <SystemTable
            fetchData={fetchDistributionQueue}
            fetchColumns={fetchDistributionQueueColumns}
            getRowId={(data) => `${data.database}-${data.table}-${data.data_path}`}
            hideHeader
            toolbarContainer={toolbarEl}
          />
        )}

        {activeTab === 'zookeeper' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-1 mb-2">
              {zookeeperSubTabs.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setZookeeperSubTab(id)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                    zookeeperSubTab === id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-hidden">
              {zookeeperSubTab === 'zookeeper' && (
                <SystemTable
                  fetchData={fetchZookeeper}
                  fetchColumns={fetchZookeeperColumns}
                  getRowId={(data) => String(data.path)}
                  hideHeader
                  toolbarContainer={toolbarEl}
                />
              )}
              {zookeeperSubTab === 'connection' && (
                <SystemTable
                  fetchData={fetchZookeeperConnection}
                  fetchColumns={fetchZookeeperConnectionColumns}
                  getRowId={(data) => `${data.index}-${data.host}`}
                  hideHeader
                  toolbarContainer={toolbarEl}
                />
              )}
              {zookeeperSubTab === 'connection-log' && (
                <SystemTable
                  fetchData={fetchZookeeperConnectionLog}
                  fetchColumns={fetchZookeeperConnectionLogColumns}
                  getRowId={(data) => `${data.event_time}-${data.type}`}
                  hideHeader
                  toolbarContainer={toolbarEl}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
