// CI check of the dependency pinning policy and of config parity (spec section 3.4.7).
// Run: node scripts/check-repo.ts
// Node.js 24 runs this file with type stripping. Thus: erasable TypeScript syntax only, and only
// Node.js built-in modules, because CI runs the check before `pnpm install`.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Problem {
  /** Path relative to the repository root, with "/" separators. */
  file: string;
  message: string;
}

export interface ImageRef {
  name: string;
  tag: string | null;
  digest: string | null;
}

/** Our own images. CI builds them and writes their digests into the overlays (spec section 3.4.4). */
export const OWN_IMAGES: ReadonlySet<string> = new Set([
  'hydra-gateway',
  'hydra-session',
  'hydra-mcp',
  'hydra-testsite',
]);

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DOCKERFILE = /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|[^/]+\.[Dd]ockerfile)$/;
const YAML = /\.ya?ml$/;
const IMAGE_FORMAT = 'an image needs a tag and a digest (name:tag@sha256:<digest>)';
const TRAEFIK_PROD = 'deploy/traefik/prod.yaml';
const TRAEFIK_DEV = 'deploy/traefik/dev.yaml';

/** All files below `root`, sorted, without .git, node_modules, dist, and coverage folders. */
export function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        files.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(root, '');
  return files.sort();
}

/** Splits `registry/name:tag@sha256:digest`. A registry port is not a tag. */
export function parseImage(reference: string): ImageRef {
  let rest = reference;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { name: rest, tag, digest };
}

/**
 * The entry point timeouts of a Traefik HelmChartConfig: each YAML key path or command-line flag
 * that contains "timeout" (any case), with its value.
 */
export function traefikTimeouts(text: string): Map<string, string> {
  const timeouts = new Map<string, string>();
  const parents: Array<{ indent: number; key: string }> = [];
  for (const rawLine of lines(text)) {
    const line = stripComment(rawLine);
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const flag = /^-\s+["']?--([\w.-]+)=([^"']*)["']?$/.exec(trimmed);
    if (flag) {
      if (/timeout/i.test(flag[1]!)) timeouts.set(flag[1]!, flag[2]!);
      continue;
    }
    const entry = /^(?:-\s+)?([\w.-]+):(?:\s+(.*))?$/.exec(trimmed);
    if (!entry) continue;
    const indent = line.length - line.trimStart().length;
    while (parents.length > 0 && parents[parents.length - 1]!.indent >= indent) parents.pop();
    const key = entry[1]!;
    const value = unquote(entry[2] ?? '');
    if (value === '' || /^[|>][-+]?$/.test(value)) {
      parents.push({ indent, key });
      continue;
    }
    const path = [...parents.map((parent) => parent.key), key].join('.');
    if (/timeout/i.test(path)) timeouts.set(path, value);
  }
  return timeouts;
}

/** Runs all checks of spec section 3.4.7 on the repository at `root`. */
export function checkRepo(root: string): Problem[] {
  const files = listFiles(root);
  return [
    ...checkPackageManifests(root, files),
    ...checkWorkspaceOverrides(root),
    ...checkImages(root, files),
    ...checkWorkflows(root, files),
    ...checkNodeVersions(root, files),
    ...checkPnpmVersions(root, files),
    ...checkTraefikTimeouts(root, files),
    ...checkSidecarPlaywright(root),
  ];
}

function checkPackageManifests(root: string, files: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const file of files.filter((path) => /(?:^|\/)package\.json$/.test(path))) {
    const add = (message: string): void => {
      problems.push({ file, message });
    };
    const manifest = readJson(root, file);
    if (manifest === null) {
      add('is not valid JSON');
      continue;
    }
    const pnpm = manifest.pnpm;
    const pnpmOverrides =
      typeof pnpm === 'object' && pnpm !== null
        ? (pnpm as Record<string, unknown>).overrides
        : undefined;
    const specMaps: Array<{ path: string; value: unknown; nested: boolean }> = [
      ...DEPENDENCY_FIELDS.map((field) => ({ path: field, value: manifest[field], nested: false })),
      { path: 'overrides', value: manifest.overrides, nested: true },
      { path: 'resolutions', value: manifest.resolutions, nested: true },
      { path: 'pnpm.overrides', value: pnpmOverrides, nested: true },
    ];
    for (const { path, value, nested } of specMaps) {
      if (typeof value !== 'object' || value === null) continue;
      for (const [name, spec] of Object.entries(value)) {
        // Nested npm overrides are objects with their own specs; only plain strings are checked.
        if (nested && typeof spec === 'object' && spec !== null) continue;
        if (!isExactSpec(spec)) add(`${path}.${name}: "${String(spec)}" is not an exact version`);
      }
    }
    const packageManager = manifest.packageManager;
    if (packageManager !== undefined && !/^pnpm@\d+\.\d+\.\d+$/.test(String(packageManager))) {
      add(`packageManager: "${String(packageManager)}" is not an exact pnpm version`);
    }
  }
  return problems;
}

/**
 * The `overrides:` block of pnpm-workspace.yaml (pnpm 12 reads overrides only there) takes exact
 * versions only. No YAML library: reads the indented `key: value` lines below a column-0 key.
 */
function checkWorkspaceOverrides(root: string): Problem[] {
  const text = readOptional(root, 'pnpm-workspace.yaml');
  if (text === null) return [];
  const problems: Problem[] = [];
  let inBlock = false;
  for (const rawLine of lines(text)) {
    if (stripComment(rawLine).trim() === '') continue; // blank or comment-only
    if (!/^\s/.test(rawLine)) {
      // A column-0 line starts a top-level key and ends the previous block.
      inBlock = stripComment(rawLine).trimEnd() === 'overrides:';
      continue;
    }
    const line = stripComment(rawLine).trim();
    if (!inBlock || line === '') continue;
    // A quoted key can contain ":"; a plain key ends at the first ":" followed by a space or the end.
    const entry =
      /^(["'])(.+?)\1\s*:(?:\s+(.*))?$/.exec(line) ?? /^()([^\s:].*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!entry) continue;
    const key = entry[2]!;
    const value = unquote(entry[3] ?? '');
    if (!isExactSpec(value)) {
      problems.push({
        file: 'pnpm-workspace.yaml',
        message: `overrides.${key}: "${value}" is not an exact version`,
      });
    }
  }
  return problems;
}

function checkImages(root: string, files: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const file of files) {
    const add = (message: string): void => {
      problems.push({ file, message });
    };
    if (DOCKERFILE.test(file)) {
      const stages = new Set<string>();
      for (const { image, stage } of fromLines(read(root, file))) {
        if (image.includes('$')) {
          add(`FROM ${image}: write the image name, not a build argument`);
        } else if (image !== 'scratch' && !stages.has(image.toLowerCase()) && !isPinned(image)) {
          add(`FROM ${image}: ${IMAGE_FORMAT}`);
        }
        if (stage !== null) stages.add(stage.toLowerCase());
      }
    } else if (YAML.test(file) && (file.startsWith('deploy/') || file.startsWith('.github/'))) {
      for (const line of lines(read(root, file))) {
        const match = /^\s*(?:-\s+)?image:\s*(.*)$/.exec(stripComment(line));
        const image = unquote(match?.[1] ?? '');
        if (image !== '' && !isPinned(image)) add(`image ${image}: ${IMAGE_FORMAT}`);
      }
    } else if (file === 'scripts/versions.sh') {
      for (const line of lines(read(root, file))) {
        const match =
          /^\s*(?:(?:export|readonly|declare|local)(?:\s+-\w+)*\s+)?(\w*IMAGE\w*)=(.*)$/.exec(
            stripComment(line),
          );
        const image = unquote(match?.[2] ?? '');
        if (match && !isPinned(image)) add(`${match[1]}=${image}: ${IMAGE_FORMAT}`);
      }
    }
  }
  return problems;
}

function checkWorkflows(root: string, files: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const file of files.filter((path) => path.startsWith('.github/') && YAML.test(path))) {
    const add = (message: string): void => {
      problems.push({ file, message });
    };
    for (const line of lines(read(root, file))) {
      const uses = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (uses) {
        const target = unquote(uses[1]!);
        const ref = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : '';
        if (target.startsWith('./')) {
          // A local action of this repository.
        } else if (target.startsWith('docker://')) {
          if (!isPinned(target.slice('docker://'.length))) add(`uses ${target}: ${IMAGE_FORMAT}`);
        } else if (!FULL_SHA.test(ref)) {
          add(`uses ${target}: pin a full 40-character commit SHA`);
        } else if (!/#\s*\S/.test(uses[2]!)) {
          add(`uses ${target}: add the version in a comment (# vX.Y.Z)`);
        }
      }
      const latest = /\b(?:ubuntu|macos|windows)-latest\b/.exec(stripComment(line));
      if (latest) add(`runner "${latest[0]}": use a fixed image such as ubuntu-24.04`);
    }
  }
  return problems;
}

function checkNodeVersions(root: string, files: string[]): Problem[] {
  const expected = (readOptional(root, '.node-version') ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(expected)) {
    const message = 'must contain an exact Node.js version, for example 24.21.0';
    return [{ file: '.node-version', message }];
  }
  const problems: Problem[] = [];
  const add = (file: string, message: string): void => {
    problems.push({ file, message });
  };
  const differs = (value: string | undefined): string =>
    `${value === undefined ? 'is missing' : `is "${value}"`}, but .node-version is "${expected}"`;

  const runtime = devEnginesRuntime(readJson(root, 'package.json'));
  if (runtime !== expected) add('package.json', `devEngines.runtime.version ${differs(runtime)}`);

  const workspace = readOptional(root, 'pnpm-workspace.yaml') ?? '';
  const nodeVersion = /^nodeVersion:\s*["']?([^"'\s#]+)/m.exec(workspace)?.[1];
  if (nodeVersion !== expected) add('pnpm-workspace.yaml', `nodeVersion ${differs(nodeVersion)}`);

  for (const file of files.filter((path) => DOCKERFILE.test(path))) {
    for (const { image } of fromLines(read(root, file))) {
      const found = nodeVersionOfImage(image);
      if (found === null) continue;
      const wanted = found.majorOnly ? expected.split('.')[0] : expected;
      if (found.version !== wanted) {
        add(file, `FROM ${image}: Node.js ${found.version}, but .node-version is "${expected}"`);
      }
    }
  }
  return problems;
}

function checkPnpmVersions(root: string, files: string[]): Problem[] {
  const packageManager = String(readJson(root, 'package.json')?.packageManager ?? '');
  const problems: Problem[] = [];
  for (const file of files.filter((path) => DOCKERFILE.test(path))) {
    for (const [pinned] of read(root, file).matchAll(/\bpnpm@[^\s"'`\\]+/g)) {
      if (pinned === packageManager) continue;
      problems.push({ file, message: `${pinned}, but packageManager is "${packageManager}"` });
    }
  }
  return problems;
}

/** Spec section 3.4.7: the sidecar uses the playwright version of its @playwright/mcp (one Playwright copy). */
function checkSidecarPlaywright(root: string): Problem[] {
  const file = 'packages/mcp-sidecar/package.json';
  const deps = (readJson(root, file)?.dependencies ?? {}) as Record<string, string>;
  const mcpVersion = deps['@playwright/mcp'];
  if (mcpVersion === undefined) return [];
  const mcpManifest = readJson(
    root,
    `node_modules/.pnpm/@playwright+mcp@${mcpVersion}/node_modules/@playwright/mcp/package.json`,
  );
  const wanted = (mcpManifest?.dependencies as Record<string, string> | undefined)?.playwright;
  if (wanted === undefined || deps.playwright === wanted) return [];
  return [
    {
      file,
      message: `playwright is ${String(deps.playwright)}, but @playwright/mcp ${mcpVersion} needs ${wanted}`,
    },
  ];
}

function checkTraefikTimeouts(root: string, files: string[]): Problem[] {
  const hasProd = files.includes(TRAEFIK_PROD);
  const hasDev = files.includes(TRAEFIK_DEV);
  if (!hasProd && !hasDev) return []; // plan 08 creates both files
  if (!hasProd || !hasDev) {
    const [missing, present] = hasProd ? [TRAEFIK_DEV, TRAEFIK_PROD] : [TRAEFIK_PROD, TRAEFIK_DEV];
    const message = `is missing, but ${present} exists (both set the entry point timeouts)`;
    return [{ file: missing, message }];
  }
  const prod = traefikTimeouts(read(root, TRAEFIK_PROD));
  const dev = traefikTimeouts(read(root, TRAEFIK_DEV));
  const problems: Problem[] = [];
  const add = (file: string, message: string): void => {
    problems.push({ file, message });
  };
  if (prod.size === 0) add(TRAEFIK_PROD, 'sets no entry point timeouts');
  if (dev.size === 0) add(TRAEFIK_DEV, 'sets no entry point timeouts');
  for (const key of [...new Set([...prod.keys(), ...dev.keys()])].sort()) {
    const devValue = dev.get(key);
    const prodValue = prod.get(key);
    if (devValue === prodValue) continue;
    const devText = devValue === undefined ? 'is not set' : `is "${devValue}"`;
    const prodText = prodValue === undefined ? 'does not set it' : `has "${prodValue}"`;
    add(TRAEFIK_DEV, `timeout ${key} ${devText}, but ${TRAEFIK_PROD} ${prodText}`);
  }
  return problems;
}

function isExactSpec(spec: unknown): boolean {
  return typeof spec === 'string' && (EXACT_VERSION.test(spec) || spec === 'workspace:*');
}

/** True for `name:tag@sha256:<digest>`, and for our own images (CI gives their digests). */
function isPinned(image: string): boolean {
  const { name, tag, digest } = parseImage(image);
  if (OWN_IMAGES.has(name.slice(name.lastIndexOf('/') + 1))) return true;
  return tag !== null && TAG.test(tag) && digest !== null && DIGEST.test(digest);
}

/**
 * The Node.js version in the tag of an official `node` image ("24.21.0" from `node:24.21.0-slim`),
 * or the major version of a distroless Node.js image ("24" from `distroless/nodejs24-debian12`,
 * whose tags carry no Node.js version). Null for other images.
 */
function nodeVersionOfImage(image: string): { version: string; majorOnly: boolean } | null {
  const { name, tag } = parseImage(image);
  if (/^(?:(?:docker\.io|index\.docker\.io)\/)?(?:library\/)?node$/.test(name) && tag !== null) {
    return { version: /^\d+\.\d+\.\d+/.exec(tag)?.[0] ?? tag, majorOnly: false };
  }
  const major = /(?:^|\/)distroless\/nodejs(\d+)(?:-|$)/.exec(name)?.[1];
  return major === undefined ? null : { version: major, majorOnly: true };
}

function fromLines(text: string): Array<{ image: string; stage: string | null }> {
  const result: Array<{ image: string; stage: string | null }> = [];
  for (const line of lines(text)) {
    const match = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!match) continue;
    const words = match[1]!.split(/\s+/).filter((word) => word !== '' && !word.startsWith('--'));
    const stage = words[1]?.toLowerCase() === 'as' ? (words[2] ?? null) : null;
    result.push({ image: words[0] ?? '', stage });
  }
  return result;
}

function devEnginesRuntime(manifest: Record<string, unknown> | null): string | undefined {
  const devEngines = manifest?.devEngines as { runtime?: { version?: unknown } } | undefined;
  const version = devEngines?.runtime?.version;
  return typeof version === 'string' ? version : undefined;
}

/** The lines of a file, for LF and CRLF line endings. */
function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Removes a YAML or shell comment (a "#" at the start or after a space, outside quotes). */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

function readOptional(root: string, file: string): string | null {
  try {
    return read(root, file);
  } catch {
    return null;
  }
}

function readJson(root: string, file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(read(root, file));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function main(): void {
  const problems = checkRepo(join(import.meta.dirname, '..'));
  for (const problem of problems) console.error(`${problem.file}: ${problem.message}`);
  if (problems.length > 0) {
    console.error(`check-repo: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log('check-repo: OK');
  }
}

if (import.meta.main) main();
