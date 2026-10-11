import { KubeConfig } from '@kubernetes/client-node';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../test/helpers/config.js';
import { createLogger } from '../lib/logger.js';
import { createKubeClient, KUBE_CALL_TIMEOUT_MS } from './kube-client.js';
import { checkMediaPortRange } from './media-port-check.js';
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
let kubeConfig: KubeConfig;

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
  kubeConfig = new KubeConfig();
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

const PODS_PATH = '/api/v1/namespaces/hydra-sessions/pods';

const podAt = (resourceVersion: string) => ({
  kind: 'Pod',
  apiVersion: 'v1',
  metadata: {
    name: 'session-abcdefghij23-0',
    namespace: 'hydra-sessions',
    resourceVersion,
    labels: { 'hydra/session-id': 'abcdefghij23' },
  },
});

/** A 200 watch answer that stays open until the client goes away. */
function openStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.flushHeaders();
}

/** A 200 watch answer with the given events, then the end of the stream. */
function streamEvents(response: ServerResponse, events: unknown[]): void {
  openStream(response);
  response.end(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

/**
 * Answers watch requests. Pod watches are numbered from 1 and passed to `answer`; watches of the
 * other kinds stay open.
 */
function watchHandler(
  podWatches: URLSearchParams[],
  answer: (index: number, response: ServerResponse) => void,
): Handler {
  return (request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.searchParams.get('watch') !== 'true') return false;
    if (url.pathname !== PODS_PATH) {
      openStream(response);
      return true;
    }
    podWatches.push(url.searchParams);
    answer(podWatches.length, response);
    return true;
  };
}

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
    const result = await kube.checkNodePorts([52000, 52099]);
    expect(result.outOfRange).toBe(true);
    expect(result.message).toContain('provided port is not in the valid range');
    const post = requests.find((r) => r.method === 'POST')!;
    expect(new URL(post.url, 'http://x').pathname).toBe(
      '/api/v1/namespaces/hydra-sessions/services',
    );
    const body = JSON.parse(post.body) as { metadata: unknown; spec: Record<string, unknown> };
    expect(body).toMatchObject({
      metadata: {
        name: 'hydra-port-check-52000',
        namespace: 'hydra-sessions',
        labels: { 'app.kubernetes.io/managed-by': 'hydra' },
      },
      spec: {
        type: 'NodePort',
        ports: [{ port: 52000, targetPort: 52000, nodePort: 52000, protocol: 'TCP' }],
      },
    });
    expect(body.spec['selector']).toBeUndefined();
  });

  it('passes and deletes the check Services when the API accepts the ports', async () => {
    handlers.push(
      (request, response) =>
        request.method === 'POST' && json(response, 201, JSON.parse(request.body)),
    );
    handlers.push(
      (request, response) => request.method === 'DELETE' && json(response, 200, status(200, 'ok')),
    );
    await expect(kube.checkNodePorts([52000, 52099])).resolves.toEqual({
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
    await expect(kube.checkNodePorts([52000])).resolves.toEqual({
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

  it('drops the resource version after an in-stream 410 ERROR event', async () => {
    const podWatches: URLSearchParams[] = [];
    handlers.push(
      watchHandler(podWatches, (index, response) => {
        if (index === 1) streamEvents(response, [{ type: 'ADDED', object: podAt('41') }]);
        else if (index === 2)
          streamEvents(response, [
            {
              type: 'ERROR',
              object: status(410, 'too old resource version'),
            },
          ]);
        else openStream(response);
      }),
    );
    const stop = await kube.watch(() => undefined);
    await expect.poll(() => podWatches.length, { timeout: 5_000 }).toBe(3);
    stop();
    expect(podWatches[1]?.get('resourceVersion')).toBe('41');
    expect(podWatches[2]?.get('resourceVersion')).toBeNull();
  });

  it('drops the resource version after an HTTP 410 answer to a watch', async () => {
    const podWatches: URLSearchParams[] = [];
    handlers.push(
      watchHandler(podWatches, (index, response) => {
        if (index === 1) streamEvents(response, [{ type: 'ADDED', object: podAt('41') }]);
        else if (index === 2) json(response, 410, status(410, 'too old resource version'));
        else openStream(response);
      }),
    );
    const stop = await kube.watch(() => undefined);
    await expect.poll(() => podWatches.length, { timeout: 5_000 }).toBe(3);
    stop();
    expect(podWatches[1]?.get('resourceVersion')).toBe('41');
    expect(podWatches[2]?.get('resourceVersion')).toBeNull();
  });

  it('starts no watch request after stop, and the server closes with no open connection', async () => {
    const podWatches: URLSearchParams[] = [];
    handlers.push(
      watchHandler(podWatches, (index, response) => {
        if (index === 1) streamEvents(response, [{ type: 'ADDED', object: podAt('41') }]);
        else openStream(response);
      }),
    );
    const stop = await kube.watch(() => undefined);
    await expect.poll(() => podWatches.length, { timeout: 5_000 }).toBe(1);
    // The first watch ends at once, so its restart (1 s) is pending when stop runs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(podWatches).toHaveLength(1);
    // Every watch the client opened is aborted by stop, so the server can close without
    // closeAllConnections. Without that, close would never complete and the test would time out.
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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

describe('createKubeClient timeouts', () => {
  const TIMEOUT_MS = 50;
  let hang: (response: ServerResponse) => true;
  let allClosed: () => boolean;
  let slow: KubeClient;

  beforeEach(() => {
    // A hung API server: it accepts the request and never answers. `allClosed` is true when the
    // server saw the close of every hung request, because the client aborted it. The state is local
    // to the test: a late close of an earlier test must not count.
    const state = { hung: 0, closed: 0 };
    hang = (response) => {
      state.hung++;
      response.on('close', () => state.closed++);
      return true;
    };
    allClosed = () => state.hung > 0 && state.closed === state.hung;
    handlers.push((_request, response) => hang(response));
    slow = createKubeClient(testConfig(), kubeConfig, {
      callTimeoutMs: TIMEOUT_MS,
      pingTimeoutMs: TIMEOUT_MS,
    });
  });

  it('has a default of 15 s', () => {
    expect(KUBE_CALL_TIMEOUT_MS).toBe(15_000);
  });

  it.each([
    ['apply', (client: KubeClient) => client.apply(configMap)],
    ['remove', (client: KubeClient) => client.remove('Secret', 'neko-x')],
    ['get', (client: KubeClient) => client.get('Secret', 'neko-x')],
    ['list', (client: KubeClient) => client.list('Pod', 'app.kubernetes.io/managed-by=hydra')],
    ['readLog', (client: KubeClient) => client.readLog('session-abcdefghij23-0', 'neko', 50)],
    ['checkNodePorts', (client: KubeClient) => client.checkNodePorts([52000])],
  ])('%s rejects after the timeout', async (_name, call) => {
    await expect(call(slow)).rejects.toThrow(`timeout after ${TIMEOUT_MS} ms`);
  });

  it('aborts the request at the timeout, so no request outlives it', async () => {
    await expect(slow.get('Secret', 'neko-x')).rejects.toThrow('timeout after');
    await expect.poll(allClosed, { timeout: 2_000 }).toBe(true);
  });

  it('aborts the request of a call of the generated client, too', async () => {
    // The DELETE of the old check Service answers 404; the POST of the check Service hangs.
    handlers.length = 0;
    handlers.push((request, response) => request.method === 'POST' && hang(response));
    await expect(slow.checkNodePorts([52000])).rejects.toThrow('timeout after');
    await expect.poll(allClosed, { timeout: 2_000 }).toBe(true);
  });

  it('times each Service call of checkNodePorts, not the whole loop', async () => {
    // Every request answers after 30 ms; four calls take 120 ms, more than the timeout of 50 ms.
    handlers.length = 0;
    handlers.push((request, response) => {
      setTimeout(() => {
        if (request.method === 'POST') json(response, 201, JSON.parse(request.body));
        else json(response, 200, status(200, 'ok'));
      }, 30);
      return true;
    });
    await expect(slow.checkNodePorts([52000, 52001])).resolves.toEqual({
      outOfRange: false,
      message: null,
    });
  });

  it('pings false after the timeout and aborts the request', async () => {
    await expect(slow.ping()).resolves.toBe(false);
    await expect.poll(allClosed, { timeout: 2_000 }).toBe(true);
  });

  it('lets checkMediaPortRange log a warning and pass', async () => {
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn');
    await expect(
      checkMediaPortRange({ kube: slow, config: testConfig(), logger }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
