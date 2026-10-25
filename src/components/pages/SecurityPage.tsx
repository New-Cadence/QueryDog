import { useState, useEffect } from 'react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import {
  ShieldCheck, Network, Fingerprint, Search, Lock, LogIn, History, ArrowLeftRight,
} from 'lucide-react';
import type { Recommendation } from '../../recommendations/types';
import { buildSecurityRecommendations } from '../../recommendations/security';
import { PageTabs, Pill, ToolbarHost, LoadingState } from '../ui';
import { loadSecurityData, type SecurityData } from '../security/model';
import { loadLoginStats } from '../security/activity';
import { PostureTab } from '../security/PostureTab';
import { AccessGraphTab } from '../security/AccessGraphTab';
import { EffectiveTab } from '../security/EffectiveTab';
import { WhoCanTab } from '../security/WhoCanTab';
import { CompareTab } from '../security/CompareTab';
import { LoginsTab } from '../security/LoginsTab';
import { AuditTab } from '../security/AuditTab';
import { PoliciesTab } from '../security/PoliciesTab';

ModuleRegistry.registerModules([AllCommunityModule]);

type SecurityTab = 'overview' | 'graph' | 'effective' | 'whocan' | 'compare' | 'logins' | 'audit' | 'policies';
export type SecuritySection = 'security' | 'access' | 'quotas';

// Which tabs each Security menu item shows
const SECTION_TABS: Record<SecuritySection, SecurityTab[]> = {
  security: ['overview', 'audit'],
  access: ['graph', 'effective', 'whocan', 'compare', 'logins'],
  quotas: ['policies'],
};

export function SecurityPage({ section = 'security' }: { section?: SecuritySection }) {
  const [tab, setTab] = useState<SecurityTab>(SECTION_TABS[section][0]);
  const [data, setData] = useState<SecurityData | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Loads once per mount; the header Refresh remounts the page to reload
  useEffect(() => {
    let live = true;
    Promise.all([loadSecurityData(), loadLoginStats()])
      .then(([d, logins]) => {
        if (!live) return;
        setError(null);
        setData(d);
        // Same recommendations the Recommendations mode shows, so the score matches
        setRecs(buildSecurityRecommendations(d, logins));
      })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Failed to load access control data'); });
    return () => { live = false; };
  }, []);

  const risky = recs.filter(r => r.severity === 'critical' || r.severity === 'high').length;

  const allTabs = [
    { id: 'overview' as const, label: 'Overview', icon: ShieldCheck, badge: risky > 0 ? <Pill tone="red">{risky}</Pill> : undefined },
    { id: 'graph' as const, label: 'Access Graph', icon: Network },
    { id: 'effective' as const, label: 'Effective Permissions', icon: Fingerprint },
    { id: 'whocan' as const, label: 'Who Can Access', icon: Search },
    { id: 'compare' as const, label: 'Compare', icon: ArrowLeftRight },
    { id: 'logins' as const, label: 'Logins', icon: LogIn },
    { id: 'audit' as const, label: 'Access Changes', icon: History },
    { id: 'policies' as const, label: 'Policies & Quotas', icon: Lock },
  ];
  const tabs = SECTION_TABS[section].map(id => allTabs.find(t => t.id === id)!);

  return (
    <div className="h-full flex flex-col">
      <ToolbarHost>
      <PageTabs
        tabs={tabs}
        active={tab}
        onChange={setTab}
        right={
          <>
            {data && (
              <span className="text-xs text-gray-400">
                {data.users.length} users · {data.roles.length} roles · {data.grants.length} grants
              </span>
            )}
          </>
        }
      />
      <div className="flex-1 overflow-hidden flex flex-col">
        {error ? (
          <div className="m-3 px-3 py-2 rounded text-xs bg-red-900/50 text-red-300">Error: {error}</div>
        ) : !data ? (
          <LoadingState label="Loading access control…" />
        ) : (
          <>
            {tab === 'overview' && <PostureTab data={data} recs={recs} />}
            {tab === 'graph' && <AccessGraphTab data={data} />}
            {tab === 'effective' && <EffectiveTab data={data} />}
            {tab === 'whocan' && <WhoCanTab data={data} />}
            {tab === 'compare' && <CompareTab data={data} />}
            {tab === 'logins' && <LoginsTab data={data} />}
            {tab === 'audit' && <AuditTab />}
            {tab === 'policies' && <PoliciesTab data={data} />}
          </>
        )}
      </div>
      </ToolbarHost>
    </div>
  );
}
