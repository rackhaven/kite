# Kite

Lightweight monitoring for a handful of machines. A small agent runs on each machine and sends its stats to one hub every 5 seconds. The hub keeps a week of history and serves a live web dashboard.

- **One page for all your machines:** CPU, RAM, GPU, power and the fullest disk at a glance, updating live.
- **A live feed per machine,** with 1 hour, 24 hour and 7 day history. Gaps show where a machine was off.
- **Linux and Windows agents,** each a single file with nothing else to install.
- **Light on purpose:** the agent runs at low priority and uses a fraction of a percent of one CPU core, so it stays out of the way of games and builds.

## How it works

```
 agent (Linux)   ─┐
 agent (Windows) ─┼─ HTTP every 5 s ─▶  kite-hub  ─▶  SQLite (raw 24 h, 1 min averages 7 days)
 agent (...)     ─┘    bearer token      │
                                         └─▶ web dashboard + JSON API + live stream (SSE)
```

Agents push; only the hub needs an open port. The hub stores rows at its own receive time, so a machine with a wrong clock still lands in the right place on the graphs. Machines appear on the dashboard automatically the first time they report.

## What gets collected

| | Linux | Windows |
|---|---|---|
| CPU usage (total and per core), clock speed | yes | yes |
| CPU temperature | yes (hwmon) | no, a motherboard "System" sensor instead |
| Memory and swap | yes | yes |
| GPU usage and VRAM | AMD (sysfs), NVIDIA | every GPU (Windows GPU counters) |
| GPU temperature and power | AMD, NVIDIA | NVIDIA |
| CPU package and platform power | yes (RAPL, needs root) | no |
| Battery charge and charge/discharge watts | yes | yes |
| Disks: usage and read/write speed | yes (LVM and LUKS aware) | yes (per drive letter) |
| Network: in/out per interface | yes | yes |
| Docker containers: state, CPU, memory | yes | yes (Docker Desktop) |
| systemd services: list and running/failed counts | yes (system and logged-in users) | no |

Systemd services come from the system manager and from each logged-in user's manager, each unit labelled with its scope. User managers are reached through systemd's own socket, which an agent running as root can open even where a session bus would refuse it, and a manager that cannot be read has its reason reported with the sample. History is counts only (`systemd.total`, `systemd.running`, `systemd.failed`); the full unit list rides in the latest sample and is shown as a table, so a machine with a hundred services does not add a hundred series.

Missing data is shown as missing, never as zero. On laptops the NVIDIA GPU is only queried while plugged in and awake, so monitoring never keeps it from sleeping or drains the battery.

## Getting started

### 1. Run the hub

The hub runs as a container. On the machine that will host it:

```sh
mkdir kite && cd kite
curl -fsSLO https://raw.githubusercontent.com/rackhaven/kite/main/deploy/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/rackhaven/kite/main/deploy/.env.example -o .env
# edit .env: set AGENT_TOKEN to a long random string (openssl rand -hex 32),
# and WEB_PASSWORD if the dashboard should need a password
docker compose up -d
```

Open `http://<hub>:8420/`. To also monitor the hub's own machine, start it with `docker compose --profile agent up -d`.

### 2. Add machines

Click **+ Add machine** on the dashboard, pick **Linux**, **Windows** or **Docker**, optionally type a name, and run the command it shows on the new machine. The hub serves everything the command needs, so the machine only has to reach the hub. The pop-up turns green when the machine reports.

| | Command runs | Installs |
|---|---|---|
| Linux | `curl ... /install.sh \| sudo sh` | `/usr/local/bin/kite-agent` and a `kite-agent` systemd service (low CPU and disk priority) |
| Windows | in an Administrator PowerShell | `C:\Program Files\Kite` and the `KiteAgent` service (delayed start); settings in `C:\ProgramData\Kite` |
| Docker | `docker build` from the hub, then `docker run` | a `kite-agent` container that reads the host through read-only mounts |

Running the same command again upgrades the agent. To remove it:

- Linux: `curl -fsSL http://<hub>:8420/install.sh | sudo sh -s -- --uninstall`
- Windows: `$env:KITE_UNINSTALL='1'; irm http://<hub>:8420/install.ps1 | iex` (Administrator PowerShell)
- Docker: `docker rm -f kite-agent`

On Linux, running as root lets the agent read CPU power (RAPL); `kite-agent -once` prints one sample as JSON to check what a machine reports.

### Building from source

With Go 1.26 or newer (no C toolchain or Node.js needed; the dashboard is built into the hub):

```sh
git clone https://github.com/rackhaven/kite.git && cd kite
scripts/release-build.sh dev    # dist/: hubs, agents and SHA256SUMS; the hub embeds the agents
AGENT_TOKEN=change-me dist/kite-hub-linux-amd64
```

A plain `go build ./cmd/...` also works, but that hub has no agent downloads, so **+ Add machine** asks for a release build.

### Dual-boot machines

Give the agent the same `-name` (or `AGENT_NAME`) on both operating systems and they show up as one machine with one history. GPUs are numbered the same way on both (AMD first, then NVIDIA).

## Configuration

Every flag can also be set with the environment variable next to it. Flags win.

### Hub

| Flag | Environment | Default | |
|---|---|---|---|
| `-listen` | `HUB_LISTEN` | `:8420` | Listen address |
| `-token` | `AGENT_TOKEN` | (required) | Token agents must send |
| `-password` | `WEB_PASSWORD` | none | Dashboard password; without it the dashboard is open |
| `-db` | `DB_PATH` | `kite.db` | SQLite database file |
| `-raw-retention` | `RAW_RETENTION` | `24h` | How long full-detail samples are kept |
| `-rollup-retention` | `ROLLUP_RETENTION` | `168h` | How long 1-minute averages are kept |
| `-tls-cert`, `-tls-key` | `TLS_CERT`, `TLS_KEY` | none | Serve HTTPS directly |

`kite-hub remove-machine -db kite.db <name>` deletes a machine and its history (also possible from the dashboard).

### Agent

| Flag | Environment | Default | |
|---|---|---|---|
| `-hub` | `HUB_URL` | (required) | Hub address, e.g. `http://hub:8420` |
| `-token` | `AGENT_TOKEN` | (required) | Must match the hub |
| `-name` | `AGENT_NAME` | hostname | Machine name on the dashboard |
| `-interval` | `INTERVAL` | `5s` | Time between samples |
| | `NET_INCLUDE` | all | Comma-separated interface globs to show |
| | `NET_EXCLUDE` | virtual adapters | Interface globs to hide (Docker bridges, loopback, Hyper-V, ...) |
| | `DOCKER_HOST` | local socket or pipe | Docker Engine address |
| `-once` | | | Print one sample as JSON and exit |
| `-debug-timing` | | | Log how long each collector takes |

## Security

- Agents authenticate with the shared token; the dashboard and API can be protected with a password (session cookie).
- Traffic is plain HTTP unless you pass `-tls-cert` and `-tls-key`. On anything but a trusted network, put the hub behind a VPN such as Tailscale or WireGuard, or behind a reverse proxy with HTTPS. The live stream sets `X-Accel-Buffering: no`, so it works behind nginx.

## API

| | |
|---|---|
| `POST /api/v1/ingest` | Agents send samples (bearer token) |
| `GET /api/v1/machines` | All machines with online state and latest sample |
| `GET /api/v1/machines/{name}/keys` | Metric names recorded for a machine |
| `GET /api/v1/machines/{name}/series?key=...&from=...&to=...[&res=raw\|1m\|10m]` | History; up to 64 `key` parameters, times in unix seconds |
| `DELETE /api/v1/machines/{name}` | Remove a machine and its history |
| `GET /api/v1/stream` | Live samples and online status (Server-Sent Events) |
| `POST /api/v1/login`, `POST /api/v1/logout`, `GET /api/v1/session` | Dashboard login, hub version |
| `GET /api/v1/install-info` | Agent token and version for **+ Add machine** (behind the dashboard password) |
| `GET /install.sh`, `GET /install.ps1`, `GET /download/kite-agent-<os>-<arch>`, `GET /docker/agent.tar` | Installers, agent binaries and the agent's Docker build context (no login; nothing secret) |

Rates (`*_bps`) are bytes per second. Container CPU is percent of one core and can exceed 100.

## Development

```sh
go test ./...                     # Go tests
cd web && npm install && npm test # dashboard tests
npm run dev                       # dashboard dev server, proxies /api to a hub on 127.0.0.1:8420
npm run build                     # rebuilds internal/web/dist (committed, so the hub builds without Node)
npm run size                      # checks the 150 KB gzipped budget
```

Windows-only code can be tested on a Windows machine with OpenSSH: `WINTEST_HOST=<ssh host> scripts/wintest.sh ./internal/agent [test-regex]` cross-compiles the tests, copies them over and runs them there.

## Releases

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`: it tests, runs `scripts/release-build.sh`, publishes `ghcr.io/rackhaven/kite-hub` and `ghcr.io/rackhaven/kite-agent` for amd64 and arm64, and creates a GitHub release with the binaries and `SHA256SUMS`.

## License

[MIT](LICENSE)
