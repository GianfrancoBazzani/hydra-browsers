// The state of the session pods after a failed test. The sessionPair fixture deletes its pods when the
// worker stops, before the diagnostics step of CI runs, so the logs go into the Playwright report.
import type { TestInfo } from '@playwright/test';
import { E2E } from './env.js';
import { kubectlResult } from './shell.js';

/** The containers of a session pod (spec section 7.3). */
export const SESSION_CONTAINERS = ['neko', 'mcp'] as const;
const LOG_LINES = 2_000;

interface PodList {
  items: Array<{
    metadata: { name: string; deletionTimestamp?: string };
  }>;
}

/** The names of the pods in a `kubectl get pods -o json` list that are not being deleted. */
export function livePodNames(list: PodList): string[] {
  return list.items
    .filter((pod) => pod.metadata.deletionTimestamp === undefined)
    .map((pod) => pod.metadata.name);
}

/** stdout of a kubectl command, or its exit code and stderr. It never rejects. */
async function kubectlText(args: readonly string[]): Promise<string> {
  try {
    const result = await kubectlResult(args, { timeoutMs: 30_000 });
    return result.code === 0
      ? result.stdout
      : `kubectl ${args.join(' ')} exited with ${result.code}:\n${result.stderr}${result.stdout}`;
  } catch (err) {
    return `kubectl ${args.join(' ')} failed: ${String(err)}`;
  }
}

async function attachText(testInfo: TestInfo, name: string, body: string): Promise<void> {
  await testInfo.attach(name, { body, contentType: 'text/plain' });
}

/**
 * Attaches the CPU and memory use of the node and the session pods, and the description and the
 * logs of the neko and mcp containers of each pod. If `podNames` is not given, it uses all session
 * pods that are not being deleted. It never fails, so it does not hide the error of the test.
 */
export async function attachSessionLogs(testInfo: TestInfo, podNames?: string[]): Promise<void> {
  const namespace = E2E.sessionNamespace;
  let pods = podNames;
  if (pods === undefined) {
    try {
      pods = livePodNames(
        JSON.parse(await kubectlText(['get', 'pods', '-n', namespace, '-o', 'json'])) as PodList,
      );
    } catch {
      pods = [];
    }
  }
  const top = await Promise.all([
    kubectlText(['top', 'node']),
    kubectlText(['top', 'pod', '-n', namespace, '--containers']),
  ]);
  await attachText(testInfo, 'kubectl-top.txt', top.join('\n'));
  for (const pod of pods) {
    await attachText(
      testInfo,
      `${pod}-describe.txt`,
      await kubectlText(['describe', 'pod', pod, '-n', namespace]),
    );
    for (const container of SESSION_CONTAINERS) {
      await attachText(
        testInfo,
        `${pod}-${container}.log`,
        await kubectlText([
          'logs',
          pod,
          '-n',
          namespace,
          '-c',
          container,
          '--timestamps',
          `--tail=${LOG_LINES}`,
        ]),
      );
    }
  }
}

/** The pod of a session (spec section 7.3). */
export function sessionPodName(sid: string): string {
  return `session-${sid}-0`;
}
