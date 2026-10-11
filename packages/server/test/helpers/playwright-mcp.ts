// Starts a local Chromium with a CDP port and the Playwright MCP server of @hydra/mcp-sidecar (index 5.12).
//
// The Chromium build is the one of the playwright-core version that @playwright/mcp 0.0.83 uses
// (Chrome for Testing 155.0.8059.12, playwright "chromium-1247"). The first start downloads it when it is
// missing, with "playwright-mcp install-browser --no-shell chromium" (about 150 MiB, into
// ~/Library/Caches/ms-playwright on macOS and ~/.cache/ms-playwright on Linux, or PLAYWRIGHT_BROWSERS_PATH).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SIDECAR_DIR = fileURLToPath(new URL('../../../mcp-sidecar/', import.meta.url));
const requireFromSidecar = createRequire(path.join(SIDECAR_DIR, 'package.json'));
const MCP_PACKAGE_JSON = requireFromSidecar.resolve('@playwright/mcp/package.json');
const MCP_CLI = path.join(path.dirname(MCP_PACKAGE_JSON), 'cli.js');
const requireFromMcp = createRequire(MCP_PACKAGE_JSON);

/** All opt-in capabilities of @playwright/mcp 0.0.83. Production uses none of them (spec section 7.4). */
export const ALL_CAPS = [
  'config',
  'devtools',
  'network',
  'pdf',
  'storage',
  'testing',
  'vision',
] as const;

/** The Host that Playwright MCP accepts in production (spec section 8.2). The test server accepts only this one. */
export const POD_HOST = 'localhost:8931';

export interface PlaywrightMcp {
  /** Base URL of the MCP server, for example http://127.0.0.1:53123 (the gateway adds /mcp). */
  url: string;
  stop(): Promise<void>;
}

export async function chromiumExecutable(): Promise<string> {
  const { chromium } = requireFromMcp('playwright-core') as {
    chromium: { executablePath(): string };
  };
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    await execFileAsync(process.execPath, [MCP_CLI, 'install-browser', '--no-shell', 'chromium'], {
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  if (!existsSync(executable))
    throw new Error(`Chromium is missing after the download: ${executable}`);
  return executable;
}

function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
  name: string,
): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let output = '';
    const stream = child.stderr;
    if (stream === null) {
      reject(new Error(`${name}: no stderr pipe`));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
      stream.resume(); // keep reading, so that a full pipe cannot block the child
    };
    const onData = (data: Buffer): void => {
      output += data.toString('utf8');
      const match = pattern.exec(output);
      if (match !== null) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`${name} exited with code ${String(code)}:\n${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${name} did not start in ${String(timeoutMs)} ms:\n${output}`));
    }, timeoutMs);
    stream.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 5_000);
  await exited;
  clearTimeout(timer);
}

export async function startPlaywrightMcp(
  options: { caps?: readonly string[] } = {},
): Promise<PlaywrightMcp> {
  const executable = await chromiumExecutable();
  const workDir = mkdtempSync(path.join(tmpdir(), 'hydra-playwright-mcp-'));
  const children: ChildProcess[] = [];
  const stop = async (): Promise<void> => {
    for (const child of children.reverse()) await stopProcess(child);
    // Chromium helper processes can still write into the profile for a moment after the main one exits.
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const chromium = spawn(
      executable,
      [
        '--headless',
        '--no-sandbox',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        `--user-data-dir=${path.join(workDir, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    children.push(chromium);
    const devtools = await waitForOutput(
      chromium,
      /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
      60_000,
      'Chromium',
    );
    const cdpEndpoint = `http://127.0.0.1:${devtools[1] ?? ''}`;

    const caps = options.caps ?? [];
    const mcp = spawn(
      process.execPath,
      [
        MCP_CLI,
        '--cdp-endpoint',
        cdpEndpoint,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--allowed-hosts',
        POD_HOST,
        '--output-dir',
        path.join(workDir, 'output'),
        ...(caps.length > 0 ? ['--caps', caps.join(',')] : []),
      ],
      { cwd: workDir, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    children.push(mcp);
    const listening = await waitForOutput(
      mcp,
      /Listening on http:\/\/localhost:(\d+)\r?\n/,
      30_000,
      'playwright-mcp',
    );
    return { url: `http://127.0.0.1:${listening[1] ?? ''}`, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
