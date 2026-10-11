import { gatewayTargets, nodeInternalIp, podIp, tcpProbe } from '../src/cluster.js';
import { E2E } from '../src/env.js';
import { expect, test } from '../src/fixtures.js';

test('a session pod cannot connect to another session pod, the gateway, the node, or 169.254.169.254', async ({
  sessionPair,
}) => {
  const podA = `session-${sessionPair.a.id}-0`;
  const podB = await podIp(E2E.sessionNamespace, `session-${sessionPair.b.id}-0`);
  const gateway = await gatewayTargets();
  const node = await nodeInternalIp();

  // Control: the probe works, and the egress exception of the dev overlay permits the test site.
  expect(await tcpProbe(podA, E2E.testsite.host, E2E.testsite.port)).toBe('open');

  const targets: Array<{ name: string; host: string; port: number }> = [
    { name: 'other session pod, Neko', host: podB, port: 8080 },
    { name: 'other session pod, MCP', host: podB, port: 8931 },
    { name: 'gateway Service', host: gateway.serviceIp, port: gateway.servicePort },
    { name: 'gateway pod', host: gateway.podIp, port: 8080 },
    { name: 'node, API server', host: node, port: 6443 },
    { name: 'node, kubelet', host: node, port: 10250 },
    { name: 'metadata endpoint', host: '169.254.169.254', port: 80 },
  ];
  for (const target of targets) {
    const outcome = await tcpProbe(podA, target.host, target.port);
    expect.soft(outcome, `${target.name} ${target.host}:${target.port}`).not.toBe('open');
  }
});
