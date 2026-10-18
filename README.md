QueryDog is a powerful tool for ClickHouse performance optimisation.  Visualise query performance and background activity, identify bottlenecks and optimise cluster performance with a single container.
 
By [New Cadence](https://newcadence.io).

<img width="2054" height="1101" alt="Screenshot 2025-12-09 at 11 31 53 pm" src="https://github.com/user-attachments/assets/e1b52d42-028a-4c46-8631-7fdcaba44747" />
<img width="2055" height="1101" alt="Screenshot 2025-12-09 at 11 32 10 pm" src="https://github.com/user-attachments/assets/81150e55-b47b-4feb-89cd-02bee733ad4b" />

## Running

Clone the repository and create your config:

```bash
git clone https://github.com/New-Cadence/QueryDog
cd querydog
cp querydog.yml.example querydog.yml
```

Edit `querydog.yml` with your connection details. You can configure multiple environments and switch between them from the UI:

```yaml
environments:
  - name: "Local"
    host: "host.docker.internal"   # your machine, as seen from the container
    port: 8123
    user: "default"
    password: ""
    database: "default"
    secure: false

  - name: "Production"
    host: "your-clickhouse-host"
    port: 8443
    user: "your-username"
    password: "your-password"
    database: "default"
    secure: true
```

Every environment needs a `host` — QueryDog refuses to start and names the offending entry if one is blank. To reach a ClickHouse running on your own machine, use `host.docker.internal` rather than `localhost`: inside the container `localhost` is the container itself. Use `localhost` only when running QueryDog directly with `npm run dev`.

`querydog.yml.example` documents the optional settings (`cluster`, `queries_folder`, `tls_reject_unauthorized`).

<details>
<summary><strong>Connecting to a ClickHouse on your own machine (Linux)</strong></summary>

Docker Desktop provides `host.docker.internal` out of the box. On Linux, `docker-compose.yml` declares it via `extra_hosts: host.docker.internal:host-gateway`, which resolves to the default bridge gateway (usually `172.17.0.1`). Two host-side settings commonly block the connection anyway:

- **`Error: connect ETIMEDOUT 172.17.0.1:8123`** — a distro-packaged ClickHouse listens on loopback only. Uncomment `<listen_host>::</listen_host>` in `/etc/clickhouse-server/config.xml` and restart the server. Confirm with `ss -tlnp | grep 8123`, which should show `*:8123` rather than `127.0.0.1:8123`.
- **Still timing out with the listener open** — a host firewall is dropping bridge traffic. A dropped packet times out; a closed port would be refused, so a timeout points here. For ufw:

  ```bash
  sudo ufw allow proto tcp from 172.16.0.0/12 to 172.17.0.1 port 8123 comment 'clickhouse-from-docker'
  ```

Both open ClickHouse to local containers, so weigh that against how the machine is used.

</details>

Start with Docker Compose:

```bash
docker compose up --build
```

Access the UI at http://localhost:3001.

## Timezones

**Queries are issued in UTC; timestamps are displayed in your local time.**

The UI connects with `session_timezone` pinned to `UTC`, so ClickHouse parses
every filter bound and returns every `DateTime` in UTC no matter which timezone
the server itself runs in. The browser then renders those instants in the
viewer's own local timezone.

Two people in different timezones looking at the same cluster therefore select
the same rows and each see the times on their own wall clock. It also means the
times shown will not always match a `clickhouse-client` session on the server,
which formats in the server's timezone.

Timestamps you type into the From/To pickers are read as your local time and
converted to UTC before being sent.

## CLI

The same image ships the `querydog` CLI. The container entrypoint routes `server` to the web UI and forwards anything else to the CLI, so you can run one-off commands with `docker compose run`:

```bash
docker compose run --rm querydog help
docker compose run --rm querydog tables
docker compose run --rm querydog queries --mode slowest --hours 6
```

Your `querydog.yml` and `./queries` mounts come along automatically, and `--rm` cleans up the container after the command exits.

### Setting an alias

For day-to-day use, add a shell alias so you can call the CLI like a local binary:

```bash
# ~/.zshrc or ~/.bashrc
alias qd='docker compose -f /path/to/querydog/docker-compose.yml run --rm querydog'
```

Then:

```bash
qd help
qd envs
qd tables -e Production
```

### Example commands

Pick an environment with `-e <name|number>` (matches names from `querydog.yml`; partial names work too). Output defaults to a table; use `-f json` or `-f csv` to pipe into other tools.

```bash
# Schema exploration
qd tables -e Production
qd databases
qd ddl -d analytics -t events
qd schema-nullables -d analytics       # find Nullable columns worth optimising
qd schema-oversized                     # find oversized integer columns

# Query log analysis
qd queries --mode slowest --hours 24 --limit 20
qd queries --mode highestmemory --hours 6
qd queries --mode bytable -d analytics
qd queries --mode errors --hours 1

# Live activity & background work
qd processes
qd merges
qd mutations
qd async-inserts
qd background-jobs

# Storage & cluster
qd partitions -d analytics -t events
qd disks
qd replicas
qd replication-queue

# Logs & metrics
qd text-log --level Error --hours 1
qd metrics
qd system-errors

# Machine-readable output
qd queries --mode slowest -f json | jq '.[].query'
qd tables -f csv > tables.csv
```

Run `qd help` for the full command list, or `qd <command> --help` for per-command flags. Add `-i` to drop into an interactive REPL after the first command.

### Next Steps

Please visit https://newcadence.io for more details on the project and our ClickHouse consulting services.

