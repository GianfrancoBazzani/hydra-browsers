import { spawn } from 'node:child_process';
import { E2E } from './env.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to stdin, then stdin closes. */
  input?: string;
  timeoutMs?: number;
}

/** Runs a command without a shell. Never rejects for a non-zero exit code. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 120_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

/** Runs a command and returns stdout. Rejects for a non-zero exit code. Never prints the input. */
export async function runOk(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.code}:\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

/** kubectl against the k3d cluster only, never against the current context. */
export function kubectl(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return runOk('kubectl', ['--context', E2E.kubeContext, ...args], options);
}

export function kubectlResult(
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return run('kubectl', ['--context', E2E.kubeContext, ...args], options);
}

export function docker(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return runOk('docker', args, options);
}
