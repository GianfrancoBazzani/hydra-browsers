# Hydra Browsers — Design Spec

- **Date:** 2026-10-10
- **Status:** Approved in brainstorming. Revised after the first written-spec review, waiting for the next review.
  Revised on 2026-10-12: secrets vault (sections 6.9, 8.8, 8.9, and the related changes), waiting for review.
- **Audience:** engineers (human or agent) who implement Hydra Browsers version 1

---

## 1. Purpose

Hydra Browsers is an internal tool for a team. A team member uses a web dashboard to start isolated
Chromium browsers ("sessions") on a remote server. The team member watches each session live in the
dashboard and can control it with mouse and keyboard. External AI agents (Claude Code, Cursor, and
other MCP clients) connect to a session through MCP and control the same browser. The human and
the agent see and use the same Chromium tabs at the same time.

The main use is tasks on third-party sites with the team's own accounts. The human does the login,
2FA, and captchas by hand in the live view. The agent then continues from the logged-in state.
Alternatively, the owner puts credentials into the vault of the session (section 6.9). The agent then
fills the username, the password, and the 2FA code into the login form without seeing these values
(section 8.8).

### 1.1 Success criteria

1. An admin creates a user, and that user logs in.
2. The user creates a session with a domain allowlist. The session is `running` in less than 60 s.
3. The user watches the live view and logs in to a site by hand.
4. The user creates an agent token, and Claude Code connects with it. The agent completes a task
   while the user watches. The audit log shows each tool call.
5. After a stop and a start of the session, the site login is still there.
6. All security e2e tests (section 15.3) pass.
7. The owner adds a credential with a username, a password, and a TOTP secret to the vault of a session.
   The agent logs in to a site with `vault_fill`. The MCP responses and the audit log contain none of
   the values.

### 1.2 Decisions taken during brainstorming

| Topic | Decision |
|---|---|
| Users | A team (internal tool), up to 10 running sessions |
| Agent | External MCP clients only. Bearer token per session. OAuth 2.1 later. |
| Runtime | k3s, single node, on one EC2 instance |
| Live view | Neko (WebRTC). A session that has a pod holds one media port from a pool. `NAT1TO1` = Elastic IP. One live origin for all sessions (known limit, section 7.10). |
| Lifecycle | Persistent sessions: stop and start keep the profile |
| Team login | Local accounts, created by an admin |
| Access | Owner plus explicit sharing (`viewer`, `operator`), admins see all |
| Agent safety (v1) | Domain allowlist per session (a guard for navigation, not against data exfiltration, section 8.7), audit log of tool calls |
| Stack | TypeScript everywhere, pnpm workspace with sub-packages |
| Database | SQLite; all gateway state in one folder (`HYDRA_DATA_DIR`) |
| Dashboard | One macOS-style app window with a sidebar, style from `ridvanonal/macos-react` |
| Infrastructure | Cloud resources (EC2, security group, DNS, volume, snapshots) are not in this repo (section 11.5). The repo has the host setup script, the dev cluster script, and the Kubernetes manifests. |
| Anti-detection | Not in scope. Only honest environment settings (locale, fonts, screen size). |
| Dependencies | Exact pins everywhere: pnpm, Node.js, packages, images (digests), Actions (SHAs), k3s. 7-day minimum release age. |
| Secrets vault | Credentials for each session, encrypted in the gateway DB. The agent fills a value by reference (`vault_fill`) and never gets it. A fill works only on the website of the credential. The gateway removes vault values from all MCP responses. Protection against accidental exposure, not against a malicious agent (section 8.7). |

### 1.3 Terminology

Each term has one meaning in this spec and in the code.

| Term | Meaning |
|---|---|
| **session** | One isolated browser: its DB row, its Kubernetes resources, and its profile. ID = `sid`. |
| **login session** | A dashboard login of a user (cookie `__Host-hydra_session`). |
| **MCP session** | A Playwright MCP session, identified by the `Mcp-Session-Id` header. |
| **agent** | An MCP client that uses an agent token. The dashboard counts one connected agent for each MCP session with activity in the last 60 s (section 8.5). |
| **agent token** | A bearer token (`hyd_…`) that permits an agent to use the MCP endpoint of one session. |
| **live ticket** | A one-use value that gives an iframe a live grant (section 9.2). |
| **live grant** | Permission of one login session to open the live view of one session (cookie `__Host-hydra_live_<sid>`). |
| **Neko profile** | The Neko member profile that the gateway uses for a user on a session: `admin` or `user` (section 6.7). |
| **gateway** | The `@hydra/server` process. It is the only component that accepts external traffic. |
| **media port** | The one UDP+TCP port that Neko uses for WebRTC media for one session. |
| **MCP stream** | An open MCP response (`text/event-stream`), or the GET stream of an MCP session. |
| **SSE stream** | An open dashboard event stream (section 10.3). |
| **video stream** | The WebRTC media of one live view. |
| **vault** | The encrypted credentials of one session (section 6.9). |
| **credential** | One entry of a vault: a name, a website, and one or more of a username, a password, and a TOTP secret. A credential is not a login session. |
| **vault value** | The username, the password, or the current TOTP code of a credential. |
| **fill** | The sidecar puts one vault value into one editable element of the page (section 8.8). |
| **view** | One of the six dashboard views of a session: Live, Tokens, Vault, Sharing, Activity, Settings. |
| **browser tab** | A tab of the local browser of a team member. |
| **Chromium tab** | A tab in the Chromium of a session. |

---

## 2. Architecture

```
 Team member's browser                  External agent (Claude Code, Cursor…)
   │ HTTPS 443                            │ HTTPS 443
   │  hydra.example.com      (UI, API)    │ POST /s/<sid>/mcp  + Bearer hyd_…
   │  live.hydra.example.com (Neko UI/WS) │
   │            ┌─────────────────────────┘
   ▼            ▼
 ┌──────────── EC2 (Elastic IP) ── k3s single node ─────────────────────────┐
 │  Traefik ingress (TLS, Let's Encrypt)                                     │
 │      │                                                                    │
 │      ▼                                                                    │
 │  namespace hydra                                                          │
 │  hydra-gateway (Deployment, 1 replica, Node.js 24 + Fastify)              │
 │   ├─ api / auth / access     dashboard API, local accounts, authorize()   │
 │   ├─ orchestrator            Kubernetes API, reconciler                   │
 │   ├─ mcp-proxy               bearer check → audit → pod:8931              │
 │   ├─ live-proxy              live grant check → Neko login → pod:8080     │
 │   ├─ static                  @hydra/web build                             │
 │   └─ db                      SQLite in HYDRA_DATA_DIR (PVC gateway-data)  │
 │      │ headless Service (NetworkPolicy: only the gateway can connect)     │
 │      ▼                                                                    │
 │  namespace hydra-sessions                                                 │
 │  session-<sid> (StatefulSet, replicas 0 or 1)                             │
 │   ├─ init: remove Chromium Singleton* lock files                          │
 │   ├─ neko      hydra-session image, :8080 HTTP/WS, CDP on 127.0.0.1:9222  │
 │   ├─ mcp       hydra-mcp image, :8931, --cdp-endpoint 127.0.0.1:9222      │
 │   └─ PVC profile-<sid> → /home/neko/.config/chromium                      │
 │        NodePort 52xxx tcp+udp ◄────── WebRTC media (direct, not proxied)  │
 └───────────────────────────────────────────────────────────────────────────┘
```

Headed Chromium binds the DevTools server only to `127.0.0.1` (it ignores
`--remote-debugging-address`). Thus Playwright MCP must run as a sidecar in the same pod.

The dashboard, the API, and the MCP endpoint use one origin (`HYDRA_PUBLIC_URL`). The live view
uses a second origin (`HYDRA_LIVE_URL`), because the Neko client is third-party JavaScript
(section 9.1). One gateway process serves both hostnames and routes by the `Host` header.

---

## 3. Repository layout

```
hydra-browsers/
├─ pnpm-workspace.yaml        packages and pnpm settings (section 3.4.3)
├─ pnpm-lock.yaml             committed lockfile
├─ package.json               packageManager, devEngines, root scripts: build, dev, test, lint, typecheck, e2e
├─ .node-version              24.21.0
├─ renovate.json              update rules (section 3.4.6)
├─ tsconfig.base.json
├─ .github/workflows/         CI and release workflows (sections 3.4.4 and 15.4)
├─ packages/
│  ├─ shared/   @hydra/shared   zod schemas, API types, constants (Node + browser)
│  ├─ server/   @hydra/server   gateway, orchestrator, proxies, db, CLI
│  ├─ web/      @hydra/web      React dashboard
│  ├─ mcp-sidecar/ @hydra/mcp-sidecar  hydra-mcp program: embeds @playwright/mcp, adds the vault fill (section 8.8)
│  ├─ testsite/ @hydra/testsite small HTTP server for the e2e tests (section 15.3)
│  └─ e2e/      @hydra/e2e      Playwright end-to-end tests on k3d
├─ deploy/
│  ├─ Dockerfile              hydra-gateway image (server + built web)
│  ├─ session/
│  │  ├─ Dockerfile.session   hydra-session image (FROM Neko Chromium)
│  │  ├─ Dockerfile.mcp       hydra-mcp image
│  │  └─ seccomp/             Chromium seccomp profile (result of spike S1)
│  ├─ testsite/Dockerfile     hydra-testsite image (dev overlay only)
│  ├─ traefik/                HelmChartConfig: prod.yaml, dev.yaml (section 11.3)
│  └─ k8s/
│     ├─ base/                namespaces, RBAC, gateway, image pre-pull, StorageClasses, NetworkPolicies, IngressRoutes
│     └─ overlays/
│        ├─ dev/              k3d values
│        └─ prod/             production values (hostnames, node IP, image digests)
├─ scripts/
│  ├─ versions.sh             k3s, k3d, and rancher/k3s image pins (section 3.4.2)
│  ├─ setup-k3s.sh            host setup for production
│  ├─ dev-cluster.sh          local k3d cluster for development and e2e
│  └─ check-repo.ts           CI check of the pinning policy and of config parity (section 3.4.7)
└─ docs/
   ├─ load-check.md           load check procedure (section 15.5)
   └─ superpowers/specs/      this spec
```

### 3.1 `@hydra/server` modules (`packages/server/src/`)

Each module has one purpose and a small public interface.

| Module | Purpose | Depends on |
|---|---|---|
| `config/` | Read and validate environment variables (zod). | — |
| `crypto/` | HKDF subkeys, HMAC, random tokens, Argon2id with a limit on parallel hashes (section 6.3). | `config` |
| `db/` | Drizzle schema, migrations, repository functions. | `config` |
| `events/` | In-process event bus (see below). | — |
| `audit/` | Event writer, redaction, retention job. Publishes each written event on the bus. | `db`, `events` |
| `auth/` | Login, logout, password change, login session cookies, CSRF check, rate limiter, login throttle, lock. | `crypto`, `db`, `audit`, `events` |
| `users/` | Admin user actions (section 6.3). | `auth`, `db`, `audit`, `events` |
| `access/` | `authorize(user, session, action)`, list filters, session members (section 6.5). | `db`, `audit`, `events` |
| `tokens/` | Agent token create, list, and revoke, and `resolveAgentPrincipal()` (sections 6.6 and 8.2). | `crypto`, `db`, `access`, `audit`, `events` |
| `orchestrator/` | Kubernetes client, manifest builders, watch, reconciler, `podEndpoint(sid, port)` (sections 7.3 and 7.9). | `config`, `crypto`, `db`, `audit` |
| `sessions/` | Session service: create, update, start, stop, restart, delete. Capacity check and media port allocation. | `db`, `tokens`, `orchestrator`, `audit` |
| `vault/` | Credential service: create, update, delete, reveal. Encryption, TOTP, site match, the values for a fill, and the redaction sets (sections 6.9, 8.8, 8.9). | `config`, `crypto`, `db`, `access`, `audit`, `events` |
| `mcp-proxy/` | Proxy, JSON-RPC and SSE parsers, tool deny list, vault tool calls, response redaction, MCP stream registry, agent activity summary. | `tokens`, `access`, `auth` (rate limiter), `db`, `audit`, `events`, `orchestrator`, `vault` |
| `live-proxy/` | Live tickets, live grants, Neko login injection, HTTP/WS proxy. | `auth`, `access`, `crypto`, `db`, `audit`, `events`, `orchestrator` |
| `api/` | Fastify routes and SSE endpoints for the dashboard. | all service modules |
| `static/` | Serve the `@hydra/web` build, with the headers of section 6.8. | `config` |
| `cli/` | `hydra keygen`, `hydra user create`, `hydra user reset-password`, `hydra db backup`. | `config`, `crypto`, `db`, `users` |
| `main.ts` | Start the server, the reconciler, and the jobs. | all |

- No dependency cycles. No module depends on `api/`.
- Events on the bus: `session.state`, `session.activity`, `token.revoked`, `rights.changed` (user ID),
  `login.ended` (login session IDs), and each audit event. The proxies close connections when they get
  these events (sections 8.3 and 9.2). The SSE endpoints read the bus.

### 3.2 `@hydra/web` structure (`packages/web/src/`)

- `theme/`: design tokens as CSS variables (light and dark), Tailwind v4 theme.
- `components/os/`: `AppWindow`, `TrafficLights`, `Sidebar`, `Toolbar`, `SegmentedControl`, `Sheet`,
  `Button`, `Switch`, `ChipInput`, `Table`, `StatusDot`, `Banner`.
- `routes/`: `login`, `change-password`, `sessions/:sid/{live,tokens,vault,sharing,activity,settings}`,
  `admin/users`, `admin/sessions`.
- `api/`: TanStack Query hooks. They validate each response with the `@hydra/shared` schemas.
- `lib/sse.ts`: the SSE client for session events.

### 3.3 `@hydra/shared`

- zod schemas for all API requests and responses, and for the arguments of `vault_fill` (section 8.8).
- Constants: global roles, session roles, actions, session states, error codes, event kinds.
- Vault helpers without Node.js APIs: the `otpauth://` URI parser, the base32 rules, and
  `vaultSiteMatches` (section 6.9).

### 3.4 Dependency pinning policy

**Goal:** one commit gives the same toolchain, the same dependency tree, the same images, and the same
cluster software on each system. All versions are exact. No version changes without a commit.

#### 3.4.1 Rules

1. Each version is exact. No `^`, `~`, `*`, `x`, `latest`, or other ranges in a `package.json`.
   The only exception is `workspace:*` for internal packages.
2. Each container image reference has a tag and a digest: `name:tag@sha256:<digest>`. Our own images get
   their digests from CI (section 3.4.4).
3. Each GitHub Action uses a full 40-character commit SHA, with the version in a comment. Runners use
   a fixed image (`ubuntu-24.04`), never `ubuntu-latest`.
4. A new version must be 7 days old or more when we add it (minimum release age). Section 3.4.6 gives
   the exceptions.
5. No dependency from a git repository or a tarball URL, direct or transitive.
6. No install scripts, except for the packages in `allowBuilds`. Each entry has a comment with the reason.
7. `pnpm-lock.yaml` is committed. All installs in CI and in Docker builds use `--frozen-lockfile`.
8. A CI check (section 3.4.7) enforces these rules.

#### 3.4.2 Toolchain

| Tool | Pin | Where |
|---|---|---|
| pnpm | `12.9.0` | `packageManager` in the root `package.json`. pnpm 12 writes its own integrity hash into `pnpm-lock.yaml`. |
| Node.js | `24.21.0` (LTS) | `devEngines.runtime` in the root `package.json`, `nodeVersion` in `pnpm-workspace.yaml`, `.node-version`, and the Docker base image tags |
| TypeScript, Vitest, ESLint, and all other dev tools | exact | `devDependencies`, recorded in the lockfile |
| k3s | exact `vX.Y.Z+k3sN` | `scripts/versions.sh`. `setup-k3s.sh` and `dev-cluster.sh` read it. |
| k3d | exact | `scripts/versions.sh`. `dev-cluster.sh` checks the installed version. |

The first plan task selects the k3s and k3d versions with the age rule of section 3.4.1. The README
gives the steps to reproduce the build on another system.

Root `package.json`:

```json
{
  "name": "hydra-browsers",
  "private": true,
  "packageManager": "pnpm@12.9.0",
  "devEngines": {
    "runtime": { "name": "node", "version": "24.21.0", "onFail": "download" }
  }
}
```

- Another pnpm version switches to pnpm 12.9.0 (`pmOnFail: download`). pnpm downloads Node.js 24.21.0
  for the scripts of the project and records its checksum in the lockfile.
- `.node-version` gives the same Node.js version to version managers (mise, fnm, nvm) and to
  `actions/setup-node`.

#### 3.4.3 `pnpm-workspace.yaml`

pnpm 12 reads its settings from `pnpm-workspace.yaml`. It reads only registry and authentication
settings from `.npmrc`.

```yaml
packages:
  - "packages/*"

# Rule 1: save exact versions
savePrefix: ""

# Rule 4: minimum release age, 7 days in minutes.
# It is strict, because it is set explicitly (minimumReleaseAgeStrict defaults to true).
minimumReleaseAge: 10080
minimumReleaseAgeExcludePrune: true

# Supply chain
trustPolicy: no-downgrade
blockExoticSubdeps: true
trustLockfile: false

# Rule 6: install scripts only for reviewed packages
strictDepBuilds: true
allowBuilds:
  better-sqlite3: true   # native SQLite binding (prebuilt download, or build from source)
  # Add an entry only after a review, with the reason.

# Node.js version for engine checks of dependencies
nodeVersion: 24.21.0
engineStrict: true

# pnpm version from packageManager
pmOnFail: download
```

The first `pnpm install` lists all dependencies with build scripts and stops (`strictDepBuilds`). Each
entry needs a review and a reason comment before it becomes `true`. All other entries become `false`.

#### 3.4.4 Container images

- **Base images** have a tag and a digest:
  - `node:24.21.0-slim@sha256:…`
  - the distroless Node.js 24 image `@sha256:…`
  - `ghcr.io/m1k1o/neko/chromium:3.1.6@sha256:…`
  - `registry.k8s.io/pause:<version>@sha256:…` (image pre-pull, section 11.2)
- **`hydra-mcp`:** the build uses the workspace package `@hydra/mcp-sidecar` (`packages/mcp-sidecar/`).
  This package has these exact dependencies: `@playwright/mcp` `0.0.83`, `playwright` with the exact
  version that `@playwright/mcp` `0.0.83` uses (`1.64.0-alpha-1790635538000`), the MCP TypeScript SDK,
  and `@hydra/shared` (`workspace:*`). The CI check fails if the `playwright` version is not equal to the
  version that `@playwright/mcp` requires, because two Playwright copies in one process cannot share
  the snapshot refs (section 8.8). The Dockerfile runs
  `pnpm --filter @hydra/mcp-sidecar deploy --prod /out` after `pnpm install --frozen-lockfile`. Thus
  the lockfile also pins all transitive dependencies of Playwright MCP. Do not use `npm install -g`,
  because it does not use the lockfile.
- **Debian packages** in `hydra-session` (the fonts) come from `snapshot.debian.org` at a fixed
  timestamp (build argument `DEBIAN_SNAPSHOT`). Thus each build installs the same package versions.
- **pnpm in Dockerfiles:** `npm install -g pnpm@12.9.0`. The CI check makes sure that this value is
  equal to `packageManager`.
- **Our images** (`hydra-gateway`, `hydra-session`, `hydra-mcp`, `hydra-testsite`): CI builds them from
  one commit and tags them with the commit SHA. The code has no default for `HYDRA_SESSION_IMAGE` and
  `HYDRA_MCP_IMAGE`.
  - **Production:** the release workflow pushes the images. Then it writes their digests to the `prod`
    overlay and commits this change directly to the default branch (no pull request): Kustomize
    `images:` for the pods, and the generated ConfigMap `hydra-images` for `HYDRA_SESSION_IMAGE` and
    `HYDRA_MCP_IMAGE`. Kustomize `images:` does not change environment values, so the ConfigMap is
    necessary. The workflow commits only digests of a commit that is on the default branch and that is
    not older than the release in the overlay.
  - **k3d (development and CI):** `dev-cluster.sh` creates a local registry. The build pushes the images
    to it and writes the same values into the `dev` overlay. These files are generated and not committed.

#### 3.4.5 Kubernetes and host

- `setup-k3s.sh` downloads `install.sh` from the pinned k3s release tag, compares its SHA-256 with a
  value in the script, and then runs it with `INSTALL_K3S_VERSION`. The k3s installer checks the
  checksum of the k3s binary.
- k3s contains Traefik and `local-path-provisioner`. Thus the k3s pin also pins these components.
- `setup-k3s.sh` and `dev-cluster.sh` read the k3s version, the k3d version, and the `rancher/k3s` image
  digest from `scripts/versions.sh`. Thus development and production use the same k3s version.

#### 3.4.6 Updates and exceptions

- **Renovate** (`renovate.json`) opens the update pull requests with the same rules:
  `rangeStrategy: "pin"`, `pinDigests: true`, `minimumReleaseAge: "7 days"`, a regex manager for
  `scripts/versions.sh`, and lock file maintenance one time each month.
- Each update pull request must pass all CI jobs, which include the e2e tests.
- Before you change the Neko, Playwright MCP, or k3s version, read the release notes, because their
  flags and defaults change between versions.
- **Urgent security fix that is younger than 7 days:** add the exact version to
  `minimumReleaseAgeExclude`, with a comment that gives the date, the reason, and the advisory ID.
  `minimumReleaseAgeExcludePrune` removes the entry when the lockfile no longer uses that version.
- **Trust policy exception:** add the exact version to `trustPolicyExclude`, with a reason comment.
- **`overrides`:** exact versions only, each with a reason comment.

#### 3.4.7 CI check

`scripts/check-repo.ts` runs with the type stripping of Node.js 24 (`node scripts/check-repo.ts`).
It fails if one of these conditions is true:

- A `package.json` contains a version range (other than `workspace:*`).
- A Dockerfile `FROM` line, a third-party image in a Kubernetes manifest, or an image in
  `scripts/versions.sh` has no `@sha256:`.
- A workflow `uses:` line has no full commit SHA, or a workflow uses `ubuntu-latest`.
- The Node.js versions in `.node-version`, `devEngines.runtime`, `nodeVersion`, and the Dockerfile tags
  are not all equal.
- The pnpm version in a Dockerfile is not equal to `packageManager`.
- The `playwright` version of `@hydra/mcp-sidecar` is not equal to the `playwright` version that its
  `@playwright/mcp` requires (section 3.4.4).
- The Traefik entry point timeouts in `deploy/traefik/prod.yaml` and `deploy/traefik/dev.yaml` are not
  equal (section 11.3).

CI also runs `pnpm install --frozen-lockfile` and `pnpm audit --audit-level high`.

#### 3.4.8 Versions of the main libraries

- **Fixed now:** Neko `3.1.6`, `@playwright/mcp` `0.0.83`, pnpm `12.9.0`, Node.js `24.21.0`.
- **Selected by the first plan task, with the age rule:** Fastify 5, React 19, Tailwind CSS 4, Vite,
  React Router, TanStack Query, Radix, Tabler icons, Drizzle ORM, better-sqlite3, `@node-rs/argon2`,
  `@kubernetes/client-node`, undici, zod, pino, Vitest, Playwright, and the MCP TypeScript SDK.

---

## 4. Configuration

A zod schema in `config/` validates all variables at start. If a value is missing or not correct,
the gateway stops with a message that names the variable.

| Variable | Default | Purpose |
|---|---|---|
| `HYDRA_DATA_DIR` | `./.data` | Folder for all gateway state (section 5) |
| `HYDRA_SECRET_KEY` | necessary | Root key, 32 bytes, base64. Alternative: `HYDRA_SECRET_KEY_FILE`. |
| `HYDRA_PUBLIC_URL` | necessary | Origin of the dashboard, API, and MCP endpoint |
| `HYDRA_LIVE_URL` | necessary | Origin of the live view (one origin for all sessions) |
| `HYDRA_PUBLIC_IP` | necessary | Elastic IP, used as Neko `NAT1TO1` |
| `HYDRA_MEDIA_PORT_RANGE` | `52000-52099` | Media port pool |
| `HYDRA_MAX_RUNNING` | `10` | Maximum number of sessions that hold a media port (section 7.8) |
| `HYDRA_SESSION_NAMESPACE` | `hydra-sessions` | Namespace for session resources |
| `HYDRA_SESSION_TRANSPORT` | `cluster-dns` | How the gateway connects to session pods: `cluster-dns` (in the cluster) or `port-forward` (development on the host, sections 7.3 and 11.7) |
| `HYDRA_SESSION_IMAGE` | necessary | `hydra-session` image with tag and digest. The overlay sets it (section 3.4.4). |
| `HYDRA_MCP_IMAGE` | necessary | `hydra-mcp` image with tag and digest. The overlay sets it (section 3.4.4). |
| `HYDRA_TRUSTED_PROXIES` | `10.42.0.0/16` | Source addresses whose `X-Forwarded-For` header the gateway trusts: the Traefik pods (section 11.3) |
| `HYDRA_DEFAULT_TIMEZONE` | `UTC` | Default timezone for new sessions |
| `HYDRA_DEFAULT_LANGUAGE` | `en-US` | Default language for new sessions |
| `HYDRA_AUDIT_RETENTION_DAYS` | `90` | Audit retention |
| `HYDRA_VAULT_HTTP_HOSTS` | empty | Comma-separated hostnames for which a credential website can use `http` (section 6.9). Only the `dev` overlay sets it, to the test site host (section 15.3). |
| `HYDRA_LOG_LEVEL` | `info` | pino log level |
| `PORT` | `8080` | HTTP port of the gateway |

Validation rules:
- `HYDRA_PUBLIC_URL` and `HYDRA_LIVE_URL` must use `https`. The only exception: `http` is permitted
  if the hostname is `localhost` or ends with `.localhost` (browsers treat these as secure contexts, so
  `Secure` and `__Host-` cookies work). The two URLs must be different and must have the same
  registrable domain. The `SameSite=Strict` live cookie needs the same site (section 9.2).
  For development on the host (section 11.7), use `http://hydra.localhost:5173` (the Vite dev server)
  and `http://live.hydra.localhost:8080` (the gateway). Ports do not change the site.
  `localhost` and `live.localhost` are not the same site.
- `HYDRA_SECRET_KEY` must decode to 32 bytes or more.
- The first port of `HYDRA_MEDIA_PORT_RANGE` must be `30128` or more. The lower node ports are for
  the fixed node ports of other Services (section 11.6).
- The size of `HYDRA_MEDIA_PORT_RANGE` must be equal to or larger than `HYDRA_MAX_RUNNING`. The capacity
  check of Start counts the sessions that hold a media port (section 7.9), so a start that passes the
  check always finds a free port.
- `HYDRA_SESSION_TRANSPORT=port-forward` is permitted only if both URLs use `localhost` hostnames.
- Each entry of `HYDRA_VAULT_HTTP_HOSTS` must be a valid lowercase hostname, without a scheme, a port, or
  a path.

`HYDRA_MEDIA_PORT_RANGE` must be inside the k3s `service-node-port-range` (section 11.6). At start,
before the reconciler starts, the gateway checks the first and the last port of the range. For each
port, it deletes a leftover Service `hydra-port-check-<port>` in `HYDRA_SESSION_NAMESPACE`, creates
that NodePort Service (no selector, label `app.kubernetes.io/managed-by: hydra`), and deletes it
at once. A dry-run request (`dryRun=All`) cannot do this check, because the API server does not check
the node port range for a dry run.
- If the API server answers that a port is not in the valid range, the gateway stops with a message
  that names `HYDRA_MEDIA_PORT_RANGE`.
- Other answers (for example, a port in use) pass the check.
- If the API server does not answer, the gateway logs a warning and the check passes. `/readyz`
  shows the problem (section 14).

---

## 5. State and persistence

### 5.1 Gateway state

The gateway writes all its persistent state in `HYDRA_DATA_DIR`, and nowhere else:

```
$HYDRA_DATA_DIR/            mode 0700
├─ hydra.db                 mode 0600, SQLite in WAL mode
├─ hydra.db-wal
├─ hydra.db-shm
└─ backups/                 hydra-<timestamp>.db, the 10 newest files are kept
```

- The gateway makes a backup (SQLite online backup API) before it runs migrations. `hydra db backup`
  makes a backup on request. These backups are on the same volume as the database. They protect against
  a failed migration, not against the loss of the volume (section 11.5).
- Short-lived data is in memory only: live tickets (60 s), rate-limit and login throttle counters, the
  MCP stream registry, the list of open WebSockets, and the agent activity summary (section 8.5). A
  gateway restart removes this data. The dashboard then requests a new ticket if one was in use, and MCP
  clients and Neko clients connect again.
- `HYDRA_SECRET_KEY` is configuration, not state. It never goes in `HYDRA_DATA_DIR`.

### 5.2 Host state

`scripts/setup-k3s.sh` sets `HYDRA_STATE_DIR` (default `/var/lib/hydra`). The operator mounts the
persistent volume at this path. k3s puts all Hydra volumes there with fixed folder names:

```
$HYDRA_STATE_DIR/
└─ volumes/
   ├─ hydra/gateway-data/              → HYDRA_DATA_DIR of the gateway pod
   ├─ hydra-sessions/profile-<sid>/    → Chromium profile of one session
   └─ kube-system/traefik/             → acme.json (TLS certificates)
```

- Two StorageClasses use the `rancher.io/local-path` provisioner with
  `pathPattern: "{{ .PVC.Namespace }}/{{ .PVC.Name }}/"`:
  - The trailing slash is necessary. The provisioner rejects a rendered path that does not start with
    `<namespace>/<pvc name>/`. The folders on disk are the folders of the tree above.
  - `hydra-retain` (`reclaimPolicy: Retain`) for `gateway-data` and Traefik.
  - `hydra-profile` (`reclaimPolicy: Delete`) for session profiles. When a session is deleted, its
    profile folder is deleted.
- The folder names do not change. Thus a redeploy, or a new k3s installation on the same volume,
  finds the same data. Spike S4 verifies this behavior.
- `local-path` does not enforce PVC sizes. The profile PVC requests 5 Gi only as information. The
  Chromium policy `DiskCacheSize` (section 7.5) limits the largest part of a profile. The gateway
  database is on the same volume, so the operator watches the free space (section 11.5).

---

## 6. Security, users, access, and keys

### 6.1 Root key and subkeys

- HKDF-SHA256 derives one subkey for each purpose from `HYDRA_SECRET_KEY`. Each subkey has its own
  `info` label:

  | Label | Use |
  |---|---|
  | `hydra/password-pepper/v1` | Argon2id `secret` parameter |
  | `hydra/login-session/v1` | HMAC of login session cookie values |
  | `hydra/live-grant/v1` | HMAC of live grant cookie values and live tickets |
  | `hydra/agent-token/v1` | HMAC of agent tokens |
  | `hydra/neko/v1` | Derivation of Neko passwords |
  | `hydra/vault/v1` | AES-256-GCM key of the vault values (section 6.9) |

- `hydra keygen` prints a new random 32-byte key in base64.
- **Caution:** if the operator loses `HYDRA_SECRET_KEY`, all passwords, tokens, and login sessions
  become invalid, and all vaults are lost. The operator must keep a copy of the key in a secret store.
- Known limit of v1: there is no key rotation command.

### 6.2 Database rules

- Drizzle with parameterized queries only. No SQL from string concatenation.
- `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`.
- The database stores no secret in plain text. It stores HMACs of tokens and cookie values,
  Argon2id hashes of passwords, and AES-256-GCM ciphertext of vault values (section 6.9).

### 6.3 Users

- Global roles: `admin`, `member`.
- **Password hash:** Argon2id (`@node-rs/argon2`), m = 64 MiB, t = 3, p = 1, random 16-byte salt for
  each password, pepper as the Argon2 `secret` parameter. The PHC string keeps the parameters. If the
  parameters in the code change, the gateway hashes the password again after the next good login. The
  gateway runs a maximum of 4 Argon2 operations at the same time (each uses 64 MiB). Other requests
  wait in a queue.
- **Password rules (NIST SP 800-63B):** 12 to 128 characters, no composition rules, a check against a
  bundled list of common passwords, and the password must not be equal to the email.
- **First admin:** `kubectl exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <e>`.
  If stdin is a terminal, the command asks for the password and does not show it. If stdin is not a
  terminal, the command reads the password from the first line of stdin. Scripts and the E2E tests use
  this form, for example `printf '%s\n' "$PASSWORD" | kubectl exec -i -n hydra deploy/hydra-gateway --
  hydra user create --admin --email <e>`.
- **Admin actions (UI and API):**
  - Create a user. The gateway generates a one-time password and shows it one time. The user must
    change it at the first login (`must_change_password`). While `must_change_password` is true, the
    API accepts only `GET /api/auth/me`, `POST /api/auth/password`, and `POST /api/auth/logout` for
    that login session. All other routes return 403 `password_change_required`.
  - Reset a password (same one-time process). This ends all login sessions of the user and the lock of
    section 6.4.
  - Unlock an account (section 6.4).
  - Change a role, change the display name.
  - Disable a user. This ends all login sessions of the user, revokes all agent tokens that the user
    created, and starts the rights check (section 6.5). Enable does not restore the tokens.

### 6.4 Login sessions

- Cookie `__Host-hydra_session`: 32 random bytes (base64url), `HttpOnly`, `Secure`, `SameSite=Lax`,
  `Path=/`. The DB stores only the HMAC (subkey `login-session`).
- Idle timeout 12 h, maximum life 7 days. A new value at each login. Logout deletes the row.
- A password change ends all other login sessions of the user.
- **CSRF:** each request that is not `GET`/`HEAD` must have an `Origin` header equal to
  `HYDRA_PUBLIC_URL`, `Content-Type: application/json`, and a JSON body. The dashboard sends `{}` when a
  request has no data. If one of these is missing, the response is 403 `csrf_failed`.
- **Brute-force protection:**
  - 10 login attempts per minute for each IP (in memory). Over the limit: 429 `rate_limited`.
  - Login throttle for each pair of email and IP (in memory, also for an email that does not exist):
    after 5 failures, the next attempt must wait 15 min. Each further failure doubles the wait, up to
    24 h. A good login resets the pair. During a wait: 429 `rate_limited` with `Retry-After`. Thus an
    attacker cannot lock out a user who logs in from a different IP.
  - After 100 failures in a row on one account, from all IPs, the account locks (the limit of NIST
    SP 800-63B). An admin unlock or a password reset ends the lock. Before the lock, a good login resets
    the count.
  - A wrong password, an email that does not exist, and a locked account give the same response: 401
    `invalid_credentials`, "Invalid email or password". The gateway runs the Argon2 verify in all three
    cases (against a fixed dummy hash if the email does not exist), so the response time is the same.
  - The audit event `auth.login_failed` records the reason. The admin sees a locked account in
    **Admin → Users**.

### 6.5 Session access

Session roles: `owner` (the creator, stored on the session row), `operator`, `viewer`
(table `session_members`). Admins have all rights on all sessions.

| Action (`access/` constant) | Viewer | Operator | Owner | Admin |
|---|---|---|---|---|
| `session.read` (see it and its metadata) | ✓ | ✓ | ✓ | ✓ |
| `vault.read` (credential metadata: name, website, username, which values are set) | ✓ | ✓ | ✓ | ✓ |
| `live.watch` | ✓ | ✓ | ✓ | ✓ |
| `live.control` | – | ✓ | ✓ | ✓ |
| `session.lifecycle` (start, stop, restart) | – | ✓ | ✓ | ✓ |
| `session.logs` | – | ✓ | ✓ | ✓ |
| `token.create`, `token.revoke_own` | – | ✓ | ✓ | ✓ |
| `audit.read` | – | ✓ | ✓ | ✓ |
| `token.revoke_any` | – | – | ✓ | ✓ |
| `session.update` (name, allowlist, locale, screen) | – | – | ✓ | ✓ |
| `session.share` | – | – | ✓ | ✓ |
| `session.delete` | – | – | ✓ | ✓ |
| `vault.manage` (create, update, delete credentials) | – | – | ✓ | ✓ |
| `vault.reveal` (see a password or a current TOTP code) | – | – | ✓ | ✓ |

- `authorize(user, session, action)` is the only place that applies this table. All routes call it.
  A table-driven unit test checks each cell.
- `authorize()` gives no rights to a disabled user.
- If a user has no `session.read` right, the API returns **404** `not_found`, never 403. Thus users
  cannot find which session IDs exist.
- When an admin does an action on a session that the admin does not own, the audit log records it.
- The owner cannot be removed or changed in v1.
- **Rights change.** A member role change, a member removal, a global role change, and a user disable
  publish the event `rights.changed` with the user ID (section 3.1). Then:
  - The live proxy ends each live grant of the user that no longer passes the rules of section 9.2,
    for example because the Neko profile changed. The dashboard then requests a new ticket.
  - The MCP proxy closes the MCP streams of each token whose creator no longer has `token.create`
    (section 8.3). Section 6.6 condition 3 then rejects the next request of that token.
  - The gateway closes the open `GET /api/events` streams of the user. The client connects again and
    fetches the session data again (section 10.3), so the sidebar shows the new rights.
  - The gateway closes each open `GET /api/sessions/<sid>/events` stream of the user for which the
    user no longer has `audit.read`.

### 6.6 Agent tokens

- **Format:** `hyd_` + base62 of 32 random bytes. The UI shows the full token one time. After that, the
  UI shows only `hyd_` + the first 8 characters + `…` (the `prefix` column).
- **Storage:** the DB stores `token_hmac` = HMAC-SHA256(subkey `agent-token`, token), unique index.
- **Expiry is necessary:** 1, 7, 30, 90, or 365 days. Default 30 days.
- **Validity.** A token is valid only if all these conditions are true:
  1. `revoked_at` is null and `expires_at` is in the future.
  2. The session exists and is not deleted.
  3. The creator still has `token.create` on the session. A disabled user has no rights (section 6.5).
- The token is accepted only in the `Authorization: Bearer` header. Never in the URL.
- The gateway updates `last_used_at` and `last_used_ip` at most one time per minute for each token.
- Rate limit: 20 requests per second for each token (in memory).

### 6.7 Neko credentials

- `neko_password(sid, profile) = base64url(HMAC-SHA256(subkey neko, sid + "|" + profile))`, with
  `profile` in `admin`, `user`.
- The DB does not store Neko passwords. The orchestrator writes them to the Secret `neko-<sid>`. k3s
  encrypts Secrets at rest (`secrets-encryption`).
- The passwords do not change during the life of the session. The browser never gets them (section
  9.2), and only the gateway can connect to the pod (section 11.4). Thus a rotation gives no protection.
- Mapping: owner, operator, and admin → Neko `admin` profile. Viewer → Neko `user` profile with
  `can_host: false` (spike S3).
- If spike S3 fails, the `object` provider has two fixed users, `hydra-admin` and `hydra-viewer`. Then
  the WebSocket rewrite (section 9.2 step 4) sets `username` to the fixed user of the Neko profile, not
  to the display name. All people with the same Neko profile then have the same name in the Neko member
  list. This is a known limit of the fallback.

### 6.8 HTTP security headers

- Dashboard origin: `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline';
  frame-src <HYDRA_LIVE_URL>; img-src 'self' data:; frame-ancestors 'none'; object-src 'none';
  base-uri 'none'`. Radix Dialog adds a `<style>` element for its scroll lock, so `style-src` needs
  `'unsafe-inline'`.
- Live origin: `Content-Security-Policy: frame-ancestors <HYDRA_PUBLIC_URL>`. No other CSP rules,
  because the Neko client needs its own scripts and WebSocket connections. The live proxy removes the
  headers that the pod sends, and sets these headers (section 9.3).
- Both origins: `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.

### 6.9 Secrets vault

Each session has one vault. The vault keeps credentials that an agent can fill into the pages of that
session (section 8.8). Only the gateway can decrypt the values.

#### 6.9.1 Credentials

| Field | Rules |
|---|---|
| `name` | Necessary. 1 to 64 characters. For example "Google - Catalina". |
| `website` | Necessary. A URL. If the input has no scheme, the gateway adds `https://`. The gateway stores only the origin, for example `https://www.google.com`. The scheme must be `https`. `http` is permitted only if the hostname is in `HYDRA_VAULT_HTTP_HOSTS` (section 4). A URL with a user name or a password is rejected. |
| `username` | Optional. 1 to 256 characters. The dashboard shows it with the label "Login". |
| `password` | Optional. 1 to 1,024 characters. |
| `totp` | Optional. The TOTP secret and its parameters (below). |

- A credential must have one or more of `username`, `password`, and `totp`.
- **TOTP input.** The user gives one of these:
  - An `otpauth://totp/…` URI. The gateway reads `secret`, `algorithm`, `digits`, and `period` from it.
    Other parameters (`issuer`, the label) are ignored.
  - A base32 secret, plus optional `algorithm`, `digits`, and `period`. The gateway removes spaces and
    `=` and changes the secret to uppercase.
  - Defaults: `SHA1`, 6 digits, 30 s. Permitted values: `SHA1`, `SHA256`, `SHA512`; 6 or 8 digits;
    30 or 60 s. The secret must have 16 to 128 base32 characters (80 bits or more).
  - An `otpauth://hotp/…` URI, another URI kind, or a value that is not valid gives 400
    `validation_failed`.
- A session has a maximum of 50 credentials. Over the limit: 409 `vault_limit_reached`.
- The Delete action of a session deletes the credentials of the session in the same DB transaction
  (section 7.9).

#### 6.9.2 Site match

A fill works only on the site of the credential. The gateway calculates the match from the hostname
of `website` at each use. It does not store the match, so a change of the public suffix list in the
code also applies to existing credentials.

- If the hostname is an IP address, or has no registrable domain (it is a public suffix or one label):
  `matchDomain` = the hostname, `matchSubdomains = false`.
- Else: `matchDomain` = the registrable domain, from `config/public-suffix.ts` (ICANN and PRIVATE
  sections), `matchSubdomains = true`.
- A URL matches if its scheme is equal to the scheme of `website`, and its hostname is equal to
  `matchDomain`, or `matchSubdomains` is true and the hostname ends with `.` + `matchDomain`. The port
  is not checked.
- Examples: `https://www.google.com` matches `https://accounts.google.com`. It does not match
  `http://accounts.google.com` or `https://google.com.evil.example`. `https://alice.github.io`
  matches only `alice.github.io` and its subdomains, because `github.io` is in the PRIVATE section.
- `vaultSiteMatches(url, match)` in `@hydra/shared` is the only implementation. The gateway and the
  sidecar use it.
- The gateway checks the `http` rule of section 6.9.1 again at each fill. If the scheme of `website`
  is `http` and its hostname is no longer in `HYDRA_VAULT_HTTP_HOSTS`, the fill fails (section 8.8.2).
  The credential stays in the vault.

#### 6.9.3 Encryption

- AES-256-GCM with the subkey `vault` (section 6.1). One ciphertext for each value: version byte
  `0x01`, 12-byte random nonce, ciphertext, 16-byte tag. Each write uses a new random nonce.
- Additional authenticated data: `<sid>|<credential id>|<field>`, with `field` in `username`, `password`,
  `totp`. Thus a person who can write to the DB cannot move a ciphertext to a different credential,
  field, or session.
- The plain text of `totp` is the JSON `{ secret, algorithm, digits, period }`.
- If a decryption fails (for example, a different `HYDRA_SECRET_KEY`), the request gets 500 `internal`.
  The gateway logs the credential ID, never a value.
- Decrypted values stay in memory only for one request, and in the redaction sets of section 8.9.
  They never go to logs, audit events, or error messages.
- DB backups (section 5.1) contain only the ciphertext.
- Known limit of v1: no rotation of the vault key (section 6.1).

#### 6.9.4 TOTP

- The gateway calculates the codes with RFC 6238 and `node:crypto`: counter = floor(Unix time in
  seconds / period), and the dynamic truncation of RFC 4226. No dependency.
- The codes depend on the clock of the server. The server must synchronize its clock (section 11.5).
- **Fill:** if the current code is valid for less than 5 s more, the gateway waits until the next
  period starts, and then uses the new code.
- **Reveal:** the gateway returns the current code and the time at which it stops being valid.
- The TOTP secret never leaves the gateway. No API returns it, and the sidecar gets only codes. A user
  can replace it or remove it.

#### 6.9.5 Rights

- `vault.read`: the credential list. The username is metadata, so each user with `vault.read` sees it.
  The password and the TOTP secret are never in the list.
- `vault.manage`: create, update, and delete credentials.
- `vault.reveal`: get one password or one current TOTP code. Each reveal creates the audit event
  `vault.revealed`. If an admin reveals a value of a session that the admin does not own, the gateway
  also records `admin.session_access` (section 6.5).
- **Fill:** each valid agent token of the session (section 6.6) can fill. The gateway does not check
  a vault right of the token creator. Thus an operator can get vault values through an agent (section
  8.7).

---

## 7. Sessions and orchestration

### 7.1 Session ID and names

- `sid`: 12 random lowercase base32 characters (alphabet `a-z2-7`). It is valid in Kubernetes names.
- The user also gives a display name (1 to 64 characters).
- All Kubernetes objects have these labels: `app.kubernetes.io/managed-by: hydra`,
  `hydra/session-id: <sid>`.

### 7.2 Session settings

| Setting | Values | Default | Change needs restart |
|---|---|---|---|
| `name` | 1–64 characters | — | no |
| `allowlist` | 1–100 host patterns, or `["*"]` | — (necessary) | yes |
| `timezone` | IANA name | `HYDRA_DEFAULT_TIMEZONE` | yes |
| `language` | BCP 47 tag | `HYDRA_DEFAULT_LANGUAGE` | yes |
| `screen` | `1280x720`, `1600x900`, `1920x1080` (all at 25 fps) | `1920x1080` | yes |

- Allowlist entries use the Chrome URL filter format for hosts: `example.com` permits the host and all
  its subdomains, and `.example.com` permits only the exact host. v1 accepts no schemes, ports, or paths.
- A `["*"]` allowlist permits all domains. The UI then shows a warning on the session.
- Settings that need a restart take effect at the next Start or Restart. These actions copy the
  settings to `applied_settings`. The reconciler builds the Kubernetes objects only from
  `applied_settings` and `media_port` (section 7.9). While the session has a pod and the settings
  differ from `applied_settings`, the API returns `restartRequired: true`, and the UI shows
  "Restart required".

### 7.3 Kubernetes resources for each session (namespace `hydra-sessions`)

| Resource | Name | Contents |
|---|---|---|
| PVC | `profile-<sid>` | StorageClass `hydra-profile`, 5 Gi (information only), `ReadWriteOnce` |
| Secret | `neko-<sid>` | `admin-password`, `user-password` (section 6.7) |
| ConfigMap | `chromium-<sid>` | `policies.json` (section 7.5), `hydra-flags` (section 7.6) |
| Service | `session-<sid>` | Headless. Ports 8080 (Neko), 8931 (MCP). |
| Service | `media-<sid>` | `NodePort`, `externalTrafficPolicy: Local`. One UDP and one TCP port: `port`, `targetPort`, and `nodePort` are all the media port. Exists only while the session holds a media port (section 7.8). |
| StatefulSet | `session-<sid>` | `replicas: 1` if `desired_state = running`, else 0. Uses `claimName: profile-<sid>` (no `volumeClaimTemplates`, so the PVC name is fixed). `podManagementPolicy: Parallel`, so a template change also replaces a pod that is not Ready. Pod template annotation `hydra/started-at` (section 7.9). |

The pod name is `session-<sid>-0`, and its DNS name is
`session-<sid>-0.session-<sid>.hydra-sessions.svc.cluster.local`.

`podEndpoint(sid, port)` in `orchestrator/` gives the address of one port of the pod. The MCP proxy and
the live proxy use it.
- `HYDRA_SESSION_TRANSPORT=cluster-dns`: `http://session-<sid>-0.session-<sid>.hydra-sessions.svc.cluster.local:<port>`.
- `HYDRA_SESSION_TRANSPORT=port-forward`: a local port of a Kubernetes port-forward to the pod. The
  gateway opens one port-forward for each pod and closes it when the pod goes away (section 11.7).

### 7.4 Pod specification

- `automountServiceAccountToken: false`, `enableServiceLinks: false`. No `hostPort`, `hostNetwork`, or
  `hostPath`: Pod Security `baseline` rejects them (section 11.2). The media port goes through the
  `media-<sid>` NodePort Service.
- `securityContext.seccompProfile`: `RuntimeDefault`, or the custom profile from spike S1 as
  `type: Localhost`, `localhostProfile: hydra/chromium.json`. The profile file must exist on the node
  (section 11.6 and 11.7).
- **Init container** (`HYDRA_SESSION_IMAGE`, non-root UID 1000): removes `Singleton*` files from the profile folder.
- **Container `neko`** (`HYDRA_SESSION_IMAGE`):
  - `allowPrivilegeEscalation: false`. Drop all capabilities, and add only the set that spike S1 finds
    necessary for supervisord and Xorg.
  - Ports: 8080/TCP; media port as `containerPort` for both UDP and TCP.
  - Environment:

    | Variable | Value |
    |---|---|
    | `NEKO_DESKTOP_SCREEN` | `<screen>@25` |
    | `NEKO_WEBRTC_UDPMUX` | `<media port>` |
    | `NEKO_WEBRTC_TCPMUX` | `<media port>` |
    | `NEKO_WEBRTC_NAT1TO1` | `HYDRA_PUBLIC_IP` |
    | `NEKO_WEBRTC_ICELITE` | `true` |
    | `NEKO_SERVER_PROXY` | `true` |
    | `NEKO_MEMBER_PROVIDER` | `multiuser` |
    | `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD` | from Secret `neko-<sid>` |
    | `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` | from Secret `neko-<sid>` |
    | viewer profile with `can_host: false` | variable name from spike S3 |
    | `NEKO_SESSION_IMPLICIT_HOSTING` | `true` |
    | `NEKO_FILETRANSFER_ENABLED` | `false` |
    | `TZ` | `<timezone>` |
    | `LANG`, `LANGUAGE` | from `<language>` |

  - Volumes:
    - PVC `profile-<sid>` → `/home/neko/.config/chromium` (owned by UID/GID 1000).
    - ConfigMap key `policies.json` → `/etc/chromium/policies/managed/policies.json`. This file
      replaces the default Neko policy file.
    - ConfigMap key `hydra-flags` → `/etc/chromium.d/hydra`.
    - `emptyDir` with `medium: Memory`, `sizeLimit: 2Gi` → `/dev/shm`.
  - Readiness probe: HTTP `GET /health` on port 8080 (verify the path in the pinned Neko version).
- **Container `mcp`** (`HYDRA_MCP_IMAGE`):
  - Non-root, `readOnlyRootFilesystem: true`, drop all capabilities, `emptyDir` for `/tmp`.
  - Command: `hydra-mcp --cdp-endpoint http://127.0.0.1:9222 --host 0.0.0.0 --port 8931`. `hydra-mcp` is
    the program of `@hydra/mcp-sidecar` (section 8.8). It embeds Playwright MCP and serves the same MCP
    endpoint `/mcp`.
  - The sidecar accepts only requests with `Host: localhost:8931`, as the default host check of
    Playwright MCP does. The gateway sets this header (section 8.2).
  - Do not use `--allowed-origins` or `--blocked-origins`. They are not a security boundary, they do not
    affect redirects, and they also block the requests of the human. The Chromium policy is the control.
  - Readiness probe: TCP on port 8931.
- **Resources:** `neko` requests 0.5 CPU / 1.5 Gi, limits 3 CPU / 4 Gi. `mcp` requests 0.1 CPU /
  256 Mi, limits 0.5 CPU / 512 Mi. The load check (section 15.5) can change these values.

### 7.5 Chromium policies

The orchestrator generates the full `policies.json` from a base template in the server code and the
session settings. Start from the Neko default policies and apply these changes:

| Policy | Value | Reason |
|---|---|---|
| `DeveloperToolsAvailability` | `1` | Neko default `2` also blocks CDP |
| `URLBlocklist` | `["*"]` | Domain allowlist |
| `URLAllowlist` | session allowlist entries, plus `about:blank` | Domain allowlist |
| `PasswordManagerEnabled` | `false` | The profile keeps no saved passwords. The vault (section 6.9) is in the gateway, not in the profile. |
| `DefaultCookiesSetting` | `1` | Logins stay after a restart |
| `RestoreOnStartup` | `1` | Chromium tabs stay after a restart |
| `DiskCacheSize` | `536870912` (512 MiB) | `local-path` does not limit the profile size (section 5.2) |
| `DownloadRestrictions` | `3` (Neko default, kept) | No downloads in v1 |
| `AllowFileSelectionDialogs` | `false` (Neko default, kept) | No uploads in v1 |
| `ExtensionInstallBlocklist` | `["*"]` (Neko default, kept) | No other extensions |
| `ExtensionInstallForcelist`, `ExtensionInstallAllowlist` | Neko defaults, kept | The only extensions: uBlock Origin Lite and SponsorBlock |

If the allowlist is `["*"]`, the orchestrator omits `URLBlocklist ["*"]` and `URLAllowlist`, and keeps
only the Neko default blocklist. Spike S5 checks the effect of the policies on subresources, `fetch()`
requests, and redirects (section 8.7).

### 7.6 Chromium flags

The file `/etc/chromium.d/hydra` adds flags through the Debian wrapper:

```sh
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=<language> --accept-lang=<language>,<base language>"
```

Do not use the `CHROMIUM_FLAGS` environment variable directly. The Debian wrapper resets it.

### 7.7 Images

Section 11.1 gives the build files and the base images.

- **`hydra-session`**: the Neko Chromium image plus a normal font set (`fonts-noto`, `fonts-noto-cjk`,
  `fonts-noto-color-emoji`, `fonts-liberation`, `fonts-dejavu`). If spike S1 succeeds, the image also
  replaces the supervisord Chromium file so that Chromium starts without `--no-sandbox`.
- **`hydra-mcp`**: the `@hydra/mcp-sidecar` program with Playwright MCP, installed from the lockfile
  (section 3.4.4). No browser download: the sidecar connects over CDP only.
- Do not use the `neko/google-chrome` image. It uses the default user data folder, and Google Chrome
  136+ refuses `--remote-debugging-port` with the default folder.

### 7.8 Media ports

- A session holds a media port from Start until it reaches `stopped` or `error`. Start assigns the
  lowest free port in `HYDRA_MEDIA_PORT_RANGE` (section 7.9). The reconciler puts the port into the pod
  template and creates the `media-<sid>` Service. Restart keeps the port.
- When the session reaches `stopped` or `error`, the reconciler deletes the `media-<sid>` Service first,
  and then sets `media_port = NULL`. Thus a new session cannot get a node port that a Service still uses.
- A partial unique index on `sessions.media_port` (`WHERE media_port IS NOT NULL`) prevents duplicates.
- The capacity check of Start counts the sessions that hold a media port. The pool is equal to or larger
  than `HYDRA_MAX_RUNNING` (section 4), so a start that passes the check always finds a free port.

### 7.9 Lifecycle and reconciler

Session states: `stopped`, `starting`, `running`, `stopping`, `error`, `deleting`, `deleted`.
The DB keeps `desired_state` (`running`, `stopped`, `deleted`). Kubernetes keeps the actual state.

| Action | Right | Effect |
|---|---|---|
| Create | any user | Validate the settings, assign `sid`, and insert the row: `state = stopped`, `desired_state = stopped`, `applied_settings` = the settings. If `start` is true (default), continue as Start. The reconciler creates the Kubernetes objects. |
| Start | `session.lifecycle` | If `state` is `starting` or `running`: no change. If `state` is not `stopped` or `error`: 409 `invalid_state`. Else, in one DB transaction: if the session holds no media port and the number of sessions that hold one is `HYDRA_MAX_RUNNING` or more, 409 `capacity_reached`. Else assign a media port if the session holds none (section 7.8), copy the settings to `applied_settings`, and set `started_at = now`, `ready_at = NULL`, `error_reason = NULL`, and `desired_state = running`. |
| Stop | `session.lifecycle` | If `state` is `deleting` or `deleted`: 409 `invalid_state`. Else set `desired_state = stopped`. |
| Restart | `session.lifecycle` | If `state` is not `starting` or `running`: 409 `invalid_state` (use Start). Else copy the settings to `applied_settings`, and set `started_at = now` and `ready_at = NULL`. The new `hydra/started-at` annotation changes the pod template, so the StatefulSet replaces the pod. The media port does not change. |
| Delete | `session.delete` | The request body must contain the exact session name, else 400 `confirm_mismatch`. In one DB transaction: set `desired_state = deleted`, revoke all tokens of the session, and delete its vault credentials (section 6.9). |

The reconciler runs at gateway start, after each action above, on each Kubernetes watch event in
`hydra-sessions`, and every 30 s. For each session, one pass has two steps.

**Step 1: objects.** Build the objects of section 7.3 from the DB row (`applied_settings`, `media_port`,
`started_at`, `desired_state`), and apply them with server-side apply (field manager `hydra`). Delete
the objects that must not exist: `media-<sid>` while `media_port` is null, and all objects when
`desired_state = deleted`. Thus the reconciler repairs objects that are missing or changed, also after a
gateway failure in the middle of an action.

**Step 2: state.** Apply the first rule that matches:

1. `desired_state = deleted` → `state = deleting`. When all objects are gone → `state = deleted`,
   `deleted_at = now`, `media_port = NULL`.
2. `desired_state = running` and the pod is Ready → `state = running`. If `ready_at` is null, set
   `ready_at = now`.
3. `desired_state = running`, and a container waits with the reason `CrashLoopBackOff`, `ErrImagePull`,
   `ImagePullBackOff`, `CreateContainerConfigError`, or `InvalidImageName` → error (below).
4. `desired_state = running`, `ready_at` is null, and `started_at` is more than 120 s ago → error.
5. `desired_state = running` → `state = starting`. This rule also applies to a pod that fails after it
   was Ready. Rule 4 does not stop such a session, because `ready_at` is set.
6. `desired_state = stopped`, a pod exists, and `state` is not `error` → `state = stopping`. A session
   in `error` stays in `error`, and `error_reason` does not change.
7. `desired_state = stopped` and no pod exists → release the media port (section 7.8). If `state` is not
   `error`, set `state = stopped`.

**Error:** set `state = error`, `error_reason` = the Kubernetes reason and message, and
`desired_state = stopped`. The next pass scales the StatefulSet to 0, and rule 7 releases the media port
when the pod is gone. The user can click **Retry start** (Start).

**Effects of a state change:** each state change creates an audit event `session.state`, which goes on
the event bus. When the new state is not `starting` or `running`, the MCP proxy closes the MCP streams
of the session, and the live proxy ends its live grants and closes their WebSockets. Thus Stop, Delete,
and errors use the same code, also when a session goes to `stopped` without `stopping`.

- If a Kubernetes call fails, the reconciler tries again with exponential backoff (maximum 5 min) and
  logs the error.
- **Orphans:** objects with the label `app.kubernetes.io/managed-by: hydra` in `hydra-sessions` that have
  no session row. An orphan can be the result of a restore of an older DB backup. Thus the reconciler
  never deletes a PVC or a Secret of an orphan. It scales an orphan StatefulSet to 0, deletes an orphan
  `media-<sid>` Service (it holds a node port), and logs a warning with the `sid`. The operator removes
  the other orphan objects by hand with `kubectl delete`.

### 7.10 Known risk: Chromium without sandbox

Neko starts Chromium with `--no-sandbox`. A renderer exploit then runs code in the `neko` container.

- **The attacker gets:** the profile of that session (cookies, logins), its Neko passwords, CDP and MCP
  of that session through `localhost`, and internet access. The attacker also gets each vault value that
  the gateway sends for a fill while the attacker controls the pod (section 8.8), and the values that
  are already in the pages. The attacker does not get the other vault values or the TOTP secrets.
- **The attacker can also attack the people who watch the session.** The attacker can replace the Neko
  server in the pod and send JavaScript to the live view. All sessions share the live origin (section
  9.1). If the same person watches a second session at the same time, this code can use the live grant
  of that person and control the second session. A live grant ends when its view closes (section 9.2),
  so this attack needs two open live views. One live origin per session removes this risk (section 17).
- **Without a second exploit, the attacker does not get:** other sessions (except through a person who
  watches two sessions, see above), the gateway database, `HYDRA_SECRET_KEY`, the Kubernetes API, or the
  EC2 credentials.
- A container escape gives the full node, which includes all sessions.

Controls: spike S1 (sandbox on), pod hardening (section 7.4), egress NetworkPolicy (section 11.4),
automatic host security updates (section 11.6). Operator rules: put only the accounts that a task needs
into a session, and do not keep two live views open without a need.

---

## 8. MCP path and audit log

### 8.1 Endpoint

`<HYDRA_PUBLIC_URL>/s/<sid>/mcp` with the MCP Streamable HTTP transport (`POST`, `GET`, `DELETE`).
v1 does not support the old SSE transport (`/sse`).

### 8.2 Request flow

1. **Principal.** `resolveAgentPrincipal(req)` returns `{ tokenId, userId, sessionId }` or fails.
   v1 has one implementation: the bearer token (section 6.6). An OAuth 2.1 implementation can replace
   it later without changes to the proxy. If the token is missing, not valid, or for a different session:
   401 with `WWW-Authenticate: Bearer realm="hydra"`.
2. **Session state.** If `state` is not `running`: 503 with the JSON-RPC error body
   `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session is not running. Start it in the dashboard."},"id":null}`.
3. **Limits.** The token rate limit of section 6.6 (429 `rate_limited`). Maximum body 1 MiB (413).
4. **Inspect.** Parse the JSON-RPC body (single message or batch). If a `tools/call` names a tool in the
   deny list (section 8.7), answer with a JSON-RPC error and do not send the call to the pod. Handle
   the calls of `vault_list` and `vault_fill` (section 8.8). Create audit records (section 8.6).
5. **Proxy** with `undici` to `podEndpoint(sid, 8931)` + `/mcp` (section 7.3):
   - Remove `Authorization`, `Cookie`, and hop-by-hop headers.
   - Set `Host: localhost:8931`.
   - Send `Mcp-Session-Id`, `Accept`, `Content-Type`, and `MCP-Protocol-Version` without changes.
6. **Response.** The response can be `application/json` or `text/event-stream`. Send it to the client
   immediately, without a buffer, and without a timeout on open MCP streams. Exception: if the vault of
   the session is not empty, the gateway first removes the vault values (section 8.9). Then it sends a
   JSON body when the body is complete, and each SSE event when the event is complete. Then read a copy
   of the response to complete the audit records.
7. **Pod restart.** The sidecar keeps MCP sessions in memory. After a restart, or after a new CDP
   connection (section 8.8.3), it returns 404 for old `Mcp-Session-Id` values. The gateway sends this 404 without changes, and the client must initialize
   again (MCP specification).

### 8.3 Stream registry and connection check

The gateway keeps the open MCP requests and MCP streams in a registry, by token, by creator, and by
session. It closes them at once in these cases:

- The token is revoked (event `token.revoked`).
- The session state changes to a state other than `starting` or `running` (section 7.9).
- The creator of the token loses `token.create` (event `rights.changed`, section 6.5).

Every 60 s, the gateway also checks each open MCP stream against section 6.6, and closes the MCP streams
of tokens that are no longer valid, for example an expired token.

### 8.4 Several agents on one session

Playwright MCP accepts many clients. All clients use the same browser context and Chromium tabs, so agents can
interfere with each other. v1 permits this. If two or more MCP sessions had activity in the last 60 s,
the dashboard shows the warning "More than one agent is connected".

### 8.5 Agent activity summary

Viewers have no `audit.read`, but the dashboard shows agent activity to all users with `session.read`
(sections 9.4 and 10.2). Thus the gateway keeps an activity summary for each session in memory, from
the `mcp.*` events:

| Field | Meaning |
|---|---|
| `activeAgentCount` | Number of MCP sessions with activity in the last 60 s |
| `lastToolCall` | `{ tool, status, durationMs, startedAt }` of the newest `mcp.tool_call`, or null. No arguments. |

- The session resource (`GET /api/sessions` and `GET /api/sessions/:sid`) contains the field `agentActivity`
  with these values. The right is `session.read`.
- When the summary changes, the gateway sends the event `session.activity` on the SSE streams (section 10.3).
  A timer also sends it when `activeAgentCount` goes down, because an MCP session had no activity for 60 s.
- A gateway restart clears the summary. This is acceptable, because all values expire after 60 s.

### 8.6 Audit events for MCP

| Kind | Created when | `data` fields |
|---|---|---|
| `mcp.connect` | an `initialize` response succeeds | `mcpSessionId`, `clientInfo` (name, version), `ip` |
| `mcp.tool_call` | a `tools/call` request arrives (`status = pending`); updated when its response arrives | `mcpSessionId`, `rpcId`, `tool`, `arguments` (after redaction), `durationMs`, `error` (max 500 characters) |

- `status` for `mcp.tool_call`: `pending`, `ok`, or `error`. `error` means a JSON-RPC error or
  `result.isError = true`. If the MCP stream closes before the response arrives, the status becomes `error`
  with `error = "stream closed"`.
- The gateway writes the `pending` record before it sends the request to the pod.
- The gateway does not record tool results, `tools/list`, or `ping`.
- **Redaction:**
  - Text values of typing tools (`browser_type` `text`, `browser_fill_form` field values) become
    `"[redacted: N chars]"`.
  - Code of `browser_evaluate` is kept.
  - The arguments of `vault_list` and `vault_fill` are kept. They contain no vault value. The audit
    record of `vault_fill` contains the arguments of the agent, never the rewritten call of section 8.8.
  - Each string is cut to 2,000 characters, and the full `arguments` object to 8 KiB.
- The error text of a `mcp.tool_call` comes from the response after the redaction of section 8.9.
- The redaction rules are in one table in `audit/redaction.ts`, with a unit test for each tool.
  Read the current tool list of the pinned Playwright MCP version when you write this table.
- The gateway does not record disconnects. Many MCP clients never send `DELETE`, so the dashboard uses
  the activity of the last 60 s (section 8.5).
- v1 has no approval queue, no tool filter that users can configure, and no audit export. The inspection
  step (section 8.2 step 4) is the place to add them later.

### 8.7 Limits of the domain allowlist

- The allowlist (section 7.5) stops navigation to sites that are not in the list, also after a redirect.
  It is a guard against navigation mistakes, and against prompt injection that sends the agent to
  another site.
- It is not a control against data exfiltration. An agent can call `browser_evaluate` on an allowed page
  and send data with `fetch()` to any host, unless spike S5 shows that Chromium blocks these requests.
  Treat each agent token as full control of the browser and of its logins.
- The gateway rejects calls to the tools in the deny list (`mcp-proxy/tool-policy.ts`,
  section 8.2 step 4). The v1 list contains the tools that run code in the MCP server process instead
  of the page, for example `browser_run_code`. Read the tool list of the pinned Playwright MCP version
  when you write the list.
- **The vault protects against accidental exposure, not against a malicious agent.** After a fill, the
  value is in the page. An agent can read it with `browser_evaluate` and change its form (for example
  base64), so the redaction of section 8.9 does not find it. Each agent token of the session can fill
  (section 6.9.5). Thus an operator can get vault values through an agent, also if the dashboard does
  not reveal them to operators. Screenshots are not redacted, so a visible username or TOTP code can be in
  a screenshot.

### 8.8 Vault tools

#### 8.8.1 Tools for the agent

The sidecar lists two tools in each `tools/list` result. The gateway does not change `tools/list`
results, except for the redaction of section 8.9.

| Tool | Description (text of the tool definition) |
|---|---|
| `vault_list` | "List the credentials in the Hydra vault of this session: ID, name, website, and the values that are set. This tool never shows the values." No arguments. |
| `vault_fill` | "Fill one value of a vault credential into an editable element. You do not see the value. Get the credential ID from vault_list and the target from a page snapshot. The element must be on the website of the credential." |

Arguments of `vault_fill` (zod schema in `@hydra/shared`):

| Argument | Type | Meaning |
|---|---|---|
| `credentialId` | string, necessary | ID from `vault_list` |
| `field` | `username`, `password`, or `totp`, necessary | The value to fill. `totp` fills the current code. |
| `target` | string, necessary | A ref from the newest snapshot, in the Playwright MCP format (`e12`, `f1e5`). CSS selectors are not accepted. |
| `element` | string, optional | A description of the element, as in Playwright MCP |
| `submit` | boolean, optional | Press Enter after the fill |
| `slowly` | boolean, optional | Type one character at a time. For code fields with one box for each digit. |

#### 8.8.2 Gateway (section 8.2 step 4)

1. If a batch contains a `tools/call` of `vault_list` or `vault_fill`, the gateway rejects the batch
   with a JSON-RPC error: "Batch rejected, because it contains a vault tool call. Send vault tool calls
   one at a time."
2. **`vault_list`:** the gateway answers the call itself (200, `application/json`) and does not send
   it to the pod. The result text has one line for each credential:
   `- <id> · <name> · <website> · values: username, password, totp` (only the values that are set). If the
   vault is empty: "The vault of this session is empty. A person adds credentials in the Vault view of
   the dashboard." The gateway writes the `mcp.tool_call` record with `status = ok`.
3. **`vault_fill`:**
   1. Remove the key `hydraFill` from the arguments of the agent. Only the gateway sets it.
   2. Write the `pending` audit record with the arguments of the agent (section 8.6).
   3. Validate the arguments with the zod schema.
   4. Read the credential from the vault of the session of the token. Check the `http` rule (section
      6.9.2). Get the value: decrypt it, or calculate the TOTP code (section 6.9.4).
   5. Add `hydraFill: { value, scheme, matchDomain, matchSubdomains }` to the arguments (section
      6.9.2), and send the changed message to the pod with the same JSON-RPC ID. The body limit of
      section 8.2 step 3 applies to the body of the agent, not to the changed body.
   6. The gateway never logs the changed body.
   - If step 3 fails, if the credential does not exist, if the `http` rule fails, or if the value is
     not set, the gateway answers with a tool result with `isError: true`, sets the audit record to
     `error`, and does not send the call to the pod. The texts are: "The arguments of vault_fill are not
     valid: <zod message>", "Credential <id> does not exist in this session. Call vault_list.",
     "Credential <id> uses http, and http is not permitted for <hostname>.", and "Credential <id> has no
     <field>."

#### 8.8.3 Sidecar (`hydra-mcp`)

**Process:**

- At start, the sidecar connects to Chromium with `chromium.connectOverCDP(<cdp endpoint>)` of
  `playwright`, and uses the first browser context. The `neko` container starts at the same time, so
  Chromium can be not ready. If the connection fails, the sidecar tries again every 1 s. It opens port
  8931 only after it connects, so the TCP readiness probe (section 7.4) passes only when the sidecar can
  serve.
- If the CDP connection closes later (for example, Chromium restarts), the sidecar ends all MCP
  sessions, connects again with the same retry rule, and then accepts new MCP sessions. It does not
  stop the process. A stop would restart the container, and repeated restarts give `CrashLoopBackOff`,
  which sets the session to `error` (section 7.9 rule 3). While the sidecar is not connected, it
  answers each MCP request with 503.
- The sidecar serves Streamable HTTP on `/mcp` with the MCP TypeScript SDK. Each `initialize` creates
  one MCP session with its own `Mcp-Session-Id`. A request with an unknown `Mcp-Session-Id` gets 404,
  also after the sidecar ended the MCP sessions. MCP clients then initialize again (section 8.2 step 7).
  `DELETE` ends an MCP session. For each MCP session, the sidecar calls
  `createConnection(config, () => context)` of `@playwright/mcp`. All MCP sessions share the browser
  context and the Chromium tabs (section 8.4). The `config` gives the same tools and defaults as the
  `playwright-mcp` command line did (spike V2).
- For each MCP session, an interceptor is between the HTTP transport and the Playwright MCP server.
  The interceptor:
  - adds the definitions of `vault_list` and `vault_fill` to each `tools/list` result, and removes
    other tools with these names (a page can register WebMCP tools, and Playwright MCP lists them);
  - handles each `vault_fill` call itself, and never sends a `vault_fill` call to Playwright MCP;
  - answers a `vault_list` call with `isError: true`: "vault_list works only through the Hydra gateway.";
  - sends its own requests to Playwright MCP with JSON-RPC IDs that start with `hydra-internal-`, and
    does not send their responses to the client. It rejects client requests with such an ID.

**Fill steps:**

1. If the arguments have no valid `hydraFill`: `isError` "vault_fill works only through the Hydra
   gateway."
2. **Current tab.** Send `browser_tabs` with `action: "list"` to Playwright MCP, read the index of the
   current tab, and use `context.pages()[index]`. If the URL of that page is not equal to the URL in the
   list: `isError` "Cannot find the current tab. Take a new snapshot and try again." (spike V1).
3. **Element.** `target` must match `^(f\d+)?e\d+$`. Get an element handle for the locator
   `aria-ref=<target>` on that page (timeout 5 s). If there is no element: `isError` "Ref <target> is not
   in the current page snapshot. Take a new snapshot."
4. **Site check.** Get the frame of the element (`ownerFrame()`) and its URL (`frame.url()`). The
   browser gives this URL, so the JavaScript of the page cannot change it. The URL must match with
   `vaultSiteMatches` (section 6.9.2). `about:blank`, `about:srcdoc`, `data:`, and `blob:` URLs do not
   match. If it does not match: `isError` "The element is on <origin>. Credential <id> fills only on
   <matchDomain>[ and its subdomains]."
5. **Field check.** The element must be an `input` with type `""`, `text`, `email`, `password`,
   `search`, `tel`, `number`, or `url`, or a `textarea`. It must not be disabled or read-only. Else:
   `isError` "The element is not an editable text field."
6. **Fill** with the element handle: replace the value, or if `slowly` is true, focus the element and
   type one key at a time. If `submit` is true, press Enter. The handle belongs to one document. If the
   frame goes to a different document after step 4, the fill fails, and no value goes to the new
   document.
7. **Result:** "Filled the <field> of credential <credentialId> into <element, or target>." If `submit`
   is true, add " Pressed Enter." The result has no snapshot. The agent calls `browser_snapshot`.

- In each error text, the sidecar replaces the value with `[vault:<credentialId>.<field>]`.
- The sidecar never logs the arguments of `vault_fill`, and keeps no vault value after the call.

### 8.9 Response redaction

Playwright MCP puts the value of each `input` into the snapshot, also for `type=password` (aria
snapshot of `playwright-core` `1.64.0-alpha-1790635538000`). Thus after a fill, a snapshot shows the
value. Pages can also show a value, for example "Signed in as <username>". The gateway removes the vault
values from each MCP response of a session whose vault is not empty.

- **Redaction set** of a session. For each credential:
  - the username and the password, if they have 4 characters or more;
  - for a credential with TOTP: the codes of the previous, the current, and the next period.
- Each value becomes `[vault:<credentialId>.<field>]`. The gateway replaces the value in two forms: as
  it is, and in its JSON string form without the quotes (`JSON.stringify(value)` without the first and
  the last character), because snapshot text puts some values in quotes. Longer values go first.
- **Where:** in each JSON-RPC message from the pod. The gateway parses the message, replaces the values
  in each string in `result`, `error`, and `params`, and serializes it again. It does not change
  `jsonrpc`, `id`, or `method`, and it does not change the `data` field of `image` and `audio` content
  items. If a message is not valid JSON, the gateway replaces the values in the raw text.
- **`application/json`:** the gateway reads the full body (maximum 64 MiB), changes it,
  and sends it without `Content-Length`. **`text/event-stream`:** the gateway changes each SSE event when
  the event is complete. It keeps only the incomplete event in a buffer, so the stream has no other
  delay.
- The audit copy of section 8.2 step 6 reads the response after the redaction.
- **Cache:** the `vault/` module keeps the redaction set of a session in memory. It builds the set at
  the first response, and removes it when a credential of the session changes, when the session state
  changes to a state other than `starting` or `running`, and after 10 min without use. It calculates
  the TOTP codes at each use. Each message uses the current set.
- **Limits:**
  - Screenshots and other images do not change.
  - A changed form of a value (base64, reversed, in parts) is not found.
  - A value with less than 4 characters is not removed.
  - A short or common value (for example the username `admin`) also replaces the same text in other
    places of the page.

---

## 9. Live view

### 9.1 Separate origin

The live view uses `HYDRA_LIVE_URL`, for example `https://live.hydra.example.com`. Code from the Neko
client cannot read the dashboard DOM. It can send requests to the dashboard API, but it cannot read the
responses, and the CSRF check (section 6.4) rejects its requests that change data. CSP rules are in
section 6.8.

All sessions share this origin. Section 7.10 gives the risk, and the grant rules of section 9.2 limit it.

### 9.2 Open flow

1. The dashboard calls `POST /api/sessions/<sid>/live-ticket` (right `live.watch`). If the session is
   not `running`: 409 `invalid_state`.
2. The gateway returns `{ url }`. The URL contains a ticket: 32 random bytes, one use, 60 s life. The
   gateway keeps the ticket in memory with the login session, the user, the session, and the Neko
   profile.
3. The iframe opens `<HYDRA_LIVE_URL>/s/<sid>/?ticket=<ticket>`. The gateway validates and removes the
   ticket, creates a live grant (DB) and the audit event `live.opened`, sets the cookie
   `__Host-hydra_live_<sid>` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`), and sends a 303
   redirect to `<HYDRA_LIVE_URL>/s/<sid>/?embed=1&usr=<display name>&pwd=x`.
   The value `pwd=x` is a dummy. It only makes the legacy Neko client log in automatically.
   The cookie name contains the `sid`, because the `__Host-` prefix needs `Path=/`. Thus two browser
   tabs can show two sessions, and each browser tab keeps its own grant. The proxy reads only the
   cookie of the `sid` in the path.
4. The Neko client opens its WebSocket. The gateway checks the live grant. Then it replaces the
   `username` query value with the Hydra display name and the `password` value with the Neko password
   of the Neko profile (section 6.7).
5. Alternative, if step 4 does not work (spike S2): the gateway calls Neko `POST /api/login` from the
   server, keeps the Neko token with the live grant (in memory), and adds the token to each request and
   WebSocket upgrade that it sends to the pod. The browser does not get the token.

A live grant ends in these cases. When a grant ends, the gateway closes its WebSockets at once.

- Its login session ends (event `login.ended`).
- The user loses `live.watch`, or the Neko profile of the user changes (event `rights.changed`,
  section 6.5).
- The session state changes to a state other than `starting` or `running` (section 7.9).
- 30 s after its last WebSocket closes, or 30 s after its creation if no WebSocket opens. After a
  gateway restart, these 30 s start at the restart. Thus a grant lives only while its view is open
  (section 7.10).
- The dashboard opens another session in the same browser tab. Before it loads the new iframe, it calls
  `DELETE /api/sessions/<previous sid>/live-grant`.
- 12 h after its creation.

Every 60 s, the live proxy also checks each open WebSocket against these rules, for example for a login
session that reached its idle timeout.

### 9.3 Proxy

- `/s/<sid>/*` on the live host goes to `podEndpoint(sid, 8080)` + `/*` (section 7.3) without the
  `/s/<sid>` prefix.
  The Neko client builds its URLs from `location.pathname`, so it works under the prefix.
- Each HTTP request and each WebSocket upgrade must have a valid live grant for that `sid`.
  If not: 401 for HTTP, and the upgrade is refused.
- The gateway removes `Set-Cookie`, `Content-Security-Policy`, and the other headers of section 6.8 from
  pod responses, and sets its own headers. Thus a pod cannot set cookies on the live origin.
- WebSocket upgrade: the gateway sends the upgrade request (with the changed query) to the pod and then
  connects the two sockets. It does not parse WebSocket frames.
- No timeout on open WebSockets. Neko sends a ping every 10 s.

### 9.4 Media and control

- WebRTC media goes directly to `HYDRA_PUBLIC_IP:<media port>`. UDP is the first choice, TCP mux is the
  fallback.
- When the user selects a different session or a different view, the dashboard removes the iframe, and
  Neko stops the video stream. Each browser tab shows a maximum of one video stream.
- Operators control the browser with a click (implicit hosting). Viewers can only watch.
- The dashboard shows the banner "Agent active" if `agentActivity.lastToolCall.startedAt` is less than
  10 s ago (section 8.5).
- Neko clipboard sync is on, so a user can paste a 2FA code.
- iframe: `allow="clipboard-read; clipboard-write; fullscreen; autoplay"`,
  `sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"`.
- Known limit: the local browser keeps some shortcuts (for example ⌘W) and does not send them.

---

## 10. Dashboard

### 10.1 Visual system

Source of the style: `https://github.com/ridvanonal/macos-react`. Its README says MIT, but the
repository has no LICENSE file. **Do not copy its code.** Write our own components that use the same
design values, and credit the project in the README. Most of the color values are the public Apple
system colors.

- **Libraries:** Tailwind CSS v4 (tokens as CSS variables), Radix primitives, Tabler icons. Animations
  use CSS transitions.
- **Colors:** Apple system colors with a light and a dark value each (red, orange, yellow, green, mint,
  teal, cyan, blue, indigo, purple, pink, brown, gray). Text uses the "accessible" variant of each color.
  Surface tokens: `--os-surface`, `--os-foreground`, `--os-tone`, `--os-black`, `--os-gray-*`,
  `--os-accent`.
- **Window:** 12 px corner radius (`rounded-xl`). Focused surfaces: `bg-os-surface/70` with
  `backdrop-blur-2xl`. Layered shadows: a 1 px outline and a large soft drop shadow, plus an inner
  1 px highlight, with separate values for light and dark.
- **Traffic lights:** 12 px circles, decorative only. The full-screen button is in the status bar of
  the Live view.
- **Controls:** macOS-style switch, checkbox, radio, segmented control, and an accent focus ring.
- **Font:** `-apple-system, BlinkMacSystemFont, "Inter", sans-serif`. Do not include SF Pro.
- **Theme:** follows `prefers-color-scheme`.
- **Layout:** the app is one window over a wallpaper. The minimum viewport width is 1024 px.

### 10.2 Screens

- **Login:** a centered macOS-style panel. If `must_change_password` is true, the user goes to
  **Change password** and cannot use other screens first.
- **Sidebar** (240 px, translucent):
  - "My sessions" and "Shared with me". Each item: status dot (green `running`, yellow
    `starting`/`stopping`, gray `stopped`, red `error`), name, agent icon when
    `agentActivity.activeAgentCount` is 1 or more (section 8.5). The user SSE stream (section 10.3)
    updates these values. The **＋** button opens the **New session** sheet (name, allowlist, timezone,
    language, screen, "Start now").
  - "Admin" (admins only): **Users**, **All sessions**.
  - User menu at the bottom: change password, logout.
- **Toolbar:** session name and state, a segmented control for the views (**Live · Tokens · Vault ·
  Sharing · Activity · Settings**, only the views that the user has rights for), **Start**/**Stop**, **Restart**,
  and a "more" menu with **Delete** (a sheet in which the user types the session name).
- **Live:** the iframe, fitted to the space with the screen aspect ratio. A status bar under it shows the
  number of connected agents, the last tool call (for example `browser_click · ok · 230 ms`), and the
  full-screen button. Banners: "Agent active", "More than one agent is connected", "Allowlist permits
  all domains". If the session is not running, the area shows the state, and users with `session.lifecycle` also see a **Start** button.
- **Tokens:** a table (name, prefix, creator, created, expires, last used) with **Revoke**. The
  **New token** sheet asks for the name and the expiry. After creation, a sheet shows the token one time
  with copy buttons for:
  - `claude mcp add --transport http <name> <HYDRA_PUBLIC_URL>/s/<sid>/mcp --header "Authorization: Bearer <token>"`
  - the JSON `mcpServers` config for other clients.
- **Vault** (right `vault.read`, in all session states):
  - A table: name, website, username, the values that are set (password and 2FA icons), updated. Users with
    `vault.manage` also see **New credential**. An empty vault shows a short text about the vault and
    the `vault_fill` tool.
  - A click on a row opens the credential sheet: name, username, password, website, and two-factor code.
    The password and the code show as dots. The website opens in a new browser tab of the local
    browser, not in the session.
  - Users with `vault.reveal` see an eye button and a copy button for the password and the code. Each
    click calls the reveal route (one audit event). The password stays visible until the user hides
    it or closes the sheet. The code shows with a ring that counts down to the end of its period, and
    then it hides. The copy button writes the value to the local clipboard. Neko clipboard sync then
    lets the user paste it into the live view.
  - Users with `vault.manage` see **Edit** and **Delete** in the sheet. The edit sheet shows the
    password and the TOTP secret as empty fields with the placeholder "Unchanged", and a **Remove**
    button for each optional value. **Delete** asks for a confirmation.
  - The **New credential** sheet asks for the name, the website, the username, the password, and the
    two-factor secret (base32 or `otpauth://` URI). An **Advanced** part gives the algorithm, the
    digits, and the period. If the user pastes a URI, the form shows its parameters in **Advanced**.
- **Sharing:** the owner and the members, with a role menu (`viewer`, `operator`) and **Remove** for
  each member. Add a member by email.
- **Activity:** the audit table with live updates and filters (kind, tool, status, token). Click a row to
  see its `data`. Pagination with "Load older".
- **Settings:** name, allowlist (chip input), timezone, language, screen, and the "Restart required"
  notice. Users with `session.logs` also see **Diagnostics**: the last 50 log lines of the `neko` and the
  `mcp` container.
- **Admin → Users:** a table (email, name, role, state, last login) and the **Create user** sheet. The
  one-time password shows one time. Row actions: disable or enable, reset password, change role, unlock.
- **Admin → All sessions:** all sessions with their owner and state.
- **Sheets** move down from the toolbar (Radix Dialog with a CSS transition).

### 10.3 Client architecture

- React 19, Vite, React Router.
- TanStack Query for API data. The zod schemas from `@hydra/shared` validate the responses.
- Two SSE connections. When the client receives an event, it updates the TanStack Query cache.
  - `GET /api/events` (open while the user is logged in): `session.state` and `session.activity` for
    all sessions that the user can read. The sidebar uses it.
  - `GET /api/sessions/<sid>/events` (for the selected session): audit events, only with `audit.read`.
    The Activity view uses it.
- The gateway sends an SSE comment line every 25 s on both SSE streams, so proxies do not close an
  idle SSE stream. After a reconnect, the client fetches the session data again.
- After a rights change, the gateway closes the SSE streams of the user (section 6.5). The reconnect
  then gives the client the data for the new rights.
- Accessibility: all controls work with the keyboard. Focus rings are visible. Text contrast meets
  WCAG AA in both themes.

---

## 11. Deployment

### 11.1 Images

| Image | Build file | Base | Notes |
|---|---|---|---|
| `hydra-gateway` | `deploy/Dockerfile` | distroless Node.js 24 | Multi-stage. Contains `@hydra/server` and the built `@hydra/web`. Non-root, read-only root filesystem. `hydra` CLI on `PATH`. |
| `hydra-session` | `deploy/session/Dockerfile.session` | `ghcr.io/m1k1o/neko/chromium:3.1.6` | Section 7.7. |
| `hydra-mcp` | `deploy/session/Dockerfile.mcp` | `node:24.21.0-slim` | Sections 3.4.4 and 7.7. Non-root. |
| `hydra-testsite` | `deploy/testsite/Dockerfile` | `node:24.21.0-slim` | `@hydra/testsite`. Only the `dev` overlay uses it. |

Section 3.4.4 gives how the image digests go into the overlays.

### 11.2 Kustomize base (`deploy/k8s/base`)

- **Namespaces:** `hydra` with Pod Security `restricted`. `hydra-sessions` with Pod Security `baseline`
  (`enforce`), because Neko starts supervisord as root.
- **RBAC:** ServiceAccount `hydra-gateway` in `hydra`. A Role in `hydra-sessions` (never a ClusterRole):
  - `statefulsets`, `services`, `configmaps`, `secrets`, `persistentvolumeclaims`: all verbs.
  - `pods`: `get`, `list`, `watch`. `pods/log`: `get`.
  - Never `pods/portforward` or `pods/exec`. The development transport (section 11.7) uses the k3d
    admin kubeconfig, not this ServiceAccount.
- **Gateway:** Deployment, 1 replica, strategy `Recreate` (SQLite has one writer). PVC `gateway-data`
  (StorageClass `hydra-retain`) mounted as `HYDRA_DATA_DIR`. Secret `hydra-secret-key` gives
  `HYDRA_SECRET_KEY`. The generated ConfigMap `hydra-images` gives `HYDRA_SESSION_IMAGE` and
  `HYDRA_MCP_IMAGE` (section 3.4.4). Probes: `/healthz` (liveness), `/readyz` (readiness).
- **Image pre-pull:** a DaemonSet `session-image-prepull` in `hydra-sessions`. Its init containers use
  the `hydra-session` and the `hydra-mcp` image and run `true`. Its main container is the pinned `pause`
  image. Thus the node has the images before the first Start, and the first start can meet the 60 s goal
  (section 1.1). The DaemonSet does not have the label `app.kubernetes.io/managed-by: hydra`.
- **StorageClasses:** `hydra-retain` and `hydra-profile` (section 5.2).
- **TLS and routes:** Traefik `IngressRoute` objects for `HYDRA_PUBLIC_URL` and `HYDRA_LIVE_URL` to the
  gateway Service. TLS from the Traefik ACME resolver (Let's Encrypt, HTTP-01).
- **NetworkPolicies:** section 11.4.

### 11.3 Traefik

The `HelmChartConfig` for the bundled Traefik is in `deploy/traefik/`, in two files:
- `prod.yaml` (`setup-k3s.sh` applies it):
  - ACME resolver `letsencrypt` (HTTP-01), `acme.json` on a PVC with StorageClass `hydra-retain`.
  - HTTP to HTTPS redirect.
- `dev.yaml` (`dev-cluster.sh` applies it): no ACME, no redirect.
- Both files:
  - The same entry point timeouts, which do not cut long responses.
  - `externalTrafficPolicy: Local` on the Traefik Service. Without it, Traefik sees an internal address
    instead of the client IP, and the per-IP limits and the audit IPs are wrong.
  - Fixed node ports on the Traefik Service: `30080` for `web`, `30081` for `websecure`, and `30082`
    for `healthCheckNodePort`. Without them, Kubernetes gives automatic node ports, and an automatic
    node port can be a media port (section 11.6).

`check-repo.ts` (section 3.4.7) fails if the timeout values in the two files are not equal. Thus the
long MCP stream test (section 15.3) on k3d verifies the production timeouts.

### 11.4 NetworkPolicies

| Namespace | Direction | Rule |
|---|---|---|
| `hydra-sessions` | ingress | Default deny. Permit TCP 8080 and 8931 from pods with label `app: hydra-gateway` in `hydra`. Permit UDP and TCP on the media port range from `0.0.0.0/0`. |
| `hydra-sessions` | egress | Default deny. Permit UDP/TCP 53 to `kube-dns` in `kube-system`. Permit `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`. |
| `hydra` | ingress | Default deny. Permit TCP 8080 from Traefik in `kube-system`. |
| `hydra` | egress | Default deny. Permit the API server (TCP 6443 on the node IP; the overlays give the node IP, and `dev-cluster.sh` writes it for k3d), the session pods (TCP 8080, 8931), and DNS. |

The excluded ranges contain the pod CIDR, the service CIDR, the VPC addresses (node IP, API server on
6443, kubelet on 10250), and the EC2 metadata endpoint. Spike S6 and the security e2e tests verify them.

### 11.5 Operator requirements (outside this repo)

- EC2 instance with an Elastic IP. IMDSv2 required, with hop limit 1.
- Security group: TCP 443 and 80 from anywhere; UDP and TCP `HYDRA_MEDIA_PORT_RANGE` from anywhere;
  SSH from admin IPs only.
- DNS records for both hostnames to the Elastic IP.
- A persistent volume mounted at `HYDRA_STATE_DIR`, with daily snapshots (for example EBS snapshots).
  The `backups/` folder (section 5.1) is on the same volume, so it does not replace the snapshots.
- An alarm when the volume is 80% full (section 5.2).
- Clock synchronization on the server (for example chrony with the Amazon Time Sync Service). TOTP
  codes of the vault depend on the clock (section 6.9.4).

### 11.6 `scripts/setup-k3s.sh`

The script is idempotent. It does these steps:

1. Check that it runs as root on Debian or Ubuntu.
2. Set the kernel sysctls that `protect-kernel-defaults` needs.
3. Install and turn on `unattended-upgrades` for security updates.
4. Create `HYDRA_STATE_DIR` with mode `0700`.
5. Write `/etc/rancher/k3s/config.yaml`:
   ```yaml
   secrets-encryption: true
   write-kubeconfig-mode: "0600"
   default-local-storage-path: <HYDRA_STATE_DIR>/volumes
   protect-kernel-defaults: true
   service-node-port-range: 30000-<last port of HYDRA_MEDIA_PORT_RANGE>
   ```
   The media ports are NodePorts (section 7.3), so the node port range must contain them.
   kube-apiserver accepts only one range, so the range starts at `30000` and ends at the last media
   port. With the default `HYDRA_MEDIA_PORT_RANGE`, the range is `30000-52099`.
   - With this range, Kubernetes keeps the lowest 128 ports (`30000-30127`) for fixed node ports. It
     gives automatic node ports from the ports above them first, so an automatic node port can take
     a media port.
   - Thus each Service with node ports in the cluster must use fixed node ports in `30000-30127`. The
     only such Service in k3s is Traefik (section 11.3). The media Services use fixed node ports too.
   - The first port of `HYDRA_MEDIA_PORT_RANGE` must be `30128` or more (section 4).
6. If `deploy/session/seccomp/chromium.json` exists (spike S1), copy it to
   `/var/lib/kubelet/seccomp/hydra/chromium.json` (the kubelet seccomp folder of k3s).
7. Download `install.sh` from the k3s release tag in `scripts/versions.sh`, check its SHA-256, and
   install that k3s version with `INSTALL_K3S_VERSION` (section 3.4.5).
8. Wait for the node to be Ready.
9. Apply the StorageClasses of the Kustomize base (`deploy/k8s/base/storageclasses.yaml`). The Traefik
   PVC needs `hydra-retain`. A later `kubectl apply -k` of the overlay applies the same objects again
   without a change.
10. Apply `deploy/traefik/prod.yaml` (section 11.3).
11. Show the next steps: create the `hydra-secret-key` Secret, apply the `prod` overlay, create the first
    admin.

### 11.7 `scripts/dev-cluster.sh`

The script does these steps:

1. Check the k3d version (`scripts/versions.sh`).
2. Create the k3d cluster `hydra-dev` with the k3s version of `scripts/versions.sh` (section 3.4.5), with
   a local image registry, with the same `service-node-port-range` as section 11.6, and with the media
   port range mapped to the host. If the seccomp profile exists, mount it into the node at
   `/var/lib/kubelet/seccomp/hydra/`.
3. Apply `deploy/traefik/dev.yaml` (section 11.3).
4. Build the images, push them to the local registry, and write the image values and the node IP into
   the `dev` overlay (section 3.4.4).
5. Apply the `dev` overlay. It deploys the gateway in the cluster (with `HYDRA_PUBLIC_IP=127.0.0.1`) and
   the test site (section 15.3).

There are two ways to run the gateway:

- **E2E and CI:** the gateway runs in the cluster, from the images of the current commit in the local
  registry, with `HYDRA_SESSION_TRANSPORT=cluster-dns`. This is the production path: pod DNS names and
  the NetworkPolicies of section 11.4. Section 15.3 uses only this mode.
- **Development:** `pnpm dev` scales the in-cluster gateway to 0. Then it runs the server
  (`tsx watch`) and the web app (Vite dev server with a proxy to the server) on the host, with
  `KUBECONFIG` of the k3d cluster and `HYDRA_SESSION_TRANSPORT=port-forward` (section 7.3). A
  port-forward goes through the kubelet, so the session NetworkPolicies do not apply to it. Thus
  development does not test the NetworkPolicies.

### 11.8 Redeploy and migrations

`kubectl apply -k deploy/k8s/overlays/prod`. At start, the gateway makes a backup and then runs the
Drizzle migrations. If a migration fails, the gateway stops and does not serve requests.

---

## 12. API

All dashboard routes are under `/api` on `HYDRA_PUBLIC_URL`, use JSON, and need a login session, except
`POST /api/auth/login`. zod schemas in `@hydra/shared` define each body and each response.

### 12.1 Routes

| Method and path | Right | Purpose |
|---|---|---|
| `POST /api/auth/login` | — | Log in (`email`, `password`) |
| `POST /api/auth/logout` | login | Log out |
| `GET /api/auth/me` | login | Current user |
| `POST /api/auth/password` | login | Change password (`current`, `new`) |
| `GET /api/users` | admin | List users |
| `POST /api/users` | admin | Create user, returns the one-time password |
| `PATCH /api/users/:id` | admin | Change `role`, `status`, `displayName` |
| `POST /api/users/:id/reset-password` | admin | Returns a new one-time password |
| `POST /api/users/:id/unlock` | admin | Unlock a locked account (section 6.4) |
| `GET /api/sessions` | login | Own and shared sessions. `?all=1` for admins. |
| `POST /api/sessions` | login | Create |
| `GET /api/sessions/:sid` | `session.read` | Details |
| `PATCH /api/sessions/:sid` | `session.update` | Change settings |
| `POST /api/sessions/:sid/start` | `session.lifecycle` | Start |
| `POST /api/sessions/:sid/stop` | `session.lifecycle` | Stop |
| `POST /api/sessions/:sid/restart` | `session.lifecycle` | Restart |
| `POST /api/sessions/:sid/delete` | `session.delete` | Delete (`confirmName`) |
| `GET /api/sessions/:sid/logs?container=neko\|mcp` | `session.logs` | Last 50 lines |
| `POST /api/sessions/:sid/live-ticket` | `live.watch` | Live view URL with ticket |
| `DELETE /api/sessions/:sid/live-grant` | login | End the live grants of this login session for the session (section 9.2) |
| `GET /api/events` | login | SSE: `session.state` and `session.activity` of all sessions that the user can read |
| `GET /api/sessions/:sid/events` | `audit.read` | SSE: audit events of the session |
| `GET /api/sessions/:sid/members` | `session.read` | Owner and members |
| `POST /api/sessions/:sid/members` | `session.share` | Add (`email`, `role`) |
| `PATCH /api/sessions/:sid/members/:userId` | `session.share` | Change role |
| `DELETE /api/sessions/:sid/members/:userId` | `session.share` | Remove |
| `GET /api/sessions/:sid/tokens` | `token.create` | List tokens |
| `POST /api/sessions/:sid/tokens` | `token.create` | Create (`name`, `expiresInDays`), returns the token one time |
| `DELETE /api/sessions/:sid/tokens/:tokenId` | `token.revoke_own` or `token.revoke_any` | Revoke |
| `GET /api/sessions/:sid/audit` | `audit.read` | Filters: `kind`, `tool`, `status`, `tokenId`, `before`, `limit` (max 200) |
| `GET /api/sessions/:sid/vault` | `vault.read` | List credentials (metadata, section 6.9.5) |
| `POST /api/sessions/:sid/vault` | `vault.manage` | Create (`name`, `website`, `username`, `password`, `totp`) |
| `PATCH /api/sessions/:sid/vault/:credentialId` | `vault.manage` | Change. A missing key keeps the value, `null` removes an optional value, a new value replaces it. |
| `DELETE /api/sessions/:sid/vault/:credentialId` | `vault.manage` | Delete |
| `POST /api/sessions/:sid/vault/:credentialId/reveal` | `vault.reveal` | `field`: `password` or `totp`. Returns the password, or the current code with `validUntil`. `Cache-Control: no-store`. |
| `POST/GET/DELETE /s/:sid/mcp` | agent token | MCP endpoint (section 8) |
| `/s/:sid/*` on the live host (HTTP and WebSocket) | live grant | Neko proxy (section 9) |
| `GET /healthz`, `GET /readyz` | — | Health |

### 12.2 Errors

Format: `{ "error": { "code": "<code>", "message": "<text for people>", "fields": { … } } }`.
`fields` is present only for `validation_failed`.

| Code | HTTP | When |
|---|---|---|
| `unauthenticated` | 401 | No valid login session |
| `csrf_failed` | 403 | Section 6.4 |
| `forbidden` | 403 | The user can see the session but does not have the right for the action |
| `not_found` | 404 | No such object, or no `session.read` |
| `validation_failed` | 400 | zod validation failed |
| `confirm_mismatch` | 400 | Delete without the exact session name |
| `password_rejected` | 400 | Password rules failed |
| `invalid_credentials` | 401 | Login failed |
| `password_change_required` | 403 | `must_change_password` is true (section 6.3) |
| `rate_limited` | 429 | Rate limit or login throttle (section 6.4) |
| `conflict` | 409 | For example, the email exists |
| `invalid_state` | 409 | The action does not fit the session state, for example a start during `deleting`, or a live ticket for a session that is not running |
| `capacity_reached` | 409 | `HYDRA_MAX_RUNNING` sessions hold a media port (section 7.8) |
| `vault_limit_reached` | 409 | The vault of the session has 50 credentials (section 6.9.1) |
| `body_too_large` | 413 | The request body is larger than the body limit |
| `internal` | 500 | An unexpected error. The message gives no details. The gateway logs the error. |

---

## 13. Data model (SQLite, Drizzle)

Times are integers in milliseconds since the Unix epoch. IDs are ULIDs, except `sessions.id` (`sid`).

### 13.1 Tables

**`users`**: `id` PK, `email` UNIQUE NOT NULL (lowercase), `display_name` NOT NULL, `password_hash`
NOT NULL, `role` (`admin` | `member`), `status` (`active` | `disabled`), `must_change_password` BOOL,
`failed_logins` INT (failures in a row), `locked_at` INT NULL, `last_login_at` INT NULL, `password_changed_at`,
`created_at`, `updated_at`.

**`login_sessions`**: `id` PK, `user_id` FK → users (cascade), `token_hmac` BLOB UNIQUE, `ip`,
`user_agent`, `created_at`, `last_seen_at`, `expires_at`.

**`sessions`**: `id` PK (`sid`), `name`, `owner_id` FK → users, `desired_state`, `state`,
`error_reason` NULL, `media_port` INT NULL, `allowlist` JSON, `timezone`, `language`, `screen`,
`applied_settings` JSON (the settings of the last Start or Restart, section 7.2), `started_at` INT NULL,
`ready_at` INT NULL, `created_at`, `updated_at`, `deleted_at` NULL.
Partial unique index on `media_port` `WHERE media_port IS NOT NULL`. `media_port` is not null only
while the session holds a port (section 7.8).

**`session_members`**: PK (`session_id`, `user_id`), `role` (`operator` | `viewer`), `granted_by`
FK → users, `created_at`.

**`agent_tokens`**: `id` PK, `session_id` FK → sessions, `created_by` FK → users, `name`, `token_hmac`
BLOB UNIQUE, `prefix`, `created_at`, `expires_at`, `last_used_at` NULL, `last_used_ip` NULL,
`revoked_at` NULL, `revoked_by` NULL FK → users.

**`live_grants`**: `id` PK, `login_session_id` FK → login_sessions (cascade), `user_id`, `session_id`,
`neko_profile` (`admin` | `user`), `cookie_hmac` BLOB UNIQUE, `created_at`, `expires_at`.

**`vault_credentials`**: `id` PK, `session_id` FK → sessions, `name`, `website` (origin),
`username_enc` BLOB NULL, `password_enc` BLOB NULL, `totp_enc` BLOB NULL (section 6.9.3), `created_by`
FK → users, `created_at`, `updated_at`. Index on `session_id`. A CHECK constraint makes sure that one or
more of the three `_enc` columns is not null.

**`audit_events`**: `id` INTEGER PK AUTOINCREMENT, `ts`, `kind`, `actor_type` (`user` | `token` |
`system`), `actor_id` NULL, `session_id` NULL, `status` NULL, `data` JSON. Indexes:
(`session_id`, `ts`), (`kind`, `ts`).

### 13.2 Audit kinds

`auth.login`, `auth.login_failed`, `auth.logout`, `auth.password_changed`, `user.created`,
`user.updated` (also an unlock), `user.password_reset`, `session.created`, `session.updated`,
`session.state`, `session.started`, `session.stopped`, `session.restarted`, `session.deleted`,
`session.shared`, `session.unshared`, `live.opened`, `token.created`, `token.revoked`,
`admin.session_access`, `mcp.connect`, `mcp.tool_call`, `vault.created`, `vault.updated`,
`vault.deleted`, `vault.revealed`.

Data of the vault events: `credentialId` and `name` for all four. `vault.created` also has `website`
and the names of the values that are set. `vault.updated` has the names of the changed fields.
`vault.revealed` has `field`. No vault event contains a value.

### 13.3 Jobs

- Every day: delete `audit_events` older than `HYDRA_AUDIT_RETENTION_DAYS`, and delete expired
  `login_sessions` and `live_grants`.
- Every 30 s: the reconciler (section 7.9).
- Every 60 s: the connection check of the MCP proxy and the live proxy (sections 8.3 and 9.2).

---

## 14. Errors and operations

- **Logs:** pino JSON to stdout. Redact paths: `req.headers.authorization`, `req.headers.cookie`,
  `res.headers["set-cookie"]`, and all fields named `password`, `token`, `ticket`, `username`, `value`,
  `secret`, `totp`, `uri`, and `hydraFill`. The gateway never logs a TOTP code.
- **Health:** `/healthz` returns 200 if the process runs. `/readyz` returns 200 if the DB answers and
  the Kubernetes API answers.
- **SIGTERM:** stop new requests, close open MCP streams and WebSockets after 10 s, close the DB.
- **Gateway restart:** the reconciler reads the DB and Kubernetes again. MCP clients and Neko clients
  connect again by themselves. Live grants are in the DB, so the live view continues after the restart
  (section 9.2 gives the 30 s rule after a restart).

---

## 15. Tests

### 15.1 Unit (Vitest)

- `crypto/`: HKDF labels give different keys, token format and HMAC, Neko password derivation.
- `access/`: the full `authorize()` table.
- `auth/`: password rules, login throttle times, the lock after 100 failures.
- `audit/`: redaction and truncation for each tool.
- `mcp-proxy/`: JSON-RPC parser (single and batch), SSE parser, and the tool deny list.
- `sessions/`: capacity check and media port allocation.
- `orchestrator/`: manifest builders (snapshot tests of the generated objects), the state rules, and the
  repair of missing or changed objects (with a fake client).
- `config/`: validation rules.
- `vault/`: encryption round trip; a ciphertext with a different `sid`, credential ID, or field fails;
  the RFC 6238 test vectors (SHA1, SHA256, SHA512); the 5 s rule of a fill; the redaction set and the
  two replacement forms.
- `@hydra/shared`: `otpauth://` URI parse (valid, `hotp`, bad parameters), base32 rules, and
  `vaultSiteMatches` (subdomains, a different scheme, an IP address, a public suffix, a PRIVATE-section
  host, `about:blank`).
- `mcp-proxy/`: the `vault_fill` rewrite (the `hydraFill` of the agent is removed, the audit record has
  no value), the batch rule, the `http` rule at fill time, and the redaction of JSON bodies and of SSE
  events that arrive in parts (a JSON-RPC `id` does not change).
- `@hydra/mcp-sidecar`: the interceptor (the tool list gets the vault tools and loses the page tools
  with the same names, `vault_fill` never reaches Playwright MCP, `hydra-internal-` IDs from the client
  are rejected), the error texts contain no value, and the CDP retry: no listen on 8931 before the
  first connection, 404 for old MCP sessions after a new connection, and no process exit.

### 15.2 Integration (Vitest)

- API with a real SQLite database in a temporary folder and a fake Kubernetes client: login, logout,
  CSRF, rate limits, the 404 rule, sharing, token create and revoke.
- Lockout: a locked account, an unknown email, and a wrong password give the same status and body.
- A password change ends the other login sessions of the user, and a password reset ends all of them.
- `must_change_password`: all routes except the three of section 6.3 return `password_change_required`.
- Rights change: a downgrade from operator to viewer ends the live grant, and a member removal closes
  the MCP streams of the tokens of that member.
- `agentActivity`: a viewer gets the summary, but `GET /api/sessions/:sid/audit` returns 403.
- MCP proxy against a real `hydra-mcp` sidecar process that connects to a local Chromium over CDP:
  responses without a buffer (with an empty vault), SSE events without delay after they are complete
  (with a vault that is not empty), header removal, `Host` rewrite, audit records, MCP stream close on revoke,
  and the tool deny list.
- Vault API: the rights of section 6.9.5 for each role, `vault_limit_reached`, the `null` rule of
  `PATCH`, a reveal creates `vault.revealed`, no response of the list contains a password or a TOTP
  secret, and a session Delete removes the credential rows.
- Vault fill against the real sidecar and a local page:
  - A fill of the username, the password, and the TOTP code works with snapshot refs, also in a
    same-site iframe and in a second tab that is the current tab.
  - A fill into an element of a cross-site iframe, of an `about:srcdoc` frame, or of a page on another
    site fails with the site check error.
  - After a fill, `browser_snapshot` and `browser_evaluate` that returns the value give
    `[vault:<id>.<field>]` to the client, not the value.
  - No value is in the audit table, in the gateway logs, or in the sidecar logs.

### 15.3 E2E (`@hydra/e2e`, Playwright, on k3d)

- **Test site:** the egress NetworkPolicy blocks private addresses, so the `dev` overlay deploys a small
  test site (`hydra-testsite`, section 3) and adds one egress exception for it. The test site sets a cookie and
  redirects on request. Only the `dev` overlay has this exception.
  The test site also has a login page with an email field, a password field, and a 6-digit code field.
  It accepts one fixed test account and the TOTP codes of one fixed test secret. The test site uses
  `http`, so the `dev` overlay sets `HYDRA_VAULT_HTTP_HOSTS` to the test site host (section 4).
- **Main flow:**
  1. Create an admin with the CLI, then log in.
  2. Create a session, and wait for `running`.
  3. Open the live view, and check that the `<video>` element plays.
  4. Create a token.
  5. Connect an MCP client (MCP TypeScript SDK) with the token.
  6. Navigate to the test site, which is in the allowlist (the navigation succeeds and sets a cookie),
     and to a domain that is not in the allowlist (Chromium blocks it).
  7. Check `navigator.language` and the `Intl` timezone against the session settings.
  8. Check the audit log in the Activity view.
  9. Stop the session: MCP returns 503. Start it again: a cookie set in step 6 is still there.
  10. In the Vault view, create a credential for the test site with the test account and the test
      TOTP secret. The agent calls `vault_list` and `vault_fill` for the username, the password, and the
      code, and the test site login succeeds. No MCP response and no audit event contains a value.
  11. Delete the session: all its Kubernetes objects, its profile folder, and its credentials are gone.
- **Security:**
  - From inside a session pod: connections to another session pod, the gateway Service, the node on
    6443 and 10250, and `169.254.169.254` all fail.
  - A token for session A gets 401 on session B.
  - A revoked token gets 401, and its open MCP stream closes.
  - A viewer cannot take control in Neko.
  - Two browser tabs show two sessions at the same time, and both live views stay connected.
  - When the dashboard opens another session in the same browser tab, the live grant of the previous
    session ends at once. 30 s after a view closes, its grant cookie gets 401.
  - A user without access gets 404 for the session.
  - The `ip` of the `auth.login` audit event is the client address, not a pod address.
  - A credential with the website `https://example.com` cannot fill the test site.
  - An operator and a viewer get 403 on the reveal route.
- **Long MCP stream:** an MCP stream stays open for 10 min through Traefik. CI runs this test every night
  and on pull requests that change `deploy/traefik/` or `scripts/versions.sh`.

### 15.4 CI (GitHub Actions)

On each pull request: `pnpm install --frozen-lockfile`, `node scripts/check-repo.ts`,
`pnpm audit --audit-level high`, lint, typecheck, unit tests, integration tests, and the e2e tests on k3d
(the long MCP stream test only as section 15.3 gives). The release workflow builds and pushes the images
(section 3.4.4). The workflows follow the pinning rules of section 3.4.1.

### 15.5 Load check (manual, procedure in `docs/load-check.md`)

On the target EC2 type: 10 running sessions and 3 watched 1080p video streams. Record the CPU and the RAM,
then adjust the resource defaults (section 7.4).

---

## 16. Spikes

Do these spikes first. Each spike gives a written result. If a result changes this spec, update the
spec before the implementation of the related part.

| ID | Question | If it fails |
|---|---|---|
| S1 | Can Chromium in the Neko pod run with its sandbox (custom seccomp profile that permits user namespaces)? Which capabilities does the `neko` container need? On Ubuntu 23.10 and later, also check the AppArmor limit on unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns`). | Keep `--no-sandbox` and the controls of section 7.10. Record the decision. |
| S2 | Does the WebSocket query rewrite (section 9.2 step 4) log in the legacy Neko client? | Use the server-side `POST /api/login` method (section 9.2 step 5). |
| S3 | Can the `multiuser` provider give the `user` profile `can_host: false`? | Use the `object` member provider with two fixed users. |
| S4 | Does the `local-path` provisioner of k3s support `pathPattern`, and does a new PVC with the same name use the existing folder? | Use static PVs with fixed `local` paths, created by the setup script and the orchestrator. |
| S5 | Do `URLBlocklist`/`URLAllowlist` affect subresources (CDNs), `fetch()` requests, and redirects? Which internal pages must be in the allowlist? | Document the behavior in the UI help text and in section 8.7, and adjust the base policy. |
| S6 | Does the k3s NetworkPolicy controller block egress to the node IP (6443, 10250)? | Add host firewall rules in `setup-k3s.sh`. |
| V1 | In the sidecar, does `page.locator('aria-ref=<ref>')` from our code find the element of a ref from the newest Playwright MCP snapshot, if both use the same `BrowserContext`? Does an internal `browser_tabs` `list` call give the current tab, and is its index the index in `context.pages()`? Check refs in iframes (`f1e5`) and with two tabs. | If refs do not resolve: read the Playwright MCP code for a public way to resolve a ref, and update section 8.8. If the tab index does not match: find the page whose newest snapshot has the ref, and fail if more than one page has it. |
| V2 | Does `createConnection(config, () => context)` give the same tool list (25 default tools of `@playwright/mcp` `0.0.83`) and the same defaults as the `playwright-mcp` command line of section 7.4? The interceptor then adds the two vault tools, so the sidecar lists 27 tools. When an MCP session closes, or an agent calls `browser_close`, do the Chromium tabs and the browser context stay open, as with the command line? | Set the `config` values that give parity. If a session close closes the context, the sidecar gives each connection a wrapper of the context whose `close()` does nothing. Record the result in section 8.8. |

---

## 17. Not in version 1

- OAuth 2.1 for agents
- Human approval queue, a tool filter that users can configure, "pause all agents" button, audit export
- One live origin per session (`<sid>.live.example.com`, with a wildcard certificate). It removes the
  risk of section 7.10 for people who watch two sessions.
- Downloads and uploads in sessions
- More than one node, autoscaling, automatic stop of idle sessions, TURN server
- A built-in agent chat in the dashboard
- `HYDRA_SECRET_KEY` rotation, transfer of session ownership, SSO
- Vault: credentials that more than one session can use, import and export, a QR code reader for TOTP
  secrets, HOTP and Steam Guard codes, a password strength meter, a password generator, a fill that a
  person starts from the dashboard, and a vault right for each agent token
