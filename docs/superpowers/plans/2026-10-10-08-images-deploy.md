# Plan 08 — Images and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four container images, the Kustomize base and overlays, the Traefik values, the
production host script, the k3d dev cluster script, and the release workflow of Hydra Browsers v1,
so that one commit gives the same images and the same cluster software in development (k3d) and in
production (k3s).

**Architecture:** Four Dockerfiles under `deploy/` build `hydra-gateway` (distroless, no shell; the
`hydra` command is a Node.js script with an absolute shebang), `hydra-session` (Neko Chromium plus
fonts from snapshot.debian.org), `hydra-mcp` (`pnpm deploy` of `@hydra/mcp-sidecar`), and
`hydra-testsite`. A Kustomize base holds the namespaces, RBAC, the gateway, the StorageClasses, the
NetworkPolicies, the IngressRoutes, and the image pre-pull DaemonSet. Two overlays add the site
values. One shell helper writes the image pins (and, for k3d, the node IP) as a Kustomize Component;
the release workflow and `dev-cluster.sh` both use it. Shell tests in `deploy/test/` check all parts
that run without Docker. Steps marked **Needs Docker** give the exact commands for the controller.

**Tech Stack:** Docker BuildKit, pnpm 12.9.0, Node.js 24.21.0, distroless Node.js 24, Neko 3.1.6,
Kustomize (in kubectl), the Traefik chart that k3s v1.36.5+k3s1 bundles, k3d 5.9.0, GitHub Actions,
bash (3.2-compatible), and the root dev tools of plan 01 (TypeScript 6.0.3, Vitest 5.0.3) for
`@hydra/testsite`.

**Spec:** `docs/superpowers/specs/2026-10-10-hydra-browsers-design.md`, sections 3.4.4, 3.4.5, 5.2,
7.4 (image side), 7.7, 11.1 to 11.8, and 15.3 (test site).
**Index:** `docs/superpowers/plans/2026-10-10-00-index.md`: file ownership row 08, section 6 rows S1,
S4, S6, and the Checkpoint step of section 3.

## Global Constraints

- Exact pins only (spec 3.4.1). Each container image reference is `name:tag@sha256:<digest>`. Each
  GitHub Action uses a full 40-character commit SHA with the version in a comment. Runners use
  `ubuntu-24.04`, never `ubuntu-latest`.
- Age rule (spec 3.4.1 rule 4, index 2.3): each pinned version and digest of this plan was published
  on or before 2026-10-03.
- pnpm in Dockerfiles: `npm install -g pnpm@12.9.0` (equal to `packageManager`). All installs in
  Docker builds use `pnpm install --frozen-lockfile`.
- Node.js `24.21.0` in the Docker base image tags (`node:24.21.0-slim`). The distroless runtime image
  also contains Node.js 24.21.0 (verified).
- `hydra-mcp`: `pnpm --filter @hydra/mcp-sidecar deploy --prod /out` after
  `pnpm install --frozen-lockfile`. Never a global npm install of Playwright MCP (spec 3.4.4).
- `hydra-session`: the fonts `fonts-noto`, `fonts-noto-cjk`, `fonts-noto-color-emoji`,
  `fonts-liberation`, `fonts-dejavu` come from `snapshot.debian.org` at the build argument
  `DEBIAN_SNAPSHOT` (spec 3.4.4, 7.7). No sandbox change before spike S1 (plan 09).
- Names (spec and index): namespaces `hydra` (Pod Security `restricted`) and `hydra-sessions`
  (`baseline`); ServiceAccount, Role, Deployment, and Service `hydra-gateway`; gateway pod label
  `app: hydra-gateway`; PVC `gateway-data`; StorageClasses `hydra-retain` and `hydra-profile`; Secret
  `hydra-secret-key`; generated ConfigMap `hydra-images`; DaemonSet `session-image-prepull`; images
  `hydra-gateway`, `hydra-session`, `hydra-mcp`, `hydra-testsite`; k3d cluster `hydra-dev`.
- Dev values (spec 4, 11.7): `http://hydra.localhost`, `http://live.hydra.localhost`,
  `HYDRA_PUBLIC_IP=127.0.0.1`. Default media port range: `52000-52099`.
- The code has no default for `HYDRA_SESSION_IMAGE` and `HYDRA_MCP_IMAGE`. Only the overlays set them
  (generated ConfigMap `hydra-images`).
- The shell scripts and tests work with bash 3.2 (macOS `/bin/bash`): no associative arrays, no
  `${var,,}`, no `mapfile`, no empty-array expansion under `set -u`.
- The SHA-256 of the k3s `install.sh` is a value in `scripts/setup-k3s.sh` (spec 3.4.5), not in
  `scripts/versions.sh`. `scripts/versions.sh` (plan 01) gives `K3S_VERSION`, `K3S_IMAGE`,
  `K3D_VERSION`; this plan appends `K3D_REGISTRY_IMAGE` with a `# renovate:` line.
- Plan 01 conventions: the dev tools are in the root `package.json` (packages have only scripts);
  `pnpm lint` runs `eslint . && prettier --check .` (Markdown is ignored); do not run `npm` commands
  inside the repository (npm enforces `devEngines.runtime`).
- AGENTS.md: no commits, the spec is not edited. Each task ends with the Checkpoint step of index
  section 3.
- Files: only index row 08 (`deploy/**`, `packages/testsite/**`, `scripts/setup-k3s.sh`,
  `scripts/dev-cluster.sh`, `.github/workflows/release.yml`), plus four appended lines in
  `scripts/versions.sh`, two appended lines in `.gitignore` (permitted by the coordinator), and the
  lockfile update that `pnpm install` makes in Task 2.

## Verified inputs (2026-10-10)

Each value below was checked with the registry APIs, `gh api`, or a local test in a scratch folder.
The tasks use these values. Do not look them up again unless a step says so.

| Item | Value | How it was verified |
|---|---|---|
| `node:24.21.0-slim` | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` (build of 2026-09-19, Debian 12, amd64 + arm64) | Docker Hub registry API; digest history in `docker-library/repo-info`. The current digest (`sha256:d6aa754f…`, built 2026-10-06) is younger than 7 days, so the plan pins the previous build. |
| Distroless Node.js 24 | `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e` (2026-10-01) | gcr.io API. Contains Node.js v24.21.0 (read from the image layer). User `65532`, entrypoint `/nodejs/bin/node`, `PATH` contains `/usr/local/bin`, no shell, no `/usr/bin/env`. `nodejs24-debian12` is deprecated (last build 2026-02-24). |
| Neko Chromium | `ghcr.io/m1k1o/neko/chromium:3.1.6@sha256:2471119c7b4010067f76f3421a78a8bcf35e3c223b2d1f4db084914ec915fb30` (2026-09-30, amd64 + arm64) | ghcr.io API. Debian 13.7 (trixie), runs as root, apt sources in deb822 `debian.sources` with `Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp`, image HEALTHCHECK `GET /health` on port 8080, `fonts-noto-color-emoji` already installed. |
| `DEBIAN_SNAPSHOT` | `20261002T203108Z` (the snapshot that `20261003T000000Z` resolves to) | snapshot.debian.org over `http://`. Font versions in it: `fonts-noto-core` 20201225-2, `fonts-noto-cjk` 1:20240730+repack1-1, `fonts-noto-color-emoji` 2.051-0+deb13u1, `fonts-liberation` 1:2.1.5-3, `fonts-dejavu-core` 2.37-8. No library dependencies. The security `Release` file has an old `Valid-Until`, so the sources need `Check-Valid-Until: no`. |
| `registry.k8s.io/pause` | `3.10.2@sha256:f548e0e8e3dc1896ca956272154dde3314e8cc4fde0a57577ee9fa1c63f5baf4` (2026-03-30) | registry.k8s.io API (newest pause tag). |
| k3d registry image | `registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8` (Docker Hub `library/registry`, 2026-09-29) | Docker Hub API. k3d 5.9.0 would otherwise use the floating tag `registry:2`. |
| Actions | `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1), `docker/login-action@dbcb813823bdd20940b903addbd779551569679f` (v4.6.0), `docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc` (v7.4.0) | `gh api` (tag → commit). `build-push-action` has the output `digest`. |
| k3s | Plan 01 pins v1.36.5+k3s1 (the "stable" channel). It bundles the Traefik chart `40.1.5+up40.1.0` (Traefik 3.7.13) and local-path-provisioner v0.0.37. The other 2026-09-30 release, v1.37.1+k3s1, bundles chart `41.4.2+up41.4.0` with the same keys. | `gh api` on `manifests/traefik.yaml` and `manifests/local-storage.yaml`. Both charts were rendered with `helm template` (k3s values plus the values of this plan): the arguments, the Service, and the PVC are as intended. |
| `install.sh` SHA-256 | v1.36.5+k3s1: `46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad` (v1.37.1+k3s1: `ed01f89fd977bf20ac1516bbebf8370bf3ddbaa55dac8aba610956a4c78cc00b`) | `curl` + `shasum -a 256`; equal to the value in plan 01. |
| k3s image tools | k3s-root v0.15.2 BusyBox has `sh`, `mkdir`, `chown`, `chmod`, `test`, `ls` (no `stat`) | `package/busybox/busybox.config` of k3s-root. `dev-cluster.sh` runs them in the k3d node. |
| kube-apiserver `--service-node-port-range` | one range only: `N-M`, `N+M`, or `N` | apimachinery `PortRange.Set` source. |
| k3s NetworkPolicy controller | kube-router v2.6.3-k3s1 supports `endPort` and always accepts traffic from the local node to pods (kubelet probes) | kube-router source. |
| local-path-provisioner v0.0.37 | rejects `pathPattern` output that does not start with `<namespace>/<pvc name>/`; the k3s setup script runs `mkdir -m 0777 -p "$VOL_DIR"` (a new folder is root-owned with mode 0777, an existing folder stays as it is) and `chmod 700 "$VOL_DIR/.."` | provisioner source and the k3s `local-path-config`. |
| k3d 5.9.0 | `k3d registry create NAME` makes the container `k3d-NAME`; `--enforce-port-match`; `--registry-use` writes the k3s mirror `k3d-NAME:PORT`; port suffix `:direct`; `k3d version` prints `k3d version v5.9.0`; `k3d cluster list NAME` fails for a missing cluster | k3d source. |
| pnpm 12.9.0 | `deploy` works without `injectWorkspacePackages`; a filtered `--prod` install gives relative links that work after a copy; default store `~/.local/share/pnpm/store` | tested on a small workspace with the `pnpm-workspace.yaml` settings of spec 3.4.3. |
| Test site toolchain | TypeScript 6.0.3, Vitest 5.0.3, Vite 8.3.2, `@types/node` 24.19.1 from the root (plan 01) | typecheck, build, and the 12 tests pass with these versions. |
| `@playwright/mcp` 0.0.83 | bin `playwright-mcp` → `cli.js` (`#!/usr/bin/env node`); no install scripts | npm registry; `pnpm deploy` test. |

## File Structure

| File | Responsibility |
|---|---|
| `deploy/lib/cluster.sh` | Shared values (gateway UID, gateway-data folder) and the media/node port range helpers of both scripts |
| `deploy/test/lib.sh`, `deploy/test/run.sh` | Assertion helpers and the runner of the deploy tests |
| `deploy/test/*.test.sh` | One test file per task: images, base, Traefik, overlays, scripts, release workflow |
| `packages/testsite/**` | `@hydra/testsite`: Node.js HTTP server that sets a cookie and redirects on request |
| `deploy/testsite/Dockerfile` (+ `.dockerignore`) | `hydra-testsite` image |
| `deploy/Dockerfile` (+ `.dockerignore`), `deploy/write-hydra-cli.sh` | `hydra-gateway` image and its `hydra` command |
| `deploy/session/Dockerfile.session` (+ `.dockerignore`) | `hydra-session` image |
| `deploy/session/Dockerfile.mcp` (+ `.dockerignore`) | `hydra-mcp` image |
| `deploy/k8s/base/*.yaml` | Namespaces, StorageClasses, RBAC, gateway, NetworkPolicies, IngressRoutes, pre-pull DaemonSet |
| `deploy/k8s/write-overlay-component.sh` | Writes the image pins (and the dev node IP) as a Kustomize Component |
| `deploy/k8s/overlays/prod/**` | Production values; `images/kustomization.yaml` is written by the release workflow |
| `deploy/k8s/overlays/dev/**` | k3d values, the test site, the egress exception; `generated/` is written by `dev-cluster.sh` and ignored by git |
| `deploy/traefik/prod.yaml`, `deploy/traefik/dev.yaml` | HelmChartConfig of the bundled Traefik |
| `scripts/setup-k3s.sh` | Production host setup (spec 11.6), with the `install.sh` hash |
| `scripts/dev-cluster.sh` | k3d dev cluster (spec 11.7) |
| `.github/workflows/release.yml` | Builds and pushes the four images, opens the prod overlay pull request |
| `scripts/versions.sh` (modify) | Appends `K3D_REGISTRY_IMAGE` |
| `.gitignore` (modify) | Appends `deploy/k8s/overlays/dev/generated/` |

Every file `.dockerignore` here is a Dockerfile-specific ignore file (`<Dockerfile>.dockerignore`).
BuildKit reads it when the build uses `-f <Dockerfile>` with the repository root as the context, so no
root `.dockerignore` is necessary.

## Review Focus

1. **The owner of the `gateway-data` folder.** The gateway runs as UID 65532 with
   `HYDRA_DATA_DIR=/data` on the PVC folder. A new local-path folder is owned by root with mode 0777,
   so the gateway could write but not set mode 0700 (spec 5.1). Decision: both scripts create
   `hydra/gateway-data` for UID 65532 with mode 0700 before the PVC exists, and local-path keeps it.
   A person expects the first deploy to start, `hydra.db` and `backups/` in that folder, and mode
   0700. If the folder came from an older PVC (root, 0777), the gateway still works and logs a warning
   (plan 02). Tests: Task 8 and Task 9 unit tests of the folder path and command; Task 3 Step 6 (Needs
   Docker) runs `hydra db backup` on both kinds of folder; Task 9 Step 7 (Needs Docker) reads the owner
   in the k3d node.
2. **Long responses through Traefik**: an MCP stream or a Neko WebSocket that is quiet for more than
   60 s. Traefik v3 cuts them at its default `readTimeout` of 60 s. A person expects no cut. Test:
   Task 6 `traefik.test.sh` (`readTimeout: "0s"` on both entry points in both files) and Task 9
   Step 7 (Needs Docker) reads the arguments of the running Traefik.
3. **A custom or wrong `HYDRA_MEDIA_PORT_RANGE`** (below 30000, above 32767, reversed, a list). A
   person expects a node port range that contains the default range and the media ports, and a clear
   stop before any change for a wrong value. Test: Task 1 `cluster.test.sh`; `main` of both scripts
   computes the range before the first change.
4. **A second run of a script** (`setup-k3s.sh` after a reboot or a pin change, `dev-cluster.sh` after
   a code change). A person expects no failure, no needless k3s restart, and the same dev Secret
   `hydra-secret-key` (a new root key makes all passwords and tokens invalid). Test: Task 8
   `setup-k3s.test.sh` (`k3s_action` cases); Task 9 Step 8 (Needs Docker) runs `dev-cluster.sh` twice
   and compares the Secret.
5. **A second run of the release workflow for the same commit.** A person expects no second pull
   request and no failure, and no change when the digests are equal. Test: Task 7 `overlays.test.sh`
   ("writer output is deterministic"); the workflow of Task 10 checks `git diff --quiet` and
   `gh pr view`.

## Spec deviations

1. **`service-node-port-range` (spec 11.6 step 5 and 11.7). Needs a user decision.**
   kube-apiserver accepts one range only (`N-M`, `N+M`, or `N`; apimachinery `PortRange.Set`). The
   plan 04 writer verified on kube-apiserver v1.37.0 that `30000-32767,52000-52099` stops the server:
   `invalid argument "30000-32767,52000-52099" for "--service-node-port-range" flag: strconv.Atoi:
   parsing "32767,52000-52099": invalid syntax`. The plan uses the most conservative value that
   contains both ranges: `30000-52099` (for another `HYDRA_MEDIA_PORT_RANGE`, both scripts write the
   one range from `min(30000, first media port)` to `max(32767, last media port)`). Known effect: an
   automatic node port of another Service (for example the Traefik LoadBalancer Service) can now fall
   into the media range, and then that media port fails. This plan adds no other mechanism; the user
   decides (for example a spec change, or fixed Traefik node ports).
2. **`pathPattern` (spec 5.2).** local-path-provisioner v0.0.37 (bundled with all k3s releases of
   2026-09-30) rejects a rendered path that does not start with `<namespace>/<pvc name>/`, so the spec
   value `"{{ .PVC.Namespace }}/{{ .PVC.Name }}"` fails each provisioning. The StorageClasses use
   `'{{ .PVC.Namespace }}/{{ .PVC.Name }}/'`. The provisioner joins the path with `filepath.Join`,
   which removes the trailing slash, so the folders are exactly the folders of spec 5.2. Spike S4
   still verifies the behavior.
3. **First admin command (spec 6.3, 11.6 step 11).** `kubectl exec` needs `-it` for the password
   prompt. The next steps of `setup-k3s.sh` print
   `kubectl exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>`.

Decisions where the spec is silent (not deviations): `setup-k3s.sh` step 4 and `dev-cluster.sh` also
create the `gateway-data` volume folder for UID 65532 with mode 0700 (plan 02 asks plan 08 to decide
the owner; `fsGroup` does not apply to local-path `hostPath` volumes, and an init container cannot
chown under Pod Security `restricted`); `setup-k3s.sh` stops before any change if `K3S_VERSION` is
not the version of its `install.sh` hash; the gateway also has a startup probe on `/healthz`
(migrations at start); `dev-cluster.sh` creates `hydra-secret-key` with a random key if it does not
exist; the k3d registry image is pinned (`K3D_REGISTRY_IMAGE`); release images are `linux/amd64` only
(x86_64 EC2 types; add `linux/arm64` and QEMU for Graviton); the prod overlay holds example hostnames
and IPs from the documentation ranges that the operator replaces; the base uses sentinel values
(`hydra.invalid`, `192.0.2.1/32`) that each overlay replaces; the gateway reads the root key from the
Secret key `HYDRA_SECRET_KEY`.

## Index issues

1. **`scripts/versions.sh` (plan 01; no contract in index section 5).** This plan reads `K3S_VERSION`,
   `K3S_IMAGE`, and `K3D_VERSION` (plan 01 names) and appends `K3D_REGISTRY_IMAGE` after a
   `# renovate: datasource=docker depName=registry` line (the regex manager of plan 01 matches it,
   verified). The `install.sh` hash is not in this file: `scripts/setup-k3s.sh` holds
   `K3S_INSTALL_SH_VERSION` and `K3S_INSTALL_SH_SHA256` (spec 3.4.5), so `K3S_INSTALL_SHA256` leaves
   plan 01. The README section "Update k3s" (plan 01) should name these two values. Proposal: add a
   `scripts/versions.sh` contract to the index.
2. **Test site contract (new; plan 10 needs it).** Inside the cluster:
   `http://testsite.hydra-testsite.svc.cluster.local/` (allowlist host
   `testsite.hydra-testsite.svc.cluster.local`). `GET /set-cookie?value=<1 to 64 of A-Za-z0-9_->`
   sets `hydra_testsite=<value>; Max-Age=2592000; Path=/; SameSite=Lax` (persistent, readable by
   `document.cookie`). `GET /` shows `<p id="cookie">hydra_testsite=<value or (none)></p>`.
   `GET /cookies` returns `{"cookies":{...}}`. `GET /redirect?to=<absolute http or https URL>`
   answers 302. `GET /healthz` returns `ok`. Proposal: add it to the index.
3. **Owner of `HYDRA_DATA_DIR` (plan 02 asks plan 08 to decide).** Decision: `setup-k3s.sh` (step 4)
   and `dev-cluster.sh` create the volume folder `hydra/gateway-data` for UID 65532 (the gateway user)
   with mode 0700 before the PVC exists; local-path keeps the existing folder. The gateway's
   `chmod 0700` then succeeds. A folder from an older PVC (root, 0777) still works with the warning of
   plan 02. The index could record the UID 65532 next to the image names.
4. **`hydra` bin (plan 03).** `packages/server/package.json` needs `"bin": { "hydra": "<file in dist>" }`.
   The image build reads it. The CLI must run when it is imported; a "main module" check that compares
   `import.meta.url` with `process.argv[1]` works, because the wrapper sets `process.argv[1]`. The
   smoke test of Task 3 uses `hydra keygen` and `hydra db backup` (spec 6.1, 5.1).
5. **Web build folder.** The `Config` of index 5.3 has no field for it. The image keeps the repository
   layout (`/app/packages/web/dist` next to `/app/packages/server/dist`), so a default relative to the
   server package works. If plan 03 reads an environment variable instead, set it with `ENV` in
   `deploy/Dockerfile`.
6. **`KubeClient` (plan 04, index 5.10).** `ping()` must use only calls that the Role of spec 11.2
   allows (for example `GET /version`, or a list in `hydra-sessions`): the gateway has no cluster-wide
   rights. `watch()` also sees the pods of `session-image-prepull` in `hydra-sessions`; they have no
   `app.kubernetes.io/managed-by: hydra` label, so the reconciler must ignore them.
7. **`scripts/check-repo.ts` (plan 01).** The rules of plan 01 (its index issue 8) fit the files of
   this plan: each `FROM` names a pinned image literally, `pnpm@12.9.0`, `node:24.21.0-slim`, the major
   version `nodejs24` for distroless, our four image names without a registry in `deploy/**` YAML, a
   digest for `K3D_REGISTRY_IMAGE`, equal Traefik timeouts. This plan adds no file type, so it does not
   change `check-repo.ts`.
8. **`pnpm-lock.yaml`, `.gitignore`, and the Vitest projects (plan 01).** Task 2 runs `pnpm install`,
   which adds the `packages/testsite` importer to the lockfile. Task 7 appends the generated dev
   overlay folder to `.gitignore` (permitted). The root project glob `packages/*/vitest.config.ts`
   already includes the test site.
9. **CI (plan 10 owns the `ci.yml` changes).** Add `bash deploy/test/run.sh` to CI. It needs `node` and
   `kubectl`, which the `ubuntu-24.04` runner has.
10. **Host development mode of spec 11.7 has no owner (plan 01, index issue 6).** Scaling the
    in-cluster gateway to 0 and running the server on the host with the k3d `KUBECONFIG` and
    `HYDRA_SESSION_TRANSPORT=port-forward` is not in this plan: it needs the dev ports and URLs of
    plans 03 and 07. Proposal: the index gives it to one plan, for example as a `dev-env` subcommand of
    `scripts/dev-cluster.sh` (it can reuse `KUBE_CONTEXT` and `k3d kubeconfig write hydra-dev`).
11. **Facts shared with other plans.** Plan 04 runs the `mcp` container with
    `command: ['playwright-mcp', ...]` as UID 1000, and plan 10 runs a network probe with `node` in
    that container: the `hydra-mcp` image has both on `PATH` and runs as UID 1000 (Task 4 Step 6
    checks it). Plan 04 runs the init container with `sh -c 'rm -f .../Singleton*'` as UID 1000 from
    the session image (Debian, has `sh`). Plan 04 checks the media node ports with a real create and
    delete of a temporary NodePort Service `hydra-port-check-<port>` in `hydra-sessions`: the Role of
    Task 5 grants all verbs on Services there, also `create` and `delete`. The range `30000-52099`
    (Spec deviation 1) contains the default media ports. In the dev cluster,
    browsers and curl resolve `*.localhost`; a Node.js client on macOS can fail to resolve
    `hydra.localhost` (plan 10). The media port range of the NetworkPolicy is the default range; a
    changed `HYDRA_MEDIA_PORT_RANGE` needs a patch of `sessions-ingress-media` in the overlay.

---

### Task 1: Deploy test harness and the shared cluster helpers

**Files:**
- Create: `deploy/test/lib.sh`
- Create: `deploy/test/run.sh`
- Create: `deploy/lib/cluster.sh`
- Test: `deploy/test/cluster.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `deploy/test/lib.sh` (source it): `HYDRA_REPO_DIR` (the repository root), `pass NAME`,
    `fail NAME`, `assert_eq NAME EXPECTED ACTUAL`, `assert_contains NAME TEXT NEEDLE`,
    `assert_not_contains NAME TEXT NEEDLE`, `assert_fails NAME COMMAND...`,
    `count_lines TEXT NEEDLE`, `k8s_doc TEXT KIND NAME` (one document of a `kubectl kustomize`
    output), `finish_tests` (exit 1 if an assertion failed).
  - `deploy/test/run.sh`: runs each `deploy/test/*.test.sh` with bash; exit 1 if one fails.
  - `deploy/lib/cluster.sh` (source it): `HYDRA_GATEWAY_UID=65532` (user of the gateway image and
    Deployment), `HYDRA_GATEWAY_DATA_PATH=hydra/gateway-data` (volume folder below the local-path
    storage folder, spec 5.2), `hydra_media_ports RANGE` (prints `FIRST LAST` or fails with a
    message), `hydra_node_port_range RANGE` (prints the k3s node port range, for example
    `30000-52099`, or fails).

- [ ] **Step 1: Write the test helpers**

Create `deploy/test/lib.sh`:

```bash
# shellcheck shell=bash
# Assertion helpers for the deploy tests. Source this file. Works with bash 3.2 (macOS).
# shellcheck disable=SC2034 # used by the test files that source this file
HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FAILURES=0

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  TEST_FAILURES=$((TEST_FAILURES + 1))
}

# assert_eq NAME EXPECTED ACTUAL
assert_eq() {
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    fail "$1"
    printf '  expected: %s\n  actual:   %s\n' "$2" "$3" >&2
  fi
}

# assert_contains NAME TEXT NEEDLE
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1 (missing: $3)"; fi
}

# assert_not_contains NAME TEXT NEEDLE
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then pass "$1"; else fail "$1 (unexpected: $3)"; fi
}

# assert_fails NAME COMMAND... : the command must exit with a non-zero status
assert_fails() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$name (command succeeded)"; else pass "$name"; fi
}

# count_lines TEXT NEEDLE : number of lines of TEXT that contain NEEDLE
count_lines() {
  printf '%s\n' "$1" | grep -cF -- "$2" || true
}

# k8s_doc TEXT KIND NAME : prints the document with this kind and metadata.name from a
# `kubectl kustomize` output (kustomize writes keys in sorted order, two-space indent).
k8s_doc() {
  printf '%s\n' "$1" | awk -v kind="$2" -v name="$3" '
    function flush() {
      if (k && n) printf "%s", doc
      doc = ""; k = 0; n = 0; meta = 0
    }
    /^---$/ { flush(); next }
    { doc = doc $0 "\n" }
    /^[^ ]/ { meta = ($0 == "metadata:") }
    $0 == "kind: " kind { k = 1 }
    meta && $0 == "  name: " name { n = 1 }
    END { flush() }
  '
}

finish_tests() {
  if ((TEST_FAILURES > 0)); then
    printf '%d test(s) failed\n' "$TEST_FAILURES" >&2
    exit 1
  fi
  echo "all tests passed"
}
```

Create `deploy/test/run.sh`:

```bash
#!/usr/bin/env bash
# Runs all deploy tests: bash deploy/test/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
status=0
for test_file in ./*.test.sh; do
  echo "== ${test_file#./}"
  bash "$test_file" || status=1
done
exit "$status"
```

Run: `chmod +x deploy/test/run.sh`

- [ ] **Step 2: Write the failing test**

Create `deploy/test/cluster.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for deploy/lib/cluster.sh: bash deploy/test/cluster.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

assert_eq 'default media range' '30000-52099' "$(hydra_node_port_range 52000-52099)"
assert_eq 'media range inside the default range' '30000-32767' "$(hydra_node_port_range 31000-31009)"
assert_eq 'media range below 30000' '20000-32767' "$(hydra_node_port_range 20000-20099)"
assert_eq 'media range above 32767' '30000-40009' "$(hydra_node_port_range 40000-40009)"
assert_fails 'leading zero is rejected' hydra_node_port_range 052000-052099
assert_eq 'media ports' '52000 52099' "$(hydra_media_ports 52000-52099)"
assert_fails 'comma list is rejected' hydra_node_port_range 30000-32767,52000-52099
assert_fails 'missing last port is rejected' hydra_node_port_range 52000
assert_fails 'reversed range is rejected' hydra_node_port_range 52099-52000
assert_fails 'port above 65535 is rejected' hydra_node_port_range 65000-65536
assert_fails 'privileged port is rejected' hydra_node_port_range 80-90
assert_fails 'empty value is rejected' hydra_node_port_range ''
assert_eq 'gateway user' '65532' "$HYDRA_GATEWAY_UID"
assert_eq 'gateway-data folder of spec 5.2' 'hydra/gateway-data' "$HYDRA_GATEWAY_DATA_PATH"
finish_tests
```

- [ ] **Step 3: Run the test to verify that it fails**

Run: `bash deploy/test/cluster.test.sh`
Expected: FAIL with `deploy/test/cluster.test.sh: line 5: <repo>/deploy/lib/cluster.sh: No such file or directory`.
In the expected messages of this plan, `<repo>` stands for the absolute path of the repository.

- [ ] **Step 4: Write the helpers**

Create `deploy/lib/cluster.sh`:

```bash
# shellcheck shell=bash
# Shared values and helpers of scripts/setup-k3s.sh and scripts/dev-cluster.sh (spec sections 5,
# 11.6, 11.7). Source this file. It defines values and functions only. It works with bash 3.2.

# The user of the hydra-gateway image (deploy/Dockerfile) and Deployment (deploy/k8s/base/gateway.yaml).
# shellcheck disable=SC2034 # used by the scripts that source this file
HYDRA_GATEWAY_UID=65532
# The folder of the gateway-data volume below the local-path storage folder (spec section 5.2). The
# scripts create it for the gateway user with mode 0700 before the PVC exists. local-path-provisioner
# keeps an existing folder (its setup script runs mkdir -p), so the non-root gateway owns
# HYDRA_DATA_DIR (spec section 5.1).
# shellcheck disable=SC2034 # used by the scripts that source this file
HYDRA_GATEWAY_DATA_PATH=hydra/gateway-data

# Prints "FIRST LAST" for a media port range "FIRST-LAST", or fails with a message on stderr.
hydra_media_ports() {
  local range="$1"
  if [[ ! "$range" =~ ^([1-9][0-9]{0,4})-([1-9][0-9]{0,4})$ ]]; then
    echo "HYDRA_MEDIA_PORT_RANGE must look like 52000-52099, got '$range'" >&2
    return 1
  fi
  local first="${BASH_REMATCH[1]}" last="${BASH_REMATCH[2]}"
  if ((first < 1024 || last > 65535 || first > last)); then
    echo "HYDRA_MEDIA_PORT_RANGE must be inside 1024-65535 with FIRST <= LAST, got '$range'" >&2
    return 1
  fi
  echo "$first $last"
}

# Prints the k3s service-node-port-range for a media port range: one range that contains the
# default NodePort range 30000-32767 and the media ports. kube-apiserver accepts only one range,
# so "30000-32767,52000-52099" is not valid.
hydra_node_port_range() {
  local ports first last
  ports="$(hydra_media_ports "$1")" || return 1
  first="${ports% *}"
  last="${ports#* }"
  if ((first > 30000)); then first=30000; fi
  if ((last < 32767)); then last=32767; fi
  echo "$first-$last"
}
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `bash deploy/test/cluster.test.sh && /bin/bash deploy/test/cluster.test.sh | tail -n 1`
Expected: 14 lines `ok   ...`, `all tests passed`, then `all tests passed` again (`/bin/bash` is
bash 3.2 on macOS).

Run: `bash deploy/test/run.sh`
Expected: `== cluster.test.sh` and `all tests passed`, exit 0.

- [ ] **Step 6: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 2: `@hydra/testsite` and the `hydra-testsite` image

**Files:**
- Create: `packages/testsite/package.json`
- Create: `packages/testsite/tsconfig.json`
- Create: `packages/testsite/tsconfig.build.json`
- Create: `packages/testsite/vitest.config.ts`
- Create: `packages/testsite/src/server.ts`
- Create: `packages/testsite/src/main.ts`
- Create: `deploy/testsite/Dockerfile`
- Create: `deploy/testsite/Dockerfile.dockerignore`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)
- Test: `packages/testsite/src/server.test.ts`, `deploy/test/testsite-image.test.sh`

**Interfaces:**
- Consumes: `tsconfig.base.json` and the root dev tools of plan 01 (`typescript`, `vitest`, `vite`,
  `@types/node` in the root `package.json`; packages declare no devDependencies); `packageManager` of
  the root `package.json`; `deploy/test/lib.sh` (Task 1).
- Produces:
  - `packages/testsite/src/server.ts`: `createTestsiteServer(): Server`,
    `COOKIE_NAME = 'hydra_testsite'`, `COOKIE_MAX_AGE_SECONDS = 2_592_000`.
  - HTTP contract (Index issue 2, used by plan 10 and by the dev overlay of Task 7):
    `GET /healthz` → `200 ok`; `GET /set-cookie?value=V` (`V` = 1 to 64 of `A-Za-z0-9_-`) → 200 and
    `Set-Cookie: hydra_testsite=V; Max-Age=2592000; Path=/; SameSite=Lax`, else 400;
    `GET /` → HTML with `<p id="cookie">hydra_testsite=<value or (none)></p>`;
    `GET /cookies` → `{"cookies":{...}}`; `GET /redirect?to=<absolute http or https URL>` → 302 to
    it, else 400; other methods → 405; other paths → 404; all responses `Cache-Control: no-store`.
  - Image `hydra-testsite`: runs `node /app/dist/main.js` as UID 1000, port from `PORT` (default
    8080), works with a read-only root filesystem.

- [ ] **Step 1: Check the root dev tools of plan 01**

Run: `grep -E '"(typescript|vitest|vite|@types/node)":' package.json`
Expected:

```text
    "@types/node": "24.19.1",
    "typescript": "6.0.3",
    "vite": "8.3.2",
    "vitest": "5.0.3"
```

Like the packages of plan 01, `@hydra/testsite` uses these root tools and declares no
devDependencies. The test site code was checked with exactly these versions.

- [ ] **Step 2: Create the package files**

Create `packages/testsite/package.json`:

```json
{
  "name": "@hydra/testsite",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Create `packages/testsite/tsconfig.json` (typecheck of the sources and the tests; the root
`tsconfig.json` of plan 01 typechecks `packages/*/vitest.config.ts`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `packages/testsite/tsconfig.build.json` (build to `dist` without the tests, as in plan 01):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "customConditions": []
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

Create `packages/testsite/vitest.config.ts` (the pattern of plan 01; the root project glob
`packages/*/vitest.config.ts` picks it up):

```ts
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run on the TypeScript source of workspace packages (export condition @hydra/source).
  ssr: { resolve: { conditions: ['@hydra/source', ...defaultServerConditions] } },
  test: {
    name: 'testsite',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Add the package to the workspace**

Run: `pnpm install`
Expected: exit 0. Then `grep -n '^  packages/testsite:' pnpm-lock.yaml` prints one line (the new
importer; no new packages, because the test site has no dependencies).

- [ ] **Step 4: Write the failing test**

Create `packages/testsite/src/server.test.ts`:

```ts
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, createTestsiteServer } from './server.js';

const server = createTestsiteServer();
let baseUrl = '';

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
}

describe('testsite', () => {
  it('answers the health check', async () => {
    const response = await get('/healthz');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
  });

  it('sets a persistent cookie', async () => {
    const response = await get('/set-cookie?value=abc_123');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(
      `${COOKIE_NAME}=abc_123; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`,
    );
    expect(await response.text()).toContain(`${COOKIE_NAME}=abc_123`);
  });

  it('rejects a cookie value that is missing or has other characters', async () => {
    expect((await get('/set-cookie')).status).toBe(400);
    expect((await get('/set-cookie?value=a%3Bb')).status).toBe(400);
    expect((await get(`/set-cookie?value=${'x'.repeat(65)}`)).status).toBe(400);
  });

  it('shows the cookie that the browser sends', async () => {
    const response = await get('/', { cookie: `other=1; ${COOKIE_NAME}=xyz` });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain(`<p id="cookie">${COOKIE_NAME}=xyz</p>`);
  });

  it('shows (none) without the cookie', async () => {
    expect(await (await get('/')).text()).toContain(`<p id="cookie">${COOKIE_NAME}=(none)</p>`);
  });

  it('escapes HTML in a cookie value from the request', async () => {
    const body = await (await get('/', { cookie: `${COOKIE_NAME}=<b>"x"` })).text();
    expect(body).toContain(`${COOKIE_NAME}=&lt;b&gt;&quot;x&quot;`);
    expect(body).not.toContain('<b>');
  });

  it('returns the cookies as JSON', async () => {
    const response = await get('/cookies', { cookie: `${COOKIE_NAME}=v1; a=b` });
    expect(await response.json()).toEqual({ cookies: { [COOKIE_NAME]: 'v1', a: 'b' } });
  });

  it('redirects to an absolute http or https URL', async () => {
    const response = await get('/redirect?to=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/path?q=1');
  });

  it('rejects a redirect target that is not an absolute http or https URL', async () => {
    expect((await get('/redirect')).status).toBe(400);
    expect((await get('/redirect?to=%2Frelative')).status).toBe(400);
    expect((await get('/redirect?to=javascript%3Aalert(1)')).status).toBe(400);
  });

  it('allows only GET and HEAD', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect((await fetch(`${baseUrl}/healthz`, { method: 'HEAD' })).status).toBe(200);
  });

  it('returns 404 for an unknown path', async () => {
    expect((await get('/nope')).status).toBe(404);
  });

  it('turns off caching', async () => {
    expect((await get('/')).headers.get('cache-control')).toBe('no-store');
  });
});
```

- [ ] **Step 5: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/testsite test`
Expected: FAIL with `Error: Cannot find module './server.js' imported from .../src/server.test.ts`.

- [ ] **Step 6: Write the server**

Create `packages/testsite/src/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// Test site for the e2e tests (spec section 15.3). Session pods reach it in the dev overlay at
// http://testsite.hydra-testsite.svc.cluster.local/. It sets a cookie and redirects on request.

export const COOKIE_NAME = 'hydra_testsite';
/** 30 days: a persistent cookie, so it is still there after a session stop and start. */
export const COOKIE_MAX_AGE_SECONDS = 2_592_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

export function createTestsiteServer(): Server {
  return createServer(handleRequest);
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed\n');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://testsite.invalid');
  switch (url.pathname) {
    case '/healthz':
      sendText(response, 200, 'ok\n');
      return;
    case '/':
      sendHtml(response, 200, homePage(readCookies(request)));
      return;
    case '/cookies':
      sendJson(response, 200, { cookies: readCookies(request) });
      return;
    case '/set-cookie':
      setCookie(url, response);
      return;
    case '/redirect':
      redirect(url, response);
      return;
    default:
      sendText(response, 404, 'Not Found\n');
  }
}

function setCookie(url: URL, response: ServerResponse): void {
  const value = url.searchParams.get('value') ?? '';
  if (!COOKIE_VALUE.test(value)) {
    sendText(response, 400, 'value must be 1 to 64 characters of A-Z a-z 0-9 _ -\n');
    return;
  }
  response.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`,
  );
  sendHtml(response, 200, page('Cookie set', `<p id="cookie">${COOKIE_NAME}=${value}</p>`));
}

function redirect(url: URL, response: ServerResponse): void {
  const target = url.searchParams.get('to') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendText(response, 400, 'to must be an absolute http or https URL\n');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendText(response, 400, 'to must be an absolute http or https URL\n');
    return;
  }
  response.statusCode = 302;
  response.setHeader('Location', parsed.href);
  response.end();
}

function readCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function homePage(cookies: Record<string, string>): string {
  const value = cookies[COOKIE_NAME];
  return page(
    'Hydra test site',
    `<p id="cookie">${COOKIE_NAME}=${value === undefined ? '(none)' : escapeHtml(value)}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>\n`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendText(response: ServerResponse, status: number, body: string): void {
  send(response, status, 'text/plain; charset=utf-8', body);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, 'text/html; charset=utf-8', body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json; charset=utf-8', `${JSON.stringify(body)}\n`);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.end(body);
}
```

Create `packages/testsite/src/main.ts`:

```ts
import { createTestsiteServer } from './server.js';

const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a port number, got "${process.env.PORT ?? ''}"`);
  process.exit(1);
}

const server = createTestsiteServer();
server.listen(port, '0.0.0.0', () => {
  console.log(`hydra-testsite listens on port ${port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 7: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/testsite test`
Expected: `Test Files  1 passed (1)` and `Tests  12 passed (12)`.

- [ ] **Step 8: Typecheck, build, and run the built server**

Run: `pnpm --filter @hydra/testsite typecheck && pnpm --filter @hydra/testsite build && ls packages/testsite/dist`
Expected: no errors, then `main.d.ts`, `main.js`, `server.d.ts`, `server.js` (no test file).

Run:

```bash
PORT=18931 node packages/testsite/dist/main.js & pid=$!; sleep 1
curl -fsS http://127.0.0.1:18931/healthz
curl -fsS -D - -o /dev/null 'http://127.0.0.1:18931/set-cookie?value=e2e' | grep -i '^set-cookie'
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' 'http://127.0.0.1:18931/redirect?to=https://example.org/'
kill "$pid"
```

Expected:

```text
hydra-testsite listens on port 18931
ok
Set-Cookie: hydra_testsite=e2e; Max-Age=2592000; Path=/; SameSite=Lax
302 https://example.org/
```

Run: `PORT=abc node packages/testsite/dist/main.js; echo "exit=$?"`
Expected: `PORT must be a port number, got "abc"` and `exit=1`.

- [ ] **Step 9: Write the failing image test**

Create `deploy/test/testsite-image.test.sh`:

```bash
#!/usr/bin/env bash
# Static tests for deploy/testsite/Dockerfile: bash deploy/test/testsite-image.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file="$HYDRA_REPO_DIR/deploy/testsite/Dockerfile"
text="$(cat "$file")"
node_image='node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"

assert_eq 'both stages use the pinned node image' '2' "$(count_lines "$text" "FROM $node_image")"
assert_eq 'every FROM line has a digest' '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
assert_contains 'pnpm version of packageManager' "$text" "npm install -g $package_manager"
assert_contains 'frozen lockfile' "$text" 'pnpm install --frozen-lockfile'
assert_contains 'pnpm deploy of the test site' "$text" 'pnpm --filter @hydra/testsite deploy --prod /out'
assert_contains 'non-root numeric user' "$text" 'USER 1000:1000'
assert_eq 'build context filter' 'yes' "$([[ -f "$file.dockerignore" ]] && echo yes)"
finish_tests
```

Run: `bash deploy/test/testsite-image.test.sh`
Expected: FAIL with `cat: <repo>/deploy/testsite/Dockerfile: No such file or directory`.

- [ ] **Step 10: Write the Dockerfile**

Create `deploy/testsite/Dockerfile`:

```dockerfile
# hydra-testsite image: @hydra/testsite, used only by the dev overlay (spec sections 11.1, 15.3).
# Build from the repository root: docker build -f deploy/testsite/Dockerfile .

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
RUN npm install -g pnpm@12.9.0
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm --filter @hydra/testsite run build \
    && pnpm --filter @hydra/testsite deploy --prod /out

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/main.js"]
```

Create `deploy/testsite/Dockerfile.dockerignore`:

```text
# Build context filter for deploy/testsite/Dockerfile (BuildKit reads <Dockerfile>.dockerignore).
.git
**/node_modules
**/dist
**/.data
**/coverage
**/test-results
**/playwright-report
**/*.log
**/.DS_Store
deploy/k8s/overlays/dev/generated
```

- [ ] **Step 11: Run the image test to verify that it passes**

Run: `bash deploy/test/testsite-image.test.sh`
Expected: 7 lines `ok   ...` and `all tests passed`.

- [ ] **Step 12: Build and run the image (Needs Docker)**

Needs Docker. Run from the repository root:

```bash
docker build -f deploy/testsite/Dockerfile -t hydra-testsite:local .
docker run -d --rm --name hydra-testsite-smoke --read-only -p 127.0.0.1:18080:8080 hydra-testsite:local
sleep 1
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS -D - -o /dev/null 'http://127.0.0.1:18080/set-cookie?value=smoke' | grep -i '^set-cookie'
docker exec hydra-testsite-smoke id -u
docker stop hydra-testsite-smoke
```

Expected: the build succeeds, then `ok`,
`Set-Cookie: hydra_testsite=smoke; Max-Age=2592000; Path=/; SameSite=Lax`, `1000`, and
`hydra-testsite-smoke`.

- [ ] **Step 13: Format**

Run: `pnpm exec prettier --write packages/testsite`
Expected: the files are unchanged or only reformatted (no content change).

- [ ] **Step 14: Checkpoint**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/testsite test && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 3: `hydra-gateway` image

**Files:**
- Create: `deploy/write-hydra-cli.sh`
- Create: `deploy/Dockerfile`
- Create: `deploy/Dockerfile.dockerignore`
- Test: `deploy/test/gateway-image.test.sh`

**Interfaces:**
- Consumes: the `build` script of `@hydra/server` and `@hydra/web` (to `dist`), the `hydra` bin of
  `packages/server/package.json` (Index issue 4), `deploy/test/lib.sh` and `HYDRA_GATEWAY_UID` of
  `deploy/lib/cluster.sh` (Task 1).
- Produces: image `hydra-gateway`. Layout: `/app/node_modules` (production dependencies),
  `/app/packages/server` (with `dist`, `drizzle`, and the other package files),
  `/app/packages/shared`, `/app/packages/web/dist`. Entrypoint `/nodejs/bin/node`, command
  `/app/packages/server/dist/main.js`, user `65532:65532`, port 8080. `hydra` is on `PATH`
  (`/usr/local/bin/hydra`), so `kubectl exec ... -- hydra user create` works without a shell. The
  root filesystem can be read-only; the Deployment of Task 5 mounts `/data` (`HYDRA_DATA_DIR`) and
  `/tmp`.

Why `hydra` works in a distroless image: the image has no shell and no `/usr/bin/env`, so a shell
wrapper or a symlink to a script with `#!/usr/bin/env node` cannot run. `deploy/write-hydra-cli.sh`
writes a small Node.js script with the absolute shebang `#!/nodejs/bin/node`. The kernel runs the
shebang, so no shell is necessary. The script sets `process.argv[1]` to the real path of the CLI file
(so a "main module" check passes) and imports the CLI.

- [ ] **Step 1: Write the failing test**

Create `deploy/test/gateway-image.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for deploy/Dockerfile and deploy/write-hydra-cli.sh: bash deploy/test/gateway-image.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

file="$HYDRA_REPO_DIR/deploy/Dockerfile"
text="$(cat "$file")"
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"
assert_contains 'build stage uses the pinned node image' "$text" \
  'FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build'
assert_contains 'runtime is the pinned distroless Node.js 24' "$text" \
  'FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e'
assert_eq 'every FROM line has a digest' '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
assert_contains 'pnpm version of packageManager' "$text" "npm install -g $package_manager"
assert_contains 'frozen lockfile' "$text" 'pnpm install --frozen-lockfile'
assert_contains 'production dependencies only' "$text" 'pnpm install --frozen-lockfile --prod --filter "@hydra/server..."'
assert_contains 'hydra on PATH' "$text" 'COPY --from=build /out/hydra /usr/local/bin/hydra'
assert_contains 'non-root numeric user of deploy/lib/cluster.sh' "$text" "USER $HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID"
assert_contains 'build context filter excludes node_modules' "$(cat "$file.dockerignore")" '**/node_modules'

work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/server/dist/cli"
cat >"$work/server/package.json" <<'JSON'
{ "name": "@hydra/server", "type": "module", "bin": { "hydra": "./dist/cli/main.js" } }
JSON
# A fake CLI that runs only when it is the main module, like many ESM CLIs.
cat >"$work/server/dist/cli/main.js" <<'JS'
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`cli ${process.argv.slice(2).join(' ')}`);
}
JS

sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" "$work/server" "$work/hydra" "$(command -v node)"
assert_eq 'shebang is the given node binary' "#!$(command -v node)" "$(head -n 1 "$work/hydra")"
assert_contains 'resolves the CLI path' "$(cat "$work/hydra")" "realpathSync(\"$work/server/dist/cli/main.js\")"
assert_eq 'wrapper is executable' 'yes' "$([[ -x "$work/hydra" ]] && echo yes || echo no)"
assert_eq 'runs the CLI with its arguments' 'cli user create --admin' "$("$work/hydra" user create --admin)"

sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app/packages/server "$work/hydra-image"
assert_eq 'default shebang is the distroless node' '#!/nodejs/bin/node' "$(head -n 1 "$work/hydra-image")"
assert_contains 'uses the CLI path in the image' "$(cat "$work/hydra-image")" 'realpathSync("/app/packages/server/dist/cli/main.js")'

printf '{ "name": "@hydra/server" }\n' >"$work/server/package.json"
assert_fails 'fails without a hydra bin' sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app "$work/x"
printf '{ "bin": { "hydra": "./dist/missing.js" } }\n' >"$work/server/package.json"
assert_fails 'fails when the bin is not built' sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app "$work/x"
finish_tests
```

Run: `bash deploy/test/gateway-image.test.sh`
Expected: FAIL with `cat: <repo>/deploy/Dockerfile: No such file or directory`.

- [ ] **Step 2: Write the `hydra` wrapper writer**

Create `deploy/write-hydra-cli.sh`:

```bash
#!/bin/sh
# Writes the `hydra` command of the hydra-gateway image (spec section 11.1).
#
# The distroless runtime image has no shell, so `hydra` cannot be a shell wrapper or a symlink to a
# script with "#!/usr/bin/env node" (there is no /usr/bin/env). It is a small Node.js script with the
# absolute shebang of the distroless Node.js binary. The kernel runs the shebang, so
# `kubectl exec ... -- hydra user create` works without a shell. The script sets process.argv[1] to
# the real path of the CLI file, so a "main module" check in the CLI still passes, and imports the CLI.
#
# Usage: write-hydra-cli.sh SERVER_PACKAGE_DIR SERVER_DIR_IN_IMAGE OUTPUT_FILE [NODE_PATH]
#   SERVER_PACKAGE_DIR   packages/server in the build stage (its package.json has bin.hydra)
#   SERVER_DIR_IN_IMAGE  the same folder in the runtime image, for example /app/packages/server
#   NODE_PATH            the Node.js binary of the runtime image (default /nodejs/bin/node)
set -eu

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 SERVER_PACKAGE_DIR SERVER_DIR_IN_IMAGE OUTPUT_FILE [NODE_PATH]" >&2
  exit 2
fi
package_dir="$(cd "$1" && pwd)"
image_dir="$2"
output="$3"
node_path="${4:-/nodejs/bin/node}"

bin="$(node -p 'require(process.argv[1]).bin?.hydra ?? ""' "$package_dir/package.json")"
if [ -z "$bin" ]; then
  echo "$package_dir/package.json has no \"bin\": { \"hydra\": ... } entry" >&2
  exit 1
fi
if [ ! -f "$package_dir/$bin" ]; then
  echo "the hydra bin $package_dir/$bin does not exist; build @hydra/server first" >&2
  exit 1
fi

node - "$image_dir" "$bin" "$output" "$node_path" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [imageDir, bin, output, nodePath] = process.argv.slice(2);
const target = path.posix.join(imageDir, bin);
const lines = [
  `#!${nodePath}`,
  '// hydra CLI (generated by deploy/write-hydra-cli.sh)',
  `const cli = require('node:fs').realpathSync(${JSON.stringify(target)});`,
  'process.argv[1] = cli;',
  "import(require('node:url').pathToFileURL(cli).href);",
  '',
];
fs.writeFileSync(output, lines.join('\n'), { mode: 0o755 });
NODE
```

Run: `chmod +x deploy/write-hydra-cli.sh`

- [ ] **Step 3: Write the Dockerfile**

Create `deploy/Dockerfile`:

```dockerfile
# hydra-gateway image: @hydra/server and the built @hydra/web (spec sections 3.4.4, 11.1).
# Build from the repository root: docker build -f deploy/Dockerfile .
# The build context is filtered by deploy/Dockerfile.dockerignore.

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
RUN npm install -g pnpm@12.9.0
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter "@hydra/server..." --filter "@hydra/web..." run build
# Keep only the production dependencies of @hydra/server and of its workspace dependency
# @hydra/shared, in the same workspace layout. The pnpm links are relative, so the tree works
# after the copy to /app.
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    rm -rf node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --filter "@hydra/server..."
RUN mkdir -p /out/app/packages/web \
    && cp -a node_modules /out/app/ \
    && cp -a packages/server packages/shared /out/app/packages/ \
    && cp -a packages/web/dist /out/app/packages/web/dist \
    && sh deploy/write-hydra-cli.sh packages/server /app/packages/server /out/hydra

# Distroless Node.js 24 on Debian 13. It contains Node.js 24.21.0 and runs as UID 65532.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/app /app
# `hydra` on PATH without a shell: see deploy/write-hydra-cli.sh.
COPY --from=build /out/hydra /usr/local/bin/hydra
USER 65532:65532
EXPOSE 8080
# The ENTRYPOINT of the base image is /nodejs/bin/node.
CMD ["/app/packages/server/dist/main.js"]
```

Create `deploy/Dockerfile.dockerignore`:

```text
# Build context filter for deploy/Dockerfile (BuildKit reads <Dockerfile>.dockerignore).
.git
**/node_modules
**/dist
**/.data
**/coverage
**/test-results
**/playwright-report
**/*.log
**/.DS_Store
deploy/k8s/overlays/dev/generated
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `bash deploy/test/gateway-image.test.sh`
Expected: 17 lines `ok   ...` and `all tests passed`.

- [ ] **Step 5: Build the image (Needs Docker)**

Needs Docker. Run from the repository root:
`docker build -f deploy/Dockerfile -t hydra-gateway:local .`
Expected: the build succeeds. The step `sh deploy/write-hydra-cli.sh ...` fails with a clear message
if `packages/server/package.json` has no built `hydra` bin (Index issue 4).

Run: `docker image inspect hydra-gateway:local --format '{{.Config.User}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'`
Expected: `65532:65532 ["/nodejs/bin/node"] ["/app/packages/server/dist/main.js"]`

- [ ] **Step 6: Smoke test the CLI and the data folder (Needs Docker)**

Needs Docker. The first `/data` tmpfs is the folder that the scripts prepare (UID 65532, mode 0700).
The second one is a folder of an older PVC (root, mode 0777). Review Focus 1.

```bash
docker run --rm --read-only --entrypoint hydra hydra-gateway:local keygen
smoke() { # TMPFS_OPTIONS
  docker run --rm --read-only --tmpfs /tmp --tmpfs "/data:$1" \
    -e HYDRA_DATA_DIR=/data \
    -e HYDRA_SECRET_KEY="$(openssl rand -base64 32)" \
    -e HYDRA_PUBLIC_URL=http://hydra.localhost \
    -e HYDRA_LIVE_URL=http://live.hydra.localhost \
    -e HYDRA_PUBLIC_IP=127.0.0.1 \
    -e HYDRA_SESSION_IMAGE="localhost:5111/hydra-session:smoke@sha256:$(printf '0%.0s' {1..64})" \
    -e HYDRA_MCP_IMAGE="localhost:5111/hydra-mcp:smoke@sha256:$(printf '0%.0s' {1..64})" \
    --entrypoint hydra hydra-gateway:local db backup
}
smoke uid=65532,gid=65532,mode=0700
smoke mode=0777
```

Expected: `keygen` prints one base64 key of 44 characters. Both `db backup` runs exit 0 and print the
path of the new backup under `/data/backups/` (spec 5.1). The second run may also log the warning
`cannot set the file mode` (plan 02); the first run must not. If a run fails, report it to the
controller (Index issues 3 and 4); do not change the Dockerfile to work around it.

- [ ] **Step 7: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 4: `hydra-session` and `hydra-mcp` images

**Files:**
- Create: `deploy/session/Dockerfile.session`
- Create: `deploy/session/Dockerfile.session.dockerignore`
- Create: `deploy/session/Dockerfile.mcp`
- Create: `deploy/session/Dockerfile.mcp.dockerignore`
- Test: `deploy/test/session-images.test.sh`

**Interfaces:**
- Consumes: `packages/mcp-sidecar/package.json` with the exact dependency `@playwright/mcp`
  `0.0.83` (plan 01); `deploy/test/lib.sh` (Task 1).
- Produces:
  - Image `hydra-session`: the Neko 3.1.6 Chromium image (root, supervisord) plus the fonts. It keeps
    the Neko `CMD`, `/etc/neko/supervisord.conf`, and `/etc/chromium.d`. Spike S1 (plan 09) is the
    only place that adds a supervisord Chromium file to this Dockerfile (index section 6).
  - Image `hydra-mcp`: `playwright-mcp` on `PATH` and as the `ENTRYPOINT`, `node` on `PATH` (plan 10
    runs a network probe with it), user `1000:1000`, `HOME=/tmp`, read-only root filesystem friendly. The orchestrator (plan 04) sets
    `--cdp-endpoint http://127.0.0.1:9222 --host 0.0.0.0 --port 8931` (spec 7.4) as `args`, or the
    full command starting with `playwright-mcp`.

- [ ] **Step 1: Write the failing test**

Create `deploy/test/session-images.test.sh`:

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2016 # ${DEBIAN_SNAPSHOT} is literal text of the Dockerfile
# Static tests for deploy/session/Dockerfile.{session,mcp}: bash deploy/test/session-images.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

session_file="$HYDRA_REPO_DIR/deploy/session/Dockerfile.session"
mcp_file="$HYDRA_REPO_DIR/deploy/session/Dockerfile.mcp"
session="$(cat "$session_file")"
mcp="$(cat "$mcp_file")"
node_image='node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"

assert_contains 'session: pinned Neko Chromium 3.1.6' "$session" \
  'FROM ghcr.io/m1k1o/neko/chromium:3.1.6@sha256:2471119c7b4010067f76f3421a78a8bcf35e3c223b2d1f4db084914ec915fb30'
assert_contains 'session: snapshot build argument' "$session" 'ARG DEBIAN_SNAPSHOT=20261002T203108Z'
assert_contains 'session: snapshot sources' "$session" 'http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}'
assert_contains 'session: snapshot security sources' "$session" 'http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}'
assert_contains 'session: font set of spec 7.7' "$session" \
  'fonts-noto fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu'
assert_eq 'session: no COPY until spike S1' '0' "$(count_lines "$session" 'COPY ')"

assert_eq 'mcp: both stages use the pinned node image' '2' "$(count_lines "$mcp" "FROM $node_image")"
assert_contains 'mcp: pnpm version of packageManager' "$mcp" "npm install -g $package_manager"
assert_contains 'mcp: frozen lockfile' "$mcp" 'pnpm install --frozen-lockfile'
assert_contains 'mcp: pnpm deploy of spec 3.4.4' "$mcp" 'pnpm --filter @hydra/mcp-sidecar deploy --prod /out'
assert_not_contains 'mcp: no global Playwright MCP install' "$mcp" 'npm install -g @playwright'
assert_contains 'mcp: non-root numeric user' "$mcp" 'USER 1000:1000'
assert_contains 'mcp: playwright-mcp is the command' "$mcp" 'ENTRYPOINT ["playwright-mcp"]'
assert_contains 'mcp: HOME on the /tmp volume' "$mcp" 'ENV HOME=/tmp'
for file in "$session_file" "$mcp_file"; do
  assert_eq "$(basename "$file"): every FROM line has a digest" '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
  assert_eq "$(basename "$file"): build context filter" 'yes' "$([[ -f "$file.dockerignore" ]] && echo yes)"
done
finish_tests
```

Run: `bash deploy/test/session-images.test.sh`
Expected: FAIL with `cat: <repo>/deploy/session/Dockerfile.session: No such file or directory`.

- [ ] **Step 2: Write the session Dockerfile**

Create `deploy/session/Dockerfile.session`:

```dockerfile
# hydra-session image: Neko Chromium plus a normal font set (spec sections 3.4.4, 7.7, 11.1).
# Build: docker build -f deploy/session/Dockerfile.session .
# Spike S1 (plan 09) adds the supervisord Chromium file here only if Chromium can run with its
# sandbox. Until then the image keeps the Neko default (--no-sandbox, spec section 7.10).

FROM ghcr.io/m1k1o/neko/chromium:3.1.6@sha256:2471119c7b4010067f76f3421a78a8bcf35e3c223b2d1f4db084914ec915fb30

# snapshot.debian.org timestamp for the font packages. Each build installs the same versions.
# Neko 3.1.6 is built on Debian 13 (trixie), so the sources use the trixie suites.
ARG DEBIAN_SNAPSHOT=20261002T203108Z

# Use only the snapshot sources for this install, then restore the image's own sources file.
RUN set -eux; \
    test "$(cut -d. -f1 /etc/debian_version)" = 13; \
    mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources; \
    printf '%s\n' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/snapshot.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      fonts-noto fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu; \
    rm /etc/apt/sources.list.d/snapshot.sources; \
    mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
```

Create `deploy/session/Dockerfile.session.dockerignore`:

```text
# Build context filter for deploy/session/Dockerfile.session. The image copies no repository
# files until spike S1 adds the supervisord Chromium file (then allow it here).
*
```

- [ ] **Step 3: Write the MCP Dockerfile**

Create `deploy/session/Dockerfile.mcp`:

```dockerfile
# hydra-mcp image: Playwright MCP from the lockfile (spec sections 3.4.4, 7.4, 7.7, 11.1).
# Build from the repository root: docker build -f deploy/session/Dockerfile.mcp .
# Do not install Playwright MCP with a global npm install: that does not use the lockfile.

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
RUN npm install -g pnpm@12.9.0
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm --filter @hydra/mcp-sidecar deploy --prod /out

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
# The pod mounts an emptyDir at /tmp and has a read-only root filesystem (spec section 7.4).
ENV HOME=/tmp
WORKDIR /app
COPY --from=build /out /app
# No browser download: the sidecar connects to the Chromium of the neko container over CDP.
RUN ln -s /app/node_modules/@playwright/mcp/cli.js /usr/local/bin/playwright-mcp \
    && playwright-mcp --version
USER 1000:1000
# The orchestrator sets the arguments: --cdp-endpoint http://127.0.0.1:9222 --host 0.0.0.0
# --port 8931 (spec section 7.4).
ENTRYPOINT ["playwright-mcp"]
```

Create `deploy/session/Dockerfile.mcp.dockerignore`:

```text
# Build context filter for deploy/session/Dockerfile.mcp (BuildKit reads <Dockerfile>.dockerignore).
.git
**/node_modules
**/dist
**/.data
**/coverage
**/test-results
**/playwright-report
**/*.log
**/.DS_Store
deploy/k8s/overlays/dev/generated
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `bash deploy/test/session-images.test.sh`
Expected: 18 lines `ok   ...` and `all tests passed`.

- [ ] **Step 5: Build and check the session image (Needs Docker)**

Needs Docker. Run from the repository root:

```bash
docker build -f deploy/session/Dockerfile.session -t hydra-session:local .
docker run --rm --entrypoint sh hydra-session:local -c '
  for f in "Noto Sans" "Noto Sans CJK" "Noto Color Emoji" "Liberation Sans" "DejaVu Sans"; do
    fc-list : family | grep -q "$f" && echo "found $f"
  done
  ls /etc/apt/sources.list.d
  dpkg-query -W -f="\${Package} \${Version}\n" fonts-noto-core fonts-noto-cjk fonts-liberation fonts-dejavu-core'
```

Expected: the build succeeds (its log shows `http://snapshot.debian.org/archive/...`, never
`deb.debian.org`), then:

```text
found Noto Sans
found Noto Sans CJK
found Noto Color Emoji
found Liberation Sans
found DejaVu Sans
debian.sources
fonts-noto-core 20201225-2
fonts-noto-cjk 1:20240730+repack1-1
fonts-liberation 1:2.1.5-3
fonts-dejavu-core 2.37-8
```

- [ ] **Step 6: Build and check the MCP image (Needs Docker)**

Needs Docker. Run from the repository root:

```bash
docker build -f deploy/session/Dockerfile.mcp -t hydra-mcp:local .
docker run --rm --read-only --tmpfs /tmp hydra-mcp:local --version
docker run --rm --read-only --tmpfs /tmp hydra-mcp:local --help | grep -c -- '--cdp-endpoint'
docker run --rm --entrypoint id hydra-mcp:local -u
docker run --rm --read-only --entrypoint node hydra-mcp:local --version
```

Expected: the build succeeds (its log runs `playwright-mcp --version` once), then `Version 0.0.83`,
`1`, `1000`, and `v24.21.0`.

- [ ] **Step 7: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 5: Kustomize base

**Files:**
- Create: `deploy/k8s/base/kustomization.yaml`
- Create: `deploy/k8s/base/namespaces.yaml`
- Create: `deploy/k8s/base/storageclasses.yaml`
- Create: `deploy/k8s/base/rbac.yaml`
- Create: `deploy/k8s/base/gateway.yaml`
- Create: `deploy/k8s/base/networkpolicies.yaml`
- Create: `deploy/k8s/base/ingressroutes.yaml`
- Create: `deploy/k8s/base/prepull.yaml`
- Test: `deploy/test/base.test.sh`

**Interfaces:**
- Consumes: `deploy/test/lib.sh` and `HYDRA_GATEWAY_UID` of `deploy/lib/cluster.sh` (Task 1). The
  gateway reads `HYDRA_PUBLIC_URL`, `HYDRA_LIVE_URL`,
  `HYDRA_PUBLIC_IP` (ConfigMap `hydra-config`) and `HYDRA_SESSION_IMAGE`, `HYDRA_MCP_IMAGE`
  (ConfigMap `hydra-images`), both generated by the overlays (Task 7).
- Produces (the overlays and scripts rely on these exact names and paths):
  - `deploy/k8s/base/namespaces.yaml` (applied alone by `dev-cluster.sh` and the next steps of
    `setup-k3s.sh`) and `deploy/k8s/base/storageclasses.yaml` (applied alone by `setup-k3s.sh`
    step 9).
  - IngressRoutes `hydra-public` and `hydra-live` in `hydra`: overlays patch `/spec/routes/0/match`
    (sentinels `Host(\`hydra.invalid\`)`, `Host(\`live.hydra.invalid\`)`), `/spec/entryPoints`
    (`websecure`), and `/spec/tls` (`certResolver: letsencrypt`).
  - NetworkPolicy `gateway-egress-apiserver` in `hydra`: overlays patch
    `/spec/egress/0/to/0/ipBlock/cidr` (sentinel `192.0.2.1/32`) with `<node IP>/32`.
  - Unqualified image names `hydra-gateway` (Deployment), `hydra-session` and `hydra-mcp` (DaemonSet
    init containers) for Kustomize `images:`.
  - Deployment `hydra-gateway`: `envFrom` ConfigMaps `hydra-config` and `hydra-images`,
    `HYDRA_SECRET_KEY` from Secret `hydra-secret-key` key `HYDRA_SECRET_KEY`, `HYDRA_DATA_DIR=/data`.

- [ ] **Step 1: Write the failing test**

Create `deploy/test/base.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for deploy/k8s/base: bash deploy/test/base.test.sh (needs kubectl for `kubectl kustomize`)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

# rule_verbs ROLE_TEXT RESOURCE : the verbs of the Role rule that lists RESOURCE, on one line
rule_verbs() {
  printf '%s\n' "$1" | awk -v res="$2" '
    function flush() { if (hit) print verbs; verbs = ""; hit = 0; section = "" }
    /^- apiGroups:/ { flush(); section = "apiGroups"; next }
    /^  resources:/ { section = "resources"; next }
    /^  verbs:/ { section = "verbs"; next }
    /^  - / {
      item = substr($0, 5)
      if (section == "resources" && item == res) hit = 1
      if (section == "verbs") verbs = verbs (verbs == "" ? "" : " ") item
    }
    END { flush() }
  '
}

out="$(kubectl kustomize "$HYDRA_REPO_DIR/deploy/k8s/base")"

ns_hydra="$(k8s_doc "$out" Namespace hydra)"
assert_contains 'hydra is restricted' "$ns_hydra" 'pod-security.kubernetes.io/enforce: restricted'
ns_sessions="$(k8s_doc "$out" Namespace hydra-sessions)"
assert_contains 'hydra-sessions is baseline' "$ns_sessions" 'pod-security.kubernetes.io/enforce: baseline'

for class in hydra-retain hydra-profile; do
  sc="$(k8s_doc "$out" StorageClass "$class")"
  assert_contains "$class uses local-path" "$sc" 'provisioner: rancher.io/local-path'
  assert_contains "$class has the fixed path pattern" "$sc" "pathPattern: '{{ .PVC.Namespace }}/{{ .PVC.Name }}/'"
done
assert_contains 'hydra-retain retains' "$(k8s_doc "$out" StorageClass hydra-retain)" 'reclaimPolicy: Retain'
assert_contains 'hydra-profile deletes' "$(k8s_doc "$out" StorageClass hydra-profile)" 'reclaimPolicy: Delete'

role="$(k8s_doc "$out" Role hydra-gateway)"
assert_contains 'Role is in hydra-sessions' "$role" 'namespace: hydra-sessions'
assert_contains 'Role can read pod logs' "$role" '- pods/log'
assert_not_contains 'no port-forward right' "$out" 'pods/portforward'
assert_not_contains 'no exec right' "$out" 'pods/exec'
assert_not_contains 'no ClusterRole' "$out" 'kind: ClusterRole'
all_verbs='get list watch create update patch delete deletecollection'
for resource in statefulsets services configmaps secrets persistentvolumeclaims; do
  assert_eq "all verbs on $resource" "$all_verbs" "$(rule_verbs "$role" "$resource")"
done
assert_eq 'pods are read-only' 'get list watch' "$(rule_verbs "$role" pods)"
assert_eq 'pod logs are get only' 'get' "$(rule_verbs "$role" pods/log)"

gw="$(k8s_doc "$out" Deployment hydra-gateway)"
assert_contains 'one replica' "$gw" 'replicas: 1'
assert_contains 'Recreate strategy' "$gw" 'type: Recreate'
assert_contains 'pod label for the session ingress rule' "$gw" 'app: hydra-gateway'
assert_contains 'data volume' "$gw" 'claimName: gateway-data'
assert_contains 'HYDRA_DATA_DIR is the volume' "$gw" 'value: /data'
assert_contains 'secret key from the Secret' "$gw" 'name: hydra-secret-key'
assert_contains 'images from hydra-images' "$gw" 'name: hydra-images'
assert_contains 'liveness probe' "$gw" 'path: /healthz'
assert_contains 'readiness probe' "$gw" 'path: /readyz'
assert_contains 'read-only root filesystem' "$gw" 'readOnlyRootFilesystem: true'
assert_contains 'runs as non-root' "$gw" 'runAsNonRoot: true'
assert_contains 'runs as the user of deploy/lib/cluster.sh' "$gw" "runAsUser: $HYDRA_GATEWAY_UID"
assert_contains 'PVC uses hydra-retain' "$(k8s_doc "$out" PersistentVolumeClaim gateway-data)" 'storageClassName: hydra-retain'

assert_eq 'eight NetworkPolicies' '8' "$(count_lines "$out" 'kind: NetworkPolicy')"
egress="$(k8s_doc "$out" NetworkPolicy sessions-egress)"
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  assert_contains "session egress excludes $cidr" "$egress" "- $cidr"
done
media="$(k8s_doc "$out" NetworkPolicy sessions-ingress-media)"
assert_eq 'media rule for UDP and TCP' '2' "$(count_lines "$media" 'endPort: 52099')"
assert_contains 'API server rule on 6443' "$(k8s_doc "$out" NetworkPolicy gateway-egress-apiserver)" 'port: 6443'
assert_contains 'Traefik may reach the gateway' "$(k8s_doc "$out" NetworkPolicy gateway-ingress-traefik)" 'app.kubernetes.io/name: traefik'

assert_contains 'public route uses the ACME resolver' "$(k8s_doc "$out" IngressRoute hydra-public)" 'certResolver: letsencrypt'
assert_contains 'live route uses the ACME resolver' "$(k8s_doc "$out" IngressRoute hydra-live)" 'certResolver: letsencrypt'

ds="$(k8s_doc "$out" DaemonSet session-image-prepull)"
assert_contains 'pre-pull of hydra-session' "$ds" 'image: hydra-session'
assert_contains 'pre-pull of hydra-mcp' "$ds" 'image: hydra-mcp'
assert_contains 'pinned pause image' "$ds" 'image: registry.k8s.io/pause:3.10.2@sha256:'
assert_not_contains 'no object has the reconciler label' "$out" 'app.kubernetes.io/managed-by'
finish_tests
```

Run: `bash deploy/test/base.test.sh`
Expected: FAIL with `error: must build at directory: not a valid directory: ... deploy/k8s/base: no such file or directory`.

- [ ] **Step 2: Write the kustomization and the namespaces**

Create `deploy/k8s/base/kustomization.yaml`:

```yaml
# Kustomize base (spec section 11.2). Apply an overlay, not the base:
# kubectl apply -k deploy/k8s/overlays/prod (or overlays/dev).
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespaces.yaml
  - storageclasses.yaml
  - rbac.yaml
  - gateway.yaml
  - networkpolicies.yaml
  - ingressroutes.yaml
  - prepull.yaml
```

Create `deploy/k8s/base/namespaces.yaml`:

```yaml
# Pod Security levels (spec section 11.2). hydra-sessions is baseline, because Neko starts
# supervisord as root.
apiVersion: v1
kind: Namespace
metadata:
  name: hydra
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
---
apiVersion: v1
kind: Namespace
metadata:
  name: hydra-sessions
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: baseline
    pod-security.kubernetes.io/warn-version: latest
```

- [ ] **Step 3: Write the StorageClasses**

Create `deploy/k8s/base/storageclasses.yaml` (Spec deviation 2 explains the trailing slash):

```yaml
# StorageClasses with fixed folder names (spec section 5.2). setup-k3s.sh applies this file before
# Traefik needs hydra-retain. Spike S4 (plan 09) verifies pathPattern.
#
# The pattern ends with "/": local-path-provisioner v0.0.37 (bundled with the pinned k3s) rejects
# a rendered path that does not start with "<namespace>/<pvc name>/". The provisioner joins the
# path with filepath.Join, which removes the slash, so the folder is
# <default-local-storage-path>/<namespace>/<pvc name>.
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: hydra-retain
provisioner: rancher.io/local-path
parameters:
  pathPattern: '{{ .PVC.Namespace }}/{{ .PVC.Name }}/'
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: hydra-profile
provisioner: rancher.io/local-path
parameters:
  pathPattern: '{{ .PVC.Namespace }}/{{ .PVC.Name }}/'
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

- [ ] **Step 4: Write the RBAC objects**

Create `deploy/k8s/base/rbac.yaml`:

```yaml
# Gateway access to the Kubernetes API (spec section 11.2): a Role in hydra-sessions only, never a
# ClusterRole. Never pods/portforward or pods/exec.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: hydra-gateway
  namespace: hydra
  labels:
    app: hydra-gateway
# Only the gateway pod mounts the token (automountServiceAccountToken: true in its pod spec).
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: hydra-gateway
  namespace: hydra-sessions
rules:
  - apiGroups:
      - apps
    resources:
      - statefulsets
    verbs:
      - get
      - list
      - watch
      - create
      - update
      - patch
      - delete
      - deletecollection
  - apiGroups:
      - ''
    resources:
      - services
      - configmaps
      - secrets
      - persistentvolumeclaims
    verbs:
      - get
      - list
      - watch
      - create
      - update
      - patch
      - delete
      - deletecollection
  - apiGroups:
      - ''
    resources:
      - pods
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - ''
    resources:
      - pods/log
    verbs:
      - get
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: hydra-gateway
  namespace: hydra-sessions
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: hydra-gateway
subjects:
  - kind: ServiceAccount
    name: hydra-gateway
    namespace: hydra
```

- [ ] **Step 5: Write the gateway objects**

Create `deploy/k8s/base/gateway.yaml`:

```yaml
# The gateway (spec sections 5.1, 11.2): one replica, Recreate (SQLite has one writer).
# The overlays generate the ConfigMaps hydra-config (URLs, public IP) and hydra-images (session and
# MCP images, spec section 3.4.4). The operator creates the Secret hydra-secret-key.
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: gateway-data
  namespace: hydra
  labels:
    app: hydra-gateway
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: hydra-retain
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hydra-gateway
  namespace: hydra
  labels:
    app: hydra-gateway
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: hydra-gateway
  template:
    metadata:
      labels:
        app: hydra-gateway
    spec:
      serviceAccountName: hydra-gateway
      automountServiceAccountToken: true
      enableServiceLinks: false
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: gateway
          image: hydra-gateway
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: HYDRA_DATA_DIR
              value: /data
            - name: HYDRA_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: hydra-secret-key
                  key: HYDRA_SECRET_KEY
          envFrom:
            - configMapRef:
                name: hydra-config
            - configMapRef:
                name: hydra-images
          volumeMounts:
            - name: data
              mountPath: /data
            - name: tmp
              mountPath: /tmp
          # The start makes a backup and runs the migrations (spec section 11.8).
          startupProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 2
            failureThreshold: 60
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            timeoutSeconds: 3
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
            timeoutSeconds: 3
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: gateway-data
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: hydra-gateway
  namespace: hydra
  labels:
    app: hydra-gateway
spec:
  selector:
    app: hydra-gateway
  ports:
    - name: http
      port: 8080
      targetPort: http
```

- [ ] **Step 6: Write the NetworkPolicies**

Create `deploy/k8s/base/networkpolicies.yaml`:

```yaml
# NetworkPolicies (spec section 11.4). Spike S6 and the security e2e tests verify them.
# The media port range below is the default HYDRA_MEDIA_PORT_RANGE (52000-52099). If you change
# HYDRA_MEDIA_PORT_RANGE, patch sessions-ingress-media in the overlay.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: hydra-sessions
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sessions-ingress-gateway
  namespace: hydra-sessions
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: hydra
          podSelector:
            matchLabels:
              app: hydra-gateway
      ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8931
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sessions-ingress-media
  namespace: hydra-sessions
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: UDP
          port: 52000
          endPort: 52099
        - protocol: TCP
          port: 52000
          endPort: 52099
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sessions-egress
  namespace: hydra-sessions
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # The excluded ranges contain the pod CIDR, the service CIDR, the VPC addresses (node IP, API
    # server on 6443, kubelet on 10250), and the EC2 metadata endpoint.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
              - 100.64.0.0/10
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: hydra
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-ingress-traefik
  namespace: hydra
spec:
  podSelector:
    matchLabels:
      app: hydra-gateway
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              app.kubernetes.io/name: traefik
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-egress
  namespace: hydra
spec:
  podSelector:
    matchLabels:
      app: hydra-gateway
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: hydra-sessions
      ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8931
---
# The API server: TCP 6443 on the node IP. Each overlay replaces the address below
# (192.0.2.1 is a documentation address that matches nothing).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-egress-apiserver
  namespace: hydra
spec:
  podSelector:
    matchLabels:
      app: hydra-gateway
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 192.0.2.1/32
      ports:
        - protocol: TCP
          port: 6443
```

- [ ] **Step 7: Write the IngressRoutes**

Create `deploy/k8s/base/ingressroutes.yaml`:

```yaml
# Traefik routes for HYDRA_PUBLIC_URL and HYDRA_LIVE_URL (spec section 11.2). One gateway process
# serves both hostnames and routes by the Host header. Each overlay sets the hostnames; the dev
# overlay also switches to the web entry point without TLS.
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: hydra-public
  namespace: hydra
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`hydra.invalid`)
      services:
        - name: hydra-gateway
          port: 8080
  tls:
    certResolver: letsencrypt
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: hydra-live
  namespace: hydra
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`live.hydra.invalid`)
      services:
        - name: hydra-gateway
          port: 8080
  tls:
    certResolver: letsencrypt
```

- [ ] **Step 8: Write the image pre-pull DaemonSet**

Create `deploy/k8s/base/prepull.yaml`:

```yaml
# Image pre-pull (spec section 11.2): the node has the session images before the first Start, so
# the first start can meet the 60 s goal. The init containers use the hydra-session and hydra-mcp
# images and run `true`. This DaemonSet has no app.kubernetes.io/managed-by: hydra label, so the
# reconciler does not treat it as a session object.
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: session-image-prepull
  namespace: hydra-sessions
  labels:
    app: session-image-prepull
spec:
  selector:
    matchLabels:
      app: session-image-prepull
  template:
    metadata:
      labels:
        app: session-image-prepull
    spec:
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        - name: session-image
          image: hydra-session
          command:
            - 'true'
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
        - name: mcp-image
          image: hydra-mcp
          command:
            - 'true'
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10.2@sha256:f548e0e8e3dc1896ca956272154dde3314e8cc4fde0a57577ee9fa1c63f5baf4
          resources:
            requests:
              cpu: 1m
              memory: 8Mi
            limits:
              memory: 16Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
```

- [ ] **Step 9: Run the test to verify that it passes**

Run: `bash deploy/test/base.test.sh`
Expected: 48 lines `ok   ...` and `all tests passed`.

Run: `kubectl kustomize deploy/k8s/base | grep '^kind:' | sort | uniq -c`
Expected:

```text
   1 kind: DaemonSet
   1 kind: Deployment
   2 kind: IngressRoute
   2 kind: Namespace
   8 kind: NetworkPolicy
   1 kind: PersistentVolumeClaim
   1 kind: Role
   1 kind: RoleBinding
   1 kind: Service
   1 kind: ServiceAccount
   2 kind: StorageClass
```

- [ ] **Step 10: Format**

Run: `pnpm exec prettier --write deploy/k8s/base`
Expected: no file content changes (the files already use the Prettier YAML style).

- [ ] **Step 11: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 6: Traefik values

**Files:**
- Create: `deploy/traefik/prod.yaml`
- Create: `deploy/traefik/dev.yaml`
- Test: `deploy/test/traefik.test.sh`

**Interfaces:**
- Consumes: `deploy/test/lib.sh` (Task 1); the StorageClass `hydra-retain` (Task 5); the Traefik chart
  bundled with `K3S_VERSION` of `scripts/versions.sh` (`v1.36.5+k3s1` → chart `40.1.5+up40.1.0`).
- Produces:
  - `deploy/traefik/prod.yaml`, applied by `setup-k3s.sh` step 10: ACME resolver `letsencrypt`
    (HTTP-01 on `web`), `acme.json` in `/data` on the chart PVC `traefik` (StorageClass
    `hydra-retain`, folder `kube-system/traefik`), HTTP to HTTPS redirect.
  - `deploy/traefik/dev.yaml`, applied by `dev-cluster.sh`: no ACME, no redirect.
  - Both: `readTimeout: "0s"`, `writeTimeout: "0s"`, `idleTimeout: "180s"` on `web` and `websecure`
    (equal blocks; `check-repo.ts` compares them), and `externalTrafficPolicy: Local`.
  - Traefik pods keep the label `app.kubernetes.io/name: traefik` (the NetworkPolicy
    `gateway-ingress-traefik` of Task 5 selects it).

- [ ] **Step 1: Write the failing test**

Create `deploy/test/traefik.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for deploy/traefik/*.yaml: bash deploy/test/traefik.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

prod="$(cat "$HYDRA_REPO_DIR/deploy/traefik/prod.yaml")"
dev="$(cat "$HYDRA_REPO_DIR/deploy/traefik/dev.yaml")"
timeouts() { printf '%s\n' "$1" | grep -E '^ +(readTimeout|writeTimeout|idleTimeout):'; }

assert_eq 'same entry point timeouts in both files' "$(timeouts "$prod")" "$(timeouts "$dev")"

check_both() { # NAME TEXT
  assert_eq "$1: no read timeout on web and websecure" '2' "$(count_lines "$2" 'readTimeout: "0s"')"
  assert_eq "$1: no write timeout on web and websecure" '2' "$(count_lines "$2" 'writeTimeout: "0s"')"
  assert_contains "$1: client IP is kept" "$2" 'externalTrafficPolicy: Local'
  assert_contains "$1: HelmChartConfig of the bundled Traefik" "$2" 'name: traefik'
}
check_both prod "$prod"
check_both dev "$dev"

assert_contains 'prod: ACME resolver letsencrypt' "$prod" 'letsencrypt:'
assert_contains 'prod: HTTP-01 challenge on web' "$prod" 'entryPoint: web'
assert_contains 'prod: acme.json on a hydra-retain volume' "$prod" 'storageClass: hydra-retain'
assert_contains 'prod: redirect to HTTPS' "$prod" 'to: websecure'
assert_not_contains 'dev: no ACME' "$dev" 'certificatesResolvers'
assert_not_contains 'dev: no redirect' "$dev" 'redirections'
finish_tests
```

Run: `bash deploy/test/traefik.test.sh`
Expected: FAIL with `cat: <repo>/deploy/traefik/prod.yaml: No such file or directory`.

- [ ] **Step 2: Write the Traefik values**

Create `deploy/traefik/prod.yaml`:

```yaml
# Values for the Traefik chart that k3s bundles (spec section 11.3). setup-k3s.sh applies this file.
# Chart keys verified for the charts of k3s v1.34 to v1.37 (traefik 40.1.x and 41.4.x).
#
# Keep the respondingTimeouts blocks equal to deploy/traefik/dev.yaml (scripts/check-repo.ts
# checks it). readTimeout 0s: the Traefik v3 default of 60 s would cut MCP streams and WebSockets.
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    ports:
      web:
        http:
          redirections:
            entryPoint:
              to: websecure
              scheme: https
              permanent: true
        transport:
          respondingTimeouts:
            readTimeout: "0s"
            writeTimeout: "0s"
            idleTimeout: "180s"
      websecure:
        transport:
          respondingTimeouts:
            readTimeout: "0s"
            writeTimeout: "0s"
            idleTimeout: "180s"
    service:
      spec:
        externalTrafficPolicy: Local
    persistence:
      enabled: true
      storageClass: hydra-retain
      accessMode: ReadWriteOnce
      size: 128Mi
      path: /data
    certificatesResolvers:
      letsencrypt:
        acme:
          storage: /data/acme.json
          httpChallenge:
            entryPoint: web
```

Create `deploy/traefik/dev.yaml`:

```yaml
# Values for the Traefik chart that k3s bundles (spec section 11.3). dev-cluster.sh applies this
# file. No ACME and no HTTP to HTTPS redirect: k3d serves http://hydra.localhost.
#
# Keep the respondingTimeouts blocks equal to deploy/traefik/prod.yaml (scripts/check-repo.ts
# checks it), so the long MCP stream test on k3d verifies the production timeouts.
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    ports:
      web:
        transport:
          respondingTimeouts:
            readTimeout: "0s"
            writeTimeout: "0s"
            idleTimeout: "180s"
      websecure:
        transport:
          respondingTimeouts:
            readTimeout: "0s"
            writeTimeout: "0s"
            idleTimeout: "180s"
    service:
      spec:
        externalTrafficPolicy: Local
```

- [ ] **Step 3: Run the test to verify that it passes**

Run: `bash deploy/test/traefik.test.sh`
Expected: 15 lines `ok   ...` and `all tests passed`.

- [ ] **Step 4: Check the chart of the pinned k3s**

The values keys were verified for the charts `40.1.5+up40.1.0` and `41.4.2+up41.4.0`. Run:

```bash
. ./scripts/versions.sh
ref="$(printf %s "$K3S_VERSION" | sed 's/+/%2B/')"
gh api "repos/k3s-io/k3s/contents/manifests/traefik.yaml?ref=$ref" --jq .content | base64 -d | grep -o 'traefik-[0-9][^ ]*\.tgz' | sort -u
gh api "repos/k3s-io/k3s/contents/manifests/local-storage.yaml?ref=$ref" --jq .content | base64 -d | grep -o 'local-path-provisioner:v[0-9.]*'
```

Expected:

```text
traefik-40.1.5+up40.1.0.tgz
local-path-provisioner:v0.0.37
```

If another chart version appears (a newer k3s pin), compare the keys of `valuesContent` with the
`values.yaml` of that chart (`ports.<name>.transport.respondingTimeouts`,
`ports.web.http.redirections.entryPoint`, `service.spec`, `persistence`, `certificatesResolvers`)
before you continue. If the local-path version changed, check `pathPattern` again (Spec deviation 2).

- [ ] **Step 5: Run the repository check**

Run: `node scripts/check-repo.ts`
Expected: `check-repo: OK` (the timeouts of both files are equal).

- [ ] **Step 6: Format**

Run: `pnpm exec prettier --write deploy/traefik`
Expected: no file content changes.

- [ ] **Step 7: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 7: Overlays and the image pin writer

**Files:**
- Create: `deploy/k8s/write-overlay-component.sh`
- Create: `deploy/k8s/overlays/prod/kustomization.yaml`
- Create: `deploy/k8s/overlays/prod/images/kustomization.yaml`
- Create: `deploy/k8s/overlays/dev/kustomization.yaml`
- Create: `deploy/k8s/overlays/dev/testsite.yaml`
- Modify: `.gitignore` (append two lines)
- Test: `deploy/test/overlays.test.sh`

**Interfaces:**
- Consumes: the base of Task 5 (object names and patch paths in its Interfaces block); the test site
  contract of Task 2 (`PORT`, `/healthz`, port 8080); `deploy/test/lib.sh` (Task 1).
- Produces:
  - `deploy/k8s/write-overlay-component.sh --out FILE --registry REGISTRY --tag TAG
    --image NAME=sha256:HEX [...] [--node-ip IPV4] [--source TEXT]`: writes a Kustomize Component
    with `images:` (`newName: REGISTRY/NAME`, `newTag: 'TAG'`, `digest`) and the ConfigMap
    `hydra-images` (`HYDRA_SESSION_IMAGE`, `HYDRA_MCP_IMAGE` = `REGISTRY/NAME:TAG@DIGEST`), plus the
    node IP patch of `gateway-egress-apiserver` with `--node-ip`. `hydra-session` and `hydra-mcp` are
    necessary. The same arguments give the same bytes. Used by Task 9 and Task 10.
  - `deploy/k8s/overlays/prod`: example operator values (to replace) and the component `images`
    (rewritten by the release workflow).
  - `deploy/k8s/overlays/dev`: `http://hydra.localhost`, `http://live.hydra.localhost`,
    `HYDRA_PUBLIC_IP=127.0.0.1`, routes on `web` without TLS, the test site, and the egress exception;
    the component `generated` (written by `dev-cluster.sh`, ignored by git).

- [ ] **Step 1: Write the failing test**

Create `deploy/test/overlays.test.sh`:

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2016 # the backticks are part of the Traefik Host() rules
# Tests for deploy/k8s/write-overlay-component.sh and both overlays, with sample generated files in
# a temporary copy of deploy/k8s: bash deploy/test/overlays.test.sh (needs kubectl)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$HYDRA_REPO_DIR/deploy/k8s" "$work/k8s"
rm -rf "$work/k8s/overlays/dev/generated"
writer="$HYDRA_REPO_DIR/deploy/k8s/write-overlay-component.sh"
d1="sha256:$(printf '1%.0s' {1..64})"
d2="sha256:$(printf '2%.0s' {1..64})"
d3="sha256:$(printf '3%.0s' {1..64})"
d4="sha256:$(printf '4%.0s' {1..64})"

# dev overlay with the files that dev-cluster.sh writes
mkdir -p "$work/k8s/overlays/dev/generated"
bash "$writer" --out "$work/k8s/overlays/dev/generated/kustomization.yaml" \
  --registry k3d-hydra-registry:5111 --tag dev-test --node-ip 172.18.0.2 \
  --image "hydra-gateway=$d1" --image "hydra-session=$d2" --image "hydra-mcp=$d3" \
  --image "hydra-testsite=$d4" --source 'scripts/dev-cluster.sh'
dev="$(kubectl kustomize "$work/k8s/overlays/dev")"
assert_contains 'dev gateway image' "$dev" "image: k3d-hydra-registry:5111/hydra-gateway:dev-test@$d1"
assert_contains 'dev pre-pull session image' "$dev" "image: k3d-hydra-registry:5111/hydra-session:dev-test@$d2"
assert_contains 'dev pre-pull mcp image' "$dev" "image: k3d-hydra-registry:5111/hydra-mcp:dev-test@$d3"
assert_contains 'dev test site image' "$dev" "image: k3d-hydra-registry:5111/hydra-testsite:dev-test@$d4"
assert_contains 'dev HYDRA_SESSION_IMAGE' "$dev" "HYDRA_SESSION_IMAGE: k3d-hydra-registry:5111/hydra-session:dev-test@$d2"
assert_contains 'dev HYDRA_MCP_IMAGE' "$dev" "HYDRA_MCP_IMAGE: k3d-hydra-registry:5111/hydra-mcp:dev-test@$d3"
assert_contains 'dev public URL' "$dev" 'HYDRA_PUBLIC_URL: http://hydra.localhost'
assert_contains 'dev live URL' "$dev" 'HYDRA_LIVE_URL: http://live.hydra.localhost'
assert_contains 'dev public IP' "$dev" 'HYDRA_PUBLIC_IP: 127.0.0.1'
assert_contains 'dev node IP in the API server rule' "$(k8s_doc "$dev" NetworkPolicy gateway-egress-apiserver)" 'cidr: 172.18.0.2/32'
dev_public="$(k8s_doc "$dev" IngressRoute hydra-public)"
assert_contains 'dev public host' "$dev_public" 'match: Host(`hydra.localhost`)'
assert_contains 'dev uses the web entry point' "$dev_public" '- web'
assert_not_contains 'dev has no TLS' "$dev_public" 'certResolver'
assert_contains 'dev live host' "$(k8s_doc "$dev" IngressRoute hydra-live)" 'match: Host(`live.hydra.localhost`)'
assert_contains 'dev test site egress exception' "$(k8s_doc "$dev" NetworkPolicy sessions-egress-testsite)" 'app: hydra-testsite'
gateway="$(k8s_doc "$dev" Deployment hydra-gateway)"
assert_contains 'gateway reads the generated hydra-images' "$gateway" 'name: hydra-images-'
assert_contains 'gateway reads the generated hydra-config' "$gateway" 'name: hydra-config-'

# prod overlay before the first release: empty image values, so the gateway stops at start
prod="$(kubectl kustomize "$work/k8s/overlays/prod")"
prod_public="$(k8s_doc "$prod" IngressRoute hydra-public)"
assert_contains 'prod public host' "$prod_public" 'match: Host(`hydra.example.com`)'
assert_contains 'prod uses TLS from the ACME resolver' "$prod_public" 'certResolver: letsencrypt'
assert_contains 'prod live host' "$(k8s_doc "$prod" IngressRoute hydra-live)" 'match: Host(`live.hydra.example.com`)'
assert_contains 'prod node IP in the API server rule' "$(k8s_doc "$prod" NetworkPolicy gateway-egress-apiserver)" 'cidr: 192.0.2.10/32'
assert_contains 'prod has no session image before a release' "$prod" 'HYDRA_SESSION_IMAGE: ""'

# prod overlay after a release pull request
bash "$writer" --out "$work/k8s/overlays/prod/images/kustomization.yaml" \
  --registry ghcr.io/example --tag 0123456789abcdef0123456789abcdef01234567 \
  --image "hydra-gateway=$d1" --image "hydra-session=$d2" --image "hydra-mcp=$d3" \
  --source 'release workflow'
prod="$(kubectl kustomize "$work/k8s/overlays/prod")"
tag=0123456789abcdef0123456789abcdef01234567
assert_contains 'prod gateway image' "$prod" "image: ghcr.io/example/hydra-gateway:$tag@$d1"
assert_contains 'prod HYDRA_SESSION_IMAGE' "$prod" "HYDRA_SESSION_IMAGE: ghcr.io/example/hydra-session:$tag@$d2"
assert_contains 'prod HYDRA_MCP_IMAGE' "$prod" "HYDRA_MCP_IMAGE: ghcr.io/example/hydra-mcp:$tag@$d3"
assert_not_contains 'prod has no test site' "$prod" 'hydra-testsite'

# writer: same arguments give the same bytes (the release job skips an empty pull request)
args=(--registry ghcr.io/example --tag t1 --image "hydra-mcp=$d3" --image "hydra-session=$d2")
bash "$writer" --out "$work/a.yaml" "${args[@]}"
bash "$writer" --out "$work/b.yaml" "${args[@]}"
assert_eq 'writer output is deterministic' "$(cat "$work/a.yaml")" "$(cat "$work/b.yaml")"
assert_fails 'writer rejects a short digest' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image hydra-session=sha256:abc --image "hydra-mcp=$d3"
assert_fails 'writer rejects an unknown image' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2" --image "hydra-mcp=$d3" --image "other=$d1"
assert_fails 'writer needs hydra-mcp' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2"
assert_fails 'writer rejects a bad node IP' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2" --image "hydra-mcp=$d3" --node-ip 'x; rm -rf /'
finish_tests
```

Run: `bash deploy/test/overlays.test.sh`
Expected: FAIL with `bash: <repo>/deploy/k8s/write-overlay-component.sh: No such file or directory`.

- [ ] **Step 2: Write the image pin writer**

Create `deploy/k8s/write-overlay-component.sh`:

```bash
#!/usr/bin/env bash
# Writes a Kustomize Component that pins the Hydra images of one build (spec section 3.4.4):
# Kustomize `images:` for the pods, and the ConfigMap hydra-images for HYDRA_SESSION_IMAGE and
# HYDRA_MCP_IMAGE (Kustomize `images:` does not change environment values). With --node-ip, the
# Component also sets the node IP of the API server egress rule (spec section 11.4).
#
# Callers: .github/workflows/release.yml (deploy/k8s/overlays/prod/images/kustomization.yaml) and
# scripts/dev-cluster.sh (deploy/k8s/overlays/dev/generated/kustomization.yaml).
#
# Usage: write-overlay-component.sh --out FILE --registry REGISTRY --tag TAG
#          --image NAME=sha256:HEX [--image NAME=sha256:HEX ...] [--node-ip IPV4] [--source TEXT]
# NAME is hydra-gateway, hydra-session, hydra-mcp, or hydra-testsite. hydra-session and hydra-mcp
# are necessary. The output is the same for the same arguments. Works with bash 3.2 (macOS).
set -euo pipefail

IMAGE_NAMES='hydra-gateway hydra-session hydra-mcp hydra-testsite'

die() {
  echo "write-overlay-component.sh: $*" >&2
  exit 2
}

out='' registry='' tag='' node_ip='' source_text=''
images=()
while (($# > 0)); do
  case "$1" in
    --out | --registry | --tag | --image | --node-ip | --source)
      (($# >= 2)) || die "$1 needs a value"
      case "$1" in
        --out) out="$2" ;;
        --registry) registry="$2" ;;
        --tag) tag="$2" ;;
        --image) images+=("$2") ;;
        --node-ip) node_ip="$2" ;;
        --source) source_text="$2" ;;
      esac
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$out" ]] || die '--out is necessary'
[[ "$registry" =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*$ ]] || die "invalid --registry: '$registry'"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid --tag: '$tag'"
if [[ -n "$node_ip" ]]; then
  [[ "$node_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "invalid --node-ip: '$node_ip'"
fi

(("${#images[@]}" > 0)) || die '--image is necessary'

# digest_of NAME : the digest given for NAME, or nothing
digest_of() {
  local arg
  for arg in "${images[@]}"; do
    if [[ "${arg%%=*}" == "$1" ]]; then
      echo "${arg#*=}"
      return
    fi
  done
}

for arg in "${images[@]}"; do
  name="${arg%%=*}"
  digest="${arg#*=}"
  [[ " $IMAGE_NAMES " == *" $name "* ]] || die "unknown image name: '$name'"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid digest for $name: '$digest'"
done
[[ -n "$(digest_of hydra-session)" ]] || die '--image hydra-session=... is necessary'
[[ -n "$(digest_of hydra-mcp)" ]] || die '--image hydra-mcp=... is necessary'

{
  echo "# Generated by deploy/k8s/write-overlay-component.sh${source_text:+ ($source_text)}."
  echo '# Do not edit by hand.'
  echo 'apiVersion: kustomize.config.k8s.io/v1alpha1'
  echo 'kind: Component'
  echo 'images:'
  for name in $IMAGE_NAMES; do
    digest="$(digest_of "$name")"
    [[ -n "$digest" ]] || continue
    echo "  - name: $name"
    echo "    newName: $registry/$name"
    echo "    newTag: '$tag'"
    echo "    digest: $digest"
  done
  echo 'configMapGenerator:'
  echo '  - name: hydra-images'
  echo '    namespace: hydra'
  echo '    literals:'
  echo "      - HYDRA_SESSION_IMAGE=$registry/hydra-session:$tag@$(digest_of hydra-session)"
  echo "      - HYDRA_MCP_IMAGE=$registry/hydra-mcp:$tag@$(digest_of hydra-mcp)"
  if [[ -n "$node_ip" ]]; then
    echo 'patches:'
    echo '  - target:'
    echo '      kind: NetworkPolicy'
    echo '      name: gateway-egress-apiserver'
    echo '    patch: |-'
    echo '      - op: replace'
    echo '        path: /spec/egress/0/to/0/ipBlock/cidr'
    echo "        value: $node_ip/32"
  fi
} >"$out.tmp"
mv "$out.tmp" "$out"
```

Run: `chmod +x deploy/k8s/write-overlay-component.sh`

- [ ] **Step 3: Write the prod overlay**

Create `deploy/k8s/overlays/prod/kustomization.yaml`:

```yaml
# Production overlay (spec sections 3.4.4, 11.2, 11.8): kubectl apply -k deploy/k8s/overlays/prod
#
# Operator values: before the first apply, replace the example hostnames, the Elastic IP
# (HYDRA_PUBLIC_IP), and the node IP (the private IP of the EC2 instance) below. Each hostname is
# in two places: the URL in hydra-config and the Host() rule of its IngressRoute.
# The release workflow writes the image digests to images/kustomization.yaml.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
components:
  - images
configMapGenerator:
  - name: hydra-config
    namespace: hydra
    literals:
      - HYDRA_PUBLIC_URL=https://hydra.example.com
      - HYDRA_LIVE_URL=https://live.hydra.example.com
      - HYDRA_PUBLIC_IP=203.0.113.10
patches:
  - target:
      kind: IngressRoute
      name: hydra-public
    patch: |-
      - op: replace
        path: /spec/routes/0/match
        value: Host(`hydra.example.com`)
  - target:
      kind: IngressRoute
      name: hydra-live
    patch: |-
      - op: replace
        path: /spec/routes/0/match
        value: Host(`live.hydra.example.com`)
  - target:
      kind: NetworkPolicy
      name: gateway-egress-apiserver
    patch: |-
      - op: replace
        path: /spec/egress/0/to/0/ipBlock/cidr
        value: 192.0.2.10/32
```

Create `deploy/k8s/overlays/prod/images/kustomization.yaml` (the state before the first release):

```yaml
# Written by .github/workflows/release.yml with deploy/k8s/write-overlay-component.sh.
# No release yet: run the release workflow and merge its pull request before the first deploy.
# Until then the gateway stops with a message that names HYDRA_SESSION_IMAGE.
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
configMapGenerator:
  - name: hydra-images
    namespace: hydra
    literals:
      - HYDRA_SESSION_IMAGE=
      - HYDRA_MCP_IMAGE=
```

- [ ] **Step 4: Write the dev overlay**

Create `deploy/k8s/overlays/dev/kustomization.yaml`:

```yaml
# k3d overlay (spec sections 3.4.4, 11.7, 15.3). scripts/dev-cluster.sh writes generated/ (the
# local registry images and the node IP) and then runs: kubectl apply -k deploy/k8s/overlays/dev
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - testsite.yaml
components:
  - generated
configMapGenerator:
  - name: hydra-config
    namespace: hydra
    literals:
      - HYDRA_PUBLIC_URL=http://hydra.localhost
      - HYDRA_LIVE_URL=http://live.hydra.localhost
      - HYDRA_PUBLIC_IP=127.0.0.1
patches:
  - target:
      kind: IngressRoute
      name: hydra-public
    patch: |-
      - op: replace
        path: /spec/entryPoints
        value:
          - web
      - op: replace
        path: /spec/routes/0/match
        value: Host(`hydra.localhost`)
      - op: remove
        path: /spec/tls
  - target:
      kind: IngressRoute
      name: hydra-live
    patch: |-
      - op: replace
        path: /spec/entryPoints
        value:
          - web
      - op: replace
        path: /spec/routes/0/match
        value: Host(`live.hydra.localhost`)
      - op: remove
        path: /spec/tls
```

Create `deploy/k8s/overlays/dev/testsite.yaml`:

```yaml
# Test site for the e2e tests, dev overlay only (spec section 15.3). Session pods reach it at
# http://testsite.hydra-testsite.svc.cluster.local/ through the one egress exception below.
apiVersion: v1
kind: Namespace
metadata:
  name: hydra-testsite
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: testsite
  namespace: hydra-testsite
  labels:
    app: hydra-testsite
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hydra-testsite
  template:
    metadata:
      labels:
        app: hydra-testsite
    spec:
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: testsite
          image: hydra-testsite
          env:
            - name: PORT
              value: '8080'
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 5
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
---
apiVersion: v1
kind: Service
metadata:
  name: testsite
  namespace: hydra-testsite
  labels:
    app: hydra-testsite
spec:
  selector:
    app: hydra-testsite
  ports:
    - name: http
      port: 80
      targetPort: http
---
# The only egress exception for session pods (spec section 15.3). It exists only in this overlay.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sessions-egress-testsite
  namespace: hydra-sessions
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: hydra-testsite
          podSelector:
            matchLabels:
              app: hydra-testsite
      ports:
        - protocol: TCP
          port: 8080
```

- [ ] **Step 5: Ignore the generated dev files**

Append these two lines to the end of `.gitignore` (after the lines of plan 01):

```gitignore
# Written by scripts/dev-cluster.sh (spec section 3.4.4): local registry digests and the k3d node IP
deploy/k8s/overlays/dev/generated/
```

Run: `git check-ignore -v deploy/k8s/overlays/dev/generated/kustomization.yaml`
Expected: one line `.gitignore:<line>:deploy/k8s/overlays/dev/generated/` followed by a tab and the
checked path (the file does not need to exist).

- [ ] **Step 6: Run the test to verify that it passes**

Run: `bash deploy/test/overlays.test.sh`
Expected: 31 lines `ok   ...` and `all tests passed`. The test builds both overlays with
`kubectl kustomize` in a temporary copy of `deploy/k8s` with sample generated files.

Run: `kubectl kustomize deploy/k8s/overlays/prod | grep -E 'HYDRA_(SESSION|MCP)_IMAGE|match:'`
Expected (no release yet):

```text
  HYDRA_MCP_IMAGE: ""
  HYDRA_SESSION_IMAGE: ""
    match: Host(`live.hydra.example.com`)
    match: Host(`hydra.example.com`)
```

- [ ] **Step 7: Format**

Run: `pnpm exec prettier --write deploy/k8s/overlays`
Expected: no file content changes.

- [ ] **Step 8: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 8: `scripts/setup-k3s.sh`

**Files:**
- Create: `scripts/setup-k3s.sh`
- Test: `deploy/test/setup-k3s.test.sh`

**Interfaces:**
- Consumes: `K3S_VERSION` of `scripts/versions.sh` (plan 01); `deploy/lib/cluster.sh` (Task 1);
  `deploy/k8s/base/storageclasses.yaml` and `deploy/k8s/base/namespaces.yaml` (Task 5);
  `deploy/traefik/prod.yaml` (Task 6); `deploy/session/seccomp/chromium.json` (plan 09, optional).
- Produces: the production host setup of spec 11.6 (steps 1 to 11, idempotent), run as
  `sudo [HYDRA_STATE_DIR=...] [HYDRA_MEDIA_PORT_RANGE=...] ./scripts/setup-k3s.sh`. Values in the
  script: `K3S_INSTALL_SH_VERSION="v1.36.5+k3s1"`, `K3S_INSTALL_SH_SHA256` (spec 3.4.5). Functions
  for tests (sourcing runs nothing): `render_k3s_config STATE_DIR NODE_PORT_RANGE`,
  `k3s_install_url K3S_VERSION`, `gateway_data_dir STATE_DIR`,
  `k3s_action INSTALLED WANTED CONFIG_CHANGED` (prints `install`, `restart`, or `none`). Spike S4
  and S6 fallbacks (plan 09) change this file only if they fail.

- [ ] **Step 1: Check the pins that the script reads**

Run: `sh -c '. ./scripts/versions.sh && echo "$K3S_VERSION $K3S_IMAGE $K3D_VERSION"'`
Expected: `v1.36.5+k3s1 rancher/k3s:v1.36.5-k3s1@sha256:057cfd5a9d51b89f1f0ee139c28d5d5fdd5aa7ddeac2742a0ba90c6dbc0329bb v5.9.0`

Run: `curl -fsSL 'https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5%2Bk3s1/install.sh' | shasum -a 256`
Expected: `46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad  -` (the value of Step 3).
If `K3S_VERSION` is not `v1.36.5+k3s1`, read the `install.sh` of that tag, and use its tag and hash
for `K3S_INSTALL_SH_VERSION` and `K3S_INSTALL_SH_SHA256` in Step 3.

- [ ] **Step 2: Write the failing test**

Create `deploy/test/setup-k3s.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for scripts/setup-k3s.sh (the parts that run without root): bash deploy/test/setup-k3s.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

assert_eq 'script syntax' 'ok' "$(bash -n "$HYDRA_REPO_DIR/scripts/setup-k3s.sh" && echo ok)"
# shellcheck source=scripts/setup-k3s.sh
. "$HYDRA_REPO_DIR/scripts/setup-k3s.sh"

assert_eq 'versions.sh: K3S_VERSION' 'yes' "$([[ "$K3S_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] && echo yes)"
assert_eq 'install.sh hash is for the pinned k3s' "$K3S_VERSION" "$K3S_INSTALL_SH_VERSION"
assert_eq 'install.sh hash format' 'yes' "$([[ "$K3S_INSTALL_SH_SHA256" =~ ^[0-9a-f]{64}$ ]] && echo yes)"
assert_eq 'versions.sh: K3S_IMAGE has a digest' 'yes' "$([[ "$K3S_IMAGE" == *:*@sha256:* ]] && echo yes)"

expected='secrets-encryption: true
write-kubeconfig-mode: "0600"
default-local-storage-path: /var/lib/hydra/volumes
protect-kernel-defaults: true
service-node-port-range: 30000-52099'
assert_eq 'k3s config' "$expected" "$(render_k3s_config /var/lib/hydra "$(hydra_node_port_range 52000-52099)")"
assert_eq 'install.sh URL' 'https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5%2Bk3s1/install.sh' \
  "$(k3s_install_url v1.36.5+k3s1)"
assert_eq 'gateway-data folder' '/var/lib/hydra/volumes/hydra/gateway-data' "$(gateway_data_dir /var/lib/hydra)"
assert_eq 'first install' 'install' "$(k3s_action '' v1.36.5+k3s1 1)"
assert_eq 'upgrade' 'install' "$(k3s_action v1.35.9+k3s1 v1.36.5+k3s1 0)"
assert_eq 'config change restarts k3s' 'restart' "$(k3s_action v1.36.5+k3s1 v1.36.5+k3s1 1)"
assert_eq 'no change, no restart' 'none' "$(k3s_action v1.36.5+k3s1 v1.36.5+k3s1 0)"
assert_eq 'sourcing does not run main' 'defined' "$(declare -F main >/dev/null && echo defined)"
finish_tests
```

Run: `bash deploy/test/setup-k3s.test.sh`
Expected: `FAIL script syntax`, then `deploy/test/setup-k3s.test.sh: line 8: <repo>/scripts/setup-k3s.sh: No such file or directory`.

- [ ] **Step 3: Write the script**

Create `scripts/setup-k3s.sh`:

```bash
#!/usr/bin/env bash
# Production host setup for Hydra Browsers (spec section 11.6). Run it as root from a checkout of
# this repository on the EC2 host:
#   sudo HYDRA_STATE_DIR=/var/lib/hydra HYDRA_MEDIA_PORT_RANGE=52000-52099 ./scripts/setup-k3s.sh
# Both variables are optional (the values above are the defaults). The script is idempotent: run it
# again after a change, for example a new k3s pin in scripts/versions.sh.
# Sourcing this file only defines the functions (deploy/test/setup-k3s.test.sh does that).
set -euo pipefail

HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.sh
. "$HYDRA_REPO_DIR/scripts/versions.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

HYDRA_STATE_DIR="${HYDRA_STATE_DIR:-/var/lib/hydra}"
HYDRA_MEDIA_PORT_RANGE="${HYDRA_MEDIA_PORT_RANGE:-52000-52099}"
K3S_CONFIG_FILE=/etc/rancher/k3s/config.yaml
SYSCTL_FILE=/etc/sysctl.d/90-kubelet.conf
SECCOMP_PROFILE="$HYDRA_REPO_DIR/deploy/session/seccomp/chromium.json"
KUBELET_SECCOMP_PROFILE=/var/lib/kubelet/seccomp/hydra/chromium.json
K3S_CONFIG_CHANGED=0

# The SHA-256 of install.sh at the k3s release tag K3S_INSTALL_SH_VERSION (spec section 3.4.5).
# When scripts/versions.sh changes K3S_VERSION, read the new install.sh and update both values
# (README.md, section "Update k3s"). deploy/test/setup-k3s.test.sh fails until then.
K3S_INSTALL_SH_VERSION="v1.36.5+k3s1"
K3S_INSTALL_SH_SHA256="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
kubectl() { k3s kubectl "$@"; }

# The content of /etc/rancher/k3s/config.yaml.
render_k3s_config() { # STATE_DIR NODE_PORT_RANGE
  cat <<EOF
secrets-encryption: true
write-kubeconfig-mode: "0600"
default-local-storage-path: $1/volumes
protect-kernel-defaults: true
service-node-port-range: $2
EOF
}

# install.sh at the k3s release tag. The "+" of the tag must be encoded in the URL.
k3s_install_url() { # K3S_VERSION
  echo "https://raw.githubusercontent.com/k3s-io/k3s/${1//+/%2B}/install.sh"
}

# The gateway-data folder of the local-path volumes (spec section 5.2).
gateway_data_dir() { # STATE_DIR
  echo "$1/volumes/$HYDRA_GATEWAY_DATA_PATH"
}

# Prints install, restart, or none.
k3s_action() { # INSTALLED_VERSION WANTED_VERSION CONFIG_CHANGED
  if [[ "$1" != "$2" ]]; then
    echo install
  elif [[ "$3" == 1 ]]; then
    echo restart
  else
    echo none
  fi
}

# Step 1: root on Debian or Ubuntu.
step_check_host() {
  [[ "$(id -u)" == 0 ]] || die 'run this script as root'
  [[ -r /etc/os-release ]] || die '/etc/os-release is missing'
  local os_id
  # shellcheck source=/dev/null
  os_id="$(. /etc/os-release && echo "${ID:-}")"
  case "$os_id" in
    debian | ubuntu) ;;
    *) die "this script supports Debian and Ubuntu, not '$os_id'" ;;
  esac
}

# Step 2: the kernel settings that protect-kernel-defaults needs (k3s hardening guide).
step_sysctls() {
  cat >"$SYSCTL_FILE" <<'EOF'
vm.panic_on_oom=0
vm.overcommit_memory=1
kernel.panic=10
kernel.panic_on_oops=1
EOF
  sysctl -p "$SYSCTL_FILE" >/dev/null
}

# Step 3: automatic security updates.
step_security_updates() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends unattended-upgrades curl ca-certificates
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades.service >/dev/null
}

# Step 4: the state folder. The operator mounts the persistent volume here (spec section 11.5).
# Also the gateway-data folder, owned by the non-root gateway with mode 0700 (deploy/lib/cluster.sh).
step_state_dir() {
  local data_dir
  data_dir="$(gateway_data_dir "$HYDRA_STATE_DIR")"
  mkdir -p "$HYDRA_STATE_DIR"
  chmod 0700 "$HYDRA_STATE_DIR"
  if ! mountpoint -q "$HYDRA_STATE_DIR"; then
    warn "$HYDRA_STATE_DIR is not a mount point; mount the persistent volume there (spec 11.5)"
  fi
  mkdir -p "$data_dir"
  chown "$HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID" "$data_dir"
  chmod 0700 "$data_dir"
}

# Step 5: the k3s config. Sets K3S_CONFIG_CHANGED to 1 if the file changed.
step_k3s_config() { # NODE_PORT_RANGE
  local wanted
  wanted="$(render_k3s_config "$HYDRA_STATE_DIR" "$1")"
  mkdir -p "$(dirname "$K3S_CONFIG_FILE")"
  if [[ -f "$K3S_CONFIG_FILE" && "$(cat "$K3S_CONFIG_FILE")" == "$wanted" ]]; then
    K3S_CONFIG_CHANGED=0
    return
  fi
  printf '%s\n' "$wanted" >"$K3S_CONFIG_FILE.tmp"
  chmod 0600 "$K3S_CONFIG_FILE.tmp"
  mv "$K3S_CONFIG_FILE.tmp" "$K3S_CONFIG_FILE"
  K3S_CONFIG_CHANGED=1
  log "wrote $K3S_CONFIG_FILE"
}

# Step 6: the Chromium seccomp profile of spike S1, if it exists.
step_seccomp() {
  if [[ -f "$SECCOMP_PROFILE" ]]; then
    install -D -m 0644 "$SECCOMP_PROFILE" "$KUBELET_SECCOMP_PROFILE"
    log "installed $KUBELET_SECCOMP_PROFILE"
  fi
}

# Step 7: k3s at the pinned version. install.sh checks the checksum of the k3s binary.
step_k3s() {
  local installed='' action tmp
  if command -v k3s >/dev/null 2>&1; then
    installed="$(k3s --version | awk 'NR == 1 { print $3 }')"
  fi
  action="$(k3s_action "$installed" "$K3S_VERSION" "$K3S_CONFIG_CHANGED")"
  case "$action" in
    none) log "k3s $K3S_VERSION is installed and its config did not change" ;;
    restart)
      log 'restarting k3s for the new config'
      systemctl restart k3s
      ;;
    install)
      log "installing k3s $K3S_VERSION"
      tmp="$(mktemp -d)"
      curl -fsSL --retry 3 -o "$tmp/install.sh" "$(k3s_install_url "$K3S_VERSION")"
      if ! echo "$K3S_INSTALL_SH_SHA256  $tmp/install.sh" | sha256sum -c --status -; then
        rm -rf "$tmp"
        die "install.sh of k3s $K3S_VERSION does not match K3S_INSTALL_SH_SHA256"
      fi
      INSTALL_K3S_VERSION="$K3S_VERSION" sh "$tmp/install.sh"
      rm -rf "$tmp"
      ;;
  esac
}

# Step 8: wait until the node is Ready.
step_wait_for_node() {
  for _ in $(seq 1 60); do
    if kubectl get nodes -o name 2>/dev/null | grep -q .; then
      break
    fi
    sleep 5
  done
  kubectl wait --for=condition=Ready nodes --all --timeout=300s
}

# Step 11: the next steps for the operator.
step_next_steps() {
  local node_ip
  node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  cat <<EOF

k3s $K3S_VERSION is ready. Next steps (spec sections 6.1, 6.3, 11.8):
  1. Create the namespaces and the root key Secret. Keep a copy of the key in a secret store:
       kubectl apply -f $HYDRA_REPO_DIR/deploy/k8s/base/namespaces.yaml
       kubectl -n hydra create secret generic hydra-secret-key \\
         --from-literal=HYDRA_SECRET_KEY="\$(openssl rand -base64 32)"
  2. In deploy/k8s/overlays/prod/kustomization.yaml, set the hostnames, the Elastic IP, and the
     node IP $node_ip. Run the release workflow and merge its pull request, so that the prod
     overlay has image digests. If the images on ghcr.io are private, give k3s a read token in
     /etc/rancher/k3s/registries.yaml.
  3. Apply the prod overlay:
       kubectl apply -k $HYDRA_REPO_DIR/deploy/k8s/overlays/prod
       kubectl -n hydra rollout status deploy/hydra-gateway
  4. Create the first admin:
       kubectl exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>
EOF
}

main() {
  step_check_host
  [[ "$K3S_VERSION" == "$K3S_INSTALL_SH_VERSION" ]] ||
    die "scripts/versions.sh pins k3s $K3S_VERSION, but K3S_INSTALL_SH_SHA256 is for $K3S_INSTALL_SH_VERSION: read the new install.sh and update both values in this script"
  local node_port_range
  node_port_range="$(hydra_node_port_range "$HYDRA_MEDIA_PORT_RANGE")"
  step_sysctls
  step_security_updates
  step_state_dir
  step_k3s_config "$node_port_range"
  step_seccomp
  step_k3s
  step_wait_for_node
  log 'step 9: applying the StorageClasses (the Traefik volume needs hydra-retain)'
  kubectl apply -f "$HYDRA_REPO_DIR/deploy/k8s/base/storageclasses.yaml"
  log 'step 10: applying the Traefik values'
  kubectl apply -f "$HYDRA_REPO_DIR/deploy/traefik/prod.yaml"
  step_next_steps
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

Run: `chmod +x scripts/setup-k3s.sh`

- [ ] **Step 4: Run the test to verify that it passes**

Run: `bash deploy/test/setup-k3s.test.sh && bash -n scripts/setup-k3s.sh && echo syntax-ok`
Expected: 13 lines `ok   ...`, `all tests passed`, `syntax-ok`.

The script needs root on Debian or Ubuntu. Do not run `main` on the development machine. Spike S4
and S6 (plan 09) run it on a test host.

- [ ] **Step 5: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 9: `scripts/dev-cluster.sh`

**Files:**
- Modify: `scripts/versions.sh` (append four lines)
- Create: `scripts/dev-cluster.sh`
- Test: `deploy/test/dev-cluster.test.sh`

**Interfaces:**
- Consumes: `K3S_VERSION`, `K3S_IMAGE`, `K3D_VERSION` of `scripts/versions.sh` (plan 01);
  `deploy/lib/cluster.sh` (Task 1); the four Dockerfiles (Tasks 2 to 4); the base and the dev overlay
  (Tasks 5 and 7); `deploy/traefik/dev.yaml` (Task 6); `deploy/k8s/write-overlay-component.sh`
  (Task 7).
- Produces: `./scripts/dev-cluster.sh` (spec 11.7, safe to run again): k3d cluster `hydra-dev`
  (kubectl context `k3d-hydra-dev`, node container `k3d-hydra-dev-server-0`), registry container
  `k3d-hydra-registry` (`localhost:5111` for pushes, `k3d-hydra-registry:5111` in the cluster), images
  tagged `dev-<12 hex>[-dirty]`, the Secret `hydra-secret-key` (created once), and the deployed dev
  overlay. Plan 09 (spikes) and plan 10 (e2e and CI) run this script. Functions for tests (sourcing
  runs nothing): `parse_k3d_version`, `parse_digest_header`, `dev_image_tag COMMIT DIRTY`,
  `k3d_create_args NODE_PORT_RANGE FIRST LAST WITH_SECCOMP`, `gateway_data_command`.

- [ ] **Step 1: Pin the registry image of the dev cluster**

Append these lines to the end of `scripts/versions.sh` (keep the lines of plan 01):

```sh

# The local image registry of the k3d dev cluster (scripts/dev-cluster.sh). Added by plan 08.
# renovate: datasource=docker depName=registry
K3D_REGISTRY_IMAGE="registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8"
```

Run: `sh -c '. ./scripts/versions.sh && echo "$K3D_REGISTRY_IMAGE"' && node scripts/check-repo.ts`
Expected: the image reference, then `check-repo: OK`.

- [ ] **Step 2: Write the failing test**

Create `deploy/test/dev-cluster.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for scripts/dev-cluster.sh (the parts that run without Docker): bash deploy/test/dev-cluster.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

assert_eq 'script syntax' 'ok' "$(bash -n "$HYDRA_REPO_DIR/scripts/dev-cluster.sh" && echo ok)"
# shellcheck source=scripts/dev-cluster.sh
. "$HYDRA_REPO_DIR/scripts/dev-cluster.sh"

assert_eq 'versions.sh: K3D_VERSION' 'yes' "$([[ "$K3D_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo yes)"
assert_eq 'versions.sh: K3D_REGISTRY_IMAGE has a digest' 'yes' "$([[ "$K3D_REGISTRY_IMAGE" == *:*@sha256:* ]] && echo yes)"
assert_eq 'k3d version' 'v5.9.0' "$(printf 'k3d version v5.9.0\nk3s version v1.31.5-k3s1 (default)\n' | parse_k3d_version)"
assert_eq 'digest header' 'sha256:abc' "$(printf 'HTTP/1.1 200 OK\r\nDocker-Content-Digest: sha256:abc\r\n\r\n' | parse_digest_header)"
assert_eq 'clean tag' 'dev-0123456789ab' "$(dev_image_tag 0123456789ab 0)"
assert_eq 'dirty tag' 'dev-0123456789ab-dirty' "$(dev_image_tag 0123456789ab 1)"

create_args="$(k3d_create_args 30000-52099 52000 52099 0)"
assert_contains 'pinned k3s image' "$create_args" "$K3S_IMAGE"
assert_contains 'local registry' "$create_args" 'k3d-hydra-registry:5111'
assert_contains 'node port range of setup-k3s.sh' "$create_args" '--service-node-port-range=30000-52099@server:0'
assert_contains 'HTTP port' "$create_args" '127.0.0.1:80:80@loadbalancer'
assert_contains 'media ports UDP' "$create_args" '127.0.0.1:52000-52099:52000-52099/udp@server:0:direct'
assert_contains 'media ports TCP' "$create_args" '127.0.0.1:52000-52099:52000-52099/tcp@server:0:direct'
assert_not_contains 'no seccomp mount without a profile' "$create_args" '/var/lib/kubelet/seccomp/hydra'
create_args="$(k3d_create_args 30000-52099 52000 52099 1)"
assert_contains 'seccomp mount with a profile' "$create_args" 'seccomp:/var/lib/kubelet/seccomp/hydra@server:0'
assert_eq 'gateway-data folder for the non-root gateway' \
  'mkdir -p /var/lib/rancher/k3s/storage/hydra/gateway-data && chown 65532:65532 /var/lib/rancher/k3s/storage/hydra/gateway-data && chmod 0700 /var/lib/rancher/k3s/storage/hydra/gateway-data' \
  "$(gateway_data_command)"
assert_eq 'sourcing does not run main' 'defined' "$(declare -F main >/dev/null && echo defined)"
finish_tests
```

Run: `bash deploy/test/dev-cluster.test.sh`
Expected: `FAIL script syntax`, then `deploy/test/dev-cluster.test.sh: line 8: <repo>/scripts/dev-cluster.sh: No such file or directory`.

- [ ] **Step 3: Write the script**

Create `scripts/dev-cluster.sh`:

```bash
#!/usr/bin/env bash
# Local k3d cluster for development and the e2e tests (spec section 11.7): ./scripts/dev-cluster.sh
#
# It creates the cluster hydra-dev (pinned k3s image) and a local registry, applies the Traefik dev
# values, builds the four images, pushes them, writes deploy/k8s/overlays/dev/generated/, and
# applies the dev overlay. Run it again after a change: it keeps the cluster and the registry and
# deploys new images. Remove everything:
#   k3d cluster delete hydra-dev && k3d registry delete k3d-hydra-registry
# Needs Docker, k3d (the version of scripts/versions.sh), kubectl, curl, git, and openssl.
# Sourcing this file only defines the functions (deploy/test/dev-cluster.test.sh does that).
# Works with bash 3.2 (macOS).
set -euo pipefail

HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.sh
. "$HYDRA_REPO_DIR/scripts/versions.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

HYDRA_MEDIA_PORT_RANGE="${HYDRA_MEDIA_PORT_RANGE:-52000-52099}"
CLUSTER_NAME=hydra-dev
KUBE_CONTEXT="k3d-$CLUSTER_NAME"
SERVER_NODE="k3d-$CLUSTER_NAME-server-0"
REGISTRY_NAME=hydra-registry
REGISTRY_CONTAINER="k3d-$REGISTRY_NAME"
REGISTRY_PORT=5111
# The host pushes to localhost:5111. The k3d node pulls k3d-hydra-registry:5111 (k3d writes this
# mirror into the k3s registries.yaml). Both names reach the same registry, so the digests match.
PUSH_REGISTRY="localhost:$REGISTRY_PORT"
CLUSTER_REGISTRY="$REGISTRY_CONTAINER:$REGISTRY_PORT"
GENERATED_DIR="$HYDRA_REPO_DIR/deploy/k8s/overlays/dev/generated"
SECCOMP_DIR="$HYDRA_REPO_DIR/deploy/session/seccomp"
# The default local-path storage folder of k3s inside the k3d node.
K3D_STORAGE_DIR=/var/lib/rancher/k3s/storage

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# Reads `k3d version` output and prints the k3d version, for example v5.9.0.
parse_k3d_version() { sed -n 's/^k3d version \(v[^ ]*\).*/\1/p' | head -n 1; }

# Reads `curl -sI` headers of a registry manifest request and prints the digest.
parse_digest_header() { tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }'; }

dev_image_tag() { # COMMIT DIRTY
  if [[ "$2" == 1 ]]; then echo "dev-$1-dirty"; else echo "dev-$1"; fi
}

# The arguments of `k3d cluster create`, one per line.
k3d_create_args() { # NODE_PORT_RANGE FIRST_MEDIA_PORT LAST_MEDIA_PORT WITH_SECCOMP
  local ports="$2-$3"
  printf '%s\n' cluster create "$CLUSTER_NAME" \
    --image "$K3S_IMAGE" \
    --servers 1 \
    --agents 0 \
    --registry-use "$CLUSTER_REGISTRY" \
    --k3s-arg "--service-node-port-range=$1@server:0" \
    --port '127.0.0.1:80:80@loadbalancer' \
    --port "127.0.0.1:$ports:$ports/udp@server:0:direct" \
    --port "127.0.0.1:$ports:$ports/tcp@server:0:direct" \
    --wait \
    --timeout 300s
  if [[ "$4" == 1 ]]; then
    printf '%s\n' --volume "$SECCOMP_DIR:/var/lib/kubelet/seccomp/hydra@server:0"
  fi
}

# The sh command that prepares the gateway-data folder in the k3d node (deploy/lib/cluster.sh).
gateway_data_command() {
  local dir="$K3D_STORAGE_DIR/$HYDRA_GATEWAY_DATA_PATH"
  echo "mkdir -p $dir && chown $HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID $dir && chmod 0700 $dir"
}

wait_for_crd() { # NAME
  for _ in $(seq 1 90); do
    if kc get crd "$1" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  kc wait --for=condition=Established "crd/$1" --timeout=60s >/dev/null
}

# Step 1: tools and the k3d version.
step_check_tools() {
  local tool installed
  for tool in docker k3d kubectl curl git openssl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
  done
  docker info >/dev/null 2>&1 || die 'the Docker daemon does not run (start Docker Desktop)'
  installed="$(k3d version | parse_k3d_version)"
  [[ "$installed" == "$K3D_VERSION" ]] ||
    die "k3d $K3D_VERSION is necessary (scripts/versions.sh), found '${installed:-none}'"
}

# Step 2a: the local registry (pinned image, only on 127.0.0.1).
step_registry() {
  if docker container inspect "$REGISTRY_CONTAINER" >/dev/null 2>&1; then
    docker start "$REGISTRY_CONTAINER" >/dev/null
    return
  fi
  log "creating the registry $REGISTRY_CONTAINER"
  k3d registry create "$REGISTRY_NAME" --image "$K3D_REGISTRY_IMAGE" \
    --port "127.0.0.1:$REGISTRY_PORT" --enforce-port-match --no-help
}

# Step 2b: the cluster with the pinned k3s image, the node port range of setup-k3s.sh, the media
# ports on 127.0.0.1, and the seccomp profile if it exists.
step_cluster() { # NODE_PORT_RANGE
  local ports first last with_seccomp=0 line running
  local -a args=()
  ports="$(hydra_media_ports "$HYDRA_MEDIA_PORT_RANGE")"
  first="${ports% *}"
  last="${ports#* }"
  if [[ -f "$SECCOMP_DIR/chromium.json" ]]; then with_seccomp=1; fi
  if k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1; then
    k3d cluster start "$CLUSTER_NAME" >/dev/null
    running="$(docker exec "$SERVER_NODE" k3s --version | awk 'NR == 1 { print $3 }')"
    if [[ "$running" != "$K3S_VERSION" ]]; then
      die "the cluster runs k3s $running, not $K3S_VERSION: run 'k3d cluster delete $CLUSTER_NAME' and this script again"
    fi
    if [[ "$with_seccomp" == 1 ]] &&
      ! docker exec "$SERVER_NODE" test -f /var/lib/kubelet/seccomp/hydra/chromium.json; then
      die "the cluster has no seccomp profile: run 'k3d cluster delete $CLUSTER_NAME' and this script again"
    fi
    return
  fi
  log "creating the cluster $CLUSTER_NAME (k3s $K3S_VERSION)"
  while IFS= read -r line; do args+=("$line"); done < <(k3d_create_args "$1" "$first" "$last" "$with_seccomp")
  k3d "${args[@]}"
}

# Step 3: the Traefik dev values.
step_traefik() {
  wait_for_crd helmchartconfigs.helm.cattle.io
  kc apply -f "$HYDRA_REPO_DIR/deploy/traefik/dev.yaml"
}

image_digest() { # NAME TAG
  curl -fsSI \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://$PUSH_REGISTRY/v2/$1/manifests/$2" | parse_digest_header
}

# Builds and pushes one image, then prints NAME=DIGEST.
build_and_push() { # NAME DOCKERFILE TAG
  local ref="$PUSH_REGISTRY/$1:$3" digest
  log "building $1"
  docker build --file "$HYDRA_REPO_DIR/$2" --tag "$ref" "$HYDRA_REPO_DIR" >&2
  docker push "$ref" >&2
  digest="$(image_digest "$1" "$3")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the registry has no digest for $ref"
  echo "$1=$digest"
}

# Step 4: images and the generated overlay files (spec section 3.4.4).
step_images() {
  local commit dirty=0 tag gateway session mcp testsite node_ip
  commit="$(git -C "$HYDRA_REPO_DIR" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "$HYDRA_REPO_DIR" status --porcelain)" ]]; then dirty=1; fi
  tag="$(dev_image_tag "$commit" "$dirty")"
  gateway="$(build_and_push hydra-gateway deploy/Dockerfile "$tag")"
  session="$(build_and_push hydra-session deploy/session/Dockerfile.session "$tag")"
  mcp="$(build_and_push hydra-mcp deploy/session/Dockerfile.mcp "$tag")"
  testsite="$(build_and_push hydra-testsite deploy/testsite/Dockerfile "$tag")"
  node_ip="$(kc get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  mkdir -p "$GENERATED_DIR"
  bash "$HYDRA_REPO_DIR/deploy/k8s/write-overlay-component.sh" \
    --out "$GENERATED_DIR/kustomization.yaml" --registry "$CLUSTER_REGISTRY" --tag "$tag" \
    --image "$gateway" --image "$session" --image "$mcp" --image "$testsite" \
    --node-ip "$node_ip" --source 'scripts/dev-cluster.sh'
  log "wrote $GENERATED_DIR/kustomization.yaml (node IP $node_ip)"
}

# Step 5: the dev overlay: the gateway (HYDRA_PUBLIC_IP=127.0.0.1) and the test site.
step_apply() {
  wait_for_crd ingressroutes.traefik.io
  kc apply -f "$HYDRA_REPO_DIR/deploy/k8s/base/namespaces.yaml"
  if ! kc -n hydra get secret hydra-secret-key >/dev/null 2>&1; then
    log 'creating the Secret hydra-secret-key with a new random key'
    kc -n hydra create secret generic hydra-secret-key \
      --from-literal=HYDRA_SECRET_KEY="$(openssl rand -base64 32)"
  fi
  docker exec "$SERVER_NODE" sh -c "$(gateway_data_command)"
  kc apply -k "$HYDRA_REPO_DIR/deploy/k8s/overlays/dev"
  kc -n hydra-testsite rollout status deploy/testsite --timeout=180s
  kc -n hydra-sessions rollout status ds/session-image-prepull --timeout=900s
  kc -n hydra rollout status deploy/hydra-gateway --timeout=300s
}

main() {
  local node_port_range
  node_port_range="$(hydra_node_port_range "$HYDRA_MEDIA_PORT_RANGE")"
  step_check_tools
  step_registry
  step_cluster "$node_port_range"
  step_traefik
  step_images
  step_apply
  cat <<EOF

The Hydra dev cluster is ready (kubectl context $KUBE_CONTEXT):
  dashboard  http://hydra.localhost
  live view  http://live.hydra.localhost
Create an admin:
  kubectl --context $KUBE_CONTEXT exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

Run: `chmod +x scripts/dev-cluster.sh`

- [ ] **Step 4: Run the test to verify that it passes**

Run: `bash deploy/test/dev-cluster.test.sh && /bin/bash -n scripts/dev-cluster.sh && echo syntax-ok`
Expected: 17 lines `ok   ...`, `all tests passed`, `syntax-ok`.

- [ ] **Step 5: Create the dev cluster (Needs Docker and k3d)**

Needs Docker and k3d `v5.9.0` (README of plan 01, "Install k3d"). Port 80 and ports 52000 to 52099 on
`127.0.0.1` must be free. Run from the repository root:

`./scripts/dev-cluster.sh`

Expected: the script creates the registry and the cluster, builds and pushes the four images, writes
`deploy/k8s/overlays/dev/generated/kustomization.yaml`, waits for the test site, the pre-pull
DaemonSet, and the gateway, and ends with:

```text
The Hydra dev cluster is ready (kubectl context k3d-hydra-dev):
  dashboard  http://hydra.localhost
  live view  http://live.hydra.localhost
```

- [ ] **Step 6: Check the deployment (Needs Docker and k3d)**

Needs Docker and k3d. Run:

```bash
kubectl --context k3d-hydra-dev -n hydra get deploy hydra-gateway -o jsonpath='{.status.readyReplicas}{"\n"}'
kubectl --context k3d-hydra-dev -n hydra-testsite get deploy testsite -o jsonpath='{.status.readyReplicas}{"\n"}'
kubectl --context k3d-hydra-dev -n hydra-sessions get ds session-image-prepull -o jsonpath='{.status.numberReady}{"\n"}'
curl -fsS -o /dev/null -w '%{http_code}\n' http://hydra.localhost/healthz
docker exec k3d-hydra-dev-server-0 ls /var/lib/rancher/k3s/storage/hydra
```

Expected: `1`, `1`, `1`, `200`, and `gateway-data` (the fixed folder of spec 5.2; spike S4 tests the
reuse of the folder).

- [ ] **Step 7: Check Traefik and the data folder (Needs Docker and k3d)**

Needs Docker and k3d. Review Focus 1 and 2. Run:

```bash
kubectl --context k3d-hydra-dev -n kube-system get deploy traefik -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -c 'respondingTimeouts.readTimeout=0s'
kubectl --context k3d-hydra-dev -n kube-system get svc traefik -o jsonpath='{.spec.externalTrafficPolicy}{"\n"}'
docker exec k3d-hydra-dev-server-0 ls -lnd /var/lib/rancher/k3s/storage/hydra/gateway-data
kubectl --context k3d-hydra-dev -n hydra logs deploy/hydra-gateway | grep -c 'cannot set the file mode'
```

Expected: `2`, `Local`, a line that starts with `drwx------` and shows the owner `65532 65532`, and
`0`.

- [ ] **Step 8: Run the script again (Needs Docker and k3d)**

Needs Docker and k3d. Review Focus 4. Run:

```bash
before="$(kubectl --context k3d-hydra-dev -n hydra get secret hydra-secret-key -o jsonpath='{.metadata.uid}')"
./scripts/dev-cluster.sh
after="$(kubectl --context k3d-hydra-dev -n hydra get secret hydra-secret-key -o jsonpath='{.metadata.uid}')"
[ "$before" = "$after" ] && echo 'same secret'
```

Expected: the second run does not create the registry, the cluster, or the Secret again, deploys the
new images, ends with the same "ready" text, and prints `same secret`.

- [ ] **Step 9: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller. Tell the
controller which Needs Docker steps ran.

---

### Task 10: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `deploy/test/release-workflow.test.sh`

**Interfaces:**
- Consumes: the four Dockerfiles (Tasks 2 to 4); `deploy/k8s/write-overlay-component.sh` and
  `deploy/k8s/overlays/prod/images/kustomization.yaml` (Task 7); `deploy/test/lib.sh` (Task 1).
- Produces: workflow `release` (manual run, or a push of a `v*` tag). Job `images` pushes
  `ghcr.io/<owner in lowercase>/hydra-{gateway,session,mcp,testsite}:<commit SHA>` for `linux/amd64`
  and gives their digests. Job `overlay` writes the digests of the gateway, session, and MCP images
  to the prod overlay and opens the pull request `release/images-<commit SHA>` (spec 3.4.4). After
  the merge: `kubectl apply -k deploy/k8s/overlays/prod` (spec 11.8).

- [ ] **Step 1: Write the failing test**

Create `deploy/test/release-workflow.test.sh`:

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2016 # ${{ ... }} is GitHub Actions syntax, not shell
# Static tests for .github/workflows/release.yml: bash deploy/test/release-workflow.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file="$HYDRA_REPO_DIR/.github/workflows/release.yml"
text="$(cat "$file")"

uses_lines="$(grep -E '^[[:space:]]*(- )?uses:' "$file" || true)"
assert_eq 'seven action steps' '7' "$(count_lines "$uses_lines" 'uses:')"
assert_eq 'every action is pinned to a full commit SHA' '0' \
  "$(printf '%s\n' "$uses_lines" | grep -vcE 'uses: [^@ ]+@[0-9a-f]{40} # v[0-9]' || true)"
assert_eq 'runners are ubuntu-24.04' "$(count_lines "$text" 'runs-on:')" "$(count_lines "$text" 'runs-on: ubuntu-24.04')"
assert_not_contains 'no ubuntu-latest' "$text" 'ubuntu-latest'
for dockerfile in deploy/Dockerfile deploy/session/Dockerfile.session deploy/session/Dockerfile.mcp deploy/testsite/Dockerfile; do
  assert_contains "builds $dockerfile" "$text" "file: $dockerfile"
done
assert_eq 'four images tagged with the commit SHA' '4' "$(count_lines "$text" ':${{ github.sha }}')"
assert_eq 'four images are pushed' '4' "$(count_lines "$text" 'push: true')"
assert_contains 'writes the prod overlay' "$text" '--out deploy/k8s/overlays/prod/images/kustomization.yaml'
for image in hydra-gateway hydra-session hydra-mcp; do
  assert_contains "pins $image in the prod overlay" "$text" "--image \"$image="
done
assert_not_contains 'the test site is not in the prod overlay' "$text" '--image "hydra-testsite='
assert_contains 'opens a pull request' "$text" 'gh pr create'
assert_contains 'no default token rights' "$text" 'permissions: {}'
finish_tests
```

Run: `bash deploy/test/release-workflow.test.sh`
Expected: FAIL with `cat: <repo>/.github/workflows/release.yml: No such file or directory`.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
# Release (spec section 3.4.4): build and push the four images from one commit, tagged with the
# commit SHA, then open a pull request that writes their digests to the prod overlay.
#
# Repository settings: allow GitHub Actions to create pull requests. GitHub starts no workflows for
# a pull request that GITHUB_TOKEN opens, so close and reopen the pull request to run CI on it.
# Images are linux/amd64 (x86_64 EC2 instance types).
name: release

on:
  workflow_dispatch:
  push:
    tags:
      - 'v*'

permissions: {}

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  images:
    name: Build and push the images
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    outputs:
      registry: ${{ steps.registry.outputs.name }}
      gateway: ${{ steps.gateway.outputs.digest }}
      session: ${{ steps.session.outputs.digest }}
      mcp: ${{ steps.mcp.outputs.digest }}
      testsite: ${{ steps.testsite.outputs.digest }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - id: registry
        name: Registry name (GHCR needs a lowercase owner)
        run: echo "name=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_OUTPUT"

      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: gateway
        name: hydra-gateway
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: deploy/Dockerfile
          platforms: linux/amd64
          push: true
          provenance: false
          sbom: false
          tags: ${{ steps.registry.outputs.name }}/hydra-gateway:${{ github.sha }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

      - id: session
        name: hydra-session
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: deploy/session/Dockerfile.session
          platforms: linux/amd64
          push: true
          provenance: false
          sbom: false
          tags: ${{ steps.registry.outputs.name }}/hydra-session:${{ github.sha }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

      - id: mcp
        name: hydra-mcp
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: deploy/session/Dockerfile.mcp
          platforms: linux/amd64
          push: true
          provenance: false
          sbom: false
          tags: ${{ steps.registry.outputs.name }}/hydra-mcp:${{ github.sha }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

      - id: testsite
        name: hydra-testsite
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: deploy/testsite/Dockerfile
          platforms: linux/amd64
          push: true
          provenance: false
          sbom: false
          tags: ${{ steps.registry.outputs.name }}/hydra-testsite:${{ github.sha }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

  overlay:
    name: Open the prod overlay pull request
    needs: images
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write
    env:
      BASE_BRANCH: ${{ github.event.repository.default_branch }}
      BRANCH: release/images-${{ github.sha }}
      COMMIT: ${{ github.sha }}
      REGISTRY: ${{ needs.images.outputs.registry }}
      GATEWAY_DIGEST: ${{ needs.images.outputs.gateway }}
      SESSION_DIGEST: ${{ needs.images.outputs.session }}
      MCP_DIGEST: ${{ needs.images.outputs.mcp }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}

      - name: Write the image digests to the prod overlay
        run: |
          bash deploy/k8s/write-overlay-component.sh \
            --out deploy/k8s/overlays/prod/images/kustomization.yaml \
            --registry "$REGISTRY" --tag "$COMMIT" \
            --image "hydra-gateway=$GATEWAY_DIGEST" \
            --image "hydra-session=$SESSION_DIGEST" \
            --image "hydra-mcp=$MCP_DIGEST" \
            --source "release workflow, commit $COMMIT"
          kubectl kustomize deploy/k8s/overlays/prod > /dev/null

      - name: Open the pull request
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if git diff --quiet; then
            echo "The prod overlay already has the digests of $COMMIT."
            exit 0
          fi
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git switch -c "$BRANCH"
          git add deploy/k8s/overlays/prod/images/kustomization.yaml
          git commit -m "Release images ${COMMIT:0:12}"
          git push --force origin "$BRANCH"
          if gh pr view "$BRANCH" > /dev/null 2>&1; then
            echo "The pull request for $BRANCH exists."
            exit 0
          fi
          gh pr create --base "$BASE_BRANCH" --head "$BRANCH" \
            --title "Release images ${COMMIT:0:12}" \
            --body "Writes the digests of the images built from $COMMIT to the prod overlay (spec section 3.4.4). After the merge, deploy with: kubectl apply -k deploy/k8s/overlays/prod"
```

- [ ] **Step 3: Run the test to verify that it passes**

Run: `bash deploy/test/release-workflow.test.sh`
Expected: 17 lines `ok   ...` and `all tests passed`.

- [ ] **Step 4: Check the pinned Actions**

Run:

```bash
for pair in actions/checkout:v7.0.1 docker/login-action:v4.6.0 docker/build-push-action:v7.4.0; do
  gh api "repos/${pair%%:*}/commits/${pair##*:}" --jq '"\(.sha) '"$pair"'"'
done
```

Expected:

```text
3d3c42e5aac5ba805825da76410c181273ba90b1 actions/checkout:v7.0.1
dbcb813823bdd20940b903addbd779551569679f docker/login-action:v4.6.0
c3c9e263c25d99ce0380d002d59b67737d91b0dc docker/build-push-action:v7.4.0
```

- [ ] **Step 5: Run the repository check and format**

Run: `node scripts/check-repo.ts && pnpm exec prettier --write .github/workflows/release.yml`
Expected: `check-repo: OK`, and no content change of the workflow.

- [ ] **Step 6: Run the workflow on GitHub (Needs GitHub, after the files are on the default branch)**

This needs the files on the default branch, the repository setting "Allow GitHub Actions to create
and approve pull requests", and a person who starts it. Run: `gh workflow run release.yml`, then
`gh run watch`. Expected: both jobs pass, and a pull request `Release images <12 hex>` changes only
`deploy/k8s/overlays/prod/images/kustomization.yaml`. GitHub starts no workflow for a pull request
that `GITHUB_TOKEN` opens: close and reopen the pull request to run CI on it.

- [ ] **Step 7: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 11: Full verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: all files of Tasks 1 to 10.
- Produces: the evidence for the controller, and the ordered list of the Needs Docker steps.

- [ ] **Step 1: Run the checks that need no Docker**

Run:

```bash
bash deploy/test/run.sh
bash -n scripts/setup-k3s.sh && bash -n scripts/dev-cluster.sh && echo 'scripts parse'
node scripts/check-repo.ts
pnpm lint && pnpm typecheck && pnpm test
```

Expected: ten `== <name>.test.sh` blocks, each with `all tests passed` (`overlays.test.sh` builds both
overlays with `kubectl kustomize` and sample generated files); `scripts parse`; `check-repo: OK`;
lint, typecheck, and all tests (also the 12 tests of `@hydra/testsite`) pass.

- [ ] **Step 2: List the Needs Docker steps for the controller**

When Docker Desktop runs and k3d `v5.9.0` is installed, run these steps in this order: Task 2 Step 12,
Task 3 Steps 5 and 6, Task 4 Steps 5 and 6, Task 9 Steps 5 to 8. After the files are on the default
branch, Task 10 Step 6 needs GitHub.

- [ ] **Step 3: Checkpoint**

Run: `pnpm lint && pnpm typecheck && bash deploy/test/run.sh && node scripts/check-repo.ts`
Expected: all pass.
Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller, and say
which Needs Docker steps ran and which wait for Docker.
