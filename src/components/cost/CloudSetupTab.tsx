// "Connect billing": shown for a ClickHouse Cloud environment with no Cloud API
// key, explaining how to add cloud_api to querydog.yml for billing data.
import { KeyRound } from 'lucide-react';
import { Panel } from '../ui';
import type { CostStatus } from './costApi';

const FIELDS: { key: string; hint: string }[] = [
  { key: 'key_id', hint: 'API key ID (Cloud console › Organization › API keys)' },
  { key: 'key_secret', hint: 'API key secret, shown once when the key is created' },
  { key: 'organization_id', hint: 'Organization ID (Organization › Settings)' },
  { key: 'service_id', hint: "This environment's service ID (Service › Settings); optional, marks it as this environment's own service" },
];

export function CloudSetupTab({ status }: { status: CostStatus }) {
  const missing = new Set(status.missing);
  const example = `  - name: "${status.environment}"
    # ...host, port, user, password...
    cloud_api:
      key_id: "<key id>"
      key_secret: "<key secret>"
      organization_id: "<organization id>"
      service_id: "<service id>"`;

  return (
    <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4">
      <Panel title="Connect ClickHouse Cloud billing" icon={KeyRound} className="max-w-3xl" bodyClassName="p-3 space-y-3 text-xs text-gray-300">
        <p>
          Billing, services and usage for <span className="text-white font-medium">{status.environment}</span> come from the ClickHouse Cloud API.
          Add a read-only API key to this environment in querydog.yml; the key stays on the server.
        </p>
        <table className="w-full">
          <tbody>
            {FIELDS.map(f => (
              <tr key={f.key} className="border-b border-gray-800 last:border-0">
                <td className="py-1.5 pr-3 font-mono text-gray-200 whitespace-nowrap">{f.key}</td>
                <td className="py-1.5 pr-3">{missing.has(f.key) ? <span className="text-yellow-400">missing</span> : <span className="text-green-400">set</span>}</td>
                <td className="py-1.5 text-gray-500">{f.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <pre className="bg-gray-950 border border-gray-700 rounded p-2 text-[11px] text-gray-300 overflow-x-auto">{example}</pre>
        <p className="text-gray-500">Until then, Storage and Cost Allocation work from the service itself using the list prices under Settings › Costs.</p>
      </Panel>
    </div>
  );
}
