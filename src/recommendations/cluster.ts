import { fetchCostStatus } from '../components/cost/costApi';
import type { Recommendation } from './types';

// How providers read system tables on a cluster (cluster: in querydog.yml).
// Plain system.X only shows the node the connection lands on, so:
// - table(): per-node state and logs, read from every replica
// - storage(): parts and other on-disk table state. Cloud replicas share one
//   copy, so it stays local there; self-managed replicas each store their own.
// Queries select hostName() AS host and pass it to tag() / tagStorage(),
// which set rec.host only on a cluster, so single-server ids don't change.
export interface Nodes {
  cluster: string | null;
  table: (name: string) => string;
  storage: (name: string) => string;
  tag: <R extends Recommendation>(rec: R, host: unknown) => R;
  tagStorage: <R extends Recommendation>(rec: R, host: unknown) => R;
}

const onHost = <R extends Recommendation>(rec: R, host: unknown): R => {
  const h = host ? String(host) : '';
  // The id carries the host so the same finding on two nodes is triaged separately
  return h ? { ...rec, id: `${rec.id}@${h}`, host: h } : rec;
};

export async function nodes(): Promise<Nodes> {
  const status = await fetchCostStatus().catch(() => ({ deployment: 'oss' as const, cluster: null }));
  const cluster = status.cluster;
  const all = (name: string) => (cluster ? `clusterAllReplicas('${cluster.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', system.${name})` : `system.${name}`);
  const sharedStorage = status.deployment === 'cloud';
  return {
    cluster,
    table: all,
    storage: name => (sharedStorage ? `system.${name}` : all(name)),
    tag: (rec, host) => (cluster ? onHost(rec, host) : rec),
    tagStorage: (rec, host) => (cluster && !sharedStorage ? onHost(rec, host) : rec),
  };
}
