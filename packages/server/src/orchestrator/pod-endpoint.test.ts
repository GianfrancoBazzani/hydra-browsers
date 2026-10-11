import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('survives a connection that is reset before the tunnel opens', async () => {
    kube.setPodReady('abcdefghij23', true);
    kube.setPortForwardTarget('session-abcdefghij23-0', 8080, {
      host: '127.0.0.1',
      port: targetPort,
    });
    const url = await resolver.endpoint('abcdefghij23', 8080);
    const socket = connect(Number(new URL(url).port), '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /health HTTP/1.1\r\n\r\n');
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`${url}/health`);
    expect(await response.text()).toBe('pong /health');
  });

  it('keeps no listener when close() runs while endpoint() is in flight', async () => {
    kube.setPodReady('abcdefghij23', true);
    const tcpServers = () =>
      process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
    const before = tcpServers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGet = kube.get.bind(kube);
    const getSpy = vi.spyOn(kube, 'get').mockImplementationOnce(async (kind, name) => {
      await gate;
      return realGet(kind, name);
    });
    const pending = resolver.endpoint('abcdefghij23', 8080);
    await expect.poll(() => getSpy.mock.calls.length).toBe(1);
    const closing = resolver.close();
    release();
    await expect(pending).rejects.toThrow('pod endpoint resolver is closed');
    await closing;
    expect(tcpServers()).toBe(before);
  });
});
