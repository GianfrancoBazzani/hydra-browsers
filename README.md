# Hydra Browsers

Hydra Browsers is an internal tool for a team. A team member starts isolated Chromium browsers
("sessions") on a remote server from a web dashboard, watches each session live, and controls it
with mouse and keyboard. External AI agents (Claude Code, Cursor, and other MCP clients) connect to
a session through MCP and control the same browser.

- Design spec (source of truth): [`docs/superpowers/specs/2026-10-10-hydra-browsers-design.md`](docs/superpowers/specs/2026-10-10-hydra-browsers-design.md)
- Rules for all contributors, human or agent: [`AGENTS.md`](AGENTS.md). Read it before you change
  anything. Frontend changes follow [`STYLE.md`](STYLE.md).

## Repository

| Path | Contents |
|---|---|
| `packages/shared` | `@hydra/shared`: zod schemas, API types, constants (Node.js and browser) |
| `packages/server` | `@hydra/server`: gateway, orchestrator, proxies, database, CLI |
| `packages/web` | `@hydra/web`: React dashboard |
| `packages/mcp-sidecar` | `@hydra/mcp-sidecar`: the exact `@playwright/mcp` dependency of the `hydra-mcp` image |
| `scripts/versions.sh` | Pinned k3s, k3d, and `rancher/k3s` image versions |
| `scripts/check-repo.ts` | CI check of the pinning policy and of config parity |
| `.github/workflows/ci.yml` | CI on pull requests |

Spec section 3 gives the full layout, including the parts that later work adds (`deploy/`, the test
site, and the e2e tests).

## Requirements

- **pnpm 10 or newer**, any version. The root `package.json` pins pnpm `12.9.0` in
  `packageManager`, and pnpm switches to that version by itself (`pmOnFail: download`).
- **Node.js 24.21.0** in your shell, from `.node-version` (mise, fnm, and nvm read it). pnpm also
  downloads Node.js 24.21.0 for the scripts of the project (`devEngines.runtime`) and checks the
  download against the checksum in `pnpm-lock.yaml`. npm refuses to run in this folder with a
  different Node.js version (`EBADDEVENGINES`).
- Later, for the local cluster: Docker and the k3d version of `scripts/versions.sh`
  (see [Install k3d](#install-k3d)).

## Commands

| Command | Use |
|---|---|
| `pnpm install` | Install the dependencies |
| `pnpm test` | All unit and integration tests (Vitest projects) |
| `pnpm --filter @hydra/server test` | The tests of one package |
| `pnpm lint` | ESLint and `prettier --check` |
| `pnpm typecheck` | `tsc` for the root scripts and for each package |
| `pnpm build` | Build all packages |
| `node scripts/check-repo.ts` | Pinning and config-parity check (spec section 3.4.7) |
| `pnpm dev` | Gateway and dashboard on the host, with the k3d cluster of `scripts/dev-cluster.sh` (spec section 11.7). Dashboard: `http://hydra.localhost:5173` |
| `pnpm e2e` | End-to-end tests on k3d (spec section 15.3) |

Tests use the TypeScript source of the workspace packages (export condition `@hydra/source`).
Production code uses the `dist/` output of `pnpm build`.

## Reproduce the build on another system

One commit gives the same toolchain, dependency tree, images, and cluster software on each system
(spec section 3.4).

1. Check out the commit.
2. Install pnpm 10 or newer, for example `npm install -g pnpm@12.9.0`. In this folder, pnpm switches
   to the pnpm version of `packageManager`. `pnpm-lock.yaml` records the integrity of that pnpm
   version.
3. Use Node.js 24.21.0 (`.node-version`).
4. Run `pnpm install --frozen-lockfile`. pnpm installs the exact dependency tree of
   `pnpm-lock.yaml` and fails if a `package.json` does not match the lockfile. It checks each package
   against its integrity hash, checks the lockfile again against `minimumReleaseAge` and
   `trustPolicy`, and runs install scripts only for the `allowBuilds` entries that are `true`.
5. Run `node scripts/check-repo.ts`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
   These are the CI jobs (`.github/workflows/ci.yml`, runner `ubuntu-24.04`).
6. Cluster software comes from `scripts/versions.sh`: the k3s version, the `rancher/k3s` image with
   its digest, and the k3d version. `scripts/setup-k3s.sh` holds the SHA-256 of the k3s
   `install.sh`. Container images always have a tag and a digest.

### Install k3d

Download the k3d binary of `K3D_VERSION` and check it against the `checksums.txt` of the same
release. Example for macOS on Apple silicon (for Linux, use `k3d-linux-amd64`). Run it from the repository root.

```sh
. scripts/versions.sh
curl -fsSLO "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-darwin-arm64"
curl -fsSL "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/checksums.txt" -o k3d-checksums.txt
echo "$(grep '/k3d-darwin-arm64$' k3d-checksums.txt | cut -d' ' -f1)  k3d-darwin-arm64" | shasum -a 256 -c - && \
chmod +x k3d-darwin-arm64 && sudo mv k3d-darwin-arm64 /usr/local/bin/k3d && rm k3d-checksums.txt
k3d version
```

### Local cluster on Docker Desktop for macOS

`scripts/dev-cluster.sh` publishes the WebRTC media ports on `127.0.0.1` (the plan 08 default). Docker
Desktop for macOS does not forward UDP that is published on `127.0.0.1`, so the live view shows no
video. Create the cluster with `HYDRA_MEDIA_BIND_ADDRESS=0.0.0.0 ./scripts/dev-cluster.sh`: this
opens the media ports on all interfaces of the Mac. It only applies to a new cluster (run
`k3d cluster delete hydra-dev` first). On Linux and in CI, leave it unset. The same holds for the
load balancer idle timeout (1 h instead of the k3d default of 600 s, needed by the 10 min MCP stream
test): an existing cluster must be deleted and created again.

## Dependency rules

Spec section 3.4 is the full policy. In short:

- **Exact versions only.** No ranges in a `package.json` (only `workspace:*` for internal packages),
  a tag and a digest for each image, a full commit SHA for each GitHub Action. `check-repo.ts`
  enforces these rules in CI.
- **7-day minimum release age.** pnpm refuses a version younger than 7 days
  (`minimumReleaseAge: 10080`), also in an existing lockfile. Add a dependency with an exact
  version, for example `pnpm --filter @hydra/server add <name>@<version>`.
- **Install scripts.** When a new dependency has an install script, `pnpm install` stops with
  `ERR_PNPM_IGNORED_BUILDS`. Read the script, then add an `allowBuilds` entry to
  `pnpm-workspace.yaml` with a comment that gives the reason: `true` only if the package needs the
  script, else `false`.
- **Urgent security fix younger than 7 days:** add the exact version to `minimumReleaseAgeExclude`
  with a comment that gives the date, the reason, and the advisory ID.
  `minimumReleaseAgeExcludePrune` removes the entry when the lockfile no longer uses that version.
- **Trust policy exception:** add the exact version to `trustPolicyExclude` with a reason comment.
- **`overrides`:** exact versions only, each with a reason comment.
- **Updates:** Renovate opens the update pull requests (`renovate.json`). Each one must pass all
  CI jobs. Before you change the Neko, Playwright MCP, or k3s version, read the release notes.

### Update k3s

A k3s update changes `K3S_VERSION` and `K3S_IMAGE` in `scripts/versions.sh`, and the `install.sh`
values `K3S_INSTALL_SH_VERSION` and `K3S_INSTALL_SH_SHA256` in `scripts/setup-k3s.sh`. Renovate
updates `K3S_VERSION` and `K3S_IMAGE` in one pull request. A person reads the new `install.sh` and
updates its version and SHA-256. Until then, `setup-k3s.sh` stops before it runs `install.sh`.

```sh
# 1. The SHA-256 of install.sh of the new release tag (K3S_VERSION, for example v1.36.5+k3s1):
curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5+k3s1/install.sh" | shasum -a 256

# 2. The digest of the multi-arch image (the tag uses "-" instead of "+"):
TOKEN=$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:rancher/k3s:pull" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -fsSI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/rancher/k3s/manifests/v1.36.5-k3s1" | grep -i docker-content-digest
```

## Credits

The visual style of the dashboard follows [ridvanonal/macos-react](https://github.com/ridvanonal/macos-react).
Its README says MIT, but the repository has no LICENSE file. Thus Hydra Browsers copies no code from
it: our components are our own and use the same design values. Most of the color values are the
public Apple system colors.
