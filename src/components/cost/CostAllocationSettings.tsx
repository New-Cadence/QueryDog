// Teams that ClickHouse Cloud spend is allocated to, edited under Settings >
// Cost allocation. Each Cloud service belongs to at most one team; the Cost
// page's Cost Allocation tab reports spend by team.
import { useEffect, useState } from 'react';
import { Users, Plus, Trash2, Save, Server } from 'lucide-react';
import { Panel, Pill, ToolbarButton, EmptyState } from '../ui';
import { inputClass } from '../uiTokens';
import { useCost, errorMessage } from './costContext';
import { fetchCloudServices, type CloudService, type CostTeam } from './costApi';
import { ErrorBox, InfoBox, Spinner } from './common';

export function CostAllocationSettings() {
  const { status, settings, updateSettings } = useCost();
  const hasCloudApi = status.deployment === 'cloud' && status.cloudApiConfigured;
  const [services, setServices] = useState<CloudService[] | null>(hasCloudApi ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<CostTeam[]>(() => settings.teams ?? []);
  const [newName, setNewName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!hasCloudApi) return;
    fetchCloudServices().then(setServices).catch(e => { setError(errorMessage(e)); setServices([]); });
  }, [hasCloudApi]);

  const change = (next: CostTeam[]) => { setTeams(next); setDirty(true); setSaved(false); };
  const ownerOf = (serviceId: string) => teams.find(t => t.services.includes(serviceId));

  const addTeam = () => {
    const name = newName.trim();
    if (!name || teams.some(t => t.name.toLowerCase() === name.toLowerCase())) return;
    change([...teams, { id: crypto.randomUUID(), name, services: [] }]);
    setNewName('');
  };

  // Ticking a service moves it to this team; unticking leaves it unallocated
  const toggleService = (teamId: string, serviceId: string, on: boolean) =>
    change(teams.map(t => {
      if (t.id === teamId) return { ...t, services: on ? [...t.services, serviceId] : t.services.filter(s => s !== serviceId) };
      return on ? { ...t, services: t.services.filter(s => s !== serviceId) } : t;
    }));

  const save = () => {
    updateSettings({ ...settings, teams: teams.map(t => ({ ...t, name: t.name.trim() })).filter(t => t.name) });
    setDirty(false);
    setSaved(true);
  };

  const unassigned = (services || []).filter(s => !ownerOf(s.id));
  const serviceName = (id: string) => services?.find(s => s.id === id)?.name ?? id;

  return (
    <div className="px-1.5 py-3 space-y-3 max-w-4xl">
      {!hasCloudApi && (
        <InfoBox>
          Services are listed from the ClickHouse Cloud API. Add <code>cloud_api</code> to a Cloud environment in querydog.yml and connect to it to map services to teams.
        </InfoBox>
      )}
      {error && <ErrorBox error={error} />}

      <Panel
        title="Teams"
        icon={Users}
        bodyClassName="p-3 space-y-3"
        actions={<>
          {saved && <span className="text-[11px] text-green-400">Saved</span>}
          <ToolbarButton icon={Save} variant="primary" onClick={save} disabled={!dirty}>Save teams</ToolbarButton>
        </>}
      >
        <div className="flex items-center gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTeam()}
            placeholder="New team name, e.g. Analytics" className={`${inputClass} max-w-xs`} />
          <ToolbarButton icon={Plus} onClick={addTeam} disabled={!newName.trim()}>Add team</ToolbarButton>
        </div>

        {teams.length === 0 && <EmptyState compact title="No teams" />}

        {services === null ? <Spinner label="Loading Cloud services…" /> : teams.map(team => (
          <div key={team.id} className="border border-gray-700 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input value={team.name} onChange={e => change(teams.map(t => (t.id === team.id ? { ...t, name: e.target.value } : t)))}
                className={`${inputClass} max-w-xs font-medium`} aria-label="Team name" />
              <Pill>{team.services.length} service{team.services.length === 1 ? '' : 's'}</Pill>
              <button onClick={() => change(teams.filter(t => t.id !== team.id))} className="ml-auto text-gray-500 hover:text-red-400" title="Remove team">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {services.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
                {services.map(s => {
                  const owner = ownerOf(s.id);
                  const mine = owner?.id === team.id;
                  return (
                    <label key={s.id} className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${mine ? 'text-white bg-blue-900/30' : 'text-gray-400 hover:bg-gray-800/60'}`}>
                      <input type="checkbox" checked={mine} onChange={e => toggleService(team.id, s.id, e.target.checked)} />
                      <Server className="w-3 h-3 shrink-0" />
                      <span className="truncate">{s.name}</span>
                      {owner && !mine && <span className="ml-auto text-[10px] text-gray-500 truncate">{owner.name}</span>}
                    </label>
                  );
                })}
              </div>
            ) : team.services.length > 0 ? (
              <p className="text-[11px] text-gray-500">{team.services.map(serviceName).join(', ')}</p>
            ) : null}
          </div>
        ))}
      </Panel>

      {services !== null && services.length > 0 && (
        <Panel title="Unallocated services" icon={Server} bodyClassName="p-3">
          {unassigned.length === 0
            ? <p className="text-xs text-gray-500">Every service belongs to a team.</p>
            : <div className="flex flex-wrap gap-1.5">{unassigned.map(s => <Pill key={s.id}>{s.name}</Pill>)}</div>}
        </Panel>
      )}
    </div>
  );
}
