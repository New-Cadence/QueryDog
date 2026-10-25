# Convoy (QueryDog)

Convoy is a web app for operating ClickHouse. It connects to one or
more ClickHouse environments (self-managed or ClickHouse Cloud), shows what
they are doing, runs checks against them on a schedule, and turns what it
finds into prioritised recommendations. It ships as a single container.

## What it does

| Area | What you get |
|---|---|
| **Observability** | Query log timeline and grouping, parts and part log, running activity, instance metrics, text log, cluster and replication health. |
| **Monitoring** | Alerting on SQL checks: each check returns rows when something needs attention. Severity, conditions, incidents, silences and notification channels (Slack, webhook, PagerDuty, email). |
| **Testing** | Query Performance (saved queries timed over time), Data Quality (SQL assertions that return failing rows) and Load Testing. |
| **Security** | Users, roles and grants, effective access, who-can-access, logins and audit, with a security overview. |
| **Cost** | ClickHouse Cloud spend from the billing API (or configured prices for self-managed), budgets and forecasts, storage, and cost allocation by team. |
| **Data Dictionary** | Catalogue of databases, tables and columns, a database browser and a data explorer. |
| **Recommendations** | Findings across cost, performance, schema, security, reliability, documentation and data quality, with triage (acknowledge, snooze, dismiss). |
| **Settings** | Appearance, API keys, notification channels, prices, budget, cost allocation teams, and a read-only view of the scheduler. |

## How it fits together

```
querydog.yml ──► server (Node/Express) ──► ClickHouse environments
                    │   ▲
   client folder ───┘   │ same HTTP API
   (clienta/)           │
                  scheduler (in the server)
                    │
                    ▼
            data/querydog.db (SQLite)  ◄── React UI (Vite)
```

- **Server** (`server/`): proxies queries to ClickHouse, serves the API and
  hosts feature modules in `server/extensions/` (alerting, data quality,
  cost, notebooks, dictionary, settings, silences). Each request can target
  an environment with the `X-QueryDog-Environment` header; otherwise it uses
  the environment selected in the UI.
- **UI** (`src/`): React + Tailwind + AG Grid + Recharts.
- **CLI and MCP** (`cli/`, `mcp/`): command-line and Model Context Protocol
  access to the same analyses.

## Configuration: `querydog.yml`

```yaml
client: "clienta"                       # folder of checks and queries to load
organisation_name: "ACME Corp"          # shown in Database Connections

scheduler:
  enabled: true
  jobs:
    monitoring:      { every: 5m }
    dataquality:     { every: 1h }
    performance:     { every: 6h }
    recommendations: { every: 6h }

environments:
  - name: "Production"
    environment: "production"           # optional label shown in Database Connections
    default: true                       # connect here on startup
    cluster: true                       # read system tables from every replica
    host: "abc123.eu-west-2.aws.clickhouse.cloud"
    port: 8443
    secure: true
    cloud_api: { key_id: "…", key_secret: "…", organization_id: "…", service_id: "…" }
  - name: "Development"
    organisation_name: "ACME Labs"      # overrides the top-level one
    cluster: false                      # a single server
    host: "clickhouse.internal"
    scheduler: false                    # never scheduled
```

`querydog.yml.example` is a complete, anonymised example. The server checks
the file on startup and exits with a list of every problem (unknown keys, a
missing `host` or `cluster`, wrong types, duplicate names, more than one
`default: true`, bad scheduler intervals). All options:

| Key | Where | Meaning |
|---|---|---|
| `client` | top level | Client folder to load checks and queries from (default `clienta`; `QUERYDOG_CLIENT` overrides) |
| `folders` | top level | Optional paths for `monitoring`, `alerts`, `performance`, `dataquality`, relative to the client folder |
| `organisation_name` | top level | Organisation shown in Database Connections; an environment can set its own |
| `scheduler` | top level | `enabled`, `environments` (`all` or a list) and `jobs` (`every`, `enabled`, `include`, `exclude` per job) |
| `name`, `host` | environment | Required. The name identifies the environment in history and the scheduler |
| `organisation_name`, `environment` | environment | Optional labels shown in Database Connections; `organisation_name` overrides the top-level one |
| `default` | environment | `true` on the environment to connect to on startup; otherwise the first one (`QUERYDOG_DEFAULT_ENVIRONMENT` overrides) |
| `port`, `user`, `password`, `database`, `secure` | environment | Connection; `secure: true` for HTTPS (port 8443 on ClickHouse Cloud) |
| `deployment` | environment | `cloud` or `oss`; inferred from the host when unset |
| `cloud_api` | environment | `key_id`, `key_secret`, `organization_id`, `service_id` for ClickHouse Cloud billing |
| `cluster` | environment | Required. `true` for a multi-replica cluster (ClickHouse Cloud), so built-in screens read system tables with `clusterAllReplicas()`; `false` for a single server |
| `cluster_name` | environment | Cluster to use when `cluster: true` (default `default`) |
| `scheduler` | environment | `false` to skip this environment, or `{ jobs: … }` to override the job settings |
| `tls_reject_unauthorized` | environment | `false` to accept self-signed certificates |
| `http_headers` | environment | Extra HTTP headers sent with every ClickHouse request |

## Client folder (read-only checks and queries)

Everything the app runs comes from files in the client folder, so a different
client gets a different folder. The UI never edits them: change the files and
redeploy.

| Folder | Contents |
|---|---|
| `monitoring/` | `.sql` checks for alerting |
| `alerts/rules.yml` | How each monitoring check alerts: operator, threshold, pending minutes, channels |
| `performance/` | `.sql` queries timed by Query Performance |
| `dataquality/` | `.sql` assertions that return the failing rows |

Every `.sql` file starts with a metadata header:

```sql
-- title: Sale amounts are not negative
-- severity: critical            (critical | warning | info)
-- category: Sales
-- description: Refunds are not recorded here, so amounts must be zero or more.
SELECT * FROM default.sales WHERE amount < 0
```

Performance queries can also set `-- warn_duration_ms:` and
`-- fail_duration_ms:`. A run that takes at least that long is recorded as
slow (warn) or too slow (fail) rather than passed; a query error is an error.

## Scheduler

The scheduler runs inside the server. On each tick it runs the monitoring,
data quality and performance checks and the recommendation providers that are
due, for every scheduled environment, by calling the same API endpoints as the
Run and Run all buttons. Every run is stored with its environment, so manual
and scheduled results appear together in the UI. It logs a summary per job,
logs a failure once until it changes or recovers, and shows its configuration,
last and next runs and log under Settings › Scheduler. `QUERYDOG_SCHEDULER=on`
or `off` overrides `scheduler.enabled` for one process.

## Storage

State is kept in `data/querydog.db`, a SQLite database using Node's built-in
`node:sqlite`. Set `QUERYDOG_DATA_DIR` to move it.

- **settings**: costs, budgets, teams, API keys, appearance, alerting and data quality state
- **runs**: every check run, with environment, trigger, status, timing and rows
- **recommendations**: recommendations and their triage status per environment
- **scheduler_log**: what the scheduler did

Run only one server against a data folder at a time.

## Running

```bash
cp querydog.yml.example querydog.yml   # then add your environments
npm install
npm run dev:all                        # UI on :3001, API on :3002
# or
docker compose up --build              # everything on :3001
```

`npm run build` builds the UI and the server bundle of the recommendation
providers (`server/generated/`), which the scheduler uses.
