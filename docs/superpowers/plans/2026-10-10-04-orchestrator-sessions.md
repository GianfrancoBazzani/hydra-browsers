# Hydra Browsers v1 — Plan 04: Orchestrator and Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kubernetes orchestrator (client, manifest builders, reconciler, pod endpoints, startup check of the media port range), the session service with the capacity check and the media ports, the session routes of spec section 12.1, and the SSE stream `GET /api/events`.

**Architecture:** `src/orchestrator/` turns one `sessions` row into the Kubernetes objects of spec section 7.3 with pure builders, applies them with server-side apply through the small `KubeClient` interface, and derives the session state from the pod with one pure rule function (spec section 7.9). The `Reconciler` runs these passes at start, after API actions, on watch events, and every 30 s. `src/sessions/` holds the user actions (Create, Start, Stop, Restart, Delete) in SQLite transactions and builds the `SessionResource`. The routes in `src/api/` validate and delegate. All tests use `FakeKubeClient`; no cluster is needed.

**Tech Stack:** TypeScript (strict, ESM), Fastify 5, Drizzle ORM with better-sqlite3, zod 4, `@kubernetes/client-node` 2.0.0, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-hydra-browsers-design.md` — sections 4 (media port range check), 7.1 to 7.9, 8.2 step 5, 10.3 (`GET /api/events`), 11.7 (port-forward transport), 12.1 (session routes), 14 (reconciler after a restart), 15.1 (orchestrator and sessions tests).

**Index:** `docs/superpowers/plans/2026-10-10-00-index.md` — conventions (sections 2 and 3), file ownership (section 4), contracts 5.1 to 5.10 and 5.12, spike-dependent files (section 6).

## Global Constraints

- No commits (`AGENTS.md` rule 1). Each task ends with the Checkpoint step of index section 3.
- The spec is the source of truth. Do not edit it (`AGENTS.md` rule 2).
- Exact versions only (spec section 3.4). The one new runtime dependency is `@kubernetes/client-node` `2.0.0`: the newest release on or before 2026-10-03 (published 2026-08-12). Its dependency tree has no install scripts, so it needs no `allowBuilds` entry.
- TypeScript strict, ESM, `.js` import extensions, `erasableSyntaxOnly` (no `enum`, no constructor parameter properties), `noUncheckedIndexedAccess` (index section 2.1).
- Prettier: `printWidth` 100, `singleQuote`, `semi`, `trailingComma: all`. The code blocks of this plan are formatted with Prettier 3.9.9, type-check with TypeScript 6.0.3 (the plan 01 pin; also checked with 7.0.2), and pass ESLint 10.12.0 with typescript-eslint 8.71.0 `recommendedTypeChecked` (stricter than the `recommended` set of plan 01).
- Dependency injection through `deps` objects. Time only from `Clock` (`FakeClock` in tests). Services throw `HydraError`. Only `api/errors.ts` turns errors into HTTP responses (index section 2.4).
- Kubernetes: namespace `config.sessionNamespace` (default `hydra-sessions`), field manager `hydra` with force, the labels `app.kubernetes.io/managed-by: hydra` and `hydra/session-id: <sid>` on all session objects and on the pod template (spec section 7.1).
- The gateway Role has no `delete` on pods and no `pods/portforward` (spec section 11.2). The reconciler never deletes a pod. The port-forward transport runs only in development with the k3d admin kubeconfig (spec section 11.7).
- Spike-dependent parts stay in one file each (index section 6): seccomp and capabilities in `orchestrator/manifests/statefulset.ts` (S1), the viewer profile variable in `orchestrator/manifests/neko-env.ts` (S3), the policy template in `orchestrator/manifests/policies.ts` (S5).
- Commands run from the repository root. One test file: `pnpm --filter @hydra/server exec vitest run <path below packages/server>`.

## Review Focus

1. **Access lost while `GET /api/events` is open** (a member is removed, an admin becomes a member): the next events of that session must not reach the user. Task 13 tests `stops the events of a session at once when the member is removed` and `checks session.read when it sends, after a rights change`.
2. **A session that the user can read only after the SSE stream opened** (new session, new share): its events must arrive without a reconnect. Task 13 test `sends events of a session that the user can read only after the stream opened`.
3. **Restart while the old pod is still Ready**: the session must not show `running` because of the old pod, and the 120 s rule must apply to the new pod. Task 8 tests `does not count the old pod as Ready after a restart` and `uses the 120 s rule for the new pod after a restart`.
4. **A user action while a reconciler pass waits for Kubernetes** (Start, Stop, Restart, Delete): the pass must not overwrite the change with a decision from the old row. Task 8 test `does not write a decision when the row changed during the pass`.
5. **The Kubernetes API does not answer, at gateway start or later**: the gateway still serves the dashboard, `/readyz` answers 503, the port check logs a warning and does not stop the gateway, the reconciler retries with backoff, and a session keeps its media port until its Service is deleted. Task 6 test `logs a warning and passes when the API server does not answer`, Task 8 tests `backs off after a failed pass and logs the error` and `keeps media_port when the media Service cannot be deleted`, Task 12 test `GET /readyz needs the database and the Kubernetes API`.

## Spec deviations

1. **Section 4, startup check of `HYDRA_MEDIA_PORT_RANGE`: a real create and delete instead of `dryRun=All`.** The Kubernetes API server does not check the node port range for a dry-run request. In `pkg/registry/core/service/portallocator/operation.go` (Kubernetes master), the dry-run branch of `PortAllocationOperation.Allocate` only calls `Has(port)`, and `Has` returns false for a port outside the range. Verified with kube-apiserver v1.37.0 (envtest binaries): a dry-run create of a NodePort Service with `nodePort: 52000` and the range `30000-32767` succeeds; the same create without dry-run fails with `spec.ports[0].nodePort: Invalid value: 52000: provided port is not in the valid range. The range of valid ports is 30000-32767`. A dry-run check would never stop the gateway. This plan keeps the purpose and the result rules of section 4 (stop with a message that names `HYDRA_MEDIA_PORT_RANGE` if the API answers "not in the valid range"; other answers pass), with a real request: for the first and the last port, `dryRunNodePorts` deletes a leftover Service `hydra-port-check-<port>`, creates the NodePort Service `hydra-port-check-<port>` (no selector; labels `app.kubernetes.io/managed-by: hydra` and `hydra/purpose: port-check`), and deletes it at once. One Service for each port, so a first port that is in use does not hide the check of the last port. Side effect: two short-lived Services in `hydra-sessions` at each gateway start, before the reconciler starts. If the API server does not answer at all, the check logs a warning and passes (section 4 does not cover this case; `/readyz` reports the problem). The `KubeClient` method keeps its index name `dryRunNodePorts` (see "Index issues").
2. **Section 7.9 rule 6 and the `error` state (clarification).** Read literally, rule 6 ("`desired_state = stopped` and a pod exists → `state = stopping`") also matches right after the error transition, while the pod terminates. The state would become `stopping` and then `stopped`, the error would disappear, and the clause "If `state` is not `error`" of rule 7 could never match. The "Error" paragraph says that the next pass scales the StatefulSet to 0, that rule 7 releases the media port, and that the user then clicks **Retry start**. Thus rule 6 does not change an `error` state in this plan. Nothing else changes.
3. **Section 7.9 rule 2, "the pod is Ready" (clarification).** The pod counts only if it belongs to the current start: its `hydra/started-at` annotation equals `started_at`. After a Restart, the old pod stays Ready for a short time. If it counted, rule 2 would set `ready_at` for the old pod, and rule 4 would never apply to the new pod. A pod of an older start counts only as "a pod exists" for rules 6 and 7. Rule 3 also looks only at the current pod.
4. **Section 7.6 and the locale variables of section 7.4 (clarification).** `--accept-lang=<language>,<base language>`: if the language has no region (for example `de`), the base language is the same, and the flag is `--accept-lang=de` without a duplicate. The language goes into a shell file, so `localeParts()` rejects a tag with characters other than `[A-Za-z0-9-]` (a second guard after the API validation). `LANG` and `LANGUAGE` "from `<language>`": `de-CH` gives `LANG=de_CH.UTF-8` and `LANGUAGE=de_CH:de`; `de` gives `LANG=de.UTF-8` and `LANGUAGE=de`.
5. **Section 7.9 Create (clarification).** "If `start` is true, continue as Start": the insert and the Start run in one transaction. A Create that fails with `capacity_reached` creates no session.
6. **Section 7.2 `restartRequired` (clarification).** "While the session has a pod" is computed from the state (`starting` or `running`), without a Kubernetes call for each API response.
7. **Points that the spec does not fix, chosen here.** `POST /api/sessions` answers `201`. `PATCH` of a `deleting` session answers `409 invalid_state`. `error_reason` of rule 4 is `Timeout: the pod was not Ready 120 s after the start (<Kubernetes reason>: <message>)`.
8. **Section 7.5, not a deviation (open point for the spec owner).** "Start from the Neko default policies" keeps the Neko v3.1.6 `ExtensionInstallForcelist` (uBlock Origin Lite and SponsorBlock) and `ExtensionInstallAllowlist`. The table reason for `ExtensionInstallBlocklist` says "No extensions". This plan follows the literal rule; the test `keeps the other Neko defaults unchanged` makes the choice visible. `policies.ts` is the S5 fallback file, so plan 09 or a reviewer can remove the two keys in one place.

## Index issues

1. **`KubeClient.portForward(podName, port, socket: Duplex): Promise<void>` is added.** The port-forward transport (spec sections 7.3 and 11.7) needs a tunnel through the API server, and `createPodEndpointResolver(config, kube, logger)` gets only a `KubeClient`. `FakeKubeClient` implements it with a TCP connection to a registered target.
2. **`dryRunNodePorts` keeps its name but makes a real create and delete** (Spec deviation 1). Suggested name for the next index revision: `checkNodePorts`.
3. **`createKubeClient(config, kubeConfig?)`** has an optional second parameter. Tests pass a `KubeConfig` for a fake API server.
4. **File ownership.** Plan 04 also modifies `packages/server/package.json` and `pnpm-lock.yaml` (plan 01 assigns the install of `@kubernetes/client-node` `2.0.0` to plan 04) and `packages/server/test/helpers/app.ts` (`createTestApp` fills the plan 04 deps, as section 5.12 asks). Section 4 lists none of these files for plan 04.
5. **`SessionsService` constructor and two additions.** `new SessionsService(deps: SessionsServiceDeps)` with `{ db, config, clock, audit, access, tokens, kube, reconciler: Pick<Reconciler, 'trigger'>, activity }`. `GET /api/events` uses two added public methods: `readableBy(user, sessionId): boolean` (session.read at send time; it also answers for a deleted session, so the members get its last `deleted` event) and `freshUser(userId): AuthedUser | null`.
6. **New helper `createSessionDeps(input): SessionDeps`** in `src/sessions/wiring.ts` returns `{ kube, podEndpoints, reconciler, sessions, activity }`. `main.ts` and `createTestApp` call it. Plan 05 passes its `ActivityTracker` as `activity`.
7. **`ActivityProvider` and `noActivity`** are in `src/sessions/activity.ts` and are exported from `src/sessions/index.ts` (section 5.10 does not name the file).
8. **`AccessService.requireSession(…, request: { method; path })`:** section 5.8 does not say if `path` is the concrete path or the route pattern. `SessionsService` passes the concrete path without the query string (for example `GET /api/sessions/abcdefghij23`), so plan 03 must match the exempt GET routes on concrete paths.
9. **`openSse(reply, …)`** must start the response before it returns (write the headers or hijack the reply). `GET /api/events` then awaits `sse.closed`.
10. **`createTestApp(overrides)`** must build all deps from `overrides.config ?? testConfig()`. The plan 04 tests pass a `config` with a small port pool.
11. **`SessionRow`:** plan 04 reads `state`, `desiredState`, and `screen` through `stateOf`, `desiredStateOf`, and `screenOf` (they work with text and with enum column types) and needs `appliedSettings` to be `NOT NULL` (`SessionSettings`).
12. **`FakeKubeClient`:** `setContainerWaiting(sid, reason, message?)` has an optional third parameter, and the class has more helpers: `calls`, `object`, `objectsOf`, `failNext`, `setLog`, `setPortForwardTarget`, `nodePortRange`, `pingResult`.
13. **Names from plan 02 that index 5.1 does not list:** plan 04 uses `DEFAULT_SCREEN`, `ListSessionsQuerySchema` (`?all=1` → `{ all: true }`), and `LogsQuerySchema` from `@hydra/shared` (written by plan 02). Plan 02's `openDb` is async and `createTestDb` stays synchronous; plan 04 calls neither directly (`main.ts` and `createTestApp` of plan 03 do).

## Notes for other plans

- **Plan 08 (spec section 11.6):** kube-apiserver accepts only one range for `--service-node-port-range`. Verified with kube-apiserver v1.37.0: `--service-node-port-range=30000-32767,52000-52099` stops the server with `invalid argument "30000-32767,52000-52099" for "--service-node-port-range" flag: strconv.Atoi: parsing "32767,52000-52099": invalid syntax`. The k3s config of section 11.6 needs one range that contains both, or a spec change.
- **Plan 08:** the pod spec runs the `mcp` container with `command: ['playwright-mcp', …]` and `runAsUser: 1000`. The `hydra-mcp` image must have `playwright-mcp` on `PATH` and must work as UID 1000.
- **Plans 05 and 06:** `podEndpoints.endpoint()` throws an `Error` in port-forward mode if the pod does not exist; treat it like a failed connection. The proxies react to the bus event `session.state` (published by the reconciler after the audit event).

## File structure

All paths are below `packages/server/`.

| File | Responsibility | Task |
|---|---|---|
| `src/orchestrator/types.ts` | `KubeKind`, `KubeObject`, `KubeWatchEvent`, `KubeClient` | 1 |
| `src/orchestrator/names.ts` | Object names, labels, annotation, ports | 1 |
| `src/orchestrator/row-fields.ts` | Typed reads of the text enum columns of `SessionRow` | 1 |
| `src/orchestrator/manifests/locale.ts` | Language tag parts (tag, base, POSIX) | 2 |
| `src/orchestrator/manifests/chromium-flags.ts` | `/etc/chromium.d/hydra` (spec section 7.6) | 2 |
| `src/orchestrator/manifests/policies.ts` | `policies.json` (spec section 7.5), S5 file | 2 |
| `src/orchestrator/manifests/{pvc,secret,configmap,headless-service,media-service}.ts` | One builder each | 3 |
| `src/orchestrator/manifests/neko-env.ts` | Env table of spec section 7.4, S3 file | 4 |
| `src/orchestrator/manifests/statefulset.ts` | StatefulSet and pod spec, S1 file | 4 |
| `src/orchestrator/manifests/index.ts` | `buildSessionObjects()` | 4 |
| `src/orchestrator/kube-client.ts` | `createKubeClient()` with `@kubernetes/client-node` | 5 |
| `test/helpers/fake-kube.ts` | `FakeKubeClient` (index section 5.12) | 6 |
| `src/orchestrator/media-port-check.ts` | Startup check of `HYDRA_MEDIA_PORT_RANGE` | 6 |
| `src/orchestrator/pod-status.ts` | What the reconciler reads from a pod | 7 |
| `src/orchestrator/state-rules.ts` | Rules 1 to 7 and the error transition (pure) | 7 |
| `src/orchestrator/reconciler.ts` | Passes, queue, backoff, watch, interval, orphans | 8 |
| `src/orchestrator/pod-endpoint.ts` | `PodEndpointResolver` (cluster-dns, port-forward) | 9 |
| `src/orchestrator/index.ts` | Public exports of the module | 9 |
| `src/sessions/{activity,ports,settings}.ts` | `ActivityProvider`, port pool, settings helpers | 10 |
| `src/sessions/service.ts` | `SessionsService` | 11 |
| `src/sessions/wiring.ts`, `src/sessions/index.ts` | `createSessionDeps()`, public exports | 11 |
| `src/api/sessions.ts` | Session routes of spec section 12.1 | 12 |
| `src/api/events.ts` | `GET /api/events` | 13 |
| Modified: `package.json` (server), `pnpm-lock.yaml` | `@kubernetes/client-node` `2.0.0` | 1 |
| Modified: `src/app.ts` | `AppDeps` fields (Task 11), route registration (Tasks 12, 13) | 11–13 |
| Modified: `src/main.ts` | Kubernetes client, port check, plan 04 deps, reconciler start and stop | 11 |
| Modified: `test/helpers/app.ts` | `createTestApp` fills the plan 04 deps | 11 |
| Modified: `src/api/health.ts` | `/readyz` also needs the Kubernetes API | 12 |

## Verified facts (scratch checks on 2026-10-10)

The code of this plan ran in a scratch copy with stand-ins for the contracts of plans 02 and 03 (143 tests pass), and the Kubernetes client ran against a real kube-apiserver.

- **`@kubernetes/client-node` 2.0.0** (ESM, uses undici 8):
  - `KubernetesObjectApi.makeApiClient(kc).patch(object, undefined, undefined, 'hydra', true, PatchStrategy.ServerSideApply)` sends `PATCH …?fieldManager=hydra&force=true` with `Content-Type: application/apply-patch+yaml` and a JSON body. Against kube-apiserver v1.37.0: the first apply creates, a second apply of the same object is a no-op (same `resourceVersion`), the managed field entry is `hydra:Apply`, and an apply that omits fields removes them (the media ports and mux env when `media_port` is null).
  - `read`, `delete`, and `list` throw `ApiException` with `code` = HTTP status. List items have no `kind`, so `normalize()` sets it.
  - `Watch.watch(path, query, callback, done)` aborts each request after 30 s (client side) and calls `done`. With `timeoutSeconds: 25` and a `resourceVersion` resume, 30 s without changes produced no replayed events, and a change after the restart arrived.
  - `CoreV1Api.readNamespacedPodLog({ name, namespace, container, tailLines })` returns a string. For a pod without a node the API answers `204` without a body, and client-node throws `Cannot parse content. No Content-Type defined.`; thus `readLog` checks the container status first.
  - `CoreV1Api.createNamespacedService({ namespace, body, fieldManager })`; a 422 Status body has the `message` `… provided port is not in the valid range …`.
  - `PortForward.portForward(namespace, pod, [port], output, null, input)` supports one port per WebSocket. Against a pod without a node it rejects with `Unexpected server response: 400`. The success path needs a kubelet and was not tested.
  - `VersionApi.getCode()` requests `GET /version`.
- **kube-apiserver v1.37.0** (envtest-v1.37.0-darwin-arm64, SHA-512 checked): dry-run and real create of an out-of-range NodePort Service as in Spec deviation 1; all objects of a session pass the API validation; against it, the reconciler created a session, stopped it (media Service deleted, `media_port` released), and removed its objects (state `deleting`; the step to `deleted` needs the garbage collector and the PVC controller of a real cluster).
- **Neko v3.1.6** (tag commit `65fba485de2987998c7028b04240b21669d674e0`):
  - Env names: viper prefix `NEKO` and `.` → `_` (`server/cmd/root.go`). Keys: `desktop.screen` (format `WxH@R`), `webrtc.udpmux`, `webrtc.tcpmux`, `webrtc.nat1to1`, `webrtc.icelite`, `server.proxy`, `member.provider` (default `multiuser`), `member.multiuser.admin_password`, `member.multiuser.user_password`, `member.multiuser.user_profile` (JSON, merged over the default user profile, which has `can_host: true`), `session.implicit_hosting`, `filetransfer.enabled`.
  - `GET /health` answers `true` (`server/internal/http/manager.go`). The image sets `NEKO_SERVER_BIND=:8080`, and its `HEALTHCHECK` uses `/health`.
  - `apps/chromium/policies.json` is the default policy file (copied into `policies.ts`). supervisord runs as root and starts Xorg, PulseAudio, and Neko as the user `neko` (`runtime/supervisord.conf`).
- **Playwright MCP 0.0.83:** the binary is `playwright-mcp`. With `--host 0.0.0.0 --port 8931` the allowed Host list is `localhost:8931` (`installHttpTransport` in playwright-core 1.64.0-alpha), so `Host: localhost:8931` passes without `--allowed-hosts`.
- **Fastify 5.12.5** sends the return value of a synchronous handler (`lib/handle-request.js`). Thus the routes of synchronous service calls are synchronous functions (no `async` without `await`).

---

### Task 1: Kubernetes client dependency, contracts, and object names

Spec sections 7.1 and 7.3; index 5.10.

**Files:**
- Modify: `packages/server/package.json` (one dependency), `pnpm-lock.yaml` (pnpm writes it)
- Create: `packages/server/src/orchestrator/types.ts`
- Create: `packages/server/src/orchestrator/names.ts`
- Create: `packages/server/src/orchestrator/row-fields.ts`
- Test: `packages/server/src/orchestrator/names.test.ts`

**Interfaces:**
- Consumes: `DesiredState`, `Screen`, `SessionState` (`@hydra/shared`, plan 02).
- Produces (later tasks and plans 05, 06 use these names):

```ts
export type KubeKind = 'PersistentVolumeClaim' | 'Secret' | 'ConfigMap' | 'Service' | 'StatefulSet' | 'Pod';
export type KubeObject = KubernetesObject & { kind: KubeKind; metadata: { name: string; namespace: string; labels: Record<string, string> } };
export interface KubeWatchEvent { kind: KubeKind; type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: KubeObject }
export interface KubeClient { apply; remove; get; list; watch; readLog; dryRunNodePorts; ping; portForward }  // index 5.10 + portForward
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by', SESSION_ID_LABEL = 'hydra/session-id',
  STARTED_AT_ANNOTATION = 'hydra/started-at', MANAGED_BY_SELECTOR = 'app.kubernetes.io/managed-by=hydra',
  NEKO_PORT = 8080, MCP_PORT = 8931;
export function objectNames(sid: string): SessionObjectNames;   // pvc, secret, configMap, headlessService, mediaService, statefulSet, pod
export function sessionLabels(sid: string): Record<string, string>;
export function sessionObjectRefs(sid: string): Array<{ kind: KubeKind; name: string }>;   // delete order, no pod
export const stateOf: (row: { state: string }) => SessionState;
export const desiredStateOf: (row: { desiredState: string }) => DesiredState;
export const screenOf: (row: { screen: string }) => Screen;
```

- [ ] **Step 1: Add the dependency**

Open `packages/server/package.json`. If `dependencies` already has `"@kubernetes/client-node": "2.0.0"`, skip this step. If it has another version, change it to `2.0.0` (the code of this plan is verified with 2.0.0) and report the change. Else merge this entry into `dependencies` (keep all other entries):

```json
"dependencies": {
  "@kubernetes/client-node": "2.0.0"
}
```

Run: `pnpm install`
Expected: exit code 0. Then run `pnpm --filter @hydra/server list @kubernetes/client-node`; expected: the output contains `@kubernetes/client-node 2.0.0`. pnpm may warn that `@kubernetes/client-node` depends on `@types/node ^26.0.0`; this is known (plan 01, "Library versions for later plans") and harmless with `skipLibCheck`. No new `allowBuilds` entry is needed.

- [ ] **Step 2: Write the failing test**

`packages/server/src/orchestrator/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { objectNames, sessionLabels, sessionObjectRefs } from './names.js';
import { desiredStateOf, screenOf, stateOf } from './row-fields.js';

describe('session object names', () => {
  it('gives the names of spec section 7.3', () => {
    expect(objectNames('abcdefghij23')).toEqual({
      pvc: 'profile-abcdefghij23',
      secret: 'neko-abcdefghij23',
      configMap: 'chromium-abcdefghij23',
      headlessService: 'session-abcdefghij23',
      mediaService: 'media-abcdefghij23',
      statefulSet: 'session-abcdefghij23',
      pod: 'session-abcdefghij23-0',
    });
  });

  it('gives the labels of spec section 7.1', () => {
    expect(sessionLabels('abcdefghij23')).toEqual({
      'app.kubernetes.io/managed-by': 'hydra',
      'hydra/session-id': 'abcdefghij23',
    });
  });

  it('lists the deletable objects, StatefulSet first and without the pod', () => {
    expect(sessionObjectRefs('abcdefghij23').map((ref) => `${ref.kind}/${ref.name}`)).toEqual([
      'StatefulSet/session-abcdefghij23',
      'Service/media-abcdefghij23',
      'Service/session-abcdefghij23',
      'ConfigMap/chromium-abcdefghij23',
      'Secret/neko-abcdefghij23',
      'PersistentVolumeClaim/profile-abcdefghij23',
    ]);
  });

  it('reads the enum columns of a session row', () => {
    const row = { state: 'running', desiredState: 'stopped', screen: '1280x720' };
    expect([stateOf(row), desiredStateOf(row), screenOf(row)]).toEqual([
      'running',
      'stopped',
      '1280x720',
    ]);
  });
});
```

- [ ] **Step 3: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/names.test.ts`
Expected: FAIL with `Error: Cannot find module './names.js' imported from …/src/orchestrator/names.test.ts`.

- [ ] **Step 4: Write the contracts, the names, and the row field helpers**

`packages/server/src/orchestrator/types.ts`:

```ts
import type { KubernetesObject } from '@kubernetes/client-node';
import type { Duplex } from 'node:stream';

/** The Kubernetes kinds that the gateway manages in HYDRA_SESSION_NAMESPACE (spec section 7.3). */
export type KubeKind =
  'PersistentVolumeClaim' | 'Secret' | 'ConfigMap' | 'Service' | 'StatefulSet' | 'Pod';

export type KubeObject = KubernetesObject & {
  kind: KubeKind;
  metadata: { name: string; namespace: string; labels: Record<string, string> };
};

export interface KubeWatchEvent {
  kind: KubeKind;
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  object: KubeObject;
}

export interface KubeClient {
  /** Server-side apply, field manager 'hydra', force. */
  apply(object: KubeObject): Promise<void>;
  /** Delete. A 404 answer counts as success. */
  remove(kind: KubeKind, name: string): Promise<void>;
  get(kind: KubeKind, name: string): Promise<KubeObject | null>;
  list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]>;
  /** Watches all kinds with the label app.kubernetes.io/managed-by=hydra. Returns the stop function. */
  watch(handler: (event: KubeWatchEvent) => void): Promise<() => void>;
  /** The last lines of a container log. '' if the pod or the container does not exist yet. */
  readLog(podName: string, container: 'neko' | 'mcp', tailLines: number): Promise<string>;
  /** Startup check of HYDRA_MEDIA_PORT_RANGE (spec section 4). See "Spec deviations" of plan 04. */
  dryRunNodePorts(ports: number[]): Promise<{ outOfRange: boolean; message: string | null }>;
  /** true if the Kubernetes API answers. */
  ping(): Promise<boolean>;
  /** Connects the socket to a port of a pod through the API server (port-forward transport). */
  portForward(podName: string, port: number, socket: Duplex): Promise<void>;
}
```

`packages/server/src/orchestrator/names.ts`:

```ts
import type { KubeKind } from './types.js';

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const SESSION_ID_LABEL = 'hydra/session-id';
export const STARTED_AT_ANNOTATION = 'hydra/started-at';
export const MANAGED_BY_SELECTOR = `${MANAGED_BY_LABEL}=hydra`;
export const NEKO_PORT = 8080;
export const MCP_PORT = 8931;

export interface SessionObjectNames {
  pvc: string;
  secret: string;
  configMap: string;
  headlessService: string;
  mediaService: string;
  statefulSet: string;
  pod: string;
}

/** Object names of spec section 7.3. */
export function objectNames(sid: string): SessionObjectNames {
  return {
    pvc: `profile-${sid}`,
    secret: `neko-${sid}`,
    configMap: `chromium-${sid}`,
    headlessService: `session-${sid}`,
    mediaService: `media-${sid}`,
    statefulSet: `session-${sid}`,
    pod: `session-${sid}-0`,
  };
}

/** Labels of spec section 7.1. */
export function sessionLabels(sid: string): Record<string, string> {
  return { [MANAGED_BY_LABEL]: 'hydra', [SESSION_ID_LABEL]: sid };
}

/**
 * The objects that the gateway creates for one session, in delete order. The pod is not in the list:
 * the StatefulSet owns it, and the gateway Role has no `delete` on pods (spec section 11.2).
 */
export function sessionObjectRefs(sid: string): Array<{ kind: KubeKind; name: string }> {
  const n = objectNames(sid);
  return [
    { kind: 'StatefulSet', name: n.statefulSet },
    { kind: 'Service', name: n.mediaService },
    { kind: 'Service', name: n.headlessService },
    { kind: 'ConfigMap', name: n.configMap },
    { kind: 'Secret', name: n.secret },
    { kind: 'PersistentVolumeClaim', name: n.pvc },
  ];
}
```

`packages/server/src/orchestrator/row-fields.ts`:

```ts
import type { DesiredState, Screen, SessionState } from '@hydra/shared';

/*
 * Typed reads of the text enum columns of SessionRow. The parameters are `string`, so the code
 * compiles and lints the same way whether db/schema.ts types these columns as text or as enums.
 */
export const stateOf = (row: { state: string }): SessionState => row.state as SessionState;
export const desiredStateOf = (row: { desiredState: string }): DesiredState =>
  row.desiredState as DesiredState;
export const screenOf = (row: { screen: string }): Screen => row.screen as Screen;
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/names.test.ts`
Expected: PASS. `Tests  4 passed (4)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 2: Chromium policies, flags, and language parts

Spec sections 7.4 (`LANG`, `LANGUAGE`), 7.5, 7.6; index section 6 (S5).

**Files:**
- Create: `packages/server/src/orchestrator/manifests/locale.ts`
- Create: `packages/server/src/orchestrator/manifests/chromium-flags.ts`
- Create: `packages/server/src/orchestrator/manifests/policies.ts`
- Test: `packages/server/src/orchestrator/manifests/chromium-flags.test.ts`
- Test: `packages/server/src/orchestrator/manifests/policies.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. The session language is already a canonical BCP 47 tag (`LanguageSchema` of plan 02).
- Produces:

```ts
export interface LocaleParts { tag: string; base: string; posix: string }
export function localeParts(language: string): LocaleParts;   // throws for a tag with characters other than [A-Za-z0-9-]
export function buildChromiumFlags(language: string): string;  // content of /etc/chromium.d/hydra
export const NEKO_DEFAULT_POLICIES: { readonly … };            // Neko v3.1.6 apps/chromium/policies.json
export const DISK_CACHE_SIZE = 536870912;
export function isAllowAll(allowlist: readonly string[]): boolean;
export function buildPolicies(allowlist: readonly string[]): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing tests**

`packages/server/src/orchestrator/manifests/chromium-flags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChromiumFlags } from './chromium-flags.js';
import { localeParts } from './locale.js';

describe('buildChromiumFlags', () => {
  it('adds the CDP port and the language flags through the Debian wrapper', () => {
    expect(buildChromiumFlags('en-US')).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=en-US --accept-lang=en-US,en"\n',
    );
  });

  it('gives one accept language when the tag has no region', () => {
    expect(buildChromiumFlags('de')).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=de --accept-lang=de"\n',
    );
  });

  it('keeps the script subtag', () => {
    expect(buildChromiumFlags('zh-Hant-TW')).toContain(
      '--lang=zh-Hant-TW --accept-lang=zh-Hant-TW,zh"',
    );
  });
});

describe('localeParts', () => {
  it('splits a tag', () => {
    expect(localeParts('pt-BR')).toEqual({ tag: 'pt-BR', base: 'pt', posix: 'pt_BR' });
    expect(localeParts('fr')).toEqual({ tag: 'fr', base: 'fr', posix: 'fr' });
  });

  it('drops extensions', () => {
    expect(localeParts('en-US-u-ca-gregory').tag).toBe('en-US');
  });

  it('rejects a value that is not a language tag', () => {
    expect(() => localeParts('en"; rm -rf /; "')).toThrow();
  });
});
```

`packages/server/src/orchestrator/manifests/policies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPolicies, DISK_CACHE_SIZE, isAllowAll, NEKO_DEFAULT_POLICIES } from './policies.js';

describe('buildPolicies', () => {
  it('applies the changes of spec section 7.5 to the Neko defaults', () => {
    const policies = buildPolicies(['example.com', '.login.example.org']);
    expect(policies['DeveloperToolsAvailability']).toBe(1);
    expect(policies['URLBlocklist']).toEqual(['*']);
    expect(policies['URLAllowlist']).toEqual(['example.com', '.login.example.org', 'about:blank']);
    expect(policies['PasswordManagerEnabled']).toBe(false);
    expect(policies['DefaultCookiesSetting']).toBe(1);
    expect(policies['RestoreOnStartup']).toBe(1);
    expect(policies['DiskCacheSize']).toBe(536870912);
    expect(policies['DownloadRestrictions']).toBe(3);
    expect(policies['AllowFileSelectionDialogs']).toBe(false);
    expect(policies['ExtensionInstallBlocklist']).toEqual(['*']);
  });

  it('keeps the other Neko defaults unchanged', () => {
    const policies = buildPolicies(['example.com']);
    expect(policies['BrowserSignin']).toBe(0);
    expect(policies['SyncDisabled']).toBe(true);
    expect(policies['IncognitoModeAvailability']).toBe(1);
    expect(policies['ExtensionInstallForcelist']).toEqual(
      NEKO_DEFAULT_POLICIES.ExtensionInstallForcelist,
    );
  });

  it('omits URLBlocklist ["*"] and URLAllowlist for the ["*"] allowlist', () => {
    const policies = buildPolicies(['*']);
    expect(policies['URLBlocklist']).toEqual(['file://*', 'chrome://policy']);
    expect('URLAllowlist' in policies).toBe(false);
    expect(policies['DiskCacheSize']).toBe(DISK_CACHE_SIZE);
  });

  it('does not change the default object', () => {
    buildPolicies(['example.com']);
    expect(NEKO_DEFAULT_POLICIES.URLBlocklist).toEqual(['file://*', 'chrome://policy']);
    expect(NEKO_DEFAULT_POLICIES.DeveloperToolsAvailability).toBe(2);
  });

  it('detects the allow-all list', () => {
    expect(isAllowAll(['*'])).toBe(true);
    expect(isAllowAll(['*', 'example.com'])).toBe(false);
    expect(isAllowAll(['example.com'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests`
Expected: FAIL with `Error: Cannot find module './chromium-flags.js'` and `Error: Cannot find module './policies.js'`; `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/orchestrator/manifests/locale.ts`:

```ts
export interface LocaleParts {
  /** BCP 47 tag without extensions, for example `en-US`. */
  tag: string;
  /** Base language, for example `en`. */
  base: string;
  /** POSIX form, for example `en_US` (`de` if the tag has no region). */
  posix: string;
}

const SAFE_TAG = /^[A-Za-z0-9-]+$/;

/**
 * Splits a session language. The API validates the tag (index section 5.1). The check here is a
 * second guard, because the tag goes into a shell file (spec section 7.6).
 */
export function localeParts(language: string): LocaleParts {
  const locale = new Intl.Locale(language);
  const tag = locale.baseName;
  if (!SAFE_TAG.test(tag)) throw new Error(`unsafe language tag: ${language}`);
  const base = locale.language;
  const posix = locale.region ? `${base}_${locale.region}` : base;
  return { tag, base, posix };
}
```

`packages/server/src/orchestrator/manifests/chromium-flags.ts`:

```ts
import { localeParts } from './locale.js';

/** Content of /etc/chromium.d/hydra (spec section 7.6). */
export function buildChromiumFlags(language: string): string {
  const { tag, base } = localeParts(language);
  const acceptLang = tag === base ? tag : `${tag},${base}`;
  return `export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=${tag} --accept-lang=${acceptLang}"\n`;
}
```

`packages/server/src/orchestrator/manifests/policies.ts`:

```ts
/**
 * Chromium policies (spec section 7.5). Spike S5 fallback file (index section 6).
 *
 * NEKO_DEFAULT_POLICIES is a copy of `apps/chromium/policies.json` of Neko v3.1.6
 * (github.com/m1k1o/neko, tag v3.1.6, commit 65fba485de2987998c7028b04240b21669d674e0).
 */
export const NEKO_DEFAULT_POLICIES = {
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  BrowserSignin: 0,
  DefaultNotificationsSetting: 2,
  DeveloperToolsAvailability: 2,
  EditBookmarksEnabled: false,
  FullscreenAllowed: true,
  IncognitoModeAvailability: 1,
  SyncDisabled: true,
  AutoplayAllowed: true,
  BrowserAddPersonEnabled: false,
  BrowserGuestModeEnabled: false,
  DefaultPopupsSetting: 2,
  DownloadRestrictions: 3,
  VideoCaptureAllowed: true,
  AllowFileSelectionDialogs: false,
  PromptForDownloadLocation: false,
  BookmarkBarEnabled: false,
  PasswordManagerEnabled: false,
  BrowserLabsEnabled: false,
  CommandLineFlagSecurityWarningsEnabled: false,
  URLAllowlist: ['file:///home/neko/Downloads'],
  URLBlocklist: ['file://*', 'chrome://policy'],
  ExtensionInstallForcelist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx',
    'mnjggcdmjocbbbhaepdhchncahnbgone;https://clients2.google.com/service/update2/crx',
  ],
  ExtensionInstallAllowlist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh',
    'mnjggcdmjocbbbhaepdhchncahnbgone',
  ],
  ExtensionInstallBlocklist: ['*'],
} as const;

/** 512 MiB (spec section 7.5). */
export const DISK_CACHE_SIZE = 536870912;

export function isAllowAll(allowlist: readonly string[]): boolean {
  return allowlist.length === 1 && allowlist[0] === '*';
}

/** The full policies.json object for one session. */
export function buildPolicies(allowlist: readonly string[]): Record<string, unknown> {
  const policies: Record<string, unknown> = structuredClone(NEKO_DEFAULT_POLICIES);
  policies['DeveloperToolsAvailability'] = 1;
  policies['PasswordManagerEnabled'] = false;
  policies['DefaultCookiesSetting'] = 1;
  policies['RestoreOnStartup'] = 1;
  policies['DiskCacheSize'] = DISK_CACHE_SIZE;
  policies['DownloadRestrictions'] = 3;
  policies['AllowFileSelectionDialogs'] = false;
  policies['ExtensionInstallBlocklist'] = ['*'];
  if (isAllowAll(allowlist)) {
    // Keep only the Neko default blocklist, and no URLAllowlist.
    policies['URLBlocklist'] = [...NEKO_DEFAULT_POLICIES.URLBlocklist];
    delete policies['URLAllowlist'];
  } else {
    policies['URLBlocklist'] = ['*'];
    policies['URLAllowlist'] = [...allowlist, 'about:blank'];
  }
  return policies;
}
```

- [ ] **Step 4: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests`
Expected: PASS. `Test Files  2 passed (2)`, `Tests  11 passed (11)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 3: Builders for the PVC, the Secret, the ConfigMap, and the two Services

Spec sections 5.2 (PVC size), 6.7 (Neko passwords), 7.3; index 5.4 (`nekoPassword`).

**Files:**
- Create: `packages/server/src/orchestrator/manifests/pvc.ts`
- Create: `packages/server/src/orchestrator/manifests/secret.ts`
- Create: `packages/server/src/orchestrator/manifests/configmap.ts`
- Create: `packages/server/src/orchestrator/manifests/headless-service.ts`
- Create: `packages/server/src/orchestrator/manifests/media-service.ts`
- Test: `packages/server/src/orchestrator/manifests/objects.test.ts`

**Interfaces:**
- Consumes: `objectNames`, `sessionLabels`, `SESSION_ID_LABEL`, `NEKO_PORT`, `MCP_PORT`, `KubeObject` (Task 1); `buildPolicies`, `buildChromiumFlags` (Task 2); `nekoPassword(nekoKey, sid, profile)`, `deriveSubkeys` (`src/crypto/index.ts`, plan 02); `SessionSettings` (`@hydra/shared`); `testConfig` (`test/helpers/config.ts`, plan 02).
- Produces:

```ts
export function buildPvc(sid: string, namespace: string): V1PersistentVolumeClaim & KubeObject;
export function buildSecret(sid: string, namespace: string, nekoKey: Buffer): V1Secret & KubeObject;
export function buildConfigMap(sid: string, namespace: string, settings: SessionSettings): V1ConfigMap & KubeObject;
export function buildHeadlessService(sid: string, namespace: string): V1Service & KubeObject;
export function buildMediaService(sid: string, namespace: string, mediaPort: number): V1Service & KubeObject;
```

- [ ] **Step 1: Write the failing test**

These tests are the reviewed snapshots of the objects (spec section 15.1): each expected object is written out in full.

`packages/server/src/orchestrator/manifests/objects.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveSubkeys, nekoPassword } from '../../crypto/index.js';
import { testConfig } from '../../../test/helpers/config.js';
import { buildConfigMap } from './configmap.js';
import { buildHeadlessService } from './headless-service.js';
import { buildMediaService } from './media-service.js';
import { buildPolicies } from './policies.js';
import { buildPvc } from './pvc.js';
import { buildSecret } from './secret.js';

const sid = 'abcdefghij23';
const labels = { 'app.kubernetes.io/managed-by': 'hydra', 'hydra/session-id': sid };

describe('session object builders', () => {
  it('builds the profile PVC', () => {
    expect(buildPvc(sid, 'hydra-sessions')).toEqual({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'profile-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        storageClassName: 'hydra-profile',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
      },
    });
  });

  it('builds the Neko password Secret from the neko subkey', () => {
    const subkeys = deriveSubkeys(testConfig().secretKey);
    const secret = buildSecret(sid, 'hydra-sessions', subkeys.neko);
    const decode = (value: string | undefined) =>
      Buffer.from(value ?? '', 'base64').toString('utf8');
    expect(secret.metadata).toEqual({
      name: 'neko-abcdefghij23',
      namespace: 'hydra-sessions',
      labels,
    });
    expect(secret.type).toBe('Opaque');
    expect(Object.keys(secret.data ?? {}).sort()).toEqual(['admin-password', 'user-password']);
    expect(decode(secret.data?.['admin-password'])).toBe(nekoPassword(subkeys.neko, sid, 'admin'));
    expect(decode(secret.data?.['user-password'])).toBe(nekoPassword(subkeys.neko, sid, 'user'));
    expect(secret.data?.['admin-password']).not.toBe(secret.data?.['user-password']);
  });

  it('builds the Chromium ConfigMap', () => {
    const settings = {
      allowlist: ['example.com'],
      timezone: 'UTC',
      language: 'en-US',
      screen: '1920x1080' as const,
    };
    const configMap = buildConfigMap(sid, 'hydra-sessions', settings);
    expect(configMap.metadata).toEqual({
      name: 'chromium-abcdefghij23',
      namespace: 'hydra-sessions',
      labels,
    });
    expect(JSON.parse(configMap.data?.['policies.json'] ?? '')).toEqual(
      buildPolicies(['example.com']),
    );
    expect(configMap.data?.['hydra-flags']).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=en-US --accept-lang=en-US,en"\n',
    );
  });

  it('builds the headless Service', () => {
    expect(buildHeadlessService(sid, 'hydra-sessions')).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'session-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        clusterIP: 'None',
        selector: { 'hydra/session-id': sid },
        ports: [
          { name: 'neko', protocol: 'TCP', port: 8080, targetPort: 8080 },
          { name: 'mcp', protocol: 'TCP', port: 8931, targetPort: 8931 },
        ],
      },
    });
  });

  it('builds the media Service with port = targetPort = nodePort for UDP and TCP', () => {
    expect(buildMediaService(sid, 'hydra-sessions', 52007)).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'media-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        type: 'NodePort',
        externalTrafficPolicy: 'Local',
        selector: { 'hydra/session-id': sid },
        ports: [
          { name: 'media-udp', protocol: 'UDP', port: 52007, targetPort: 52007, nodePort: 52007 },
          { name: 'media-tcp', protocol: 'TCP', port: 52007, targetPort: 52007, nodePort: 52007 },
        ],
      },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests/objects.test.ts`
Expected: FAIL with `Error: Cannot find module './configmap.js'`.

- [ ] **Step 3: Write the builders**

`packages/server/src/orchestrator/manifests/pvc.ts`:

```ts
import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/** PVC profile-<sid> (spec sections 5.2 and 7.3). local-path does not enforce the size. */
export function buildPvc(sid: string, namespace: string): V1PersistentVolumeClaim & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: objectNames(sid).pvc, namespace, labels: sessionLabels(sid) },
    spec: {
      storageClassName: 'hydra-profile',
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '5Gi' } },
    },
  };
}
```

`packages/server/src/orchestrator/manifests/secret.ts`:

```ts
import type { V1Secret } from '@kubernetes/client-node';
import { nekoPassword } from '../../crypto/index.js';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

/** Secret neko-<sid> with the Neko passwords of spec section 6.7. */
export function buildSecret(
  sid: string,
  namespace: string,
  nekoKey: Buffer,
): V1Secret & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: objectNames(sid).secret, namespace, labels: sessionLabels(sid) },
    type: 'Opaque',
    data: {
      'admin-password': base64(nekoPassword(nekoKey, sid, 'admin')),
      'user-password': base64(nekoPassword(nekoKey, sid, 'user')),
    },
  };
}
```

`packages/server/src/orchestrator/manifests/configmap.ts`:

```ts
import type { V1ConfigMap } from '@kubernetes/client-node';
import type { SessionSettings } from '@hydra/shared';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';
import { buildChromiumFlags } from './chromium-flags.js';
import { buildPolicies } from './policies.js';

/** ConfigMap chromium-<sid>: policies.json (spec section 7.5) and hydra-flags (spec section 7.6). */
export function buildConfigMap(
  sid: string,
  namespace: string,
  settings: SessionSettings,
): V1ConfigMap & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: objectNames(sid).configMap, namespace, labels: sessionLabels(sid) },
    data: {
      'policies.json': `${JSON.stringify(buildPolicies(settings.allowlist), null, 2)}\n`,
      'hydra-flags': buildChromiumFlags(settings.language),
    },
  };
}
```

`packages/server/src/orchestrator/manifests/headless-service.ts`:

```ts
import type { V1Service } from '@kubernetes/client-node';
import { MCP_PORT, NEKO_PORT, objectNames, SESSION_ID_LABEL, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/** Headless Service session-<sid>: gives the pod its DNS name (spec section 7.3). */
export function buildHeadlessService(sid: string, namespace: string): V1Service & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: objectNames(sid).headlessService, namespace, labels: sessionLabels(sid) },
    spec: {
      clusterIP: 'None',
      selector: { [SESSION_ID_LABEL]: sid },
      ports: [
        { name: 'neko', protocol: 'TCP', port: NEKO_PORT, targetPort: NEKO_PORT },
        { name: 'mcp', protocol: 'TCP', port: MCP_PORT, targetPort: MCP_PORT },
      ],
    },
  };
}
```

`packages/server/src/orchestrator/manifests/media-service.ts`:

```ts
import type { V1Service } from '@kubernetes/client-node';
import { objectNames, SESSION_ID_LABEL, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/**
 * NodePort Service media-<sid> (spec sections 7.3 and 7.8). port, targetPort, and nodePort are all
 * the media port, for UDP and TCP. It exists only while the session holds a media port.
 */
export function buildMediaService(
  sid: string,
  namespace: string,
  mediaPort: number,
): V1Service & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: objectNames(sid).mediaService, namespace, labels: sessionLabels(sid) },
    spec: {
      type: 'NodePort',
      externalTrafficPolicy: 'Local',
      selector: { [SESSION_ID_LABEL]: sid },
      ports: [
        {
          name: 'media-udp',
          protocol: 'UDP',
          port: mediaPort,
          targetPort: mediaPort,
          nodePort: mediaPort,
        },
        {
          name: 'media-tcp',
          protocol: 'TCP',
          port: mediaPort,
          targetPort: mediaPort,
          nodePort: mediaPort,
        },
      ],
    },
  };
}
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests/objects.test.ts`
Expected: PASS. `Tests  5 passed (5)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 4: Pod spec — Neko environment, StatefulSet, and `buildSessionObjects`

Spec sections 6.7 (viewer profile), 7.2, 7.3, 7.4, 7.9 step 1; index 5.10 (`buildSessionObjects`), section 6 (S1, S3).

**Files:**
- Create: `packages/server/src/orchestrator/manifests/neko-env.ts`
- Create: `packages/server/src/orchestrator/manifests/statefulset.ts`
- Create: `packages/server/src/orchestrator/manifests/index.ts`
- Test: `packages/server/src/orchestrator/manifests/neko-env.test.ts`
- Test: `packages/server/src/orchestrator/manifests/statefulset.test.ts`
- Test: `packages/server/src/orchestrator/manifests/index.test.ts` (writes `__snapshots__/index.test.ts.snap` on the first run)

**Interfaces:**
- Consumes: Tasks 1 to 3; `Config`, `Subkeys`, `SessionRow` (`src/config/index.ts`, `src/crypto/index.ts`, `src/db/schema.ts`, plan 02); `DesiredState`, `SessionSettings` (`@hydra/shared`).
- Produces:

```ts
export const VIEWER_PROFILE_ENV: V1EnvVar;   // S3: NEKO_MEMBER_MULTIUSER_USER_PROFILE = {"can_host":false}
export function buildNekoEnv(input: { sid: string; settings: SessionSettings; mediaPort: number | null; publicIp: string }): V1EnvVar[];
export const USE_CHROMIUM_SECCOMP_PROFILE = false;                // S1 switch
export const NEKO_ADDED_CAPABILITIES: string[];                     // S1 capability set
export function seccompProfile(): V1SeccompProfile;
export function buildStatefulSet(input: StatefulSetInput): V1StatefulSet & KubeObject;
export function buildSessionObjects(row: SessionRow, context: { config: Config; subkeys: Subkeys }): KubeObject[];   // index 5.10
```

- [ ] **Step 1: Write the failing tests**

`packages/server/src/orchestrator/manifests/neko-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNekoEnv, VIEWER_PROFILE_ENV } from './neko-env.js';

const settings = {
  allowlist: ['example.com'],
  timezone: 'Europe/Zurich',
  language: 'de-CH',
  screen: '1600x900' as const,
};

describe('buildNekoEnv', () => {
  it('gives the env table of spec section 7.4', () => {
    expect(
      buildNekoEnv({ sid: 'abcdefghij23', settings, mediaPort: 52003, publicIp: '203.0.113.10' }),
    ).toEqual([
      { name: 'NEKO_DESKTOP_SCREEN', value: '1600x900@25' },
      { name: 'NEKO_WEBRTC_UDPMUX', value: '52003' },
      { name: 'NEKO_WEBRTC_TCPMUX', value: '52003' },
      { name: 'NEKO_WEBRTC_NAT1TO1', value: '203.0.113.10' },
      { name: 'NEKO_WEBRTC_ICELITE', value: 'true' },
      { name: 'NEKO_SERVER_PROXY', value: 'true' },
      { name: 'NEKO_MEMBER_PROVIDER', value: 'multiuser' },
      {
        name: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'neko-abcdefghij23', key: 'admin-password' } },
      },
      {
        name: 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'neko-abcdefghij23', key: 'user-password' } },
      },
      { name: 'NEKO_MEMBER_MULTIUSER_USER_PROFILE', value: '{"can_host":false}' },
      { name: 'NEKO_SESSION_IMPLICIT_HOSTING', value: 'true' },
      { name: 'NEKO_FILETRANSFER_ENABLED', value: 'false' },
      { name: 'TZ', value: 'Europe/Zurich' },
      { name: 'LANG', value: 'de_CH.UTF-8' },
      { name: 'LANGUAGE', value: 'de_CH:de' },
    ]);
  });

  it('has no mux ports while the session holds no media port', () => {
    const names = buildNekoEnv({
      sid: 'abcdefghij23',
      settings,
      mediaPort: null,
      publicIp: '203.0.113.10',
    }).map((e) => e.name);
    expect(names).not.toContain('NEKO_WEBRTC_UDPMUX');
    expect(names).not.toContain('NEKO_WEBRTC_TCPMUX');
  });

  it('keeps the viewer profile in one constant (spike S3)', () => {
    expect(JSON.parse(VIEWER_PROFILE_ENV.value ?? '')).toEqual({ can_host: false });
  });
});
```

`packages/server/src/orchestrator/manifests/statefulset.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNekoEnv } from './neko-env.js';
import {
  buildStatefulSet,
  NEKO_ADDED_CAPABILITIES,
  seccompProfile,
  USE_CHROMIUM_SECCOMP_PROFILE,
} from './statefulset.js';

const sid = 'abcdefghij23';
const labels = { 'app.kubernetes.io/managed-by': 'hydra', 'hydra/session-id': sid };
const settings = {
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080' as const,
};
const input = {
  sid,
  namespace: 'hydra-sessions',
  desiredState: 'running' as const,
  settings,
  mediaPort: 52000,
  startedAt: 1791633600000,
  sessionImage: 'registry.example/hydra-session:abc@sha256:1111',
  mcpImage: 'registry.example/hydra-mcp:abc@sha256:2222',
  publicIp: '203.0.113.10',
};

describe('buildStatefulSet', () => {
  it('builds the StatefulSet and the pod of spec sections 7.3 and 7.4', () => {
    expect(buildStatefulSet(input)).toEqual({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'session-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        replicas: 1,
        serviceName: 'session-abcdefghij23',
        podManagementPolicy: 'Parallel',
        selector: { matchLabels: { 'hydra/session-id': sid } },
        template: {
          metadata: { labels, annotations: { 'hydra/started-at': '1791633600000' } },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
            initContainers: [
              {
                name: 'remove-locks',
                image: 'registry.example/hydra-session:abc@sha256:1111',
                command: ['sh', '-c', 'rm -f /home/neko/.config/chromium/Singleton*'],
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'profile', mountPath: '/home/neko/.config/chromium' }],
              },
            ],
            containers: [
              {
                name: 'neko',
                image: 'registry.example/hydra-session:abc@sha256:1111',
                ports: [
                  { name: 'http', containerPort: 8080, protocol: 'TCP' },
                  { name: 'media-udp', containerPort: 52000, protocol: 'UDP' },
                  { name: 'media-tcp', containerPort: 52000, protocol: 'TCP' },
                ],
                env: buildNekoEnv({ sid, settings, mediaPort: 52000, publicIp: '203.0.113.10' }),
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: {
                    drop: ['ALL'],
                    add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID'],
                  },
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: 8080 },
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                resources: {
                  requests: { cpu: '500m', memory: '1536Mi' },
                  limits: { cpu: '3', memory: '4Gi' },
                },
                volumeMounts: [
                  { name: 'profile', mountPath: '/home/neko/.config/chromium' },
                  {
                    name: 'chromium-config',
                    mountPath: '/etc/chromium/policies/managed/policies.json',
                    subPath: 'policies.json',
                    readOnly: true,
                  },
                  {
                    name: 'chromium-config',
                    mountPath: '/etc/chromium.d/hydra',
                    subPath: 'hydra-flags',
                    readOnly: true,
                  },
                  { name: 'dshm', mountPath: '/dev/shm' },
                ],
              },
              {
                name: 'mcp',
                image: 'registry.example/hydra-mcp:abc@sha256:2222',
                command: [
                  'playwright-mcp',
                  '--cdp-endpoint',
                  'http://127.0.0.1:9222',
                  '--host',
                  '0.0.0.0',
                  '--port',
                  '8931',
                ],
                ports: [{ name: 'mcp', containerPort: 8931, protocol: 'TCP' }],
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                readinessProbe: {
                  tcpSocket: { port: 8931 },
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                resources: {
                  requests: { cpu: '100m', memory: '256Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              },
            ],
            volumes: [
              { name: 'profile', persistentVolumeClaim: { claimName: 'profile-abcdefghij23' } },
              { name: 'chromium-config', configMap: { name: 'chromium-abcdefghij23' } },
              { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    });
  });

  it('has 0 replicas unless desired_state is running', () => {
    expect(buildStatefulSet({ ...input, desiredState: 'stopped' }).spec?.replicas).toBe(0);
    expect(buildStatefulSet({ ...input, desiredState: 'deleted' }).spec?.replicas).toBe(0);
  });

  it('has no media container ports while the session holds no media port', () => {
    const neko = buildStatefulSet({ ...input, desiredState: 'stopped', mediaPort: null }).spec
      ?.template.spec?.containers[0];
    expect(neko?.ports).toEqual([{ name: 'http', containerPort: 8080, protocol: 'TCP' }]);
  });

  it('writes started_at 0 for a session that never started', () => {
    const annotations = buildStatefulSet({ ...input, startedAt: null }).spec?.template.metadata
      ?.annotations;
    expect(annotations).toEqual({ 'hydra/started-at': '0' });
  });

  it('keeps the spike S1 switches on the main path', () => {
    expect(USE_CHROMIUM_SECCOMP_PROFILE).toBe(false);
    expect(seccompProfile()).toEqual({ type: 'RuntimeDefault' });
    expect(NEKO_ADDED_CAPABILITIES).toEqual([
      'CHOWN',
      'DAC_OVERRIDE',
      'FOWNER',
      'KILL',
      'SETGID',
      'SETUID',
    ]);
  });
});
```

`packages/server/src/orchestrator/manifests/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveSubkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { testConfig } from '../../../test/helpers/config.js';
import { buildSessionObjects } from './index.js';

const config = testConfig();
const subkeys = deriveSubkeys(config.secretKey);
const row: SessionRow = {
  id: 'abcdefghij23',
  name: 'Research',
  ownerId: 'user-1',
  desiredState: 'running',
  state: 'starting',
  errorReason: null,
  mediaPort: 52000,
  allowlist: ['changed.example.com'],
  timezone: 'Asia/Tokyo',
  language: 'ja-JP',
  screen: '1280x720',
  appliedSettings: {
    allowlist: ['example.com'],
    timezone: 'UTC',
    language: 'en-US',
    screen: '1920x1080',
  },
  startedAt: 1791633600000,
  readyAt: null,
  createdAt: 1791633000000,
  updatedAt: 1791633600000,
  deletedAt: null,
};

describe('buildSessionObjects', () => {
  it('builds the objects of spec section 7.3 in apply order', () => {
    const objects = buildSessionObjects(row, { config, subkeys });
    expect(objects.map((o) => `${o.kind}/${o.metadata.name}`)).toEqual([
      'PersistentVolumeClaim/profile-abcdefghij23',
      'Secret/neko-abcdefghij23',
      'ConfigMap/chromium-abcdefghij23',
      'Service/session-abcdefghij23',
      'Service/media-abcdefghij23',
      'StatefulSet/session-abcdefghij23',
    ]);
    for (const object of objects) {
      expect(object.metadata.namespace).toBe('hydra-sessions');
      expect(object.metadata.labels).toEqual({
        'app.kubernetes.io/managed-by': 'hydra',
        'hydra/session-id': 'abcdefghij23',
      });
    }
  });

  it('uses applied_settings, not the current settings', () => {
    const objects = buildSessionObjects(row, { config, subkeys });
    const configMap = objects.find((o) => o.kind === 'ConfigMap') as unknown as {
      data: Record<string, string>;
    };
    const policies = JSON.parse(configMap.data['policies.json'] ?? '') as Record<string, unknown>;
    expect(policies['URLAllowlist']).toEqual(['example.com', 'about:blank']);
    expect(configMap.data['hydra-flags']).toContain('--lang=en-US');
    expect(JSON.stringify(objects)).not.toContain('Asia/Tokyo');
  });

  it('has no media Service while media_port is null', () => {
    const objects = buildSessionObjects(
      { ...row, desiredState: 'stopped', mediaPort: null },
      { config, subkeys },
    );
    expect(objects.some((o) => o.metadata.name === 'media-abcdefghij23')).toBe(false);
  });

  it('matches the snapshot', () => {
    expect(buildSessionObjects(row, { config, subkeys })).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests`
Expected: FAIL with `Error: Cannot find module './neko-env.js'`, `Error: Cannot find module './statefulset.js'`, and `Error: Cannot find module './index.js'`; `Test Files  3 failed | 3 passed (6)`.

- [ ] **Step 3: Write the Neko environment**

`packages/server/src/orchestrator/manifests/neko-env.ts`:

```ts
import type { V1EnvVar } from '@kubernetes/client-node';
import type { SessionSettings } from '@hydra/shared';
import { objectNames } from '../names.js';
import { localeParts } from './locale.js';

/**
 * Viewer profile with can_host false (spec section 6.7). Spike S3 fallback file (index section 6).
 * Main path: the multiuser provider reads the profile template of the `user` password from
 * `member.multiuser.user_profile` (Neko v3.1.6 server/internal/config/member.go). Neko maps the key to
 * the env variable NEKO_MEMBER_MULTIUSER_USER_PROFILE (viper prefix NEKO, "." → "_") and merges the
 * JSON over its default user profile, so only can_host changes.
 */
export const VIEWER_PROFILE_ENV: V1EnvVar = {
  name: 'NEKO_MEMBER_MULTIUSER_USER_PROFILE',
  value: JSON.stringify({ can_host: false }),
};

export interface NekoEnvInput {
  sid: string;
  settings: SessionSettings;
  mediaPort: number | null;
  publicIp: string;
}

/** Environment of the neko container (spec section 7.4 table). */
export function buildNekoEnv(input: NekoEnvInput): V1EnvVar[] {
  const secretName = objectNames(input.sid).secret;
  const locale = localeParts(input.settings.language);
  const mux: V1EnvVar[] =
    input.mediaPort === null
      ? []
      : [
          { name: 'NEKO_WEBRTC_UDPMUX', value: String(input.mediaPort) },
          { name: 'NEKO_WEBRTC_TCPMUX', value: String(input.mediaPort) },
        ];
  return [
    { name: 'NEKO_DESKTOP_SCREEN', value: `${input.settings.screen}@25` },
    ...mux,
    { name: 'NEKO_WEBRTC_NAT1TO1', value: input.publicIp },
    { name: 'NEKO_WEBRTC_ICELITE', value: 'true' },
    { name: 'NEKO_SERVER_PROXY', value: 'true' },
    { name: 'NEKO_MEMBER_PROVIDER', value: 'multiuser' },
    {
      name: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD',
      valueFrom: { secretKeyRef: { name: secretName, key: 'admin-password' } },
    },
    {
      name: 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD',
      valueFrom: { secretKeyRef: { name: secretName, key: 'user-password' } },
    },
    VIEWER_PROFILE_ENV,
    { name: 'NEKO_SESSION_IMPLICIT_HOSTING', value: 'true' },
    { name: 'NEKO_FILETRANSFER_ENABLED', value: 'false' },
    { name: 'TZ', value: input.settings.timezone },
    { name: 'LANG', value: `${locale.posix}.UTF-8` },
    {
      name: 'LANGUAGE',
      value: locale.posix === locale.base ? locale.base : `${locale.posix}:${locale.base}`,
    },
  ];
}
```

- [ ] **Step 4: Write the StatefulSet builder**

`packages/server/src/orchestrator/manifests/statefulset.ts`:

```ts
import type { V1ContainerPort, V1SeccompProfile, V1StatefulSet } from '@kubernetes/client-node';
import type { DesiredState, SessionSettings } from '@hydra/shared';
import {
  MCP_PORT,
  NEKO_PORT,
  objectNames,
  SESSION_ID_LABEL,
  sessionLabels,
  STARTED_AT_ANNOTATION,
} from '../names.js';
import type { KubeObject } from '../types.js';
import { buildNekoEnv } from './neko-env.js';

/**
 * Spike S1 switch (index section 6). false is the main path: Chromium keeps --no-sandbox and the pod
 * uses the RuntimeDefault seccomp profile. Plan 09 sets it to true only if spike S1 succeeds; the
 * profile file must then exist on the node (spec sections 11.6 and 11.7).
 */
export const USE_CHROMIUM_SECCOMP_PROFILE = false;

/**
 * Capabilities that the neko container adds after `drop: ALL` (spec section 7.4): supervisord runs as
 * root, switches to the neko user (SETUID, SETGID), changes the owner of its socket (CHOWN), writes its
 * files (DAC_OVERRIDE, FOWNER), and signals its child processes (KILL). All are in the Pod Security
 * `baseline` list. Spike S1 confirms or changes this set.
 */
export const NEKO_ADDED_CAPABILITIES = [
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'KILL',
  'SETGID',
  'SETUID',
];

export function seccompProfile(): V1SeccompProfile {
  return USE_CHROMIUM_SECCOMP_PROFILE
    ? { type: 'Localhost', localhostProfile: 'hydra/chromium.json' }
    : { type: 'RuntimeDefault' };
}

export interface StatefulSetInput {
  sid: string;
  namespace: string;
  desiredState: DesiredState;
  /** applied_settings of the session (spec section 7.2). */
  settings: SessionSettings;
  mediaPort: number | null;
  startedAt: number | null;
  sessionImage: string;
  mcpImage: string;
  publicIp: string;
}

/** StatefulSet session-<sid> with the pod of spec section 7.4. */
export function buildStatefulSet(input: StatefulSetInput): V1StatefulSet & KubeObject {
  const names = objectNames(input.sid);
  const labels = sessionLabels(input.sid);
  const profileMount = { name: 'profile', mountPath: '/home/neko/.config/chromium' };
  const mediaPorts: V1ContainerPort[] =
    input.mediaPort === null
      ? []
      : [
          { name: 'media-udp', containerPort: input.mediaPort, protocol: 'UDP' },
          { name: 'media-tcp', containerPort: input.mediaPort, protocol: 'TCP' },
        ];
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: names.statefulSet, namespace: input.namespace, labels },
    spec: {
      replicas: input.desiredState === 'running' ? 1 : 0,
      serviceName: names.headlessService,
      podManagementPolicy: 'Parallel',
      selector: { matchLabels: { [SESSION_ID_LABEL]: input.sid } },
      template: {
        metadata: {
          labels,
          annotations: { [STARTED_AT_ANNOTATION]: String(input.startedAt ?? 0) },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { seccompProfile: seccompProfile() },
          initContainers: [
            {
              name: 'remove-locks',
              image: input.sessionImage,
              command: ['sh', '-c', 'rm -f /home/neko/.config/chromium/Singleton*'],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [profileMount],
            },
          ],
          containers: [
            {
              name: 'neko',
              image: input.sessionImage,
              ports: [{ name: 'http', containerPort: NEKO_PORT, protocol: 'TCP' }, ...mediaPorts],
              env: buildNekoEnv({
                sid: input.sid,
                settings: input.settings,
                mediaPort: input.mediaPort,
                publicIp: input.publicIp,
              }),
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'], add: [...NEKO_ADDED_CAPABILITIES] },
              },
              readinessProbe: {
                httpGet: { path: '/health', port: NEKO_PORT },
                periodSeconds: 3,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '500m', memory: '1536Mi' },
                limits: { cpu: '3', memory: '4Gi' },
              },
              volumeMounts: [
                profileMount,
                {
                  name: 'chromium-config',
                  mountPath: '/etc/chromium/policies/managed/policies.json',
                  subPath: 'policies.json',
                  readOnly: true,
                },
                {
                  name: 'chromium-config',
                  mountPath: '/etc/chromium.d/hydra',
                  subPath: 'hydra-flags',
                  readOnly: true,
                },
                { name: 'dshm', mountPath: '/dev/shm' },
              ],
            },
            {
              name: 'mcp',
              image: input.mcpImage,
              command: [
                'playwright-mcp',
                '--cdp-endpoint',
                'http://127.0.0.1:9222',
                '--host',
                '0.0.0.0',
                '--port',
                String(MCP_PORT),
              ],
              ports: [{ name: 'mcp', containerPort: MCP_PORT, protocol: 'TCP' }],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              readinessProbe: {
                tcpSocket: { port: MCP_PORT },
                periodSeconds: 3,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [
            { name: 'profile', persistentVolumeClaim: { claimName: names.pvc } },
            { name: 'chromium-config', configMap: { name: names.configMap } },
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}
```

- [ ] **Step 5: Write `buildSessionObjects` and the module exports**

`packages/server/src/orchestrator/manifests/index.ts`:

```ts
import type { Config } from '../../config/index.js';
import type { Subkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { desiredStateOf } from '../row-fields.js';
import type { KubeObject } from '../types.js';
import { buildConfigMap } from './configmap.js';
import { buildHeadlessService } from './headless-service.js';
import { buildMediaService } from './media-service.js';
import { buildPvc } from './pvc.js';
import { buildSecret } from './secret.js';
import { buildStatefulSet } from './statefulset.js';

/**
 * The objects of spec section 7.3 for one session, in apply order. Built only from applied_settings,
 * media_port, started_at, and desired_state (spec sections 7.2 and 7.9). The media Service is in the
 * list only while the session holds a media port.
 */
export function buildSessionObjects(
  row: SessionRow,
  context: { config: Config; subkeys: Subkeys },
): KubeObject[] {
  const sid = row.id;
  const namespace = context.config.sessionNamespace;
  const settings = row.appliedSettings;
  const objects: KubeObject[] = [
    buildPvc(sid, namespace),
    buildSecret(sid, namespace, context.subkeys.neko),
    buildConfigMap(sid, namespace, settings),
    buildHeadlessService(sid, namespace),
  ];
  if (row.mediaPort !== null) objects.push(buildMediaService(sid, namespace, row.mediaPort));
  objects.push(
    buildStatefulSet({
      sid,
      namespace,
      desiredState: desiredStateOf(row),
      settings,
      mediaPort: row.mediaPort,
      startedAt: row.startedAt,
      sessionImage: context.config.sessionImage,
      mcpImage: context.config.mcpImage,
      publicIp: context.config.publicIp,
    }),
  );
  return objects;
}

export { buildConfigMap } from './configmap.js';
export { buildChromiumFlags } from './chromium-flags.js';
export { buildHeadlessService } from './headless-service.js';
export { buildMediaService } from './media-service.js';
export { buildNekoEnv, VIEWER_PROFILE_ENV } from './neko-env.js';
export { buildPolicies, DISK_CACHE_SIZE, isAllowAll, NEKO_DEFAULT_POLICIES } from './policies.js';
export { buildPvc } from './pvc.js';
export { buildSecret } from './secret.js';
export {
  buildStatefulSet,
  NEKO_ADDED_CAPABILITIES,
  seccompProfile,
  USE_CHROMIUM_SECCOMP_PROFILE,
} from './statefulset.js';
```

- [ ] **Step 6: Run the tests to verify that they pass and write the snapshot**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests --update`
Expected: PASS. `Snapshots  1 written`, `Test Files  6 passed (6)`, `Tests  28 passed (28)`. The new file `src/orchestrator/manifests/__snapshots__/index.test.ts.snap` belongs to this task (report it). Open it once and check that it contains the six objects of the first test.

Run again without `--update`: `pnpm --filter @hydra/server exec vitest run src/orchestrator/manifests`
Expected: PASS. `Tests  28 passed (28)`, no snapshot written.

- [ ] **Step 7: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 5: `createKubeClient` with `@kubernetes/client-node`

Spec sections 4, 7.3, 7.9 (server-side apply, watch), 10.2 (logs), 11.7 (port-forward), 14 (`/readyz`); index 5.10.

**Files:**
- Create: `packages/server/src/orchestrator/kube-client.ts`
- Test: `packages/server/src/orchestrator/kube-client.test.ts`

**Interfaces:**
- Consumes: `KubeClient`, `KubeKind`, `KubeObject`, `KubeWatchEvent`, `MANAGED_BY_LABEL`, `MANAGED_BY_SELECTOR` (Task 1); `Config` (`src/config/index.ts`, plan 02); `testConfig` (plan 02).
- Produces:

```ts
export function createKubeClient(config: Config, kubeConfig?: KubeConfig): KubeClient;   // index 5.10 (+ optional kubeConfig)
export function loadKubeConfig(env?: Record<string, string | undefined>): KubeConfig;  // in-cluster, else KUBECONFIG
export function isApiStatus(error: unknown, code: number): boolean;
export function apiErrorMessage(error: unknown): string;
export const WATCHED_KINDS: readonly KubeKind[];
```

Notes for the implementer (all verified, see "Verified facts"):
- `apply` uses `KubernetesObjectApi.patch` with `PatchStrategy.ServerSideApply`, field manager `hydra`, and `force: true`. The generic object API reads the API discovery documents (`/api/v1`, `/apis/apps/v1`) once and caches them.
- `watch` starts one watch for each kind with the label selector `app.kubernetes.io/managed-by=hydra`. client-node 2.0.0 aborts each watch request after 30 s, so the server ends each watch after 25 s (`timeoutSeconds`), and the next watch resumes at the last `resourceVersion` (no replay of old events). A `410 Gone` error drops the resource version, so the next watch lists all objects again.
- `readLog` reads the pod first: for a pod without a node, the API answers 204 without a body, and client-node cannot parse it.
- `dryRunNodePorts` makes a real create and delete (Spec deviation 1). The API answer for a port outside the range is 422 with `provided port is not in the valid range`.
- `portForward` opens one WebSocket tunnel for one TCP connection (client-node supports one port per tunnel).

- [ ] **Step 1: Write the failing test**

The test starts a small HTTP server that answers like the Kubernetes API and records each request. It pins the exact requests that the real API server accepted in the scratch checks.

`packages/server/src/orchestrator/kube-client.test.ts`:

```ts
import { KubeConfig } from '@kubernetes/client-node';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers/config.js';
import { createKubeClient } from './kube-client.js';
import type { KubeClient, KubeObject, KubeWatchEvent } from './types.js';

interface Recorded {
  method: string;
  url: string;
  contentType: string | undefined;
  authorization: string | undefined;
  body: string;
}

type Handler = (request: Recorded, response: ServerResponse) => boolean;

const RESOURCES: Record<string, Array<{ name: string; kind: string }>> = {
  '/api/v1': [
    { name: 'pods', kind: 'Pod' },
    { name: 'services', kind: 'Service' },
    { name: 'configmaps', kind: 'ConfigMap' },
    { name: 'secrets', kind: 'Secret' },
    { name: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim' },
  ],
  '/apis/apps/v1': [{ name: 'statefulsets', kind: 'StatefulSet' }],
};

function json(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
  return true;
}

const status = (code: number, message: string) => ({
  kind: 'Status',
  apiVersion: 'v1',
  status: 'Failure',
  message,
  code,
});

let server: Server;
let requests: Recorded[];
let handlers: Handler[];
let kube: KubeClient;

beforeEach(async () => {
  requests = [];
  handlers = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const recorded: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization,
        body,
      };
      const path = recorded.url.split('?')[0] ?? '';
      const resources = RESOURCES[path];
      if (resources && recorded.method === 'GET') {
        json(response, 200, {
          kind: 'APIResourceList',
          groupVersion: path === '/api/v1' ? 'v1' : 'apps/v1',
          resources: resources.map((r) => ({
            ...r,
            namespaced: true,
            singularName: '',
            verbs: [],
          })),
        });
        return;
      }
      requests.push(recorded);
      if (!handlers.some((handler) => handler(recorded, response)))
        json(response, 404, status(404, 'not found'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'fake', server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: 'fake', token: 'test-token' }],
    contexts: [{ name: 'fake', cluster: 'fake', user: 'fake' }],
    currentContext: 'fake',
  });
  kube = createKubeClient(testConfig(), kubeConfig);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const configMap: KubeObject = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name: 'chromium-abcdefghij23',
    namespace: 'hydra-sessions',
    labels: { 'hydra/session-id': 'abcdefghij23' },
  },
  data: { 'hydra-flags': 'x' },
} as KubeObject;

describe('createKubeClient', () => {
  it('applies with server-side apply, field manager hydra, and force', async () => {
    handlers.push(
      (request, response) => request.method === 'PATCH' && json(response, 200, configMap),
    );
    await kube.apply(configMap);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    const url = new URL(request!.url, 'http://x');
    expect(request!.method).toBe('PATCH');
    expect(url.pathname).toBe('/api/v1/namespaces/hydra-sessions/configmaps/chromium-abcdefghij23');
    expect(url.searchParams.get('fieldManager')).toBe('hydra');
    expect(url.searchParams.get('force')).toBe('true');
    expect(request!.contentType).toBe('application/apply-patch+yaml');
    expect(request!.authorization).toBe('Bearer test-token');
    expect(JSON.parse(request!.body)).toMatchObject({
      kind: 'ConfigMap',
      data: { 'hydra-flags': 'x' },
    });
  });

  it('uses the apps/v1 path for a StatefulSet', async () => {
    handlers.push(
      (request, response) => request.method === 'DELETE' && json(response, 200, status(200, 'ok')),
    );
    await kube.remove('StatefulSet', 'session-abcdefghij23');
    expect(new URL(requests[0]!.url, 'http://x').pathname).toBe(
      '/apis/apps/v1/namespaces/hydra-sessions/statefulsets/session-abcdefghij23',
    );
  });

  it('counts a 404 as success for remove, and returns null for get', async () => {
    await expect(kube.remove('Secret', 'neko-missing')).resolves.toBeUndefined();
    await expect(kube.get('Secret', 'neko-missing')).resolves.toBeNull();
  });

  it('throws other errors', async () => {
    handlers.push((_request, response) => json(response, 500, status(500, 'etcd unavailable')));
    await expect(kube.remove('Secret', 'neko-x')).rejects.toThrow();
  });

  it('lists with a label selector and sets kind and apiVersion on the items', async () => {
    handlers.push(
      (request, response) =>
        request.method === 'GET' &&
        request.url.startsWith('/api/v1/namespaces/hydra-sessions/services') &&
        json(response, 200, {
          kind: 'ServiceList',
          apiVersion: 'v1',
          items: [
            {
              metadata: {
                name: 'media-abcdefghij23',
                namespace: 'hydra-sessions',
                labels: { 'hydra/session-id': 'abcdefghij23' },
              },
            },
          ],
        }),
    );
    const items = await kube.list('Service', 'app.kubernetes.io/managed-by=hydra');
    expect(new URL(requests[0]!.url, 'http://x').searchParams.get('labelSelector')).toBe(
      'app.kubernetes.io/managed-by=hydra',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'Service',
      apiVersion: 'v1',
      metadata: { name: 'media-abcdefghij23' },
    });
  });

  it('reports a port outside the node port range from the API answer', async () => {
    handlers.push((request, response) => {
      if (request.method !== 'POST') return false;
      const body = JSON.parse(request.body) as { spec: { ports: Array<{ nodePort: number }> } };
      const port = body.spec.ports[0]?.nodePort;
      if (port === 52000) {
        return json(
          response,
          422,
          status(
            422,
            `Service "hydra-port-check-52000" is invalid: spec.ports[0].nodePort: Invalid value: 52000: provided port is not in the valid range. The range of valid ports is 30000-32767`,
          ),
        );
      }
      return json(response, 201, JSON.parse(request.body));
    });
    const result = await kube.dryRunNodePorts([52000, 52099]);
    expect(result.outOfRange).toBe(true);
    expect(result.message).toContain('provided port is not in the valid range');
    const post = requests.find((r) => r.method === 'POST')!;
    expect(new URL(post.url, 'http://x').pathname).toBe(
      '/api/v1/namespaces/hydra-sessions/services',
    );
    expect(JSON.parse(post.body)).toMatchObject({
      metadata: { name: 'hydra-port-check-52000' },
      spec: {
        type: 'NodePort',
        ports: [{ port: 52000, targetPort: 52000, nodePort: 52000, protocol: 'TCP' }],
      },
    });
  });

  it('passes and deletes the check Services when the API accepts the ports', async () => {
    handlers.push(
      (request, response) =>
        request.method === 'POST' && json(response, 201, JSON.parse(request.body)),
    );
    handlers.push(
      (request, response) => request.method === 'DELETE' && json(response, 200, status(200, 'ok')),
    );
    await expect(kube.dryRunNodePorts([52000, 52099])).resolves.toEqual({
      outOfRange: false,
      message: null,
    });
    expect(requests.map((r) => `${r.method} ${new URL(r.url, 'http://x').pathname}`)).toEqual([
      'DELETE /api/v1/namespaces/hydra-sessions/services/hydra-port-check-52000',
      'POST /api/v1/namespaces/hydra-sessions/services',
      'DELETE /api/v1/namespaces/hydra-sessions/services/hydra-port-check-52000',
      'DELETE /api/v1/namespaces/hydra-sessions/services/hydra-port-check-52099',
      'POST /api/v1/namespaces/hydra-sessions/services',
      'DELETE /api/v1/namespaces/hydra-sessions/services/hydra-port-check-52099',
    ]);
  });

  it('passes for other answers, for example a port in use', async () => {
    handlers.push(
      (request, response) =>
        request.method === 'POST' &&
        json(
          response,
          422,
          status(
            422,
            'spec.ports[0].nodePort: Invalid value: 52000: provided port is already allocated',
          ),
        ),
    );
    await expect(kube.dryRunNodePorts([52000])).resolves.toEqual({
      outOfRange: false,
      message: null,
    });
  });

  it('watches the managed objects and resumes at the last resource version', async () => {
    const podWatches: URLSearchParams[] = [];
    handlers.push((request, response) => {
      const url = new URL(request.url, 'http://x');
      if (url.searchParams.get('watch') !== 'true') return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      if (url.pathname !== '/api/v1/namespaces/hydra-sessions/pods') return true; // stays open
      podWatches.push(url.searchParams);
      if (podWatches.length === 1) {
        const object = {
          kind: 'Pod',
          apiVersion: 'v1',
          metadata: {
            name: 'session-abcdefghij23-0',
            namespace: 'hydra-sessions',
            resourceVersion: '41',
            labels: { 'hydra/session-id': 'abcdefghij23' },
          },
        };
        response.end(`${JSON.stringify({ type: 'ADDED', object })}\n`);
      }
      return true;
    });
    const events: KubeWatchEvent[] = [];
    const stop = await kube.watch((event) => events.push(event));
    await expect.poll(() => podWatches.length, { timeout: 5_000 }).toBe(2);
    stop();
    expect(podWatches[0]?.get('labelSelector')).toBe('app.kubernetes.io/managed-by=hydra');
    expect(podWatches[0]?.get('timeoutSeconds')).toBe('25');
    expect(podWatches[0]?.get('resourceVersion')).toBeNull();
    expect(podWatches[1]?.get('resourceVersion')).toBe('41');
    expect(events).toEqual([
      {
        kind: 'Pod',
        type: 'ADDED',
        object: expect.objectContaining({
          kind: 'Pod',
          metadata: expect.objectContaining({ name: 'session-abcdefghij23-0' }) as unknown,
        }) as unknown,
      },
    ]);
  });

  it('pings /version', async () => {
    handlers.push(
      (request, response) =>
        request.url === '/version' && json(response, 200, { gitVersion: 'v1.37.0' }),
    );
    await expect(kube.ping()).resolves.toBe(true);
    handlers.length = 0;
    await expect(kube.ping()).resolves.toBe(false);
  });

  it('reads a log only after the container has started', async () => {
    const pod = (running: boolean) => ({
      kind: 'Pod',
      apiVersion: 'v1',
      metadata: { name: 'session-abcdefghij23-0', namespace: 'hydra-sessions' },
      status: {
        containerStatuses: [
          {
            name: 'neko',
            ready: running,
            restartCount: 0,
            image: 'x',
            imageID: 'x',
            state: running ? { running: {} } : { waiting: { reason: 'ContainerCreating' } },
          },
        ],
      },
    });
    let running = false;
    handlers.push((request, response) => {
      const path = new URL(request.url, 'http://x').pathname;
      if (path === '/api/v1/namespaces/hydra-sessions/pods/session-abcdefghij23-0')
        return json(response, 200, pod(running));
      if (path === '/api/v1/namespaces/hydra-sessions/pods/session-abcdefghij23-0/log') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('line 1\nline 2\n');
        return true;
      }
      return false;
    });
    await expect(kube.readLog('session-abcdefghij23-0', 'neko', 50)).resolves.toBe('');
    running = true;
    await expect(kube.readLog('session-abcdefghij23-0', 'neko', 50)).resolves.toBe(
      'line 1\nline 2\n',
    );
    const logRequest = requests.find((r) => r.url.includes('/log'))!;
    const query = new URL(logRequest.url, 'http://x').searchParams;
    expect(query.get('container')).toBe('neko');
    expect(query.get('tailLines')).toBe('50');
    await expect(kube.readLog('session-missing-0', 'neko', 50)).resolves.toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/kube-client.test.ts`
Expected: FAIL with `Error: Cannot find module './kube-client.js' imported from …/src/orchestrator/kube-client.test.ts`.

- [ ] **Step 3: Write the client**

`packages/server/src/orchestrator/kube-client.ts`:

```ts
import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  PortForward,
  VersionApi,
  Watch,
  type KubernetesObject,
  type V1Pod,
  type V1Service,
} from '@kubernetes/client-node';
import type { Duplex } from 'node:stream';
import type { Config } from '../config/index.js';
import { MANAGED_BY_LABEL, MANAGED_BY_SELECTOR } from './names.js';
import type { KubeClient, KubeKind, KubeObject, KubeWatchEvent } from './types.js';

const FIELD_MANAGER = 'hydra';
const PING_TIMEOUT_MS = 3_000;
/** The server ends each watch after 25 s, before the 30 s request timeout of client-node 2.0.0. */
const WATCH_SERVER_TIMEOUT_S = 25;
const WATCH_RESTART_MS = 1_000;
const WATCH_RETRY_MAX_MS = 30_000;
const OUT_OF_RANGE_TEXT = 'provided port is not in the valid range';

const KINDS: Record<KubeKind, { apiVersion: string; plural: string }> = {
  PersistentVolumeClaim: { apiVersion: 'v1', plural: 'persistentvolumeclaims' },
  Secret: { apiVersion: 'v1', plural: 'secrets' },
  ConfigMap: { apiVersion: 'v1', plural: 'configmaps' },
  Service: { apiVersion: 'v1', plural: 'services' },
  StatefulSet: { apiVersion: 'apps/v1', plural: 'statefulsets' },
  Pod: { apiVersion: 'v1', plural: 'pods' },
};

export const WATCHED_KINDS: readonly KubeKind[] = [
  'Pod',
  'StatefulSet',
  'Service',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
];

/** In-cluster config if the pod has the service environment, else KUBECONFIG or ~/.kube/config. */
export function loadKubeConfig(env: Record<string, string | undefined> = process.env): KubeConfig {
  const kubeConfig = new KubeConfig();
  if (env['KUBERNETES_SERVICE_HOST'] && env['KUBERNETES_SERVICE_PORT'])
    kubeConfig.loadFromCluster();
  else kubeConfig.loadFromDefault();
  return kubeConfig;
}

export function isApiStatus(error: unknown, code: number): boolean {
  return error instanceof ApiException && error.code === code;
}

/** The `message` of a Kubernetes Status body, or the error message. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiException) {
    const body: unknown = error.body;
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
      return body.message;
    if (typeof body === 'string') {
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'message' in parsed &&
          typeof parsed.message === 'string'
        ) {
          return parsed.message;
        }
      } catch {
        return body;
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function watchPath(kind: KubeKind, namespace: string): string {
  const { apiVersion, plural } = KINDS[kind];
  const prefix = apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`;
  return `${prefix}/namespaces/${namespace}/${plural}`;
}

/** List items and watch objects have no kind; reads return class instances. Make them plain KubeObjects. */
function normalize(kind: KubeKind, object: KubernetesObject, namespace: string): KubeObject {
  const metadata = object.metadata ?? {};
  return {
    ...object,
    apiVersion: KINDS[kind].apiVersion,
    kind,
    metadata: {
      ...metadata,
      name: metadata.name ?? '',
      namespace: metadata.namespace ?? namespace,
      labels: metadata.labels ?? {},
    },
  };
}

/** The part of the port-forward WebSocket that the gateway uses. */
interface TunnelSocket {
  on(event: 'close' | 'error', listener: () => void): void;
  close(): void;
}

function containerHasStarted(pod: KubeObject, container: string): boolean {
  const status = (pod as V1Pod).status?.containerStatuses?.find(
    (entry) => entry.name === container,
  );
  return Boolean(
    status && (status.state?.running || status.state?.terminated || status.lastState?.terminated),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createKubeClient(
  config: Config,
  kubeConfig: KubeConfig = loadKubeConfig(),
): KubeClient {
  const namespace = config.sessionNamespace;
  const objects = KubernetesObjectApi.makeApiClient(kubeConfig);
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const version = kubeConfig.makeApiClient(VersionApi);
  const ref = (kind: KubeKind, name: string) => ({
    apiVersion: KINDS[kind].apiVersion,
    kind,
    metadata: { name, namespace },
  });

  const get = async (kind: KubeKind, name: string): Promise<KubeObject | null> => {
    try {
      return normalize(kind, await objects.read(ref(kind, name)), namespace);
    } catch (error) {
      if (isApiStatus(error, 404)) return null;
      throw error;
    }
  };

  const remove = async (kind: KubeKind, name: string): Promise<void> => {
    try {
      await objects.delete(ref(kind, name));
    } catch (error) {
      if (!isApiStatus(error, 404)) throw error;
    }
  };

  return {
    async apply(object) {
      await objects.patch(
        object,
        undefined,
        undefined,
        FIELD_MANAGER,
        true,
        PatchStrategy.ServerSideApply,
      );
    },

    remove,

    get,

    async list(kind, labelSelector) {
      const result = await objects.list(
        KINDS[kind].apiVersion,
        kind,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector,
      );
      return result.items.map((item) => normalize(kind, item, namespace));
    },

    async watch(handler: (event: KubeWatchEvent) => void) {
      const watcher = new Watch(kubeConfig);
      const controllers = new Map<KubeKind, AbortController>();
      const timers = new Set<NodeJS.Timeout>();
      const resourceVersions = new Map<KubeKind, string>();
      let stopped = false;

      const start = async (kind: KubeKind, failures: number): Promise<void> => {
        if (stopped) return;
        const retry = (delayMs: number, nextFailures: number) => {
          if (stopped) return;
          const timer = setTimeout(() => {
            timers.delete(timer);
            void start(kind, nextFailures);
          }, delayMs);
          timers.add(timer);
        };
        const backoffMs = Math.min(1_000 * 2 ** failures, WATCH_RETRY_MAX_MS);
        let received = false;
        let controller: AbortController;
        try {
          controller = await watcher.watch(
            watchPath(kind, namespace),
            {
              labelSelector: MANAGED_BY_SELECTOR,
              allowWatchBookmarks: true,
              timeoutSeconds: WATCH_SERVER_TIMEOUT_S,
              resourceVersion: resourceVersions.get(kind),
            },
            (phase: string, apiObject: unknown) => {
              received = true;
              const object = apiObject as KubernetesObject & { code?: number };
              if (phase === 'ERROR') {
                // 410 Gone: the resource version is too old. The next start lists all objects.
                if (object.code === 410) resourceVersions.delete(kind);
                return;
              }
              const resourceVersion = object.metadata?.resourceVersion;
              if (resourceVersion) resourceVersions.set(kind, resourceVersion);
              if (phase === 'ADDED' || phase === 'MODIFIED' || phase === 'DELETED') {
                handler({ kind, type: phase, object: normalize(kind, object, namespace) });
              }
            },
            (error: unknown) => {
              controllers.delete(kind);
              // The next watch resumes at the last resource version, so a restart loses no event.
              if (error && !received) retry(backoffMs, failures + 1);
              else retry(WATCH_RESTART_MS, 0);
            },
          );
        } catch {
          retry(backoffMs, failures + 1);
          return;
        }
        if (stopped) controller.abort();
        else controllers.set(kind, controller);
      };

      await Promise.all(WATCHED_KINDS.map((kind) => start(kind, 0)));
      return () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        for (const controller of controllers.values()) controller.abort();
      };
    },

    async readLog(podName, container, tailLines) {
      // A pod without a node gives 204 without a body, which client-node cannot parse. Thus read the
      // log only after the container has started.
      const pod = await get('Pod', podName);
      if (!pod || !containerHasStarted(pod, container)) return '';
      try {
        return await core.readNamespacedPodLog({ name: podName, namespace, container, tailLines });
      } catch (error) {
        // 404: the pod is gone. 400: the container does not run (race with the check above).
        if (isApiStatus(error, 404) || isApiStatus(error, 400)) return '';
        throw error;
      }
    },

    async dryRunNodePorts(ports) {
      for (const port of ports) {
        const name = `hydra-port-check-${port}`;
        await remove('Service', name);
        const service: V1Service = {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name,
            namespace,
            labels: { [MANAGED_BY_LABEL]: 'hydra', 'hydra/purpose': 'port-check' },
          },
          spec: {
            type: 'NodePort',
            ports: [{ name: 'check', protocol: 'TCP', port, targetPort: port, nodePort: port }],
          },
        };
        try {
          await core.createNamespacedService({
            namespace,
            body: service,
            fieldManager: FIELD_MANAGER,
          });
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
          const message = apiErrorMessage(error);
          if (error.code === 422 && message.includes(OUT_OF_RANGE_TEXT))
            return { outOfRange: true, message };
          // Other answers pass the check, for example a port in use (spec section 4).
          continue;
        }
        await remove('Service', name);
      }
      return { outOfRange: false, message: null };
    },

    async ping() {
      try {
        await withTimeout(version.getCode(), PING_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    },

    async portForward(podName: string, port: number, socket: Duplex) {
      const forward = new PortForward(kubeConfig);
      // The WebSocket type of client-node comes from isomorphic-ws, whose types need @types/ws.
      const opened: unknown = await forward.portForward(
        namespace,
        podName,
        [port],
        socket,
        null,
        socket,
      );
      const webSocket = (
        typeof opened === 'function' ? (opened as () => unknown)() : opened
      ) as TunnelSocket | null;
      if (!webSocket) {
        socket.destroy();
        throw new Error(`port-forward to ${podName}:${port} did not open`);
      }
      webSocket.on('close', () => socket.destroy());
      webSocket.on('error', () => socket.destroy());
      socket.on('close', () => webSocket.close());
      socket.on('error', () => webSocket.close());
    },
  };
}
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/kube-client.test.ts`
Expected: PASS. `Tests  11 passed (11)`. The watch test takes about 1 s (the restart delay of 1 s).

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 6: `FakeKubeClient` and the startup check of `HYDRA_MEDIA_PORT_RANGE`

Spec section 4 (as changed by Spec deviation 1); index 5.12 (`FakeKubeClient`).

**Files:**
- Create: `packages/server/test/helpers/fake-kube.ts`
- Create: `packages/server/src/orchestrator/media-port-check.ts`
- Test: `packages/server/src/orchestrator/media-port-check.test.ts`

**Interfaces:**
- Consumes: Task 1 (types, names); `Config`, `Logger`, `createLogger` (plan 02); `testConfig` (plan 02).
- Produces:

```ts
// test/helpers/fake-kube.ts (index 5.12, with more helpers; see "Index issues")
export class FakeKubeClient implements KubeClient {
  constructor(namespace?: string);                      // default 'hydra-sessions'
  readonly calls: Array<{ op: FakeKubeOperation; kind?: KubeKind; name?: string }>;
  nodePortRange: { first: number; last: number };       // default 30000-32767, for dryRunNodePorts
  pingResult: boolean;                                  // default true
  setPodReady(sid: string, ready: boolean): void;       // creates the pod with the annotation of the current template
  setContainerWaiting(sid: string, reason: string, message?: string): void;
  removePod(sid: string): void;
  object(kind: KubeKind, name: string): KubeObject | undefined;   // no recorded call
  objectsOf(sid: string): string[];                     // sorted 'Kind/name' keys of the session objects
  failNext(op: FakeKubeOperation, error?: Error): void;
  setLog(podName: string, container: 'neko' | 'mcp', text: string): void;
  setPortForwardTarget(podName: string, port: number, target: { host: string; port: number }): void;
}
// src/orchestrator/media-port-check.ts
export class MediaPortRangeError extends Error { readonly variable = 'HYDRA_MEDIA_PORT_RANGE' }
export function checkMediaPortRange(deps: { kube: KubeClient; config: Config; logger: Logger }): Promise<void>;
```

The fake emits a watch event for each change: `ADDED` or `MODIFIED` on `apply` (only if the content changes, like a server-side apply without a change), `DELETED` on `remove` and `removePod`. Its pod helpers model the StatefulSet controller and the kubelet: a new pod gets the `hydra/started-at` annotation of the current StatefulSet template, so a test models a Restart with `removePod` and then `setPodReady`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/orchestrator/media-port-check.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { testConfig } from '../../test/helpers/config.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { checkMediaPortRange, MediaPortRangeError } from './media-port-check.js';

describe('checkMediaPortRange', () => {
  it('passes when the API server accepts the first and the last port', async () => {
    const kube = new FakeKubeClient();
    kube.nodePortRange = { first: 30000, last: 52099 };
    const dryRun = vi.spyOn(kube, 'dryRunNodePorts');
    await checkMediaPortRange({ kube, config: testConfig(), logger: createLogger('fatal') });
    expect(dryRun).toHaveBeenCalledWith([52000, 52099]);
  });

  it('stops with an error that names HYDRA_MEDIA_PORT_RANGE', async () => {
    const kube = new FakeKubeClient();
    const check = checkMediaPortRange({
      kube,
      config: testConfig(),
      logger: createLogger('fatal'),
    });
    await expect(check).rejects.toBeInstanceOf(MediaPortRangeError);
    await expect(check).rejects.toThrow(
      /HYDRA_MEDIA_PORT_RANGE 52000-52099 is not inside the service-node-port-range/,
    );
  });

  it('checks one port for a range of one port', async () => {
    const kube = new FakeKubeClient();
    kube.nodePortRange = { first: 30000, last: 52000 };
    const dryRun = vi.spyOn(kube, 'dryRunNodePorts');
    const config = testConfig({ mediaPortRange: { first: 52000, last: 52000 }, maxRunning: 1 });
    await checkMediaPortRange({ kube, config, logger: createLogger('fatal') });
    expect(dryRun).toHaveBeenCalledWith([52000]);
  });

  it('logs a warning and passes when the API server does not answer', async () => {
    const kube = new FakeKubeClient();
    kube.failNext('dryRunNodePorts', new Error('connect ECONNREFUSED'));
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn');
    const anyError: unknown = expect.any(Error);
    await checkMediaPortRange({ kube, config: testConfig(), logger });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: anyError }),
      expect.stringContaining('HYDRA_MEDIA_PORT_RANGE'),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/media-port-check.test.ts`
Expected: FAIL with `Error: Cannot find module '../../test/helpers/fake-kube.js'`.

- [ ] **Step 3: Write `FakeKubeClient`**

`packages/server/test/helpers/fake-kube.ts`:

```ts
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { objectNames, sessionLabels, STARTED_AT_ANNOTATION } from '../../src/orchestrator/names.js';
import type {
  KubeClient,
  KubeKind,
  KubeObject,
  KubeWatchEvent,
} from '../../src/orchestrator/types.js';

export type FakeKubeOperation =
  'apply' | 'remove' | 'get' | 'list' | 'readLog' | 'dryRunNodePorts' | 'portForward';

interface FakePodStatus {
  phase: string;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  containerStatuses: Array<{
    name: string;
    ready: boolean;
    state: { running?: Record<string, never>; waiting?: { reason: string; message: string } };
  }>;
}

type FakePod = KubeObject & { status: FakePodStatus };
type WithTemplate = {
  spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
};

const key = (kind: KubeKind, name: string): string => `${kind}/${name}`;

/** Compares two objects without the fields that the fake API server sets. */
function sameContent(a: KubeObject, b: KubeObject): boolean {
  const strip = (o: KubeObject) =>
    JSON.stringify({
      ...o,
      metadata: { ...o.metadata, uid: undefined, resourceVersion: undefined },
    });
  return strip(a) === strip(b);
}

/**
 * KubeClient in memory (index section 5.12). Objects live in a map; each change emits a watch event
 * to all handlers. The test helpers model the pod that the StatefulSet controller and the kubelet
 * create. Like a real client, each method returns a rejected promise on failure.
 */
export class FakeKubeClient implements KubeClient {
  readonly namespace: string;
  /** Each call of a KubeClient method, in order. */
  readonly calls: Array<{ op: FakeKubeOperation; kind?: KubeKind; name?: string }> = [];
  /** service-node-port-range of the fake API server, for dryRunNodePorts. */
  nodePortRange = { first: 30000, last: 32767 };
  /** Result of ping(). */
  pingResult = true;
  private readonly store = new Map<string, KubeObject>();
  private readonly handlers = new Set<(event: KubeWatchEvent) => void>();
  private readonly failures: Array<{ op: FakeKubeOperation; error: Error }> = [];
  private readonly logs = new Map<string, string>();
  private readonly forwardTargets = new Map<string, { host: string; port: number }>();
  private version = 0;

  constructor(namespace = 'hydra-sessions') {
    this.namespace = namespace;
  }

  apply(object: KubeObject): Promise<void> {
    return this.perform('apply', object.kind, object.metadata.name, () => {
      const id = key(object.kind, object.metadata.name);
      const existing = this.store.get(id);
      const next = structuredClone(object);
      next.metadata.namespace = this.namespace;
      next.metadata.uid = existing?.metadata.uid ?? `uid-${++this.version}`;
      next.metadata.resourceVersion = existing?.metadata.resourceVersion ?? '0';
      if (existing && sameContent(existing, next)) return;
      next.metadata.resourceVersion = String(++this.version);
      this.store.set(id, next);
      this.emit(existing ? 'MODIFIED' : 'ADDED', next);
    });
  }

  remove(kind: KubeKind, name: string): Promise<void> {
    return this.perform('remove', kind, name, () => {
      const existing = this.store.get(key(kind, name));
      if (!existing) return;
      this.store.delete(key(kind, name));
      this.emit('DELETED', existing);
    });
  }

  get(kind: KubeKind, name: string): Promise<KubeObject | null> {
    return this.perform('get', kind, name, () => {
      const object = this.store.get(key(kind, name));
      return object ? structuredClone(object) : null;
    });
  }

  list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]> {
    return this.perform('list', kind, undefined, () => {
      const terms = labelSelector
        .split(',')
        .filter((term) => term !== '')
        .map((term) => term.split('=') as [string, string]);
      return [...this.store.values()]
        .filter((o) => o.kind === kind && terms.every(([k, v]) => o.metadata.labels[k] === v))
        .map((o) => structuredClone(o));
    });
  }

  watch(handler: (event: KubeWatchEvent) => void): Promise<() => void> {
    this.handlers.add(handler);
    return Promise.resolve(() => {
      this.handlers.delete(handler);
    });
  }

  readLog(podName: string, container: 'neko' | 'mcp', tailLines: number): Promise<string> {
    return this.perform('readLog', 'Pod', podName, () => {
      const lines = (this.logs.get(`${podName}/${container}`) ?? '').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.length === 0 ? '' : `${lines.slice(-tailLines).join('\n')}\n`;
    });
  }

  dryRunNodePorts(ports: number[]): Promise<{ outOfRange: boolean; message: string | null }> {
    return this.perform('dryRunNodePorts', undefined, undefined, () => {
      const { first, last } = this.nodePortRange;
      const bad = ports.find((port) => port < first || port > last);
      if (bad === undefined) return { outOfRange: false, message: null };
      return {
        outOfRange: true,
        message: `Service "hydra-port-check-${bad}" is invalid: spec.ports[0].nodePort: Invalid value: ${bad}: provided port is not in the valid range. The range of valid ports is ${first}-${last}`,
      };
    });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.pingResult);
  }

  async portForward(podName: string, port: number, socket: Duplex): Promise<void> {
    const target = await this.perform('portForward', 'Pod', podName, () => {
      if (!this.store.has(key('Pod', podName))) throw new Error(`pod ${podName} not found`);
      const found = this.forwardTargets.get(`${podName}:${port}`);
      if (!found) throw new Error(`no port-forward target for ${podName}:${port}`);
      return found;
    });
    const upstream = connect(target.port, target.host);
    await new Promise<void>((resolve, reject) => {
      upstream.once('connect', resolve);
      upstream.once('error', reject);
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on('close', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }

  // Test helpers of index section 5.12.

  /** Creates the pod `session-<sid>-0` if it is missing, with the annotation of the current template, and sets Ready. */
  setPodReady(sid: string, ready: boolean): void {
    const pod = this.podOf(sid);
    pod.status.conditions = [
      { type: 'PodScheduled', status: 'True' },
      ready
        ? { type: 'Ready', status: 'True' }
        : {
            type: 'Ready',
            status: 'False',
            reason: 'ContainersNotReady',
            message: 'containers with unready status: [neko]',
          },
    ];
    pod.status.containerStatuses = ['neko', 'mcp'].map((name) => ({
      name,
      ready,
      state: { running: {} },
    }));
    this.storePod(pod);
  }

  /** Makes the neko container of the pod wait with this reason (the pod is created if it is missing). */
  setContainerWaiting(sid: string, reason: string, message = `${reason}: back-off`): void {
    const pod = this.podOf(sid);
    pod.status.conditions = [
      { type: 'PodScheduled', status: 'True' },
      {
        type: 'Ready',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [neko]',
      },
    ];
    pod.status.containerStatuses = [
      { name: 'neko', ready: false, state: { waiting: { reason, message } } },
      { name: 'mcp', ready: true, state: { running: {} } },
    ];
    this.storePod(pod);
  }

  /** Deletes the pod, as the StatefulSet controller does after a scale to 0 or a template change. */
  removePod(sid: string): void {
    const id = key('Pod', objectNames(sid).pod);
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.delete(id);
    this.emit('DELETED', existing);
  }

  /** The stored object, without a recorded call. */
  object(kind: KubeKind, name: string): KubeObject | undefined {
    const object = this.store.get(key(kind, name));
    return object ? structuredClone(object) : undefined;
  }

  /** The keys of all stored objects of one session, sorted: ['ConfigMap/chromium-<sid>', …]. */
  objectsOf(sid: string): string[] {
    return [...this.store.entries()]
      .filter(([, object]) => object.metadata.labels['hydra/session-id'] === sid)
      .map(([id]) => id)
      .sort();
  }

  /** The next call of this operation fails with the error. */
  failNext(op: FakeKubeOperation, error: Error = new Error(`fake ${op} failure`)): void {
    this.failures.push({ op, error });
  }

  setLog(podName: string, container: 'neko' | 'mcp', text: string): void {
    this.logs.set(`${podName}/${container}`, text);
  }

  setPortForwardTarget(
    podName: string,
    port: number,
    target: { host: string; port: number },
  ): void {
    this.forwardTargets.set(`${podName}:${port}`, target);
  }

  private perform<T>(
    op: FakeKubeOperation,
    kind: KubeKind | undefined,
    name: string | undefined,
    run: () => T,
  ): Promise<T> {
    this.calls.push({ op, ...(kind ? { kind } : {}), ...(name ? { name } : {}) });
    const index = this.failures.findIndex((failure) => failure.op === op);
    if (index !== -1) {
      const failure = this.failures.splice(index, 1)[0];
      return Promise.reject(failure?.error ?? new Error(`fake ${op} failure`));
    }
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private podOf(sid: string): FakePod {
    const name = objectNames(sid).pod;
    const existing = this.store.get(key('Pod', name));
    if (existing) return structuredClone(existing) as FakePod;
    const statefulSet: unknown = this.store.get(key('StatefulSet', objectNames(sid).statefulSet));
    const template = (statefulSet as WithTemplate | undefined)?.spec?.template;
    const startedAt = template?.metadata?.annotations?.[STARTED_AT_ANNOTATION] ?? '0';
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: this.namespace,
        labels: sessionLabels(sid),
        annotations: { [STARTED_AT_ANNOTATION]: startedAt },
        uid: `uid-${++this.version}`,
      },
      status: { phase: 'Running', conditions: [], containerStatuses: [] },
    };
  }

  private storePod(pod: FakePod): void {
    const id = key('Pod', pod.metadata.name);
    const existed = this.store.has(id);
    pod.metadata.resourceVersion = String(++this.version);
    this.store.set(id, pod);
    this.emit(existed ? 'MODIFIED' : 'ADDED', pod);
  }

  private emit(type: KubeWatchEvent['type'], object: KubeObject): void {
    for (const handler of [...this.handlers]) {
      handler({ kind: object.kind, type, object: structuredClone(object) });
    }
  }
}
```

- [ ] **Step 4: Write the startup check**

`packages/server/src/orchestrator/media-port-check.ts`:

```ts
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { KubeClient } from './types.js';

export class MediaPortRangeError extends Error {
  readonly variable = 'HYDRA_MEDIA_PORT_RANGE';
}

/**
 * Startup check of spec section 4: the media port range must be inside the node port range of the
 * cluster. The gateway stops if the API server answers that a port is not in the valid range. Other
 * answers pass. If the API server does not answer, the check logs a warning and passes.
 */
export async function checkMediaPortRange(deps: {
  kube: KubeClient;
  config: Config;
  logger: Logger;
}): Promise<void> {
  const { first, last } = deps.config.mediaPortRange;
  const ports = first === last ? [first] : [first, last];
  let result: { outOfRange: boolean; message: string | null };
  try {
    result = await deps.kube.dryRunNodePorts(ports);
  } catch (error) {
    deps.logger.warn(
      { err: error },
      'HYDRA_MEDIA_PORT_RANGE check skipped: the Kubernetes API did not answer',
    );
    return;
  }
  if (result.outOfRange) {
    throw new MediaPortRangeError(
      `HYDRA_MEDIA_PORT_RANGE ${first}-${last} is not inside the service-node-port-range of the cluster: ${result.message ?? 'port not in the valid range'}`,
    );
  }
}
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/media-port-check.test.ts`
Expected: PASS. `Tests  4 passed (4)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 7: Pod observation and the state rules

Spec section 7.9 step 2 (rules 1 to 7) and the error transition, with Spec deviations 2 and 3.

**Files:**
- Create: `packages/server/src/orchestrator/pod-status.ts`
- Create: `packages/server/src/orchestrator/state-rules.ts`
- Test: `packages/server/src/orchestrator/pod-status.test.ts`
- Test: `packages/server/src/orchestrator/state-rules.test.ts`

**Interfaces:**
- Consumes: `KubeObject`, `STARTED_AT_ANNOTATION` (Task 1); `DesiredState`, `SessionState` (`@hydra/shared`).
- Produces:

```ts
export const ERROR_WAIT_REASONS: ReadonlySet<string>;   // CrashLoopBackOff, ErrImagePull, ImagePullBackOff, CreateContainerConfigError, InvalidImageName
export interface PodObservation { exists: boolean; current: boolean; ready: boolean; waitingError: string | null; notReadyReason: string | null }
export function observePod(pod: KubeObject | null, startedAt: number | null): PodObservation;
export const START_TIMEOUT_MS = 120_000;
export interface StateInput { state; desiredState; startedAt; readyAt; mediaPort; pod: PodObservation; allObjectsGone: boolean; now: number }
export interface StatePatch { state?; readyAt?; errorReason?; desiredState?: 'stopped'; deletedAt?; mediaPort?: null }
export interface StatePlan { rule: number; patch: StatePatch; releasePort: boolean }
export function decideState(input: StateInput): StatePlan;   // pure: the first rule that matches
```

- [ ] **Step 1: Write the failing tests**

`packages/server/src/orchestrator/pod-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { observePod } from './pod-status.js';
import type { KubeObject } from './types.js';

function pod(
  fields: {
    startedAt?: string;
    ready?: boolean;
    waiting?: string;
    terminating?: boolean;
    init?: string;
    scheduled?: boolean;
  } = {},
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'session-abcdefghij23-0',
      namespace: 'hydra-sessions',
      labels: {},
      annotations: { 'hydra/started-at': fields.startedAt ?? '1000' },
      ...(fields.terminating ? { deletionTimestamp: new Date(0) } : {}),
    },
    status: {
      conditions: [
        fields.scheduled === false
          ? {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/1 nodes are available',
            }
          : { type: 'PodScheduled', status: 'True' },
        fields.ready
          ? { type: 'Ready', status: 'True' }
          : {
              type: 'Ready',
              status: 'False',
              reason: 'ContainersNotReady',
              message: 'containers with unready status: [neko]',
            },
      ],
      initContainerStatuses: fields.init
        ? [
            {
              name: 'remove-locks',
              state: { waiting: { reason: fields.init, message: 'init waits' } },
            },
          ]
        : [],
      containerStatuses: [
        {
          name: 'neko',
          state: fields.waiting
            ? { waiting: { reason: fields.waiting, message: 'back-off 10s' } }
            : { running: {} },
        },
      ],
    },
  } as unknown as KubeObject;
}

describe('observePod', () => {
  it('reports no pod', () => {
    expect(observePod(null, 1000)).toEqual({
      exists: false,
      current: false,
      ready: false,
      waitingError: null,
      notReadyReason: null,
    });
  });

  it('reports a Ready pod of the current start', () => {
    expect(observePod(pod({ ready: true }), 1000)).toMatchObject({
      exists: true,
      current: true,
      ready: true,
      waitingError: null,
    });
  });

  it('does not count a pod of an older start as Ready', () => {
    expect(observePod(pod({ ready: true, startedAt: '999' }), 1000)).toEqual({
      exists: true,
      current: false,
      ready: false,
      waitingError: null,
      notReadyReason: null,
    });
  });

  it('does not count a terminating pod as Ready', () => {
    expect(observePod(pod({ ready: true, terminating: true }), 1000).ready).toBe(false);
  });

  it.each([
    'CrashLoopBackOff',
    'ErrImagePull',
    'ImagePullBackOff',
    'CreateContainerConfigError',
    'InvalidImageName',
  ])('reports the wait reason %s', (reason) => {
    expect(observePod(pod({ waiting: reason }), 1000).waitingError).toBe(`${reason}: back-off 10s`);
  });

  it('ignores other wait reasons', () => {
    expect(observePod(pod({ waiting: 'ContainerCreating' }), 1000).waitingError).toBeNull();
  });

  it('reports a wait reason of the init container', () => {
    expect(observePod(pod({ init: 'ImagePullBackOff' }), 1000).waitingError).toBe(
      'ImagePullBackOff: init waits',
    );
  });

  it('gives the scheduling reason first, then the Ready reason', () => {
    expect(observePod(pod({ scheduled: false }), 1000).notReadyReason).toBe(
      'Unschedulable: 0/1 nodes are available',
    );
    expect(observePod(pod({}), 1000).notReadyReason).toBe(
      'ContainersNotReady: containers with unready status: [neko]',
    );
  });

  it('matches started_at null to the annotation 0', () => {
    expect(observePod(pod({ startedAt: '0', ready: true }), null).current).toBe(true);
  });
});
```

`packages/server/src/orchestrator/state-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PodObservation } from './pod-status.js';
import { decideState, START_TIMEOUT_MS, type StateInput } from './state-rules.js';

const noPod: PodObservation = {
  exists: false,
  current: false,
  ready: false,
  waitingError: null,
  notReadyReason: null,
};
const readyPod: PodObservation = {
  exists: true,
  current: true,
  ready: true,
  waitingError: null,
  notReadyReason: null,
};
const startingPod: PodObservation = {
  exists: true,
  current: true,
  ready: false,
  waitingError: null,
  notReadyReason: 'ContainersNotReady: x',
};
const now = 1_000_000;

function input(fields: Partial<StateInput>): StateInput {
  return {
    state: 'starting',
    desiredState: 'running',
    startedAt: now - 1_000,
    readyAt: null,
    mediaPort: 52000,
    pod: noPod,
    allObjectsGone: false,
    now,
    ...fields,
  };
}

describe('decideState (spec section 7.9 step 2)', () => {
  it('rule 1: deleting while objects remain', () => {
    expect(
      decideState(input({ desiredState: 'deleted', state: 'running', pod: readyPod })),
    ).toEqual({
      rule: 1,
      patch: { state: 'deleting' },
      releasePort: false,
    });
    expect(decideState(input({ desiredState: 'deleted', state: 'deleting' })).patch).toEqual({});
  });

  it('rule 1: deleted when all objects are gone', () => {
    expect(
      decideState(input({ desiredState: 'deleted', state: 'deleting', allObjectsGone: true })),
    ).toEqual({
      rule: 1,
      patch: { state: 'deleted', deletedAt: now, mediaPort: null },
      releasePort: false,
    });
    expect(
      decideState(input({ desiredState: 'deleted', state: 'deleted', allObjectsGone: true })).patch,
    ).toEqual({});
  });

  it('rule 2: running when the pod is Ready, ready_at set once', () => {
    expect(decideState(input({ pod: readyPod }))).toEqual({
      rule: 2,
      patch: { state: 'running', readyAt: now },
      releasePort: false,
    });
    expect(decideState(input({ state: 'running', readyAt: 5, pod: readyPod })).patch).toEqual({});
  });

  it('rule 3: error for a container wait reason', () => {
    const pod: PodObservation = { ...startingPod, waitingError: 'ImagePullBackOff: pull failed' };
    expect(decideState(input({ pod }))).toEqual({
      rule: 3,
      patch: {
        state: 'error',
        errorReason: 'ImagePullBackOff: pull failed',
        desiredState: 'stopped',
      },
      releasePort: false,
    });
  });

  it('rule 3 applies also after the pod was Ready', () => {
    const pod: PodObservation = { ...startingPod, waitingError: 'CrashLoopBackOff: back-off' };
    expect(decideState(input({ state: 'running', readyAt: 5, pod })).rule).toBe(3);
  });

  it('rule 4: error 120 s after the start while ready_at is null', () => {
    const plan = decideState(input({ startedAt: now - START_TIMEOUT_MS - 1, pod: startingPod }));
    expect(plan.rule).toBe(4);
    expect(plan.patch).toEqual({
      state: 'error',
      errorReason: 'Timeout: the pod was not Ready 120 s after the start (ContainersNotReady: x)',
      desiredState: 'stopped',
    });
  });

  it('rule 4 does not apply at exactly 120 s, or when ready_at is set', () => {
    expect(decideState(input({ startedAt: now - START_TIMEOUT_MS, pod: startingPod })).rule).toBe(
      5,
    );
    expect(
      decideState(input({ startedAt: now - START_TIMEOUT_MS - 1, readyAt: 5, pod: noPod })).rule,
    ).toBe(5);
  });

  it('rule 4 names a missing pod', () => {
    const plan = decideState(input({ startedAt: now - START_TIMEOUT_MS - 1 }));
    expect(plan.patch.errorReason).toBe(
      'Timeout: the pod was not Ready 120 s after the start (no pod exists)',
    );
  });

  it('rule 5: starting, also for a pod that fails after it was Ready', () => {
    expect(decideState(input({ state: 'stopped', pod: startingPod }))).toEqual({
      rule: 5,
      patch: { state: 'starting' },
      releasePort: false,
    });
    expect(decideState(input({ state: 'running', readyAt: 5, pod: startingPod })).patch).toEqual({
      state: 'starting',
    });
  });

  it('rule 6: stopping while a pod exists', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'running', pod: readyPod })),
    ).toEqual({
      rule: 6,
      patch: { state: 'stopping' },
      releasePort: false,
    });
  });

  it('rule 6 keeps the error state', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'error', pod: startingPod })).patch,
    ).toEqual({});
  });

  it('rule 7: stopped and the media port is released', () => {
    expect(decideState(input({ desiredState: 'stopped', state: 'stopping' }))).toEqual({
      rule: 7,
      patch: { state: 'stopped', mediaPort: null },
      releasePort: true,
    });
  });

  it('rule 7 keeps the error state and releases the port', () => {
    expect(decideState(input({ desiredState: 'stopped', state: 'error' }))).toEqual({
      rule: 7,
      patch: { mediaPort: null },
      releasePort: true,
    });
  });

  it('rule 7 without a port is no change for a stopped session', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'stopped', mediaPort: null })),
    ).toEqual({
      rule: 7,
      patch: {},
      releasePort: false,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/pod-status.test.ts src/orchestrator/state-rules.test.ts`
Expected: FAIL with `Error: Cannot find module './pod-status.js'` and `Error: Cannot find module './state-rules.js'`; `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the pod observation**

`packages/server/src/orchestrator/pod-status.ts`:

```ts
import type { V1Pod, V1PodCondition } from '@kubernetes/client-node';
import { STARTED_AT_ANNOTATION } from './names.js';
import type { KubeObject } from './types.js';

/** Container wait reasons that make a session go to `error` (spec section 7.9, rule 3). */
export const ERROR_WAIT_REASONS: ReadonlySet<string> = new Set([
  'CrashLoopBackOff',
  'ErrImagePull',
  'ImagePullBackOff',
  'CreateContainerConfigError',
  'InvalidImageName',
]);

export interface PodObservation {
  /** A pod exists: also a terminating pod, or a pod of an older start (rules 6 and 7). */
  exists: boolean;
  /**
   * The pod of the current start: its `hydra/started-at` annotation equals `started_at`. Restart
   * changes the annotation, so the old pod does not count as Ready while the StatefulSet replaces it.
   */
  current: boolean;
  /** The current pod is not terminating and its Ready condition is True (rule 2). */
  ready: boolean;
  /** `<reason>: <message>` of the first container of the current pod that waits with an error reason (rule 3). */
  waitingError: string | null;
  /** `<reason>: <message>` of the first condition of the current pod that is not True (text for rule 4). */
  notReadyReason: string | null;
}

const NO_POD: PodObservation = {
  exists: false,
  current: false,
  ready: false,
  waitingError: null,
  notReadyReason: null,
};

function conditionText(condition: V1PodCondition): string {
  const reason = condition.reason ?? `${condition.type}=${condition.status}`;
  return condition.message ? `${reason}: ${condition.message}` : reason;
}

export function observePod(object: KubeObject | null, startedAt: number | null): PodObservation {
  if (!object) return NO_POD;
  const pod = object as V1Pod & KubeObject;
  const annotation = pod.metadata.annotations?.[STARTED_AT_ANNOTATION];
  const current = annotation === String(startedAt ?? 0);
  if (!current) return { ...NO_POD, exists: true };
  const terminating = Boolean(pod.metadata.deletionTimestamp);
  const conditions = pod.status?.conditions ?? [];
  const ready = !terminating && conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  let waitingError: string | null = null;
  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason && ERROR_WAIT_REASONS.has(waiting.reason)) {
      waitingError = waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
      break;
    }
  }
  const scheduled = conditions.find((c) => c.type === 'PodScheduled' && c.status !== 'True');
  const notReady = scheduled ?? conditions.find((c) => c.type === 'Ready' && c.status !== 'True');
  return {
    exists: true,
    current,
    ready,
    waitingError,
    notReadyReason: notReady ? conditionText(notReady) : null,
  };
}
```

- [ ] **Step 4: Write the state rules**

`packages/server/src/orchestrator/state-rules.ts`:

```ts
import type { DesiredState, SessionState } from '@hydra/shared';
import type { PodObservation } from './pod-status.js';

/** Rule 4 of spec section 7.9. */
export const START_TIMEOUT_MS = 120_000;

export interface StateInput {
  state: SessionState;
  desiredState: DesiredState;
  startedAt: number | null;
  readyAt: number | null;
  mediaPort: number | null;
  pod: PodObservation;
  /** desired_state = deleted only: no object of the session and no pod exists. */
  allObjectsGone: boolean;
  now: number;
}

export interface StatePatch {
  state?: SessionState;
  readyAt?: number;
  errorReason?: string;
  desiredState?: 'stopped';
  deletedAt?: number;
  mediaPort?: null;
}

export interface StatePlan {
  /** The rule of spec section 7.9 step 2 that matched (1 to 7). */
  rule: number;
  /** The fields to write. An empty object: no change. */
  patch: StatePatch;
  /** Rule 7: delete media-<sid> first, then write mediaPort = null (spec section 7.8). */
  releasePort: boolean;
}

function error(rule: number, reason: string): StatePlan {
  return {
    rule,
    patch: { state: 'error', errorReason: reason, desiredState: 'stopped' },
    releasePort: false,
  };
}

/** Step 2 of spec section 7.9: the first rule that matches. Pure, so the tests cover each rule. */
export function decideState(input: StateInput): StatePlan {
  const { state, pod, now } = input;
  if (input.desiredState === 'deleted') {
    if (state === 'deleted') return { rule: 1, patch: {}, releasePort: false };
    if (!input.allObjectsGone)
      return {
        rule: 1,
        patch: state === 'deleting' ? {} : { state: 'deleting' },
        releasePort: false,
      };
    return {
      rule: 1,
      patch: { state: 'deleted', deletedAt: now, mediaPort: null },
      releasePort: false,
    };
  }
  if (input.desiredState === 'running') {
    if (pod.ready) {
      const patch: StatePatch = {};
      if (state !== 'running') patch.state = 'running';
      if (input.readyAt === null) patch.readyAt = now;
      return { rule: 2, patch, releasePort: false };
    }
    if (pod.waitingError) return error(3, pod.waitingError);
    if (
      input.readyAt === null &&
      input.startedAt !== null &&
      now - input.startedAt > START_TIMEOUT_MS
    ) {
      const detail = pod.notReadyReason ?? (pod.exists ? 'the pod is not Ready' : 'no pod exists');
      return error(
        4,
        `Timeout: the pod was not Ready ${START_TIMEOUT_MS / 1000} s after the start (${detail})`,
      );
    }
    return {
      rule: 5,
      patch: state === 'starting' ? {} : { state: 'starting' },
      releasePort: false,
    };
  }
  // desired_state = stopped. An `error` state stays until the next Start (see plan 04 "Spec deviations").
  if (pod.exists) {
    return {
      rule: 6,
      patch: state === 'stopping' || state === 'error' ? {} : { state: 'stopping' },
      releasePort: false,
    };
  }
  const patch: StatePatch = {};
  if (state !== 'stopped' && state !== 'error') patch.state = 'stopped';
  if (input.mediaPort !== null) patch.mediaPort = null;
  return { rule: 7, patch, releasePort: input.mediaPort !== null };
}
```

- [ ] **Step 5: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/pod-status.test.ts src/orchestrator/state-rules.test.ts`
Expected: PASS. `Test Files  2 passed (2)`, `Tests  27 passed (27)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 8: Reconciler

Spec sections 7.8 (release order), 7.9 (step 1, step 2, error, effects of a state change, backoff, orphans, triggers), 14 (reconciler after a gateway restart); index 5.10 (`Reconciler`).

**Files:**
- Create: `packages/server/src/orchestrator/reconciler.ts`
- Test: `packages/server/src/orchestrator/reconciler.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 6, 7; `Db`, `sessions`, `SessionRow` (`src/db/index.ts`, `src/db/schema.ts`, plan 02); `AuditWriter` (`src/audit/index.ts`), `EventBus` (`src/events/index.ts`), `Clock`, `Logger`, `Config`, `Subkeys`, `newSid` (plan 02); `createTestApp`, `seedUser` (`test/helpers/app.ts`, `test/helpers/seed.ts`, plan 03), `FakeClock` (plan 02). In this task `createTestApp` is still the plan 03 version: the test builds its own `Reconciler` from `deps` and a `FakeKubeClient`.
- Produces (index 5.10, plus helpers):

```ts
export const RECONCILE_INTERVAL_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;
export function backoffDelayMs(failures: number): number;   // 1 s, 2 s, 4 s, … 5 min
export interface ReconcilerDeps { db: Db; kube: KubeClient; config: Config; subkeys: Subkeys; clock: Clock; logger: Logger; audit: AuditWriter; bus: EventBus }
export function toApplyObject(object: KubeObject): KubeObject;
export class Reconciler {
  constructor(deps: ReconcilerDeps);
  start(): Promise<void>;                      // first pass (all sessions that are not deleted, and the orphans), then the watch, then every 30 s
  stop(): Promise<void>;
  trigger(sessionId: string): void;            // a pass soon; ignores the backoff; no effect before start()
  reconcileSession(sessionId: string): Promise<void>;   // one pass; throws if a Kubernetes call fails
  backoff(sessionId: string): { failures: number; retryAt: number } | null;   // tests and diagnostics
  idle(): Promise<void>;                       // resolves when the queue is empty
}
```

How one pass works:
- **Step 1:** `desired_state = deleted` removes the six objects of `sessionObjectRefs` (never the pod). Else it applies the objects of `buildSessionObjects` and removes `media-<sid>` while `media_port` is null.
- **Step 2:** it reads the pod, checks "all objects gone" only for `desired_state = deleted`, and calls `decideState`. For rule 7 it deletes `media-<sid>` first and writes `media_port = NULL` after (spec section 7.8).
- **Write:** one `UPDATE … WHERE` that also compares `state`, `desired_state`, `started_at`, and `media_port` with the row that the pass read. If a user action changed the row during the pass, nothing is written, and a new pass is queued (Review Focus item 4).
- **State change:** the audit event `session.state` (actor `system`, data `{ state, previous, errorReason }`), then the bus event `session.state`.
- **Scheduling:** one queue, one pass at a time, a per-session lock. A failed pass logs `reconcile failed` with `retryInMs` and retries after `backoffDelayMs`; watch events and the 30 s interval skip a session during its backoff; `trigger()` (API actions) does not wait.
- **Orphans:** objects with the managed-by label and a `hydra/session-id` without a session row: the StatefulSet is scaled to 0 (apply of the read object with `replicas: 0`), `media-<sid>` is deleted, one warning per `sid` is logged, and the PVC, the Secret, the ConfigMap, and the headless Service stay. A row with state `deleted` that still has objects gets a normal pass (it deletes them).

- [ ] **Step 1: Write the failing test**

`packages/server/src/orchestrator/reconciler.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../app.js';
import { newSid } from '../crypto/index.js';
import { auditEvents, sessions } from '../db/schema.js';
import type { HydraEvent } from '../events/index.js';
import { createTestApp } from '../../test/helpers/app.js';
import type { FakeClock } from '../../test/helpers/clock.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { seedUser } from '../../test/helpers/seed.js';
import { buildSessionObjects } from './manifests/index.js';
import { backoffDelayMs, BACKOFF_MAX_MS, Reconciler, RECONCILE_INTERVAL_MS } from './reconciler.js';
import { START_TIMEOUT_MS } from './state-rules.js';
import type { KubeObject } from './types.js';

let kube: FakeKubeClient;
let deps: AppDeps;
let clock: FakeClock;
let close: () => Promise<void>;
let ownerId: string;
let reconciler: Reconciler;

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp();
  ({ deps, clock } = testApp);
  ownerId = (await seedUser(deps)).user.id;
  reconciler = new Reconciler({ ...deps, kube });
  close = async () => {
    await reconciler.stop();
    await testApp.close();
  };
});

afterEach(async () => {
  vi.useRealTimers();
  await close();
});

type SessionInsert = typeof sessions.$inferInsert;

/** A session row as Start leaves it (spec section 7.9), with field overrides. */
function insertSession(fields: Partial<SessionInsert> = {}): string {
  const now = clock.now();
  const id = fields.id ?? newSid();
  const settings = {
    allowlist: ['example.com'],
    timezone: 'UTC',
    language: 'en-US',
    screen: '1920x1080' as const,
  };
  deps.db
    .insert(sessions)
    .values({
      id,
      name: 'Research',
      ownerId,
      desiredState: 'running',
      state: 'stopped',
      errorReason: null,
      mediaPort: 52000,
      allowlist: settings.allowlist,
      timezone: settings.timezone,
      language: settings.language,
      screen: settings.screen,
      appliedSettings: settings,
      startedAt: now,
      readyAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...fields,
    })
    .run();
  return id;
}

const rowOf = (sid: string) => deps.db.select().from(sessions).where(eq(sessions.id, sid)).get()!;
const update = (sid: string, fields: Partial<SessionInsert>) =>
  deps.db.update(sessions).set(fields).where(eq(sessions.id, sid)).run();
const pass = (sid: string) => reconciler.reconcileSession(sid);
const replicasOf = (sid: string) =>
  (kube.object('StatefulSet', `session-${sid}`) as KubeObject & { spec: { replicas: number } }).spec
    .replicas;

function objectKeys(sid: string, withMedia: boolean): string[] {
  return [
    `ConfigMap/chromium-${sid}`,
    `PersistentVolumeClaim/profile-${sid}`,
    `Secret/neko-${sid}`,
    ...(withMedia ? [`Service/media-${sid}`] : []),
    `Service/session-${sid}`,
    `StatefulSet/session-${sid}`,
  ];
}

describe('backoffDelayMs', () => {
  it('doubles from 1 s up to 5 min', () => {
    expect([1, 2, 3, 4, 9, 10, 30].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 256000, 300000, 300000,
    ]);
    expect(BACKOFF_MAX_MS).toBe(300000);
  });
});

describe('Reconciler.reconcileSession', () => {
  it('creates the objects of a started session and reaches running when the pod is Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, true));
    expect(replicasOf(sid)).toBe(1);
    expect(rowOf(sid).state).toBe('starting');

    clock.advance(5_000);
    kube.setPodReady(sid, true);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'running', readyAt: clock.now() });
  });

  it('creates objects with 0 replicas and no media Service for a stopped session', async () => {
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    await pass(sid);
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, false));
    expect(replicasOf(sid)).toBe(0);
    expect(rowOf(sid).state).toBe('stopped');
  });

  it('writes the audit event session.state and publishes session.state for each change', async () => {
    const events: HydraEvent[] = [];
    deps.bus.subscribe('session.state', (event) => events.push(event));
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    await pass(sid);
    expect(events).toEqual([
      {
        type: 'session.state',
        sessionId: sid,
        state: 'starting',
        previous: 'stopped',
        errorReason: null,
      },
      {
        type: 'session.state',
        sessionId: sid,
        state: 'running',
        previous: 'starting',
        errorReason: null,
      },
    ]);
    const audits = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'session.state'))
      .all();
    expect(audits.map((a) => [a.actorType, a.actorId, a.sessionId, a.data])).toEqual([
      ['system', null, sid, { state: 'starting', previous: 'stopped', errorReason: null }],
      ['system', null, sid, { state: 'running', previous: 'starting', errorReason: null }],
    ]);
  });

  it('repairs a missing object and a changed object', async () => {
    const sid = insertSession();
    await pass(sid);
    await kube.remove('ConfigMap', `chromium-${sid}`);
    const changed = kube.object('StatefulSet', `session-${sid}`) as KubeObject & {
      spec: { replicas: number };
    };
    changed.spec.replicas = 3;
    await kube.apply(changed);
    await pass(sid);
    expect(kube.object('ConfigMap', `chromium-${sid}`)).toBeDefined();
    expect(replicasOf(sid)).toBe(1);
  });

  it('deletes the media Service while media_port is null', async () => {
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    const withPort = { ...rowOf(sid), mediaPort: 52009 };
    for (const object of buildSessionObjects(withPort, deps)) await kube.apply(object);
    await pass(sid);
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
  });

  it('goes to error for a container wait reason, then releases the port when the pod is gone', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setContainerWaiting(sid, 'ImagePullBackOff', 'Back-off pulling image "x"');
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      errorReason: 'ImagePullBackOff: Back-off pulling image "x"',
      desiredState: 'stopped',
      mediaPort: 52000,
    });

    await pass(sid);
    expect(replicasOf(sid)).toBe(0);
    expect(rowOf(sid).state).toBe('error');

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'error', mediaPort: null });
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
  });

  it('goes to error 120 s after the start while the pod is not Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, false);
    clock.advance(START_TIMEOUT_MS);
    await pass(sid);
    expect(rowOf(sid).state).toBe('starting');
    clock.advance(1);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      desiredState: 'stopped',
      errorReason:
        'Timeout: the pod was not Ready 120 s after the start (ContainersNotReady: containers with unready status: [neko])',
    });
  });

  it('does not use the 120 s rule after the pod was Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    kube.setPodReady(sid, false);
    clock.advance(START_TIMEOUT_MS * 2);
    await pass(sid);
    expect(rowOf(sid).state).toBe('starting');
  });

  it('stops: stopping while the pod exists, then stopped, and the media Service goes first', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    update(sid, { desiredState: 'stopped' });
    await pass(sid);
    expect(rowOf(sid).state).toBe('stopping');
    expect(replicasOf(sid)).toBe(0);

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'stopped', mediaPort: null });
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
  });

  it('keeps media_port when the media Service cannot be deleted', async () => {
    const sid = insertSession();
    await pass(sid);
    update(sid, { desiredState: 'stopped' });
    const realRemove = kube.remove.bind(kube);
    vi.spyOn(kube, 'remove').mockImplementation((kind, name) =>
      name === `media-${sid}`
        ? Promise.reject(new Error('API server unavailable'))
        : realRemove(kind, name),
    );
    await expect(pass(sid)).rejects.toThrow('API server unavailable');
    expect(rowOf(sid).mediaPort).toBe(52000);
  });

  it('deletes: deleting while objects remain, deleted when all are gone', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    update(sid, { desiredState: 'deleted' });
    await pass(sid);
    expect(rowOf(sid).state).toBe('deleting');
    expect(kube.objectsOf(sid)).toEqual([`Pod/session-${sid}-0`]);

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'deleted', deletedAt: clock.now(), mediaPort: null });
  });

  it('does not count the old pod as Ready after a restart', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    clock.advance(1_000);
    update(sid, { startedAt: clock.now(), readyAt: null });
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'starting', readyAt: null });

    kube.removePod(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'running', readyAt: clock.now() });
  });

  it('uses the 120 s rule for the new pod after a restart', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    clock.advance(1_000);
    update(sid, { startedAt: clock.now(), readyAt: null });
    await pass(sid);
    clock.advance(START_TIMEOUT_MS + 1);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'error', desiredState: 'stopped' });
    expect(rowOf(sid).errorReason).toMatch(/^Timeout: the pod was not Ready 120 s after the start/);
  });

  it('does not write a decision when the row changed during the pass', async () => {
    const sid = insertSession();
    await pass(sid);
    clock.advance(START_TIMEOUT_MS + 1);
    const realGet = kube.get.bind(kube);
    vi.spyOn(kube, 'get').mockImplementation(async (kind, name) => {
      const result = await realGet(kind, name);
      // A Restart arrives while the pass waits for Kubernetes.
      if (kind === 'Pod') update(sid, { startedAt: clock.now() });
      return result;
    });
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'starting',
      desiredState: 'running',
      errorReason: null,
    });
  });

  it('scales an orphan StatefulSet to 0 and deletes its media Service, but keeps the PVC and the Secret', async () => {
    const warn = vi.spyOn(deps.logger, 'warn');
    const orphan = { ...rowOf(insertSession()), id: 'orphanorphan' };
    for (const object of buildSessionObjects(orphan, deps)) await kube.apply(object);
    await pass(orphan.id);
    expect(replicasOf(orphan.id)).toBe(0);
    expect(kube.object('Service', 'media-orphanorphan')).toBeUndefined();
    expect(kube.object('PersistentVolumeClaim', 'profile-orphanorphan')).toBeDefined();
    expect(kube.object('Secret', 'neko-orphanorphan')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      { sessionId: 'orphanorphan' },
      expect.stringContaining('orphan'),
    );
  });
});

describe('Reconciler scheduling', () => {
  it('start() runs the first pass over all sessions and the orphans', async () => {
    const sid = insertSession();
    const orphan = { ...rowOf(sid), id: 'orphanorphan' };
    for (const object of buildSessionObjects(orphan, deps)) await kube.apply(object);
    await reconciler.start();
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, true));
    expect(replicasOf('orphanorphan')).toBe(0);
  });

  it('runs a pass after trigger() and after a watch event', async () => {
    await reconciler.start();
    const sid = insertSession();
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(rowOf(sid).state).toBe('starting');
    kube.setPodReady(sid, true);
    await reconciler.idle();
    expect(rowOf(sid).state).toBe('running');
  });

  it('does nothing on trigger() before start()', async () => {
    const sid = insertSession();
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(kube.objectsOf(sid)).toEqual([]);
  });

  it('backs off after a failed pass and logs the error', async () => {
    const error = vi.spyOn(deps.logger, 'error');
    await reconciler.start();
    const sid = insertSession();
    kube.failNext('apply');
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toEqual({ failures: 1, retryAt: clock.now() + 1000 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: sid, retryInMs: 1000 }),
      'reconcile failed',
    );
    expect(kube.objectsOf(sid)).toEqual([]);

    // A watch event does not run a pass during the backoff.
    kube.setPodReady(sid, false);
    await reconciler.idle();
    expect(kube.objectsOf(sid)).toEqual([`Pod/session-${sid}-0`]);

    // An API action runs a pass at once. A second failure doubles the delay.
    kube.failNext('apply');
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toEqual({ failures: 2, retryAt: clock.now() + 2000 });

    // A good pass ends the backoff.
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toBeNull();
    expect(kube.objectsOf(sid)).toEqual([...objectKeys(sid, true), `Pod/session-${sid}-0`].sort());
  });

  it('runs a pass every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    await reconciler.start();
    const spy = vi.spyOn(reconciler, 'reconcileSession');
    vi.advanceTimersByTime(RECONCILE_INTERVAL_MS - 1);
    await reconciler.idle();
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await reconciler.idle();
    expect(spy).toHaveBeenCalledWith(sid);
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/reconciler.test.ts`
Expected: FAIL with `Error: Cannot find module './reconciler.js' imported from …/src/orchestrator/reconciler.test.ts`.

- [ ] **Step 3: Write the reconciler**

`packages/server/src/orchestrator/reconciler.ts`:

```ts
import { and, eq, isNull, ne, type SQL } from 'drizzle-orm';
import type { V1StatefulSet } from '@kubernetes/client-node';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AuditWriter } from '../audit/index.js';
import type { Config } from '../config/index.js';
import type { Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { sessions, type SessionRow } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import { buildSessionObjects } from './manifests/index.js';
import { MANAGED_BY_SELECTOR, objectNames, SESSION_ID_LABEL, sessionObjectRefs } from './names.js';
import { observePod } from './pod-status.js';
import { desiredStateOf, stateOf } from './row-fields.js';
import { decideState, type StatePlan } from './state-rules.js';
import type { KubeClient, KubeKind, KubeObject, KubeWatchEvent } from './types.js';

export const RECONCILE_INTERVAL_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;

/** 1 s, 2 s, 4 s, … up to 5 min (spec section 7.9). */
export function backoffDelayMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export interface ReconcilerDeps {
  db: Db;
  kube: KubeClient;
  config: Config;
  subkeys: Subkeys;
  clock: Clock;
  logger: Logger;
  audit: AuditWriter;
  bus: EventBus;
}

/** Kinds that the orphan pass lists (spec section 7.9 "Orphans"). Pods belong to their StatefulSet. */
const ORPHAN_KINDS: readonly KubeKind[] = [
  'StatefulSet',
  'Service',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
];

function sameOrNull(column: SQLiteColumn, value: number | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/** An apply object made from an object that the API returned: no status and no server metadata. */
export function toApplyObject(object: KubeObject): KubeObject {
  const spec = (object as { spec?: unknown }).spec;
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    metadata: {
      name: object.metadata.name,
      namespace: object.metadata.namespace,
      labels: object.metadata.labels,
    },
    ...(spec === undefined ? {} : { spec }),
  };
}

export class Reconciler {
  private readonly deps: ReconcilerDeps;
  private started = false;
  private readonly queue = new Set<string>();
  private orphanPassQueued = false;
  private draining: Promise<void> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopWatch: (() => void) | null = null;
  private readonly failures = new Map<
    string,
    { count: number; retryAt: number; timer: NodeJS.Timeout }
  >();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly warnedOrphans = new Set<string>();

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
  }

  /** First pass over all sessions and orphans, then the watch, then a pass every 30 s. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.enqueueAll();
    this.kick();
    await this.idle();
    await this.startWatch();
    this.interval = setInterval(() => {
      if (!this.stopWatch) void this.startWatch();
      this.enqueueAll();
      this.kick();
    }, RECONCILE_INTERVAL_MS);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.stopWatch?.();
    this.stopWatch = null;
    for (const failure of this.failures.values()) clearTimeout(failure.timer);
    this.failures.clear();
    this.queue.clear();
    this.orphanPassQueued = false;
    await this.idle();
  }

  /** A pass for one session soon (after an API action). Ignores the backoff. No effect before start(). */
  trigger(sessionId: string): void {
    if (!this.started) return;
    this.queue.add(sessionId);
    this.kick();
  }

  /** One pass for one session (spec section 7.9, steps 1 and 2). Throws if a Kubernetes call fails. */
  async reconcileSession(sessionId: string): Promise<void> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.pass(sessionId));
    this.locks.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }

  /** The backoff state of a session, or null (tests and diagnostics). */
  backoff(sessionId: string): { failures: number; retryAt: number } | null {
    const failure = this.failures.get(sessionId);
    return failure ? { failures: failure.count, retryAt: failure.retryAt } : null;
  }

  /** Resolves when the queue is empty. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async startWatch(): Promise<void> {
    try {
      this.stopWatch = await this.deps.kube.watch((event) => this.onWatchEvent(event));
      if (!this.started) {
        this.stopWatch();
        this.stopWatch = null;
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'kubernetes watch failed to start');
    }
  }

  private onWatchEvent(event: KubeWatchEvent): void {
    const sessionId = event.object.metadata.labels[SESSION_ID_LABEL];
    if (!sessionId) return;
    this.enqueue(sessionId);
    this.kick();
  }

  private enqueue(sessionId: string): void {
    const failure = this.failures.get(sessionId);
    if (failure && failure.retryAt > this.deps.clock.now()) return;
    this.queue.add(sessionId);
  }

  private enqueueAll(): void {
    const rows = this.deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(ne(sessions.state, 'deleted'))
      .all();
    for (const row of rows) this.enqueue(row.id);
    this.orphanPassQueued = true;
  }

  private kick(): void {
    if (!this.started || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.started && (this.queue.size > 0 || this.orphanPassQueued)) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.started) {
      if (this.orphanPassQueued) {
        this.orphanPassQueued = false;
        await this.runOrphanPass();
        continue;
      }
      const next = this.queue.values().next();
      if (next.done) return;
      this.queue.delete(next.value);
      await this.runSession(next.value);
    }
  }

  private async runSession(sessionId: string): Promise<void> {
    try {
      await this.reconcileSession(sessionId);
      const failure = this.failures.get(sessionId);
      if (failure) clearTimeout(failure.timer);
      this.failures.delete(sessionId);
    } catch (error) {
      const count = (this.failures.get(sessionId)?.count ?? 0) + 1;
      const delayMs = backoffDelayMs(count);
      const previous = this.failures.get(sessionId);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        if (!this.started) return;
        this.queue.add(sessionId);
        this.kick();
      }, delayMs);
      timer.unref();
      this.failures.set(sessionId, { count, retryAt: this.deps.clock.now() + delayMs, timer });
      this.deps.logger.error({ err: error, sessionId, retryInMs: delayMs }, 'reconcile failed');
    }
  }

  private loadRow(sessionId: string): SessionRow | undefined {
    return this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  }

  private async pass(sessionId: string): Promise<void> {
    const row = this.loadRow(sessionId);
    if (!row) {
      await this.handleOrphan(sessionId);
      return;
    }
    const { kube } = this.deps;
    const names = objectNames(sessionId);
    const desiredState = desiredStateOf(row);

    // Step 1: objects.
    if (desiredState === 'deleted') {
      for (const ref of sessionObjectRefs(sessionId)) await kube.remove(ref.kind, ref.name);
    } else {
      for (const object of buildSessionObjects(row, this.deps)) await kube.apply(object);
      if (row.mediaPort === null) await kube.remove('Service', names.mediaService);
    }

    // Step 2: state.
    const pod = await kube.get('Pod', names.pod);
    let allObjectsGone = false;
    if (desiredState === 'deleted' && pod === null) {
      allObjectsGone = true;
      for (const ref of sessionObjectRefs(sessionId)) {
        if ((await kube.get(ref.kind, ref.name)) !== null) {
          allObjectsGone = false;
          break;
        }
      }
    }
    const plan = decideState({
      state: stateOf(row),
      desiredState,
      startedAt: row.startedAt,
      readyAt: row.readyAt,
      mediaPort: row.mediaPort,
      pod: observePod(pod, row.startedAt),
      allObjectsGone,
      now: this.deps.clock.now(),
    });
    // Release order of spec section 7.8: the Service first, then media_port = NULL.
    if (plan.releasePort) await kube.remove('Service', names.mediaService);
    this.write(row, plan);
  }

  /** Writes the plan only if the row did not change during the pass. Else the next pass decides again. */
  private write(row: SessionRow, plan: StatePlan): void {
    if (Object.keys(plan.patch).length === 0) return;
    const result = this.deps.db
      .update(sessions)
      .set({ ...plan.patch, updatedAt: this.deps.clock.now() })
      .where(
        and(
          eq(sessions.id, row.id),
          eq(sessions.state, row.state),
          eq(sessions.desiredState, row.desiredState),
          sameOrNull(sessions.startedAt, row.startedAt),
          sameOrNull(sessions.mediaPort, row.mediaPort),
        ),
      )
      .run();
    if (result.changes === 0) {
      this.trigger(row.id);
      return;
    }
    const previous = stateOf(row);
    const state = plan.patch.state;
    if (state === undefined || state === previous) return;
    const errorReason = plan.patch.errorReason ?? (state === 'error' ? row.errorReason : null);
    this.deps.audit.write({
      kind: 'session.state',
      actorType: 'system',
      actorId: null,
      sessionId: row.id,
      data: { state, previous, errorReason },
    });
    this.deps.bus.publish({
      type: 'session.state',
      sessionId: row.id,
      state,
      previous,
      errorReason,
    });
  }

  private async runOrphanPass(): Promise<void> {
    try {
      const rows = this.deps.db
        .select({ id: sessions.id, state: sessions.state })
        .from(sessions)
        .all();
      const known = new Map(rows.map((row) => [row.id, row.state]));
      const orphans = new Set<string>();
      for (const kind of ORPHAN_KINDS) {
        for (const object of await this.deps.kube.list(kind, MANAGED_BY_SELECTOR)) {
          const sessionId = object.metadata.labels[SESSION_ID_LABEL];
          if (!sessionId) continue;
          const state = known.get(sessionId);
          if (state === undefined) orphans.add(sessionId);
          else if (state === 'deleted') this.queue.add(sessionId);
        }
      }
      for (const sessionId of orphans) await this.handleOrphan(sessionId);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'orphan pass failed');
    }
  }

  /**
   * Objects without a session row, for example after a restore of an older DB backup. Never delete
   * the PVC or the Secret: scale the StatefulSet to 0, delete media-<sid> (it holds a node port), and
   * log a warning. The operator removes the other objects by hand.
   */
  private async handleOrphan(sessionId: string): Promise<void> {
    const names = objectNames(sessionId);
    const statefulSet = await this.deps.kube.get('StatefulSet', names.statefulSet);
    if (statefulSet && (statefulSet as V1StatefulSet).spec?.replicas !== 0) {
      const object = toApplyObject(statefulSet) as KubeObject & { spec: Record<string, unknown> };
      await this.deps.kube.apply({
        ...object,
        spec: { ...object.spec, replicas: 0 },
      } as KubeObject);
    }
    await this.deps.kube.remove('Service', names.mediaService);
    if (!this.warnedOrphans.has(sessionId)) {
      this.warnedOrphans.add(sessionId);
      this.deps.logger.warn(
        { sessionId },
        'orphan session objects without a session row: StatefulSet scaled to 0, media Service deleted; remove the other objects with kubectl delete',
      );
    }
  }
}
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/reconciler.test.ts`
Expected: PASS. `Tests  21 passed (21)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 9: Pod endpoints (cluster-dns and port-forward) and the module exports

Spec sections 7.3 (`podEndpoint`), 8.2 step 5, 11.7; index 5.10 (`PodEndpointResolver`, `createPodEndpointResolver`).

**Files:**
- Create: `packages/server/src/orchestrator/pod-endpoint.ts`
- Create: `packages/server/src/orchestrator/index.ts`
- Test: `packages/server/src/orchestrator/pod-endpoint.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5 to 8; `Config`, `Logger`, `createLogger` (plan 02).
- Produces (plans 05 and 06 call `deps.podEndpoints.endpoint(sid, 8931)` and `endpoint(sid, 8080)`):

```ts
export interface PodEndpointResolver { endpoint(sessionId: string, port: 8080 | 8931): Promise<string>; close(): Promise<void> }   // 'http://host:port'
export function clusterDnsEndpoint(namespace: string, sessionId: string, port: number): string;
export function createPodEndpointResolver(config: Config, kube: KubeClient, logger: Logger): PodEndpointResolver;
// src/orchestrator/index.ts re-exports the public names of the module.
```

`cluster-dns` gives `http://session-<sid>-0.session-<sid>.<namespace>.svc.cluster.local:<port>`. `port-forward` keeps one forward for each pod with one local listener (`127.0.0.1`, random port) for each pod port; each TCP connection opens one tunnel through `kube.portForward`. A watch on the pods closes the listeners and their connections when the pod is deleted or replaced (new `uid`). If the pod does not exist, `endpoint()` throws `pod session-<sid>-0 does not exist`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/orchestrator/pod-endpoint.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { testConfig } from '../../test/helpers/config.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { createPodEndpointResolver, type PodEndpointResolver } from './pod-endpoint.js';

const logger = createLogger('fatal');

describe('createPodEndpointResolver with cluster-dns', () => {
  it('gives the pod DNS name of spec section 7.3', async () => {
    const resolver = createPodEndpointResolver(testConfig(), new FakeKubeClient(), logger);
    await expect(resolver.endpoint('abcdefghij23', 8931)).resolves.toBe(
      'http://session-abcdefghij23-0.session-abcdefghij23.hydra-sessions.svc.cluster.local:8931',
    );
    await resolver.close();
  });
});

describe('createPodEndpointResolver with port-forward', () => {
  let target: Server;
  let targetPort: number;
  let kube: FakeKubeClient;
  let resolver: PodEndpointResolver;

  beforeEach(async () => {
    target = createServer((request, response) => response.end(`pong ${request.url}`));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as AddressInfo).port;
    kube = new FakeKubeClient();
    resolver = createPodEndpointResolver(
      testConfig({ sessionTransport: 'port-forward' }),
      kube,
      logger,
    );
  });

  afterEach(async () => {
    await resolver.close();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('opens one local listener for each pod port and forwards through the Kubernetes API', async () => {
    kube.setPodReady('abcdefghij23', true);
    kube.setPortForwardTarget('session-abcdefghij23-0', 8080, {
      host: '127.0.0.1',
      port: targetPort,
    });
    const url = await resolver.endpoint('abcdefghij23', 8080);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(resolver.endpoint('abcdefghij23', 8080)).resolves.toBe(url);
    const response = await fetch(`${url}/health`);
    expect(await response.text()).toBe('pong /health');
    expect(kube.calls.filter((c) => c.op === 'portForward')).toEqual([
      { op: 'portForward', kind: 'Pod', name: 'session-abcdefghij23-0' },
    ]);
  });

  it('closes the listener when the pod goes away', async () => {
    kube.setPodReady('abcdefghij23', true);
    kube.setPortForwardTarget('session-abcdefghij23-0', 8080, {
      host: '127.0.0.1',
      port: targetPort,
    });
    const url = await resolver.endpoint('abcdefghij23', 8080);
    kube.removePod('abcdefghij23');
    await expect
      .poll(() =>
        fetch(`${url}/health`).then(
          () => 'open',
          () => 'closed',
        ),
      )
      .toBe('closed');
  });

  it('fails when the pod does not exist', async () => {
    await expect(resolver.endpoint('abcdefghij23', 8931)).rejects.toThrow(
      'pod session-abcdefghij23-0 does not exist',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/pod-endpoint.test.ts`
Expected: FAIL with `Error: Cannot find module './pod-endpoint.js' imported from …/src/orchestrator/pod-endpoint.test.ts`.

- [ ] **Step 3: Write the resolver**

`packages/server/src/orchestrator/pod-endpoint.ts`:

```ts
import { createServer, type Server, type Socket } from 'node:net';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import { objectNames, SESSION_ID_LABEL } from './names.js';
import type { KubeClient, KubeWatchEvent } from './types.js';

export interface PodEndpointResolver {
  /** 'http://host:port' of one port of the session pod (spec section 7.3). */
  endpoint(sessionId: string, port: 8080 | 8931): Promise<string>;
  close(): Promise<void>;
}

/** HYDRA_SESSION_TRANSPORT=cluster-dns: the pod DNS name through the headless Service. */
export function clusterDnsEndpoint(namespace: string, sessionId: string, port: number): string {
  const names = objectNames(sessionId);
  return `http://${names.pod}.${names.headlessService}.${namespace}.svc.cluster.local:${port}`;
}

interface Listener {
  server: Server;
  sockets: Set<Socket>;
  url: string;
}

interface Forward {
  podUid: string;
  listeners: Map<number, Promise<Listener>>;
}

/**
 * HYDRA_SESSION_TRANSPORT=port-forward (spec sections 7.3 and 11.7): one port-forward for each pod, with
 * a local listener for each pod port. Each TCP connection opens one tunnel through the API server
 * (client-node supports one port per tunnel). When the pod goes away, the listeners close.
 */
class PortForwardResolver implements PodEndpointResolver {
  private readonly kube: KubeClient;
  private readonly logger: Logger;
  private readonly forwards = new Map<string, Forward>();
  private watchStarted: Promise<void> | null = null;
  private stopWatch: (() => void) | null = null;
  private closed = false;

  constructor(kube: KubeClient, logger: Logger) {
    this.kube = kube;
    this.logger = logger;
  }

  async endpoint(sessionId: string, port: 8080 | 8931): Promise<string> {
    if (this.closed) throw new Error('pod endpoint resolver is closed');
    await this.ensureWatch();
    let forward = this.forwards.get(sessionId);
    if (!forward) {
      const pod = await this.kube.get('Pod', objectNames(sessionId).pod);
      if (!pod) throw new Error(`pod ${objectNames(sessionId).pod} does not exist`);
      forward = this.forwards.get(sessionId) ?? {
        podUid: pod.metadata.uid ?? '',
        listeners: new Map(),
      };
      this.forwards.set(sessionId, forward);
    }
    let listener = forward.listeners.get(port);
    if (!listener) {
      listener = this.listen(sessionId, port);
      forward.listeners.set(port, listener);
    }
    return (await listener).url;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatch?.();
    this.stopWatch = null;
    await Promise.all([...this.forwards.keys()].map((sessionId) => this.closeForward(sessionId)));
  }

  private ensureWatch(): Promise<void> {
    this.watchStarted ??= this.kube
      .watch((event) => this.onWatchEvent(event))
      .then((stop) => {
        if (this.closed) stop();
        else this.stopWatch = stop;
      });
    return this.watchStarted;
  }

  private onWatchEvent(event: KubeWatchEvent): void {
    if (event.kind !== 'Pod') return;
    const sessionId = event.object.metadata.labels[SESSION_ID_LABEL];
    if (!sessionId) return;
    const forward = this.forwards.get(sessionId);
    if (!forward) return;
    const uid = event.object.metadata.uid ?? '';
    if (
      event.type === 'DELETED' ||
      (uid !== '' && forward.podUid !== '' && uid !== forward.podUid)
    ) {
      void this.closeForward(sessionId);
    }
  }

  private listen(sessionId: string, port: number): Promise<Listener> {
    const podName = objectNames(sessionId).pod;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      this.kube.portForward(podName, port, socket).catch((error: unknown) => {
        this.logger.warn({ err: error, sessionId, port }, 'port-forward failed');
        socket.destroy();
      });
    });
    return new Promise<Listener>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('port-forward listener has no address'));
          return;
        }
        resolve({ server, sockets, url: `http://127.0.0.1:${address.port}` });
      });
    });
  }

  private async closeForward(sessionId: string): Promise<void> {
    const forward = this.forwards.get(sessionId);
    if (!forward) return;
    this.forwards.delete(sessionId);
    for (const pending of forward.listeners.values()) {
      const listener = await pending.catch(() => null);
      if (!listener) continue;
      for (const socket of listener.sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
    }
  }
}

export function createPodEndpointResolver(
  config: Config,
  kube: KubeClient,
  logger: Logger,
): PodEndpointResolver {
  if (config.sessionTransport === 'port-forward') return new PortForwardResolver(kube, logger);
  const namespace = config.sessionNamespace;
  return {
    endpoint: (sessionId, port) => Promise.resolve(clusterDnsEndpoint(namespace, sessionId, port)),
    close: () => Promise.resolve(),
  };
}
```

- [ ] **Step 4: Write the module exports**

`packages/server/src/orchestrator/index.ts`:

```ts
export { createKubeClient, loadKubeConfig, WATCHED_KINDS } from './kube-client.js';
export { buildSessionObjects } from './manifests/index.js';
export { checkMediaPortRange, MediaPortRangeError } from './media-port-check.js';
export {
  MANAGED_BY_LABEL,
  MANAGED_BY_SELECTOR,
  MCP_PORT,
  NEKO_PORT,
  objectNames,
  SESSION_ID_LABEL,
  sessionLabels,
  STARTED_AT_ANNOTATION,
} from './names.js';
export {
  clusterDnsEndpoint,
  createPodEndpointResolver,
  type PodEndpointResolver,
} from './pod-endpoint.js';
export {
  backoffDelayMs,
  Reconciler,
  RECONCILE_INTERVAL_MS,
  type ReconcilerDeps,
} from './reconciler.js';
export type { KubeClient, KubeKind, KubeObject, KubeWatchEvent } from './types.js';
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator/pod-endpoint.test.ts`
Expected: PASS. `Tests  4 passed (4)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 10: Session helpers — activity, port pool, settings

Spec sections 7.2 (`restartRequired`), 7.8 (lowest free port), 8.5 (agent activity); index 5.10 (`ActivityProvider`, `noActivity`).

**Files:**
- Create: `packages/server/src/sessions/activity.ts`
- Create: `packages/server/src/sessions/ports.ts`
- Create: `packages/server/src/sessions/settings.ts`
- Test: `packages/server/src/sessions/ports.test.ts`
- Test: `packages/server/src/sessions/settings.test.ts`

**Interfaces:**
- Consumes: `stateOf`, `screenOf` (Task 1); `SessionRow` (plan 02); `AgentActivity`, `SessionSettings` (`@hydra/shared`).
- Produces:

```ts
export interface ActivityProvider { get(sessionId: string): AgentActivity }   // index 5.10; plan 05 implements it with ActivityTracker
export const noActivity: ActivityProvider;                                    // { activeAgentCount: 0, lastToolCall: null }
export function lowestFreePort(range: { first: number; last: number }, used: Iterable<number>): number | null;
export function currentSettings(row: SessionRow): SessionSettings;
export function sameSettings(a: SessionSettings, b: SessionSettings): boolean;   // the allowlist order counts
export function restartRequired(row: SessionRow): boolean;                      // state starting or running, and settings ≠ applied_settings
```

- [ ] **Step 1: Write the failing tests**

`packages/server/src/sessions/ports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lowestFreePort } from './ports.js';

describe('lowestFreePort', () => {
  const range = { first: 52000, last: 52003 };

  it('gives the first port of an empty pool', () => {
    expect(lowestFreePort(range, [])).toBe(52000);
  });

  it('gives the lowest gap', () => {
    expect(lowestFreePort(range, [52000, 52002])).toBe(52001);
    expect(lowestFreePort(range, [52001, 52000])).toBe(52002);
  });

  it('gives the last port', () => {
    expect(lowestFreePort(range, [52000, 52001, 52002])).toBe(52003);
  });

  it('gives null when all ports are in use', () => {
    expect(lowestFreePort(range, [52000, 52001, 52002, 52003])).toBeNull();
  });

  it('ignores ports outside the range', () => {
    expect(lowestFreePort(range, [51999, 52004])).toBe(52000);
  });
});
```

`packages/server/src/sessions/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SessionRow } from '../db/schema.js';
import { currentSettings, restartRequired, sameSettings } from './settings.js';

const applied = {
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080' as const,
};
const row = (fields: Partial<SessionRow>): SessionRow => ({
  id: 'abcdefghij23',
  name: 'Research',
  ownerId: 'user-1',
  desiredState: 'running',
  state: 'running',
  errorReason: null,
  mediaPort: 52000,
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080',
  appliedSettings: applied,
  startedAt: 1,
  readyAt: 2,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...fields,
});

describe('session settings', () => {
  it('reads the current settings of the row', () => {
    expect(currentSettings(row({ timezone: 'Asia/Tokyo' }))).toEqual({
      ...applied,
      timezone: 'Asia/Tokyo',
    });
  });

  it('compares settings, with the allowlist in order', () => {
    expect(sameSettings(applied, { ...applied })).toBe(true);
    expect(sameSettings(applied, { ...applied, screen: '1280x720' })).toBe(false);
    expect(
      sameSettings(
        { ...applied, allowlist: ['a.com', 'b.com'] },
        { ...applied, allowlist: ['b.com', 'a.com'] },
      ),
    ).toBe(false);
  });

  it('needs a restart only while the session has a pod and the settings differ (spec section 7.2)', () => {
    expect(restartRequired(row({}))).toBe(false);
    expect(restartRequired(row({ allowlist: ['other.com'] }))).toBe(true);
    expect(restartRequired(row({ state: 'starting', language: 'de' }))).toBe(true);
    expect(restartRequired(row({ state: 'stopped', allowlist: ['other.com'] }))).toBe(false);
    expect(restartRequired(row({ state: 'error', allowlist: ['other.com'] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/sessions`
Expected: FAIL with `Error: Cannot find module './ports.js'` and `Error: Cannot find module './settings.js'`; `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the helpers**

`packages/server/src/sessions/activity.ts`:

```ts
import type { AgentActivity } from '@hydra/shared';

/** Agent activity summary of a session (spec section 8.5). Plan 05 replaces noActivity with ActivityTracker. */
export interface ActivityProvider {
  get(sessionId: string): AgentActivity;
}

export const noActivity: ActivityProvider = {
  get: () => ({ activeAgentCount: 0, lastToolCall: null }),
};
```

`packages/server/src/sessions/ports.ts`:

```ts
/** The lowest port of the range that is not in use (spec section 7.8), or null if all are in use. */
export function lowestFreePort(
  range: { first: number; last: number },
  used: Iterable<number>,
): number | null {
  const taken = new Set(used);
  for (let port = range.first; port <= range.last; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}
```

`packages/server/src/sessions/settings.ts`:

```ts
import type { SessionSettings } from '@hydra/shared';
import type { SessionRow } from '../db/schema.js';
import { screenOf, stateOf } from '../orchestrator/row-fields.js';

/** The settings of the row. Start and Restart copy them to applied_settings (spec section 7.2). */
export function currentSettings(row: SessionRow): SessionSettings {
  return {
    allowlist: [...row.allowlist],
    timezone: row.timezone,
    language: row.language,
    screen: screenOf(row),
  };
}

export function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return (
    a.timezone === b.timezone &&
    a.language === b.language &&
    a.screen === b.screen &&
    a.allowlist.length === b.allowlist.length &&
    a.allowlist.every((entry, index) => entry === b.allowlist[index])
  );
}

/** Spec section 7.2: the session has a pod (state starting or running) and the settings differ. */
export function restartRequired(row: SessionRow): boolean {
  const state = stateOf(row);
  return (
    (state === 'starting' || state === 'running') &&
    !sameSettings(currentSettings(row), row.appliedSettings)
  );
}
```

- [ ] **Step 4: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/sessions`
Expected: PASS. `Test Files  2 passed (2)`, `Tests  8 passed (8)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 11: `SessionsService`, the wiring, `AppDeps`, `createTestApp`, and `main.ts`

Spec sections 4 (startup check), 6.5 (rights), 7.1, 7.2, 7.8, 7.9 (action table), 10.2 (logs), 14 (start and SIGTERM); index 5.9 (`AppDeps`, `main.ts`), 5.10 (`SessionsService`), 5.12 (`createTestApp`).

**Files:**
- Create: `packages/server/src/sessions/service.ts`
- Create: `packages/server/src/sessions/wiring.ts`
- Create: `packages/server/src/sessions/index.ts`
- Modify: `packages/server/src/app.ts` (only the `AppDeps` interface)
- Modify: `packages/server/test/helpers/app.ts` (plan 03; see "Index issues" item 4)
- Modify: `packages/server/src/main.ts`
- Test: `packages/server/src/sessions/service.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 10; `AccessService` (`requireSession`, `listReadable`, `addMember` in tests), `authorize`, `effectiveRole`, `rightsOf`, `SessionAccessView` (`src/access/index.ts`, plan 03); `TokensService` (`revokeAllForSession`; `create` and `isValid` in tests) (`src/tokens/index.ts`, plan 03); `AuthedUser`, `LoginContext` (`src/auth/index.ts`, plan 03); `newSid` (plan 02); `DEFAULT_SCREEN`, `CreateSessionRequest`, `UpdateSessionRequest`, `SessionResource`, `LogsResponse` (`@hydra/shared`, plan 02); `createTestApp`, `seedUser` (plan 03).
- Produces (index 5.10, plus the additions of "Index issues" items 5 and 6):

```ts
export const LOG_TAIL_LINES = 50;
export interface SessionsServiceDeps { db; config; clock; audit; access; tokens; kube: KubeClient; reconciler: Pick<Reconciler, 'trigger'>; activity: ActivityProvider }
export class SessionsService {
  constructor(deps: SessionsServiceDeps);
  create(context: LoginContext, input: CreateSessionRequest): SessionResource;
  update(context: LoginContext, sessionId: string, input: UpdateSessionRequest): SessionResource;
  start(context: LoginContext, sessionId: string): SessionResource;
  stop(context: LoginContext, sessionId: string): SessionResource;
  restart(context: LoginContext, sessionId: string): SessionResource;
  remove(context: LoginContext, sessionId: string, confirmName: string): void;
  get(context: LoginContext, sessionId: string): SessionResource;
  list(context: LoginContext, options: { all: boolean }): SessionResource[];     // all only for admins
  logs(context: LoginContext, sessionId: string, container: 'neko' | 'mcp'): Promise<LogsResponse>;
  toResource(row: SessionRow, user: AuthedUser): SessionResource;
  readableBy(user: AuthedUser, sessionId: string): boolean;                     // GET /api/events
  freshUser(userId: string): AuthedUser | null;                                 // GET /api/events
}
export interface SessionDeps { kube: KubeClient; podEndpoints: PodEndpointResolver; reconciler: Reconciler; sessions: SessionsService; activity: ActivityProvider }
export function createSessionDeps(input: SessionDepsInput): SessionDeps;      // SessionDepsInput = the plan 02/03 deps + kube + activity
// AppDeps gets: kube, podEndpoints, reconciler, sessions, activity (index 5.9)
```

Behavior (spec section 7.9 action table):
- Each method except `create` and `list` first calls `access.requireSession(context, sid, action, { method, path })` with the concrete path of its route (`GET /api/sessions/<sid>`, `PATCH /api/sessions/<sid>`, `POST /api/sessions/<sid>/start|stop|restart|delete`, `GET /api/sessions/<sid>/logs`). `requireSession` gives 404 without `session.read`, 403 without the right, and writes `admin.session_access` (index 5.8).
- **Create** inserts the row (`state` and `desired_state` `stopped`, `applied_settings` = the settings, defaults from `config.defaultTimezone`, `config.defaultLanguage`, `DEFAULT_SCREEN`) and, if `start` is not false, runs Start in the same transaction (Spec deviation 5).
- **Start** (one immediate transaction): no change for `starting` and `running`; `409 invalid_state` unless `stopped` or `error`; if the session holds no media port and the sessions that hold one are `config.maxRunning` or more: `409 capacity_reached`; else the lowest free port (if none is held), `applied_settings` = the settings, `started_at = now`, `ready_at = NULL`, `error_reason = NULL`, `desired_state = running`.
- **Stop**: `409 invalid_state` for `deleting` and `deleted`; else `desired_state = stopped`.
- **Restart**: `409 invalid_state` unless `starting` or `running`; else `applied_settings` = the settings, `started_at = now`, `ready_at = NULL` (the media port stays).
- **Delete**: `400 confirm_mismatch` unless `confirmName` equals the name; then `desired_state = deleted` and `tokens.revokeAllForSession(sid)`.
- Audit events (actor `user`): `session.created`, `session.updated` (data `{ changes }`), `session.started`, `session.stopped`, `session.restarted`, `session.deleted`, only when the action changes the row. After each change of `desired_state` or `started_at`, `reconciler.trigger(sid)`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/sessions/service.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../app.js';
import type { LoginContext } from '../auth/index.js';
import { auditEvents, sessions } from '../db/schema.js';
import { HydraError } from '../lib/errors.js';
import { createTestApp } from '../../test/helpers/app.js';
import type { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { seedUser } from '../../test/helpers/seed.js';

let kube: FakeKubeClient;
let deps: AppDeps;
let clock: FakeClock;
let close: () => Promise<void>;
let owner: LoginContext;

beforeEach(async () => {
  kube = new FakeKubeClient();
  const config = testConfig({ maxRunning: 2, mediaPortRange: { first: 52000, last: 52002 } });
  const testApp = await createTestApp({ kube, config });
  ({ deps, clock } = testApp);
  close = () => testApp.close();
  owner = { user: (await seedUser(deps)).user, loginSessionId: 'login-owner' };
});

afterEach(async () => {
  await close();
});

const rowOf = (sid: string) => deps.db.select().from(sessions).where(eq(sessions.id, sid)).get()!;
const create = (start = true, name = 'Research') =>
  deps.sessions.create(owner, { name, allowlist: ['example.com'], start });
const auditKinds = (sid: string) =>
  deps.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.sessionId, sid))
    .all()
    .map((event) => event.kind);
/** What the reconciler does when the pod is gone (rule 7). */
const releasePort = (sid: string, state: 'stopped' | 'error' = 'stopped') =>
  deps.db
    .update(sessions)
    .set({ state, desiredState: 'stopped', mediaPort: null })
    .where(eq(sessions.id, sid))
    .run();
const setState = (sid: string, state: 'starting' | 'running' | 'stopping' | 'error' | 'deleting') =>
  deps.db.update(sessions).set({ state }).where(eq(sessions.id, sid)).run();

function expectHydraError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HydraError);
    expect((error as HydraError).code).toBe(code);
    return;
  }
  throw new Error(`expected HydraError ${code}`);
}

describe('SessionsService.create', () => {
  it('inserts the row with the defaults and continues as Start', () => {
    const resource = create();
    expect(resource).toMatchObject({
      name: 'Research',
      owner: { id: owner.user.id, email: owner.user.email, displayName: owner.user.displayName },
      myRole: 'owner',
      state: 'stopped',
      errorReason: null,
      settings: {
        allowlist: ['example.com'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
      },
      restartRequired: false,
      agentActivity: { activeAgentCount: 0, lastToolCall: null },
    });
    expect(resource.id).toMatch(/^[a-z2-7]{12}$/);
    expect(resource.rights).toContain('session.delete');
    expect(rowOf(resource.id)).toMatchObject({
      desiredState: 'running',
      mediaPort: 52000,
      startedAt: clock.now(),
      readyAt: null,
      appliedSettings: {
        allowlist: ['example.com'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
      },
    });
    expect(auditKinds(resource.id)).toEqual(['session.created', 'session.started']);
  });

  it('does not start when start is false', () => {
    const resource = create(false);
    expect(rowOf(resource.id)).toMatchObject({
      desiredState: 'stopped',
      state: 'stopped',
      mediaPort: null,
      startedAt: null,
    });
    expect(auditKinds(resource.id)).toEqual(['session.created']);
  });
});

describe('capacity check and media port allocation', () => {
  it('assigns the lowest free port', () => {
    const a = create().id;
    const b = create().id;
    expect([rowOf(a).mediaPort, rowOf(b).mediaPort]).toEqual([52000, 52001]);
    deps.sessions.stop(owner, a);
    releasePort(a);
    const c = create().id;
    expect(rowOf(c).mediaPort).toBe(52000);
  });

  it('rejects a start when HYDRA_MAX_RUNNING sessions hold a media port', () => {
    create();
    create();
    const stopped = create(false).id;
    expectHydraError(() => deps.sessions.start(owner, stopped), 'capacity_reached');
    expect(rowOf(stopped)).toMatchObject({ desiredState: 'stopped', mediaPort: null });
  });

  it('creates nothing when Create cannot start', () => {
    create();
    create();
    const before = deps.db.select().from(sessions).all().length;
    expectHydraError(() => create(true, 'Third'), 'capacity_reached');
    expect(deps.db.select().from(sessions).all()).toHaveLength(before);
  });

  it('counts a session that still holds its port while it stops or after an error', () => {
    const a = create().id;
    create();
    deps.sessions.stop(owner, a);
    setState(a, 'stopping');
    const c = create(false).id;
    expectHydraError(() => deps.sessions.start(owner, c), 'capacity_reached');
    releasePort(a);
    expect(deps.sessions.start(owner, c).id).toBe(c);
    expect(rowOf(c).mediaPort).toBe(52000);
  });

  it('keeps the held port when an error session starts again', () => {
    const a = create().id;
    deps.db
      .update(sessions)
      .set({ state: 'error', desiredState: 'stopped', errorReason: 'CrashLoopBackOff: x' })
      .where(eq(sessions.id, a))
      .run();
    create();
    clock.advance(1_000);
    deps.sessions.start(owner, a);
    expect(rowOf(a)).toMatchObject({
      mediaPort: 52000,
      desiredState: 'running',
      errorReason: null,
      startedAt: clock.now(),
    });
  });
});

describe('SessionsService actions', () => {
  it('Start does nothing for a session that starts or runs, and rejects other states', () => {
    const sid = create().id;
    setState(sid, 'running');
    deps.sessions.start(owner, sid);
    expect(auditKinds(sid)).toEqual(['session.created', 'session.started']);
    setState(sid, 'stopping');
    expectHydraError(() => deps.sessions.start(owner, sid), 'invalid_state');
  });

  it('Stop sets desired_state stopped once, and rejects a deleting session', () => {
    const sid = create().id;
    deps.sessions.stop(owner, sid);
    deps.sessions.stop(owner, sid);
    expect(rowOf(sid).desiredState).toBe('stopped');
    expect(auditKinds(sid)).toEqual(['session.created', 'session.started', 'session.stopped']);
    setState(sid, 'deleting');
    expectHydraError(() => deps.sessions.stop(owner, sid), 'invalid_state');
  });

  it('Restart copies the settings, sets a new started_at, and keeps the port', () => {
    const sid = create().id;
    setState(sid, 'running');
    deps.db.update(sessions).set({ readyAt: clock.now() }).where(eq(sessions.id, sid)).run();
    deps.sessions.update(owner, sid, { allowlist: ['other.example.com'] });
    expect(deps.sessions.get(owner, sid).restartRequired).toBe(true);
    clock.advance(5_000);
    const resource = deps.sessions.restart(owner, sid);
    expect(resource.restartRequired).toBe(false);
    expect(rowOf(sid)).toMatchObject({
      mediaPort: 52000,
      startedAt: clock.now(),
      readyAt: null,
      appliedSettings: { allowlist: ['other.example.com'] },
    });
    expect(auditKinds(sid)).toContain('session.restarted');
  });

  it('Restart is only for a session that starts or runs', () => {
    const sid = create(false).id;
    expectHydraError(() => deps.sessions.restart(owner, sid), 'invalid_state');
  });

  it('Update writes the changed fields and the audit event session.updated', () => {
    const sid = create(false).id;
    const resource = deps.sessions.update(owner, sid, {
      name: 'Renamed',
      screen: '1280x720',
      timezone: 'UTC',
    });
    expect(resource).toMatchObject({ name: 'Renamed', settings: { screen: '1280x720' } });
    const updated = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'session.updated'))
      .all();
    expect(updated.map((event) => event.data)).toEqual([
      { changes: { name: 'Renamed', screen: '1280x720' } },
    ]);
  });

  it('Delete needs the exact name, revokes the tokens, and sets desired_state deleted', () => {
    const sid = create().id;
    const { token } = deps.tokens.create(owner, sid, { name: 'agent', expiresInDays: 30 });
    expectHydraError(() => deps.sessions.remove(owner, sid, 'research'), 'confirm_mismatch');
    expect(rowOf(sid).desiredState).toBe('running');
    deps.sessions.remove(owner, sid, 'Research');
    expect(rowOf(sid).desiredState).toBe('deleted');
    expect(deps.tokens.isValid(token.id)).toBe(false);
    expect(auditKinds(sid)).toContain('session.deleted');
  });

  it('reads the last 50 log lines of a container', async () => {
    const sid = create().id;
    const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    kube.setLog(`session-${sid}-0`, 'mcp', `${text}\n`);
    const logs = await deps.sessions.logs(owner, sid, 'mcp');
    expect(logs.container).toBe('mcp');
    expect(logs.lines).toHaveLength(50);
    expect(logs.lines[0]).toBe('line 11');
    expect(logs.lines[49]).toBe('line 60');
    await expect(deps.sessions.logs(owner, sid, 'neko')).resolves.toEqual({
      container: 'neko',
      lines: [],
    });
  });
});

describe('rights and the session resource', () => {
  it('gives a viewer the viewer rights and no lifecycle action', async () => {
    const sid = create().id;
    const viewer = await seedUser(deps);
    deps.access.addMember(owner, sid, { email: viewer.user.email, role: 'viewer' });
    const context = { user: viewer.user, loginSessionId: 'login-viewer' };
    expect(deps.sessions.get(context, sid)).toMatchObject({
      myRole: 'viewer',
      rights: ['session.read', 'live.watch'],
    });
    expectHydraError(() => deps.sessions.stop(context, sid), 'forbidden');
    await expect(deps.sessions.logs(context, sid, 'neko')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('hides a session from a user without access', async () => {
    const sid = create().id;
    const stranger = { user: (await seedUser(deps)).user, loginSessionId: 'login-stranger' };
    expectHydraError(() => deps.sessions.get(stranger, sid), 'not_found');
    expectHydraError(() => deps.sessions.remove(stranger, sid, 'Research'), 'not_found');
    expect(deps.sessions.list(stranger, { all: true })).toEqual([]);
  });

  it('lists own and shared sessions, and all sessions for an admin with all', async () => {
    const other = { user: (await seedUser(deps)).user, loginSessionId: 'login-other' };
    const own = create(false, 'Own').id;
    clock.advance(1_000);
    const shared = deps.sessions.create(other, {
      name: 'Shared',
      allowlist: ['*'],
      start: false,
    }).id;
    clock.advance(1_000);
    const hidden = deps.sessions.create(other, {
      name: 'Hidden',
      allowlist: ['*'],
      start: false,
    }).id;
    deps.access.addMember(other, shared, { email: owner.user.email, role: 'operator' });
    expect(deps.sessions.list(owner, { all: true }).map((s) => s.id)).toEqual([own, shared]);

    const admin = {
      user: (await seedUser(deps, { role: 'admin' })).user,
      loginSessionId: 'login-admin',
    };
    expect(deps.sessions.list(admin, { all: false })).toEqual([]);
    const all = deps.sessions.list(admin, { all: true });
    expect(all.map((s) => s.id)).toEqual([own, shared, hidden]);
    expect(all[0]?.myRole).toBe('admin');
  });

  it('checks session.read for events also after the delete', async () => {
    const sid = create().id;
    const stranger = (await seedUser(deps)).user;
    deps.sessions.remove(owner, sid, 'Research');
    deps.db
      .update(sessions)
      .set({ state: 'deleted', deletedAt: clock.now() })
      .where(eq(sessions.id, sid))
      .run();
    expect(deps.sessions.readableBy(owner.user, sid)).toBe(true);
    expect(deps.sessions.readableBy(stranger, sid)).toBe(false);
    expect(deps.sessions.readableBy(owner.user, 'nosuchsessio')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/sessions/service.test.ts`
Expected: FAIL. `createTestApp` does not fill `deps.sessions` yet, so each test fails with `TypeError: Cannot read properties of undefined (reading 'create')` (or `'list'`); `Tests  18 failed (18)`.

- [ ] **Step 3: Write the service**

`packages/server/src/sessions/service.ts`:

```ts
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  DEFAULT_SCREEN,
  type Action,
  type CreateSessionRequest,
  type GlobalRole,
  type LogsResponse,
  type MemberRole,
  type SessionResource,
  type SessionSettings,
  type UpdateSessionRequest,
  type UserStatus,
} from '@hydra/shared';
import {
  authorize,
  effectiveRole,
  rightsOf,
  type AccessService,
  type SessionAccessView,
} from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { newSid } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { sessionMembers, sessions, users, type SessionRow } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { objectNames } from '../orchestrator/names.js';
import { stateOf } from '../orchestrator/row-fields.js';
import type { Reconciler } from '../orchestrator/reconciler.js';
import type { KubeClient } from '../orchestrator/types.js';
import type { TokensService } from '../tokens/index.js';
import type { ActivityProvider } from './activity.js';
import { lowestFreePort } from './ports.js';
import { currentSettings, restartRequired } from './settings.js';

export const LOG_TAIL_LINES = 50;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Typed reads of text enum columns; `string` parameters work with text and enum column types.
const memberRoleOf = (role: string | undefined): MemberRole | null =>
  role === undefined ? null : (role as MemberRole);
const globalRoleOf = (role: string): GlobalRole => role as GlobalRole;
const userStatusOf = (status: string): UserStatus => status as UserStatus;

export interface SessionsServiceDeps {
  db: Db;
  config: Config;
  clock: Clock;
  audit: AuditWriter;
  access: AccessService;
  tokens: TokensService;
  kube: KubeClient;
  reconciler: Pick<Reconciler, 'trigger'>;
  activity: ActivityProvider;
}

/** Session actions of spec section 7.9 and the session resource of index section 5.1. */
export class SessionsService {
  private readonly deps: SessionsServiceDeps;

  constructor(deps: SessionsServiceDeps) {
    this.deps = deps;
  }

  create(context: LoginContext, input: CreateSessionRequest): SessionResource {
    const { config, clock } = this.deps;
    const now = clock.now();
    const sid = newSid();
    const settings: SessionSettings = {
      allowlist: [...input.allowlist],
      timezone: input.timezone ?? config.defaultTimezone,
      language: input.language ?? config.defaultLanguage,
      screen: input.screen ?? DEFAULT_SCREEN,
    };
    const start = input.start ?? true;
    // Create continues as Start in the same transaction: capacity_reached creates nothing.
    this.deps.db.transaction(
      (tx) => {
        tx.insert(sessions)
          .values({
            id: sid,
            name: input.name,
            ownerId: context.user.id,
            desiredState: 'stopped',
            state: 'stopped',
            errorReason: null,
            mediaPort: null,
            allowlist: settings.allowlist,
            timezone: settings.timezone,
            language: settings.language,
            screen: settings.screen,
            appliedSettings: settings,
            startedAt: null,
            readyAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .run();
        if (start) this.startLocked(tx, this.rowIn(tx, sid), now);
      },
      { behavior: 'immediate' },
    );
    this.audit(context, sid, 'session.created', { name: input.name, settings });
    if (start) this.audit(context, sid, 'session.started', {});
    this.deps.reconciler.trigger(sid);
    return this.toResource(this.rowIn(this.deps.db, sid), context.user);
  }

  update(context: LoginContext, sessionId: string, input: UpdateSessionRequest): SessionResource {
    this.requireRight(context, sessionId, 'session.update', 'PATCH', `/api/sessions/${sessionId}`);
    const row = this.rowIn(this.deps.db, sessionId);
    const state = stateOf(row);
    if (state === 'deleting' || state === 'deleted')
      throw new HydraError('invalid_state', `The session is ${state}`);
    const changes: UpdateSessionRequest = {};
    if (input.name !== undefined && input.name !== row.name) changes.name = input.name;
    if (
      input.allowlist !== undefined &&
      JSON.stringify(input.allowlist) !== JSON.stringify(row.allowlist)
    ) {
      changes.allowlist = [...input.allowlist];
    }
    if (input.timezone !== undefined && input.timezone !== row.timezone)
      changes.timezone = input.timezone;
    if (input.language !== undefined && input.language !== row.language)
      changes.language = input.language;
    if (input.screen !== undefined && input.screen !== row.screen) changes.screen = input.screen;
    if (Object.keys(changes).length > 0) {
      this.deps.db
        .update(sessions)
        .set({ ...changes, updatedAt: this.deps.clock.now() })
        .where(eq(sessions.id, sessionId))
        .run();
      this.audit(context, sessionId, 'session.updated', { changes });
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  start(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/start`,
    );
    const now = this.deps.clock.now();
    const changed = this.deps.db.transaction(
      (tx) => this.startLocked(tx, this.rowIn(tx, sessionId), now),
      {
        behavior: 'immediate',
      },
    );
    if (changed) {
      this.audit(context, sessionId, 'session.started', {});
      this.deps.reconciler.trigger(sessionId);
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  stop(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/stop`,
    );
    const now = this.deps.clock.now();
    const changed = this.deps.db.transaction(
      (tx) => {
        const row = this.rowIn(tx, sessionId);
        const state = stateOf(row);
        if (state === 'deleting' || state === 'deleted')
          throw new HydraError('invalid_state', `The session is ${state}`);
        if (row.desiredState === 'stopped') return false;
        tx.update(sessions)
          .set({ desiredState: 'stopped', updatedAt: now })
          .where(eq(sessions.id, sessionId))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.audit(context, sessionId, 'session.stopped', {});
      this.deps.reconciler.trigger(sessionId);
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  restart(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/restart`,
    );
    const now = this.deps.clock.now();
    this.deps.db.transaction(
      (tx) => {
        const row = this.rowIn(tx, sessionId);
        const state = stateOf(row);
        if (state !== 'starting' && state !== 'running') {
          throw new HydraError('invalid_state', `The session is ${state}. Use Start.`);
        }
        // The new started_at changes the hydra/started-at annotation, so the StatefulSet replaces the pod.
        tx.update(sessions)
          .set({
            appliedSettings: currentSettings(row),
            startedAt: now,
            readyAt: null,
            updatedAt: now,
          })
          .where(eq(sessions.id, sessionId))
          .run();
      },
      { behavior: 'immediate' },
    );
    this.audit(context, sessionId, 'session.restarted', {});
    this.deps.reconciler.trigger(sessionId);
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  remove(context: LoginContext, sessionId: string, confirmName: string): void {
    this.requireRight(
      context,
      sessionId,
      'session.delete',
      'POST',
      `/api/sessions/${sessionId}/delete`,
    );
    const row = this.rowIn(this.deps.db, sessionId);
    if (confirmName !== row.name) {
      throw new HydraError('confirm_mismatch', 'Type the exact session name to delete the session');
    }
    if (row.desiredState === 'deleted') return;
    this.deps.db
      .update(sessions)
      .set({ desiredState: 'deleted', updatedAt: this.deps.clock.now() })
      .where(eq(sessions.id, sessionId))
      .run();
    this.deps.tokens.revokeAllForSession(sessionId);
    this.audit(context, sessionId, 'session.deleted', { name: row.name });
    this.deps.reconciler.trigger(sessionId);
  }

  get(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(context, sessionId, 'session.read', 'GET', `/api/sessions/${sessionId}`);
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  list(context: LoginContext, options: { all: boolean }): SessionResource[] {
    const all = options.all && context.user.role === 'admin';
    const ids = this.deps.access.listReadable(context.user, { all });
    if (ids.length === 0) return [];
    const rows = this.deps.db
      .select()
      .from(sessions)
      .where(and(inArray(sessions.id, ids), ne(sessions.state, 'deleted')))
      .orderBy(asc(sessions.createdAt), asc(sessions.id))
      .all();
    return rows.map((row) => this.toResource(row, context.user));
  }

  async logs(
    context: LoginContext,
    sessionId: string,
    container: 'neko' | 'mcp',
  ): Promise<LogsResponse> {
    this.requireRight(context, sessionId, 'session.logs', 'GET', `/api/sessions/${sessionId}/logs`);
    const text = await this.deps.kube.readLog(
      objectNames(sessionId).pod,
      container,
      LOG_TAIL_LINES,
    );
    const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.at(-1) === '') lines.pop();
    return { container, lines: lines.slice(-LOG_TAIL_LINES) };
  }

  toResource(row: SessionRow, user: AuthedUser): SessionResource {
    const view = this.viewOf(row, user.id);
    const myRole = effectiveRole(user, view);
    if (myRole === null) throw new HydraError('not_found', 'Session not found');
    const owner = this.deps.db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .get();
    return {
      id: row.id,
      name: row.name,
      owner: owner ?? { id: row.ownerId, email: '', displayName: '' },
      myRole,
      rights: rightsOf(user, view),
      state: stateOf(row),
      errorReason: row.errorReason,
      settings: currentSettings(row),
      restartRequired: restartRequired(row),
      agentActivity: this.deps.activity.get(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * session.read at send time, for GET /api/events. Uses the row also when the session is deleted, so
   * the people who could read the session get its last `deleted` event.
   */
  readableBy(user: AuthedUser, sessionId: string): boolean {
    const row = this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    return row !== undefined && authorize(user, this.viewOf(row, user.id), 'session.read');
  }

  /** The current role and status of a user (GET /api/events after rights.changed). */
  freshUser(userId: string): AuthedUser | null {
    const row = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: globalRoleOf(row.role),
      status: userStatusOf(row.status),
      mustChangePassword: Boolean(row.mustChangePassword),
    };
  }

  /** Start of spec section 7.9 inside a transaction. Returns false if the session already starts or runs. */
  private startLocked(tx: Tx, row: SessionRow, now: number): boolean {
    const { config } = this.deps;
    const state = stateOf(row);
    if (state === 'starting' || state === 'running') return false;
    if (state !== 'stopped' && state !== 'error')
      throw new HydraError('invalid_state', `The session is ${state}`);
    let mediaPort = row.mediaPort;
    if (mediaPort === null) {
      const used = tx
        .select({ port: sessions.mediaPort })
        .from(sessions)
        .where(isNotNull(sessions.mediaPort))
        .all()
        .map((entry) => entry.port)
        .filter((port): port is number => port !== null);
      if (used.length >= config.maxRunning) {
        throw new HydraError(
          'capacity_reached',
          `${config.maxRunning} sessions are running. Stop a session first.`,
        );
      }
      mediaPort = lowestFreePort(config.mediaPortRange, used);
      if (mediaPort === null) throw new HydraError('capacity_reached', 'No free media port');
    }
    tx.update(sessions)
      .set({
        mediaPort,
        appliedSettings: currentSettings(row),
        startedAt: now,
        readyAt: null,
        errorReason: null,
        desiredState: 'running',
        updatedAt: now,
      })
      .where(eq(sessions.id, row.id))
      .run();
    return true;
  }

  private rowIn(db: Db | Tx, sessionId: string): SessionRow {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) throw new HydraError('not_found', 'Session not found');
    return row;
  }

  private viewOf(row: SessionRow, userId: string): SessionAccessView {
    const member = this.deps.db
      .select({ role: sessionMembers.role })
      .from(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, row.id), eq(sessionMembers.userId, userId)))
      .get();
    return {
      id: row.id,
      ownerId: row.ownerId,
      memberRole: memberRoleOf(member?.role),
    };
  }

  private requireRight(
    context: LoginContext,
    sessionId: string,
    action: Action,
    method: string,
    path: string,
  ): void {
    this.deps.access.requireSession(context, sessionId, action, { method, path });
  }

  private audit(
    context: LoginContext,
    sessionId: string,
    kind:
      | 'session.created'
      | 'session.updated'
      | 'session.started'
      | 'session.stopped'
      | 'session.restarted'
      | 'session.deleted',
    data: Record<string, unknown>,
  ): void {
    this.deps.audit.write({ kind, actorType: 'user', actorId: context.user.id, sessionId, data });
  }
}
```

- [ ] **Step 4: Write the wiring and the module exports**

`packages/server/src/sessions/wiring.ts`:

```ts
import type { AccessService } from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { Config } from '../config/index.js';
import type { Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import {
  createPodEndpointResolver,
  type PodEndpointResolver,
} from '../orchestrator/pod-endpoint.js';
import { Reconciler } from '../orchestrator/reconciler.js';
import type { KubeClient } from '../orchestrator/types.js';
import type { TokensService } from '../tokens/index.js';
import type { ActivityProvider } from './activity.js';
import { SessionsService } from './service.js';

export interface SessionDepsInput {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  access: AccessService;
  tokens: TokensService;
  kube: KubeClient;
  activity: ActivityProvider;
}

/** The AppDeps fields of plan 04. main.ts and createTestApp call this one function. */
export interface SessionDeps {
  kube: KubeClient;
  podEndpoints: PodEndpointResolver;
  reconciler: Reconciler;
  sessions: SessionsService;
  activity: ActivityProvider;
}

export function createSessionDeps(input: SessionDepsInput): SessionDeps {
  const { config, clock, logger, db, bus, subkeys, audit, access, tokens, kube, activity } = input;
  const reconciler = new Reconciler({ db, kube, config, subkeys, clock, logger, audit, bus });
  const podEndpoints = createPodEndpointResolver(config, kube, logger);
  const sessions = new SessionsService({
    db,
    config,
    clock,
    audit,
    access,
    tokens,
    kube,
    reconciler,
    activity,
  });
  return { kube, podEndpoints, reconciler, sessions, activity };
}
```

`packages/server/src/sessions/index.ts`:

```ts
export { noActivity, type ActivityProvider } from './activity.js';
export { lowestFreePort } from './ports.js';
export { LOG_TAIL_LINES, SessionsService, type SessionsServiceDeps } from './service.js';
export { currentSettings, restartRequired, sameSettings } from './settings.js';
export { createSessionDeps, type SessionDeps, type SessionDepsInput } from './wiring.js';
```

- [ ] **Step 5: Add the plan 04 fields to `AppDeps`**

In `packages/server/src/app.ts`, add these imports:

```ts
import type { PodEndpointResolver } from './orchestrator/pod-endpoint.js';
import type { Reconciler } from './orchestrator/reconciler.js';
import type { KubeClient } from './orchestrator/types.js';
import type { ActivityProvider } from './sessions/activity.js';
import type { SessionsService } from './sessions/service.js';
```

and add these fields at the end of `export interface AppDeps { … }` (keep the fields of plans 02 and 03; index 5.9 lists the same five names):

```ts
  // Plan 04
  kube: KubeClient;
  podEndpoints: PodEndpointResolver;
  reconciler: Reconciler;
  sessions: SessionsService;
  activity: ActivityProvider;
```

`buildApp` does not change in this task.

- [ ] **Step 6: Fill the plan 04 deps in `createTestApp`**

Read `packages/server/test/helpers/app.ts` (plan 03) first. Make these changes and keep everything else:

1. Add the imports:

```ts
import { createSessionDeps, noActivity } from '../../src/sessions/index.js';
import { FakeKubeClient } from './fake-kube.js';
```

2. The helper must build all deps from one config: `overrides.config ?? testConfig()` (index issue 10). If plan 03 already does this, keep it.
3. Plan 03 builds an object with the plan 02 and plan 03 deps before it calls `buildApp`. Insert this code right before the `buildApp` call. In the code, `base` is that object; if the helper uses another name, use that name. Then pass the new `deps` to `buildApp` and return it:

```ts
  // Plan 04: the session deps. A test can pass its own kube (a FakeKubeClient) or activity.
  const sessionDeps = createSessionDeps({
    config: base.config,
    clock: base.clock,
    logger: base.logger,
    db: base.db,
    bus: base.bus,
    subkeys: base.subkeys,
    audit: base.audit,
    access: base.access,
    tokens: base.tokens,
    kube: overrides.kube ?? new FakeKubeClient(base.config.sessionNamespace),
    activity: overrides.activity ?? noActivity,
  });
  const deps: AppDeps = { ...base, ...sessionDeps, ...overrides };
```

4. In the `close()` function that the helper returns, stop the reconciler and close the pod endpoints first, before the app and the database close:

```ts
    await deps.reconciler.stop();
    await deps.podEndpoints.close();
```

- [ ] **Step 7: Start the orchestrator in `main.ts`**

Read `packages/server/src/main.ts` (plan 03) first. Make these changes and keep everything else:

1. Add the imports:

```ts
import {
  checkMediaPortRange,
  createKubeClient,
  MediaPortRangeError,
} from './orchestrator/index.js';
import { createSessionDeps, noActivity } from './sessions/index.js';
```

2. After plan 03 has built `access` and `tokens`, and before it builds the `AppDeps` object, insert this code (the names `config`, `clock`, `logger`, `db`, `bus`, `subkeys`, `audit`, `access`, `tokens` are the plan 02 and plan 03 objects; use the names in the file):

```ts
  // Plan 04: Kubernetes client, startup check of HYDRA_MEDIA_PORT_RANGE (spec section 4), session deps.
  const kube = createKubeClient(config);
  try {
    await checkMediaPortRange({ kube, config, logger });
  } catch (error) {
    if (error instanceof MediaPortRangeError) {
      logger.fatal({ variable: error.variable }, error.message);
      process.exit(1);
    }
    throw error;
  }
  const sessionDeps = createSessionDeps({
    config,
    clock,
    logger,
    db,
    bus,
    subkeys,
    audit,
    access,
    tokens,
    kube,
    activity: noActivity,
  });
```

3. Add `...sessionDeps` to the `AppDeps` object that `main.ts` passes to `buildApp`.
4. After `app.listen(…)` resolves, start the reconciler (`deps` is the `AppDeps` object):

```ts
  // Plan 04: first pass, watch, every 30 s (spec sections 7.9 and 14).
  await deps.reconciler.start();
```

5. In the SIGTERM handler, after the server stops accepting requests and before the database closes, add:

```ts
    // Plan 04
    await deps.reconciler.stop();
    await deps.podEndpoints.close();
```

- [ ] **Step 8: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/sessions`
Expected: PASS. `Test Files  3 passed (3)`, `Tests  26 passed (26)`.

Run: `pnpm --filter @hydra/server exec vitest run src/orchestrator`
Expected: PASS. `Test Files  13 passed (13)`, `Tests  99 passed (99)`. The reconciler test still builds its own `Reconciler`; the one in `createTestApp` is not started.

- [ ] **Step 9: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 12: Session routes and `/readyz`

Spec sections 6.4 (CSRF), 6.5 (404 rule), 7.9, 12.1 (session routes), 12.2 (errors), 14 (`/readyz`); index 5.9.

**Files:**
- Create: `packages/server/src/api/sessions.ts`
- Modify: `packages/server/src/app.ts` (register the routes in the public scope)
- Modify: `packages/server/src/api/health.ts` (`/readyz` also needs the Kubernetes API)
- Test: `packages/server/test/integration/sessions.test.ts`

**Interfaces:**
- Consumes: `SessionsService` (Task 11); `requireLogin` (`src/api/context.ts`, plan 03); `HydraError` (plan 02); `CreateSessionRequestSchema`, `UpdateSessionRequestSchema`, `DeleteSessionRequestSchema`, `ListSessionsQuerySchema`, `LogsQuerySchema`, `SessionResourceSchema`, `LogsResponseSchema` (`@hydra/shared`, plan 02); `createTestApp`, `seedUser`, `loginAs` (plan 03).
- Produces:

```ts
export function registerSessionRoutes(scope: FastifyInstance, deps: AppDeps): void;
// GET /api/sessions (?all=1)      → 200 SessionResource[]
// POST /api/sessions              → 201 SessionResource
// GET /api/sessions/:sid          → 200 SessionResource
// PATCH /api/sessions/:sid        → 200 SessionResource
// POST /api/sessions/:sid/start   → 200 SessionResource (also /stop, /restart)
// POST /api/sessions/:sid/delete  → 204 (body { confirmName })
// GET /api/sessions/:sid/logs?container=neko|mcp → 200 LogsResponse (last 50 lines)
```

The routes validate with the `@hydra/shared` schemas (`400 validation_failed` with `fields`) and call the service; the service checks the rights. A delete body without a valid `confirmName` is `confirm_mismatch` after the rights check, so a user without access still gets 404. The CSRF hook of plan 03 covers all these `POST` and `PATCH` routes (they are under `/api/`).

- [ ] **Step 1: Write the failing test**

`packages/server/test/integration/sessions.test.ts`:

```ts
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogsResponseSchema, SessionResourceSchema, type SessionResource } from '@hydra/shared';
import type { AppDeps } from '../../src/app.js';
import type { AuthedUser } from '../../src/auth/index.js';
import { createTestApp } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { FakeKubeClient } from '../helpers/fake-kube.js';
import { loginAs, seedUser } from '../helpers/seed.js';

let app: FastifyInstance;
let deps: AppDeps;
let close: () => Promise<void>;
let kube: FakeKubeClient;
let owner: { user: AuthedUser; cookie: string };

async function login(
  role: 'admin' | 'member' = 'member',
): Promise<{ user: AuthedUser; cookie: string }> {
  const { user, password } = await seedUser(deps, { role });
  return { user, cookie: await loginAs(app, user.email, password) };
}

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie: string | null,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: deps.config.publicUrl.host };
  if (cookie) headers['cookie'] = cookie;
  if (method === 'GET') return app.inject({ method, url, headers });
  headers['origin'] = deps.config.publicUrl.origin;
  headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: JSON.stringify(body ?? {}) });
}

async function createSession(body: Record<string, unknown> = {}): Promise<SessionResource> {
  const response = await call('POST', '/api/sessions', owner.cookie, {
    name: 'Research',
    allowlist: ['example.com'],
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return SessionResourceSchema.parse(response.json());
}

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp({
    kube,
    config: testConfig({ maxRunning: 1, mediaPortRange: { first: 52000, last: 52001 } }),
  });
  ({ app, deps } = testApp);
  close = () => testApp.close();
  owner = await login();
});

afterEach(async () => {
  await close();
});

describe('session routes', () => {
  it('creates a session and returns the session resource', async () => {
    const resource = await createSession({
      timezone: 'Europe/Rome',
      language: 'it-IT',
      screen: '1600x900',
    });
    expect(resource).toMatchObject({
      name: 'Research',
      myRole: 'owner',
      state: 'stopped',
      settings: {
        allowlist: ['example.com'],
        timezone: 'Europe/Rome',
        language: 'it-IT',
        screen: '1600x900',
      },
    });
  });

  it('rejects a body that is not valid', async () => {
    const response = await call('POST', '/api/sessions', owner.cookie, {
      name: '',
      allowlist: ['https://example.com/path'],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const fields = response.json<{ error: { fields: Record<string, string> } }>().error.fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['name']));
  });

  it('needs a login and the CSRF headers', async () => {
    expect((await call('GET', '/api/sessions', null)).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        host: deps.config.publicUrl.host,
        cookie: owner.cookie,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'x', allowlist: ['example.com'] }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it('returns 404 to a user without access, and 403 to a viewer for a lifecycle action', async () => {
    const { id } = await createSession();
    const stranger = await login();
    expect((await call('GET', `/api/sessions/${id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await call('POST', `/api/sessions/${id}/stop`, stranger.cookie)).statusCode).toBe(404);
    expect(
      (
        await call('POST', `/api/sessions/${id}/delete`, stranger.cookie, {
          confirmName: 'Research',
        })
      ).statusCode,
    ).toBe(404);

    const viewer = await login();
    deps.access.addMember({ user: owner.user, loginSessionId: 'x' }, id, {
      email: viewer.user.email,
      role: 'viewer',
    });
    const asViewer = await call('GET', `/api/sessions/${id}`, viewer.cookie);
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json()).toMatchObject({
      myRole: 'viewer',
      rights: ['session.read', 'live.watch'],
    });
    const stop = await call('POST', `/api/sessions/${id}/stop`, viewer.cookie);
    expect(stop.statusCode).toBe(403);
    expect(stop.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('lists own sessions, and all sessions with all=1 for an admin only', async () => {
    const { id } = await createSession({ start: false });
    const other = await login();
    const otherList = await call('GET', '/api/sessions?all=1', other.cookie);
    expect(otherList.json()).toEqual([]);
    const admin = await login('admin');
    expect((await call('GET', '/api/sessions', admin.cookie)).json()).toEqual([]);
    const all = await call('GET', '/api/sessions?all=1', admin.cookie);
    expect(all.json<SessionResource[]>().map((s) => [s.id, s.myRole])).toEqual([[id, 'admin']]);
  });

  it('starts, stops, and restarts with the state rules', async () => {
    const first = await createSession({ start: false });
    const second = await createSession({ start: false, name: 'Second' });
    const start = await call('POST', `/api/sessions/${first.id}/start`, owner.cookie);
    expect(start.statusCode).toBe(200);
    const full = await call('POST', `/api/sessions/${second.id}/start`, owner.cookie);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: { code: 'capacity_reached' } });

    const restartStopped = await call('POST', `/api/sessions/${second.id}/restart`, owner.cookie);
    expect(restartStopped.statusCode).toBe(409);
    expect(restartStopped.json()).toMatchObject({ error: { code: 'invalid_state' } });

    await deps.reconciler.reconcileSession(first.id);
    const restart = await call('POST', `/api/sessions/${first.id}/restart`, owner.cookie);
    expect(restart.statusCode).toBe(200);
    const stop = await call('POST', `/api/sessions/${first.id}/stop`, owner.cookie);
    expect(stop.statusCode).toBe(200);
  });

  it('shows restartRequired after a settings change of a running session', async () => {
    const { id } = await createSession();
    await deps.reconciler.reconcileSession(id);
    kube.setPodReady(id, true);
    await deps.reconciler.reconcileSession(id);
    const patch = await call('PATCH', `/api/sessions/${id}`, owner.cookie, {
      allowlist: ['other.example.com'],
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      state: 'running',
      restartRequired: true,
      settings: { allowlist: ['other.example.com'] },
    });
  });

  it('deletes with the exact name, and the reconciler removes the objects', async () => {
    const { id } = await createSession();
    await deps.reconciler.reconcileSession(id);
    expect(kube.objectsOf(id).length).toBeGreaterThan(0);

    const missing = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'confirm_mismatch' } });
    const wrong = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {
      confirmName: 'research',
    });
    expect(wrong.json()).toMatchObject({ error: { code: 'confirm_mismatch' } });

    const ok = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {
      confirmName: 'Research',
    });
    expect(ok.statusCode).toBe(204);
    await deps.reconciler.reconcileSession(id);
    expect(kube.objectsOf(id)).toEqual([]);
    await deps.reconciler.reconcileSession(id);
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).statusCode).toBe(404);
  });

  it('reads container logs', async () => {
    const { id } = await createSession();
    kube.setLog(`session-${id}-0`, 'neko', 'started\nready\n');
    const response = await call('GET', `/api/sessions/${id}/logs?container=neko`, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(LogsResponseSchema.parse(response.json())).toEqual({
      container: 'neko',
      lines: ['started', 'ready'],
    });
    expect(
      (await call('GET', `/api/sessions/${id}/logs?container=other`, owner.cookie)).statusCode,
    ).toBe(400);
  });

  it('reaches running through the started reconciler after the API action', async () => {
    await deps.reconciler.start();
    const { id } = await createSession();
    await deps.reconciler.idle();
    kube.setPodReady(id, true);
    await deps.reconciler.idle();
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).json()).toMatchObject({
      state: 'running',
    });
  });
});

describe('GET /readyz', () => {
  it('needs the database and the Kubernetes API', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    kube.pingResult = false;
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/sessions.test.ts`
Expected: FAIL. The routes do not exist yet: for example `expected 404 to be 201` in `createSession`, and `expected 200 to be 503` in the `/readyz` test.

- [ ] **Step 3: Write the routes**

`packages/server/src/api/sessions.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  ListSessionsQuerySchema,
  LogsQuerySchema,
  UpdateSessionRequestSchema,
} from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { HydraError } from '../lib/errors.js';
import { requireLogin } from './context.js';

type SidParams = { Params: { sid: string } };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    fields[field] ??= issue.message;
  }
  throw new HydraError('validation_failed', 'The request is not valid', fields);
}

/** Session routes of spec section 12.1. Rights: SessionsService calls AccessService.requireSession. */
export function registerSessionRoutes(scope: FastifyInstance, deps: AppDeps): void {
  // Handlers of synchronous service calls are synchronous: Fastify sends the returned value.
  scope.get('/api/sessions', (request) => {
    const login = requireLogin(request);
    const query = parse(ListSessionsQuerySchema, request.query);
    return deps.sessions.list(login, { all: query.all });
  });

  scope.post('/api/sessions', async (request, reply) => {
    const login = requireLogin(request);
    const input = parse(CreateSessionRequestSchema, request.body);
    return reply.code(201).send(deps.sessions.create(login, input));
  });

  scope.get<SidParams>('/api/sessions/:sid', (request) =>
    deps.sessions.get(requireLogin(request), request.params.sid),
  );

  scope.patch<SidParams>('/api/sessions/:sid', (request) => {
    const login = requireLogin(request);
    const input = parse(UpdateSessionRequestSchema, request.body);
    return deps.sessions.update(login, request.params.sid, input);
  });

  scope.post<SidParams>('/api/sessions/:sid/start', (request) =>
    deps.sessions.start(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/stop', (request) =>
    deps.sessions.stop(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/restart', (request) =>
    deps.sessions.restart(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/delete', async (request, reply) => {
    const login = requireLogin(request);
    // A missing or wrong confirmName is confirm_mismatch, after the rights check (404 rule).
    const body = DeleteSessionRequestSchema.safeParse(request.body);
    deps.sessions.remove(login, request.params.sid, body.success ? body.data.confirmName : '');
    return reply.code(204).send();
  });

  scope.get<SidParams>('/api/sessions/:sid/logs', async (request) => {
    const login = requireLogin(request);
    const query = parse(LogsQuerySchema, request.query);
    return deps.sessions.logs(login, request.params.sid, query.container);
  });
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add the import:

```ts
import { registerSessionRoutes } from './api/sessions.js';
```

In `buildApp`, in the function that registers the routes of the public scope (the scope with the host constraint `config.publicUrl.host`, index 5.9), add this call next to the `register…Routes` calls of plan 03:

```ts
    registerSessionRoutes(scope, deps);
```

- [ ] **Step 5: Make `/readyz` check the Kubernetes API**

Spec section 14: `/readyz` answers 200 only if the database and the Kubernetes API answer. Read `packages/server/src/api/health.ts` (plan 03). Keep `/healthz`. Change the `/readyz` handler so that it also awaits `deps.kube.ping()` and answers 503 if the database check or the Kubernetes check fails. If plan 03 has a database check that you can call, keep it and its response bodies; else use this complete version (the health route function gets `deps: AppDeps`; if it gets fewer deps, pass `deps.kube` to it in `buildApp`):

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

function databaseAnswers(db: Db): boolean {
  try {
    db.get(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// In the function that registers /healthz and /readyz:
  app.get('/readyz', async (_request, reply) => {
    const dbOk = databaseAnswers(deps.db);
    const kubeOk = await deps.kube.ping();
    if (!dbOk || !kubeOk) {
      return reply.code(503).send({ status: 'unavailable', db: dbOk, kubernetes: kubeOk });
    }
    return reply.code(200).send({ status: 'ok' });
  });
```

- [ ] **Step 6: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/sessions.test.ts`
Expected: PASS. `Tests  11 passed (11)`.

If a plan 03 test of `/readyz` builds deps without `kube`, it now uses the `FakeKubeClient` of `createTestApp` (`pingResult` is true), so it still passes.

- [ ] **Step 7: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

### Task 13: `GET /api/events`

Spec sections 3.1 (bus events), 8.5 (`session.activity`), 10.3 (SSE stream of the sidebar), 12.1; index 5.6 (`login.ended`, `rights.changed`), 5.9 (`openSse`).

**Files:**
- Create: `packages/server/src/api/events.ts`
- Modify: `packages/server/src/app.ts` (register the route in the public scope)
- Test: `packages/server/test/integration/events.test.ts`

**Interfaces:**
- Consumes: `requireLogin`, `openSse(reply, { clock })` (plan 03; index issue 9); `EventBus.subscribe` (plan 02); `SessionsService.readableBy`, `SessionsService.freshUser` (Task 11); `SessionStateEvent`, `SessionActivityEvent` (`@hydra/shared`); `AccessService.addMember`, `AccessService.removeMember`, `AuthService.endLoginSessions` (plan 03, in tests).
- Produces:

```ts
export function registerEventRoutes(scope: FastifyInstance, deps: AppDeps): void;
// GET /api/events (login) → text/event-stream with
//   event: session.state     data: SessionStateEvent
//   event: session.activity  data: SessionActivityEvent
```

Rules: each bus event `session.state` or `session.activity` goes to the stream only if `deps.sessions.readableBy(user, sessionId)` is true when it is sent (Review Focus items 1 and 2). `rights.changed` for the user reloads the user (role and status); a disabled user's stream closes. `login.ended` with the login session of the stream closes it. The heartbeat comes from `openSse` (spec section 10.3). `GET /api/events` writes no `admin.session_access` audit event (index 5.8).

- [ ] **Step 1: Write the failing test**

The test listens on a random port and reads the stream with `node:http` (`app.inject` waits for the end of the response, so it cannot read a stream).

`packages/server/test/integration/events.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import type { AuthedUser, LoginContext } from '../../src/auth/index.js';
import { users } from '../../src/db/schema.js';
import { createTestApp } from '../helpers/app.js';
import { FakeKubeClient } from '../helpers/fake-kube.js';
import { loginAs, seedUser } from '../helpers/seed.js';

interface SseEvent {
  event: string;
  data: unknown;
}

interface SseClient {
  status: number;
  next(timeoutMs?: number): Promise<SseEvent>;
  ended: Promise<void>;
  close(): void;
}

let app: FastifyInstance;
let deps: AppDeps;
let close: () => Promise<void>;
let kube: FakeKubeClient;
let port: number;
const clients: SseClient[] = [];

/** Opens GET /api/events on the listening server and parses the SSE frames. */
function openEvents(cookie: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const queue: SseEvent[] = [];
    const waiters: Array<(event: SseEvent) => void> = [];
    let buffer = '';
    let resolveEnded!: () => void;
    const ended = new Promise<void>((r) => (resolveEnded = r));
    const req: ClientRequest = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { host: deps.config.publicUrl.host, cookie, accept: 'text/event-stream' },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const lines = frame.split('\n').filter((line) => !line.startsWith(':'));
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            if (!event || data === undefined) continue;
            const parsed: SseEvent = { event, data: JSON.parse(data) };
            const waiter = waiters.shift();
            if (waiter) waiter(parsed);
            else queue.push(parsed);
          }
        });
        res.on('end', resolveEnded);
        res.on('close', resolveEnded);
        const client: SseClient = {
          status: res.statusCode ?? 0,
          next: (timeoutMs = 2_000) =>
            new Promise<SseEvent>((resolveNext, rejectNext) => {
              const queued = queue.shift();
              if (queued) return resolveNext(queued);
              const timer = setTimeout(() => rejectNext(new Error('no SSE event')), timeoutMs);
              waiters.push((event) => {
                clearTimeout(timer);
                resolveNext(event);
              });
            }),
          ended,
          close: () => req.destroy(),
        };
        clients.push(client);
        resolve(client);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function login(
  role: 'admin' | 'member' = 'member',
): Promise<{ user: AuthedUser; cookie: string; context: LoginContext }> {
  const { user, password } = await seedUser(deps, { role });
  return {
    user,
    cookie: await loginAs(app, user.email, password),
    context: { user, loginSessionId: 'service-call' },
  };
}

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp({ kube });
  ({ app, deps } = testApp);
  close = () => testApp.close();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await close();
});

describe('GET /api/events', () => {
  it('needs a login', async () => {
    const client = await openEvents('');
    expect(client.status).toBe(401);
  });

  it('sends session.state of readable sessions from the reconciler', async () => {
    const owner = await login();
    const stranger = await login();
    const own = deps.sessions.create(owner.context, { name: 'Own', allowlist: ['example.com'] }).id;
    const hidden = deps.sessions.create(stranger.context, {
      name: 'Hidden',
      allowlist: ['example.com'],
    }).id;
    const client = await openEvents(owner.cookie);
    expect(client.status).toBe(200);

    await deps.reconciler.reconcileSession(hidden);
    await deps.reconciler.reconcileSession(own);
    expect(await client.next()).toEqual({
      event: 'session.state',
      data: { sessionId: own, state: 'starting', errorReason: null },
    });
  });

  it('sends session.activity of readable sessions only', async () => {
    const owner = await login();
    const stranger = await login();
    const own = deps.sessions.create(owner.context, {
      name: 'Own',
      allowlist: ['*'],
      start: false,
    }).id;
    const hidden = deps.sessions.create(stranger.context, {
      name: 'Hidden',
      allowlist: ['*'],
      start: false,
    }).id;
    const client = await openEvents(owner.cookie);
    const agentActivity = {
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_click', status: 'ok' as const, durationMs: 230, startedAt: 1 },
    };
    deps.bus.publish({ type: 'session.activity', sessionId: hidden, agentActivity });
    deps.bus.publish({ type: 'session.activity', sessionId: own, agentActivity });
    expect(await client.next()).toEqual({
      event: 'session.activity',
      data: { sessionId: own, agentActivity },
    });
  });

  it('checks session.read when it sends, after a rights change', async () => {
    const admin = await login('admin');
    const member = await login();
    const sid = deps.sessions.create(member.context, {
      name: 'Member',
      allowlist: ['*'],
      start: false,
    }).id;
    const client = await openEvents(admin.cookie);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'starting',
      previous: 'stopped',
      errorReason: null,
    });
    expect((await client.next()).data).toMatchObject({ sessionId: sid, state: 'starting' });

    deps.db.update(users).set({ role: 'member' }).where(eq(users.id, admin.user.id)).run();
    deps.bus.publish({ type: 'rights.changed', userId: admin.user.id });
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'running',
      previous: 'starting',
      errorReason: null,
    });
    await expect(client.next(200)).rejects.toThrow('no SSE event');
  });

  it('sends events of a session that the user can read only after the stream opened', async () => {
    const owner = await login();
    const viewer = await login();
    const client = await openEvents(viewer.cookie);
    const sid = deps.sessions.create(owner.context, { name: 'Later', allowlist: ['*'] }).id;
    deps.access.addMember(owner.context, sid, { email: viewer.user.email, role: 'viewer' });
    await deps.reconciler.reconcileSession(sid);
    expect(await client.next()).toEqual({
      event: 'session.state',
      data: { sessionId: sid, state: 'starting', errorReason: null },
    });
  });

  it('stops the events of a session at once when the member is removed', async () => {
    const owner = await login();
    const viewer = await login();
    const sid = deps.sessions.create(owner.context, {
      name: 'Shared',
      allowlist: ['*'],
      start: false,
    }).id;
    deps.access.addMember(owner.context, sid, { email: viewer.user.email, role: 'viewer' });
    const client = await openEvents(viewer.cookie);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'starting',
      previous: 'stopped',
      errorReason: null,
    });
    expect((await client.next()).data).toMatchObject({ sessionId: sid });

    deps.access.removeMember(owner.context, sid, viewer.user.id);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'running',
      previous: 'starting',
      errorReason: null,
    });
    await expect(client.next(200)).rejects.toThrow('no SSE event');
  });

  it('closes the stream when its login session ends', async () => {
    const owner = await login();
    const client = await openEvents(owner.cookie);
    expect(client.status).toBe(200);
    deps.auth.endLoginSessions(owner.user.id);
    await client.ended;
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/events.test.ts`
Expected: FAIL. The route does not exist yet: `expected 404 to be 401` in `needs a login`, `expected 404 to be 200` in the next test, and `no SSE event` in the others.

- [ ] **Step 3: Write the route**

`packages/server/src/api/events.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { SessionActivityEvent, SessionStateEvent } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import type { AuthedUser } from '../auth/index.js';
import { requireLogin } from './context.js';
import { openSse } from './sse.js';

/**
 * GET /api/events (spec section 10.3): session.state and session.activity of all sessions that the
 * user can read. session.read is checked for each event when it is sent.
 */
export function registerEventRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get('/api/events', async (request, reply) => {
    const login = requireLogin(request);
    let user: AuthedUser = login.user;
    const sse = openSse(reply, { clock: deps.clock });
    const unsubscribe = [
      deps.bus.subscribe('session.state', (event) => {
        if (!deps.sessions.readableBy(user, event.sessionId)) return;
        const data: SessionStateEvent = {
          sessionId: event.sessionId,
          state: event.state,
          errorReason: event.errorReason,
        };
        sse.send('session.state', data);
      }),
      deps.bus.subscribe('session.activity', (event) => {
        if (!deps.sessions.readableBy(user, event.sessionId)) return;
        const data: SessionActivityEvent = {
          sessionId: event.sessionId,
          agentActivity: event.agentActivity,
        };
        sse.send('session.activity', data);
      }),
      deps.bus.subscribe('login.ended', (event) => {
        if (event.loginSessionIds.includes(login.loginSessionId)) sse.close();
      }),
      deps.bus.subscribe('rights.changed', (event) => {
        if (event.userId !== user.id) return;
        const fresh = deps.sessions.freshUser(user.id);
        if (!fresh || fresh.status !== 'active') sse.close();
        else user = fresh;
      }),
    ];
    try {
      await sse.closed;
    } finally {
      for (const off of unsubscribe) off();
    }
  });
}
```

- [ ] **Step 4: Register the route**

In `packages/server/src/app.ts`, add the import:

```ts
import { registerEventRoutes } from './api/events.js';
```

In `buildApp`, in the function that registers the routes of the public scope, add this call after `registerSessionRoutes(scope, deps);`:

```ts
    registerEventRoutes(scope, deps);
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/events.test.ts`
Expected: PASS. `Tests  7 passed (7)`.

Run: `pnpm --filter @hydra/server test`
Expected: PASS. All test files of plans 02 to 04 pass; the plan 04 files add 143 tests.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

