# Hydra Browsers

![Hydra Browsers](hydra-browsers.jpeg)

Hydra Browsers runs isolated Chromium browsers on your own server, and lets humans and AI agents
use the same browser at the same time.

You start a browser ("session") from a web dashboard. You watch the session live and control it with
mouse and keyboard. AI agents (Claude Code, Cursor, and other MCP clients) connect to the same
session through MCP and control the same Chromium tabs.

## Features

- **Isolated sessions.** Each session is a separate Chromium in its own Kubernetes pod, with its own
  profile volume. Network policies block access from a session to the cluster, to the private
  network, and to the cloud metadata endpoint.
- **Persistent profiles.** Cookies, logins, and local storage stay after a stop and a start of the
  session.
- **Live view.** You see the browser in real time over WebRTC (Neko), and you control it with mouse and
  keyboard. The live view uses a separate origin from the dashboard.
- **MCP for AI agents.** Each session has an MCP endpoint (Streamable HTTP, Playwright MCP). The
  dashboard gives a `claude mcp add` command and an `mcpServers` JSON config that you can copy.

## How it works

```
 Browser of a user                       AI agent (Claude Code, Cursor…)
   │  hydra.example.com       (dashboard, API)   │  POST /s/<sid>/mcp + Bearer hyd_…
   │  live.hydra.example.com  (live view)        │
   ▼                                             ▼
 ┌────────── one server ── k3s, single node ──────────────────────────┐
 │  Traefik (TLS, Let's Encrypt)                                      │
 │      ▼                                                             │
 │  hydra-gateway   dashboard, API, auth, MCP proxy, live proxy,      │
 │                  orchestrator, SQLite                              │
 │      ▼                                                             │
 │  session-<sid>   neko (Chromium + WebRTC)  +  mcp (Playwright MCP) │
 │                  profile volume                                    │
 └────────────────────────────────────────────────────────────────────┘
```

The gateway is the only component that accepts external traffic. It checks each request, writes the
audit log, and sends the request to the session pod. Only the WebRTC media goes directly to the
session pod, on one port from a pool.

The stack is TypeScript in a pnpm workspace:

| Path | Contents |
|---|---|
| `packages/server` | `@hydra/server`: gateway, orchestrator, proxies, database, `hydra` CLI |
| `packages/web` | `@hydra/web`: React dashboard |
| `packages/shared` | `@hydra/shared`: zod schemas, API types, constants |
| `packages/mcp-sidecar` | `@hydra/mcp-sidecar`: the pinned `@playwright/mcp` of the `hydra-mcp` image |
| `packages/testsite` | `@hydra/testsite`: the test site of the e2e tests |
| `packages/e2e` | `@hydra/e2e`: Playwright end-to-end tests on k3d |
| `deploy/` | Dockerfiles, Kustomize base and overlays, Traefik values |
| `scripts/` | Host setup, local cluster, pinned versions, repository check |

## Connect an AI agent

1. In the dashboard, start the session.
2. Open the **Tokens** view of the session and create a token.
3. Copy the command that the dashboard shows. For Claude Code, the command is:

   ```sh
   claude mcp add --transport http <name> https://hydra.example.com/s/<sid>/mcp \
     --header "Authorization: Bearer hyd_…"
   ```

4. For other MCP clients, copy the `mcpServers` JSON config from the same view.

The dashboard shows the full token one time only. Keep it in a safe place.

## Production deploy

Hydra Browsers runs on k3s on one Linux server, for example an EC2 instance.

### What you must prepare

The repository does not create the cloud resources. Prepare these items first:

- A Debian or Ubuntu server with a static public IP (for example an Elastic IP). On EC2, require
  IMDSv2 with hop limit 1.
- Firewall rules (for example a security group):
  - TCP 80 and 443 from all addresses.
  - UDP and TCP on the media port range (default `52000-52099`) from all addresses.
  - SSH from admin addresses only.
- Two DNS records to the public IP, for example `hydra.example.com` (dashboard, API, and MCP) and
  `live.hydra.example.com` (live view). The two hostnames must have the same registrable domain.
- A persistent volume for the state folder (default `/var/lib/hydra`), with daily snapshots.

### Install k3s on the server

1. Clone the repository on the server.
2. Run the setup script as root:

   ```sh
   sudo HYDRA_STATE_DIR=/var/lib/hydra HYDRA_MEDIA_PORT_RANGE=52000-52099 ./scripts/setup-k3s.sh
   ```

The script installs the pinned k3s version and checks the SHA-256 of the k3s installer. It also
sets kernel parameters, turns on security updates, and configures Traefik with Let's Encrypt. You can
run it again safely, for example after a k3s update.

If you use a media port range that is not the default, also change the range in the `prod` overlay
and in the firewall. The comments in `scripts/setup-k3s.sh` give the details.

### Deploy the gateway

1. Create the namespaces and the root key. Keep a copy of the key in a secret store:

   ```sh
   kubectl apply -f deploy/k8s/base/namespaces.yaml
   kubectl -n hydra create secret generic hydra-secret-key \
     --from-literal=HYDRA_SECRET_KEY="$(openssl rand -base64 32)"
   ```

2. In `deploy/k8s/overlays/prod/kustomization.yaml`, set these values:
   - The two hostnames, in `hydra-config` and in the `Host()` rules of the two IngressRoutes.
   - The public IP (`HYDRA_PUBLIC_IP`).
   - The private IP of the server, in the `gateway-egress-apiserver` NetworkPolicy.
3. If the images on `ghcr.io` are private, give k3s a read token in
   `/etc/rancher/k3s/registries.yaml`.
4. Apply the overlay:

   ```sh
   kubectl apply -k deploy/k8s/overlays/prod
   kubectl -n hydra rollout status deploy/hydra-gateway
   ```

5. Create the first admin:

   ```sh
   kubectl exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>
   ```

6. Open `https://hydra.example.com` and log in.

### Update

1. Pull the new commit on the server.
2. Run `kubectl apply -k deploy/k8s/overlays/prod`.

At start, the gateway makes a backup of the database and then runs the migrations. If a migration
fails, the gateway stops and does not serve requests.

### `hydra` CLI

The gateway image contains the `hydra` CLI. Run it with
`kubectl exec -it -n hydra deploy/hydra-gateway -- hydra <command>`.

| Command | Use |
|---|---|
| `hydra user create --email <email> [--admin] [--name <name>]` | Create a user |
| `hydra user reset-password --email <email>` | Set a new password for a user |
| `hydra db backup` | Make a backup of the database |
| `hydra keygen` | Print a new root key |

## Local development

Local development uses a k3d cluster (k3s in Docker) for the session pods. The gateway and the
dashboard run on your computer with hot reload.

### Requirements

- **Node.js 24.21.0**, from `.node-version` (mise, fnm, and nvm read it).
- **pnpm 10 or newer.** pnpm switches to the pinned version of `packageManager` by itself.
- **Docker**, **kubectl**, **curl**, **git**, and **openssl**.
- **k3d**, the version of `K3D_VERSION` in `scripts/versions.sh`.

To install k3d, download the binary and check it against the checksums of the release. This example
is for macOS on Apple silicon. For Linux, use `k3d-linux-amd64`. Run it from the repository root:

```sh
. scripts/versions.sh
curl -fsSLO "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-darwin-arm64"
curl -fsSL "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/checksums.txt" -o k3d-checksums.txt
echo "$(grep '/k3d-darwin-arm64$' k3d-checksums.txt | cut -d' ' -f1)  k3d-darwin-arm64" | shasum -a 256 -c - && \
chmod +x k3d-darwin-arm64 && sudo mv k3d-darwin-arm64 /usr/local/bin/k3d && rm k3d-checksums.txt
k3d version
```

### Start

1. Install the dependencies:

   ```sh
   pnpm install
   ```

2. Create the local cluster. The script builds the images, pushes them to a local registry, and
   deploys the `dev` overlay:

   ```sh
   ./scripts/dev-cluster.sh
   ```

   On Docker Desktop for macOS, use `HYDRA_MEDIA_BIND_ADDRESS=0.0.0.0 ./scripts/dev-cluster.sh`.
   Docker Desktop does not forward UDP on `127.0.0.1`, and without this value the live view shows no
   video.

3. Start the gateway and the dashboard on your computer:

   ```sh
   pnpm dev
   ```

4. In a second terminal, create an admin in the database of the local gateway:

   ```sh
   bash scripts/dev-cluster.sh dev pnpm --filter @hydra/server run hydra user create --admin --email <email>
   ```

5. Open `http://hydra.localhost:5173` and log in.

`pnpm dev` stops the gateway in the cluster and runs the gateway on your computer. To start the
gateway in the cluster again, stop `pnpm dev` and run `./scripts/dev-cluster.sh`. That gateway is at
`http://hydra.localhost`.

To remove the cluster and the registry:

```sh
k3d cluster delete hydra-dev && k3d registry delete k3d-hydra-registry
```

### Commands

| Command | Use |
|---|---|
| `pnpm test` | All unit and integration tests (Vitest) |
| `pnpm --filter @hydra/server test` | The tests of one package |
| `pnpm lint` | ESLint and `prettier --check` |
| `pnpm typecheck` | `tsc` for the root scripts and for each package |
| `pnpm build` | Build all packages |
| `pnpm e2e` | End-to-end tests on the k3d cluster |
| `node scripts/check-repo.ts` | Check the pinning rules and the config parity |

## Contributing

- The design spec is the source of truth:
  [`docs/superpowers/specs/2026-10-10-hydra-browsers-design.md`](docs/superpowers/specs/2026-10-10-hydra-browsers-design.md).
- Read [`AGENTS.md`](AGENTS.md) before you change the code. These rules apply to humans and to agents.
- Frontend changes follow [`STYLE.md`](STYLE.md).
- Spec section 3.4 gives the dependency rules. Add a dependency with an exact version, for example
  `pnpm --filter @hydra/server add <name>@<version>`.
