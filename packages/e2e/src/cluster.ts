import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E } from './env.js';
import { docker, kubectl, kubectlResult, run } from './shell.js';
import { missingTraefikArgs } from './traefik.js';

interface KubeList<T> {
  items: T[];
}
interface KubeNode {
  metadata: { name: string };
  status: {
    addresses: Array<{ type: string; address: string }>;
    conditions: Array<{ type: string; status: string }>;
  };
}
interface KubePod {
  status: { podIP?: string };
}
interface KubeDeployment {
  spec: { replicas?: number };
}
interface KubeTraefikDeployment {
  spec: { template: { spec: { containers: Array<{ args?: string[] }> } } };
}
interface KubeService {
  spec: { clusterIP: string; ports: Array<{ port: number }> };
}
interface KubePvc {
  spec: { volumeName?: string };
}
interface KubePv {
  spec: {
    hostPath?: { path: string };
    local?: { path: string };
    nodeAffinity?: {
      required?: {
        nodeSelectorTerms: Array<{ matchExpressions?: Array<{ key: string; values?: string[] }> }>;
      };
    };
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export async function getJson<T>(args: readonly string[]): Promise<T> {
  return JSON.parse(await kubectl([...args, '-o', 'json'])) as T;
}

/**
 * Waits until the Traefik of k3s is installed with the dev values. scripts/dev-cluster.sh applies
 * deploy/traefik/dev.yaml and does not wait for the rollout, so the first request of a test can
 * reach the old Traefik (chart defaults) or none. Three checks, each with a time limit:
 * the Helm job `helm-install-traefik` is complete, the Deployment has the dev arguments
 * (the Helm job upgrades it), and the new Deployment revision is rolled out.
 */
export async function waitForTraefik(): Promise<void> {
  const job = await kubectlResult(
    [
      'wait',
      '--for=condition=complete',
      'job/helm-install-traefik',
      '-n',
      'kube-system',
      '--timeout=300s',
    ],
    { timeoutMs: 330_000 },
  );
  if (job.code !== 0) {
    throw new Error(
      `The Helm job helm-install-traefik in kube-system is not complete after 300 s ` +
        `(did scripts/dev-cluster.sh finish?): ${job.stderr}${job.stdout}`,
    );
  }
  const deadline = Date.now() + 180_000;
  for (;;) {
    const deployment = await getJson<KubeTraefikDeployment>([
      'get',
      'deployment',
      'traefik',
      '-n',
      'kube-system',
    ]);
    const missing = missingTraefikArgs(deployment.spec.template.spec.containers[0]?.args ?? []);
    if (missing.length === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The Traefik Deployment lacks the dev values of deploy/traefik/dev.yaml after 180 s. ` +
          `Missing arguments: ${missing.join(' ')}. Run scripts/dev-cluster.sh again.`,
      );
    }
    await sleep(2_000);
  }
  const rollout = await kubectlResult(
    ['rollout', 'status', 'deployment/traefik', '-n', 'kube-system', '--timeout=300s'],
    { timeoutMs: 330_000 },
  );
  if (rollout.code !== 0) {
    throw new Error(
      `deployment/traefik in kube-system is not rolled out after 300 s: ${rollout.stderr}${rollout.stdout}`,
    );
  }
}

/** Fails unless the k3d cluster runs the gateway, Traefik with the dev values, the image pre-pull, and the test site. */
export async function checkCluster(): Promise<void> {
  const nodes = await getJson<KubeList<KubeNode>>(['get', 'nodes']);
  const ready = nodes.items.filter((node) =>
    node.status.conditions.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  );
  if (ready.length === 0) {
    throw new Error(`No Ready node in the cluster of the kubectl context ${E2E.kubeContext}`);
  }
  // E2E mode needs the in-cluster gateway. The host development mode (pnpm dev) scales it to 0
  // (spec section 11.7), and `kubectl rollout status` passes for 0 replicas.
  const gateway = await getJson<KubeDeployment>([
    'get',
    'deployment',
    E2E.gatewayDeployment,
    '-n',
    E2E.gatewayNamespace,
  ]);
  if ((gateway.spec.replicas ?? 1) < 1) {
    throw new Error(
      `The in-cluster gateway has 0 replicas (pnpm dev scales it to 0). Stop pnpm dev, then run: ` +
        `kubectl --context ${E2E.kubeContext} -n ${E2E.gatewayNamespace} ` +
        `scale deployment/${E2E.gatewayDeployment} --replicas=1`,
    );
  }
  await waitForTraefik();
  const rollouts: Array<[string, string, string]> = [
    [`deployment/${E2E.gatewayDeployment}`, E2E.gatewayNamespace, '300s'],
    // The pre-pull DaemonSet makes the first start meet the 60 s goal (spec section 11.2).
    [`daemonset/${E2E.prepullDaemonSet}`, E2E.sessionNamespace, '900s'],
    [`deployment/${E2E.testsite.deployment}`, E2E.testsite.namespace, '300s'],
  ];
  for (const [resource, namespace, timeout] of rollouts) {
    await kubectl(['rollout', 'status', resource, '-n', namespace, `--timeout=${timeout}`], {
      timeoutMs: 960_000,
    });
  }
}

export async function nodeInternalIp(): Promise<string> {
  const nodes = await getJson<KubeList<KubeNode>>(['get', 'nodes']);
  const address = nodes.items[0]?.status.addresses.find(
    (entry) => entry.type === 'InternalIP',
  )?.address;
  if (address === undefined) {
    throw new Error('The node has no InternalIP');
  }
  return address;
}

export async function podIp(namespace: string, pod: string): Promise<string> {
  const ip = (await getJson<KubePod>(['get', 'pod', pod, '-n', namespace])).status.podIP;
  if (ip === undefined) {
    throw new Error(`Pod ${namespace}/${pod} has no IP`);
  }
  return ip;
}

export interface GatewayTargets {
  serviceIp: string;
  servicePort: number;
  podIp: string;
}

export async function gatewayTargets(): Promise<GatewayTargets> {
  const service = await getJson<KubeService>([
    'get',
    'service',
    E2E.gatewayService,
    '-n',
    E2E.gatewayNamespace,
  ]);
  const pods = await getJson<KubeList<KubePod>>([
    'get',
    'pods',
    '-n',
    E2E.gatewayNamespace,
    '-l',
    'app=hydra-gateway',
  ]);
  const servicePort = service.spec.ports[0]?.port;
  const ip = pods.items[0]?.status.podIP;
  if (servicePort === undefined || ip === undefined) {
    throw new Error('The gateway Service has no port or the gateway pod has no IP');
  }
  return { serviceIp: service.spec.clusterIP, servicePort, podIp: ip };
}

/** The objects of one session (spec section 7.3), as `kubectl get -o name` prints them. */
export function sessionObjectNames(sid: string): string[] {
  return [
    `configmap/chromium-${sid}`,
    `persistentvolumeclaim/profile-${sid}`,
    `pod/session-${sid}-0`,
    `secret/neko-${sid}`,
    `service/media-${sid}`,
    `service/session-${sid}`,
    `statefulset.apps/session-${sid}`,
  ];
}

/** The session objects that exist, found by name and by the label hydra/session-id. Sorted. */
export async function existingSessionObjects(sid: string): Promise<string[]> {
  const byName = await kubectl([
    'get',
    ...sessionObjectNames(sid),
    '-n',
    E2E.sessionNamespace,
    '--ignore-not-found',
    '-o',
    'name',
  ]);
  const byLabel = await kubectl([
    'get',
    'statefulsets,services,configmaps,secrets,persistentvolumeclaims,pods',
    '-n',
    E2E.sessionNamespace,
    '-l',
    `hydra/session-id=${sid}`,
    '-o',
    'name',
  ]);
  return [...new Set([...lines(byName), ...lines(byLabel)])].sort();
}

export interface NodeVolume {
  pvName: string;
  /** Kubernetes node name. In k3d it is also the name of the node container. */
  node: string;
  /** Folder of the volume inside the node. */
  path: string;
}

/** Finds the local-path folder of a bound PVC. */
export async function pvcVolume(namespace: string, pvc: string): Promise<NodeVolume> {
  const pvName = (await getJson<KubePvc>(['get', 'pvc', pvc, '-n', namespace])).spec.volumeName;
  if (pvName === undefined || pvName === '') {
    throw new Error(`PVC ${namespace}/${pvc} is not bound`);
  }
  const volume = await getJson<KubePv>(['get', 'pv', pvName]);
  // The pathPattern ends with "/" (spec section 5.2). Remove a trailing slash, if the PV keeps it.
  const path = (volume.spec.hostPath?.path ?? volume.spec.local?.path)?.replace(/\/+$/, '');
  const node = volume.spec.nodeAffinity?.required?.nodeSelectorTerms[0]?.matchExpressions?.find(
    (expression) => expression.key === 'kubernetes.io/hostname',
  )?.values?.[0];
  if (path === undefined || node === undefined) {
    throw new Error(`PV ${pvName} has no local path or no node affinity`);
  }
  return { pvName, node, path };
}

export async function pvExists(pvName: string): Promise<boolean> {
  return (await kubectl(['get', 'pv', pvName, '--ignore-not-found', '-o', 'name'])).trim() !== '';
}

/** True if the path exists inside the k3d node container. */
export async function nodePathExists(node: string, path: string): Promise<boolean> {
  const result = await run('docker', ['exec', node, 'sh', '-c', 'test -e "$1"', 'sh', path]);
  if (result.code === 0) {
    return true;
  }
  if (result.code === 1) {
    return false;
  }
  throw new Error(`docker exec ${node} failed with ${result.code}: ${result.stderr}`);
}

async function listNodeDir(node: string, dir: string): Promise<string[]> {
  return lines(
    await docker(['exec', node, 'sh', '-c', 'ls -1 "$1" 2>/dev/null || true', 'sh', dir]),
  );
}

const PROBE_SCRIPT = [
  "const net = require('node:net');",
  'const [host, port] = process.argv.slice(1);',
  'const socket = net.connect({ host, port: Number(port), timeout: 3000 });',
  "socket.on('connect', () => { console.log('open'); socket.destroy(); });",
  "socket.on('timeout', () => { console.log('timeout'); socket.destroy(); });",
  "socket.on('error', (error) => { console.log(error.code === 'ECONNREFUSED' ? 'refused' : 'error:' + error.code); });",
].join('\n');

/**
 * Opens a TCP connection from inside a session pod (container "mcp", which has node).
 * Returns "open", "refused", "timeout", or "error:<code>".
 */
export async function tcpProbe(pod: string, host: string, port: number): Promise<string> {
  const result = await kubectlResult(
    [
      'exec',
      '-n',
      E2E.sessionNamespace,
      pod,
      '-c',
      'mcp',
      '--',
      'node',
      '-e',
      PROBE_SCRIPT,
      host,
      String(port),
    ],
    { timeoutMs: 60_000 },
  );
  const outcome = result.stdout.trim();
  if (result.code !== 0 || outcome === '') {
    throw new Error(`The probe in ${pod} failed (exit ${result.code}): ${result.stderr}`);
  }
  return outcome;
}

/**
 * Creates the first admin with the gateway CLI (spec section 6.3), as
 * `printf '%s\n' "$PASSWORD" | kubectl exec -i -n hydra deploy/hydra-gateway -- hydra user create
 * --admin --email <e>`. Without `-t` the CLI has no terminal, so it reads the password from the
 * first line of stdin. The password never appears in the arguments or in the logs.
 */
export async function createAdminWithCli(email: string, password: string): Promise<void> {
  await kubectl(
    [
      'exec',
      '-i',
      '-n',
      E2E.gatewayNamespace,
      `deployment/${E2E.gatewayDeployment}`,
      '--',
      'hydra',
      'user',
      'create',
      '--admin',
      '--email',
      email,
    ],
    { input: `${password}\n`, timeoutMs: 120_000 },
  );
}

/** IPv4 subnets of the Docker network of the k3d cluster. */
export async function dockerNetworkSubnets(): Promise<string[]> {
  const output = await docker([
    'network',
    'inspect',
    E2E.dockerNetwork,
    '--format',
    '{{json .IPAM.Config}}',
  ]);
  const config = JSON.parse(output) as Array<{ Subnet?: string }>;
  return config.map((entry) => entry.Subnet ?? '').filter((subnet) => subnet.includes('.'));
}

/**
 * Reads the `ip` of the audit events of one kind and one actor from the gateway database.
 * The API has no route for events without a session, so the test takes a consistent copy:
 * `hydra db backup` in the gateway pod, then `docker cp` of the new file out of the k3d node.
 */
export async function auditIps(kind: string, actorId: string): Promise<string[]> {
  const volume = await pvcVolume(E2E.gatewayNamespace, E2E.gatewayDataPvc);
  const backupDir = `${volume.path}/backups`;
  const before = new Set(await listNodeDir(volume.node, backupDir));
  await kubectl([
    'exec',
    '-n',
    E2E.gatewayNamespace,
    `deployment/${E2E.gatewayDeployment}`,
    '--',
    'hydra',
    'db',
    'backup',
  ]);
  const created = (await listNodeDir(volume.node, backupDir))
    .filter((name) => !before.has(name))
    .sort();
  const file = created.at(-1);
  if (file === undefined) {
    throw new Error(`hydra db backup created no file in ${backupDir}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'hydra-e2e-db-'));
  const copy = join(dir, 'hydra.db');
  try {
    await docker(['cp', `${volume.node}:${backupDir}/${file}`, copy]);
    // Loaded here, so that only this test prints the ExperimentalWarning of node:sqlite.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(copy);
    try {
      const rows = db
        .prepare('SELECT data FROM audit_events WHERE kind = ? AND actor_id = ? ORDER BY id DESC')
        .all(kind, actorId);
      return rows.map((row) => {
        const data = JSON.parse(String(row.data)) as { ip?: unknown };
        if (typeof data.ip !== 'string') {
          throw new Error(`An ${kind} event has no ip: ${String(row.data)}`);
        }
        return data.ip;
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
