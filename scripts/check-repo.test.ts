import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRepo, parseImage, traefikTimeouts } from './check-repo.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The files of a minimal repository that passes all checks. */
function baseFiles(): Record<string, string> {
  return {
    '.node-version': '24.21.0\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'pnpm@12.9.0',
      devEngines: { runtime: { name: 'node', version: '24.21.0', onFail: 'download' } },
      devDependencies: { typescript: '6.0.3' },
    }),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\nnodeVersion: 24.21.0\n',
  };
}

/** Writes the base files plus `files` (which can replace base files) into a new temporary folder. */
function check(files: Record<string, string>): ReturnType<typeof checkRepo> {
  const root = mkdtempSync(join(tmpdir(), 'check-repo-'));
  roots.push(root);
  for (const [path, content] of Object.entries({ ...baseFiles(), ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return checkRepo(root);
}

function traefik(timeouts: string): string {
  return [
    'apiVersion: helm.cattle.io/v1',
    'kind: HelmChartConfig',
    'metadata:',
    '  name: traefik',
    '  namespace: kube-system',
    'spec:',
    '  valuesContent: |-',
    '    ports:',
    '      websecure:',
    '        transport:',
    '          respondingTimeouts:',
    timeouts,
    '',
  ].join('\n');
}

describe('base fixture', () => {
  it('passes all checks', () => {
    expect(check({})).toEqual([]);
  });
});

describe('package.json versions', () => {
  it('accepts exact versions, prereleases, and workspace:*', () => {
    const manifest = {
      name: '@hydra/x',
      dependencies: { a: '1.2.3', b: '1.64.0-alpha-1790635538000', '@hydra/shared': 'workspace:*' },
    };
    expect(check({ 'packages/x/package.json': JSON.stringify(manifest) })).toEqual([]);
  });

  it('rejects ranges, tags, and other specifiers', () => {
    const manifest = {
      name: '@hydra/x',
      dependencies: { a: '^1.2.3', b: '~1.2.3', c: '*', d: 'latest' },
      devDependencies: { e: '1.x', f: '>=1.0.0', g: 'workspace:^', h: 'github:owner/repo' },
    };
    const file = 'packages/x/package.json';
    expect(check({ [file]: JSON.stringify(manifest) })).toEqual([
      { file, message: 'dependencies.a: "^1.2.3" is not an exact version' },
      { file, message: 'dependencies.b: "~1.2.3" is not an exact version' },
      { file, message: 'dependencies.c: "*" is not an exact version' },
      { file, message: 'dependencies.d: "latest" is not an exact version' },
      { file, message: 'devDependencies.e: "1.x" is not an exact version' },
      { file, message: 'devDependencies.f: ">=1.0.0" is not an exact version' },
      { file, message: 'devDependencies.g: "workspace:^" is not an exact version' },
      { file, message: 'devDependencies.h: "github:owner/repo" is not an exact version' },
    ]);
  });

  it('ignores package.json files in node_modules and dist', () => {
    const manifest = JSON.stringify({ name: 'dep', dependencies: { a: '^1.0.0' } });
    expect(
      check({
        'node_modules/dep/package.json': manifest,
        'packages/x/dist/package.json': manifest,
      }),
    ).toEqual([]);
  });

  it('rejects a packageManager without an exact pnpm version', () => {
    const manifest = JSON.parse(baseFiles()['package.json']!) as Record<string, unknown>;
    manifest.packageManager = 'pnpm@12';
    expect(check({ 'package.json': JSON.stringify(manifest) })).toEqual([
      { file: 'package.json', message: 'packageManager: "pnpm@12" is not an exact pnpm version' },
    ]);
  });

  it('reports a package.json that is not valid JSON', () => {
    expect(check({ 'packages/x/package.json': '{ "name": ' })).toEqual([
      { file: 'packages/x/package.json', message: 'is not valid JSON' },
    ]);
  });

  it('checks the versions of overrides, resolutions, and pnpm.overrides', () => {
    const accepted = {
      name: '@hydra/x',
      overrides: { a: '1.2.3', nested: { b: '2.0.0' } },
      resolutions: { c: '3.0.0' },
      pnpm: { overrides: { d: '4.0.0' } },
    };
    expect(check({ 'packages/x/package.json': JSON.stringify(accepted) })).toEqual([]);
    const rejected = {
      name: '@hydra/x',
      overrides: { a: '^1.2.3' },
      resolutions: { c: 'latest' },
      pnpm: { overrides: { b: '~2.0.0' } },
    };
    const file = 'packages/x/package.json';
    expect(check({ [file]: JSON.stringify(rejected) })).toEqual([
      { file, message: 'overrides.a: "^1.2.3" is not an exact version' },
      { file, message: 'resolutions.c: "latest" is not an exact version' },
      { file, message: 'pnpm.overrides.b: "~2.0.0" is not an exact version' },
    ]);
  });
});

describe('pnpm-workspace.yaml overrides', () => {
  const workspace = (...overrides: string[]): string =>
    ['packages:', '  - "packages/*"', 'nodeVersion: 24.21.0', 'overrides:', ...overrides, ''].join(
      '\n',
    );
  const notExact = (key: string, value: string) => ({
    file: 'pnpm-workspace.yaml',
    message: `overrides.${key}: "${value}" is not an exact version`,
  });

  it('handles comments, blank lines, and quoted keys and values', () => {
    const text = workspace(
      '  # pinned for a security fix',
      '# a comment at column 0 does not end the block',
      '  foo: 1.2.3',
      '',
      '  bar: 2.0.0-beta.1 # why',
      "  '@scope/pkg@<2': '1.0.0'",
      '  "foo>bar": "3.0.0"',
      '# column-0 comment inside the block',
      '  late: ^1.0.0',
    );
    expect(check({ 'pnpm-workspace.yaml': text })).toEqual([notExact('late', '^1.0.0')]);
  });

  it('accepts exact overrides with CRLF line endings', () => {
    const text = workspace('  foo: 1.2.3', '  "@scope/pkg@<2": 1.0.0').replace(/\n/g, '\r\n');
    expect(check({ 'pnpm-workspace.yaml': text })).toEqual([]);
  });

  it('rejects ranges, "-", and $ references', () => {
    const text = workspace(
      '  a: ^1.0.0',
      '  b: ~2.0.0',
      '  c: -',
      '  d: $foo',
      '  "@scope/pkg@<2": "^1.0.0" # range',
      '  ok: 1.0.0',
    );
    expect(check({ 'pnpm-workspace.yaml': text })).toEqual([
      notExact('a', '^1.0.0'),
      notExact('b', '~2.0.0'),
      notExact('c', '-'),
      notExact('d', '$foo'),
      notExact('@scope/pkg@<2', '^1.0.0'),
    ]);
  });

  it('rejects ranges with CRLF line endings', () => {
    const text = workspace('  a: ^1.0.0', '  b: 1.0.0').replace(/\n/g, '\r\n');
    expect(check({ 'pnpm-workspace.yaml': text })).toEqual([notExact('a', '^1.0.0')]);
  });

  it('ignores a nested overrides key and keys after the block', () => {
    const nested = ['packages:', '  - "packages/*"', 'catalog:', '  overrides: ^1.0.0', ''];
    expect(check({ 'pnpm-workspace.yaml': `${nested.join('\n')}nodeVersion: 24.21.0\n` })).toEqual(
      [],
    );
    const after = workspace('  foo: 1.2.3').concat('minimumReleaseAge: 10080\nother: ^1.0.0\n');
    expect(check({ 'pnpm-workspace.yaml': after })).toEqual([]);
  });

  it('does not read nodeVersion after the block as an override', () => {
    const text = ['overrides:', '  foo: 1.2.3', 'nodeVersion: 24.21.0', ''].join('\n');
    expect(check({ 'pnpm-workspace.yaml': text })).toEqual([]);
  });
});

describe('container images', () => {
  it('accepts tag and digest, build stages, scratch, and our own images', () => {
    const dockerfile = [
      `FROM --platform=$BUILDPLATFORM node:24.21.0-slim@${DIGEST} AS build`,
      'RUN echo build',
      'FROM build AS test',
      'FROM scratch',
      `FROM gcr.io/distroless/nodejs24-debian12:nonroot@${DIGEST}`,
      'COPY --from=build /out /app',
    ].join('\n');
    const manifest = [
      'containers:',
      '  - name: gateway',
      '    image: hydra-gateway',
      '  - name: session',
      '    image: "localhost:5000/hydra-session:abc123"',
      '  - name: pause',
      `    image: registry.k8s.io/pause:3.10@${DIGEST} # pinned`,
    ].join('\n');
    expect(
      check({
        'deploy/Dockerfile': dockerfile,
        'deploy/k8s/base/gateway.yaml': manifest,
        'scripts/versions.sh': `K3S_VERSION="v1.36.5+k3s1"\nK3S_IMAGE="rancher/k3s:v1.36.5-k3s1@${DIGEST}"\n`,
      }),
    ).toEqual([]);
  });

  it('rejects Dockerfile FROM lines without a tag and a digest, or with a build argument', () => {
    const dockerfile = ['FROM node:24.21.0-slim', `FROM node@${DIGEST}`, 'FROM ${BASE_IMAGE}'].join(
      '\n',
    );
    const file = 'deploy/session/Dockerfile.mcp';
    expect(check({ [file]: dockerfile })).toEqual([
      {
        file,
        message:
          'FROM node:24.21.0-slim: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
      {
        file,
        message: `FROM node@${DIGEST}: an image needs a tag and a digest (name:tag@sha256:<digest>)`,
      },
      { file, message: 'FROM ${BASE_IMAGE}: write the image name, not a build argument' },
    ]);
  });

  it('rejects a third-party image without a digest in a manifest and in a workflow', () => {
    expect(
      check({
        'deploy/k8s/base/prepull.yaml': 'containers:\n  - image: registry.k8s.io/pause:3.10\n',
        '.github/workflows/x.yml':
          'jobs:\n  a:\n    services:\n      db:\n        image: redis:7\n',
      }),
    ).toEqual([
      {
        file: '.github/workflows/x.yml',
        message: 'image redis:7: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
      {
        file: 'deploy/k8s/base/prepull.yaml',
        message:
          'image registry.k8s.io/pause:3.10: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
    ]);
  });

  it('rejects an image in scripts/versions.sh without a digest', () => {
    expect(check({ 'scripts/versions.sh': 'K3S_IMAGE="rancher/k3s:v1.36.5-k3s1"\n' })).toEqual([
      {
        file: 'scripts/versions.sh',
        message:
          'K3S_IMAGE=rancher/k3s:v1.36.5-k3s1: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
    ]);
  });

  it('checks images in every declaration form of scripts/versions.sh', () => {
    const pinned = [
      `readonly K3S_IMAGE="rancher/k3s:v1.36.5-k3s1@${DIGEST}"`,
      `declare -r CADDY_IMAGE=caddy:2@${DIGEST}`,
      `local -r OTHER_IMAGE="foo:1@${DIGEST}"`,
      '',
    ].join('\n');
    expect(check({ 'scripts/versions.sh': pinned })).toEqual([]);
    const unpinned = [
      'readonly K3S_IMAGE="rancher/k3s:v1.36.5-k3s1"',
      'declare -r CADDY_IMAGE=caddy:2',
      'local OTHER_IMAGE=foo:1',
      '',
    ].join('\n');
    expect(check({ 'scripts/versions.sh': unpinned })).toEqual([
      {
        file: 'scripts/versions.sh',
        message:
          'K3S_IMAGE=rancher/k3s:v1.36.5-k3s1: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
      {
        file: 'scripts/versions.sh',
        message:
          'CADDY_IMAGE=caddy:2: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
      {
        file: 'scripts/versions.sh',
        message: 'OTHER_IMAGE=foo:1: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
    ]);
  });
});

describe('workflows', () => {
  it('accepts full commit SHAs with a version comment, and local actions', () => {
    const workflow = [
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      `      - uses: actions/checkout@${SHA} # v7.0.1`,
      `      - uses: "pnpm/action-setup@${SHA}" # v6.1.0`,
      '      - uses: ./.github/actions/local',
    ].join('\n');
    expect(check({ '.github/workflows/ci.yml': workflow })).toEqual([]);
  });

  it('rejects tags, short SHAs, missing version comments, and ubuntu-latest', () => {
    const workflow = [
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - uses: actions/setup-node@8207627',
      `      - uses: pnpm/action-setup@${SHA}`,
    ].join('\n');
    const file = '.github/workflows/ci.yml';
    expect(check({ [file]: workflow })).toEqual([
      { file, message: 'runner "ubuntu-latest": use a fixed image such as ubuntu-24.04' },
      { file, message: 'uses actions/checkout@v7: pin a full 40-character commit SHA' },
      { file, message: 'uses actions/setup-node@8207627: pin a full 40-character commit SHA' },
      { file, message: `uses pnpm/action-setup@${SHA}: add the version in a comment (# vX.Y.Z)` },
    ]);
  });
});

describe('line endings', () => {
  it('finds problems in files with CRLF line endings', () => {
    const file = '.github/workflows/ci.yml';
    const workflow = 'jobs:\r\n  a:\r\n    steps:\r\n      - uses: actions/checkout@v7\r\n';
    expect(check({ [file]: workflow, 'deploy/Dockerfile': 'FROM node:24.21.0-slim\r\n' })).toEqual([
      {
        file: 'deploy/Dockerfile',
        message:
          'FROM node:24.21.0-slim: an image needs a tag and a digest (name:tag@sha256:<digest>)',
      },
      { file, message: 'uses actions/checkout@v7: pin a full 40-character commit SHA' },
    ]);
  });
});

describe('Node.js versions', () => {
  it('rejects versions that differ from .node-version', () => {
    const manifest = JSON.parse(baseFiles()['package.json']!) as {
      devEngines: { runtime: { version: string } };
    };
    manifest.devEngines.runtime.version = '24.20.0';
    expect(
      check({
        'package.json': JSON.stringify(manifest),
        'pnpm-workspace.yaml': 'nodeVersion: 24.19.0\n',
        'deploy/Dockerfile': [
          `FROM node:24.18.0-slim@${DIGEST} AS build`,
          `FROM node:24-slim@${DIGEST} AS test`,
          `FROM gcr.io/distroless/nodejs22-debian12:nonroot@${DIGEST}`,
        ].join('\n'),
      }),
    ).toEqual([
      {
        file: 'package.json',
        message: 'devEngines.runtime.version is "24.20.0", but .node-version is "24.21.0"',
      },
      {
        file: 'pnpm-workspace.yaml',
        message: 'nodeVersion is "24.19.0", but .node-version is "24.21.0"',
      },
      {
        file: 'deploy/Dockerfile',
        message: `FROM node:24.18.0-slim@${DIGEST}: Node.js 24.18.0, but .node-version is "24.21.0"`,
      },
      {
        file: 'deploy/Dockerfile',
        message: `FROM node:24-slim@${DIGEST}: Node.js 24-slim, but .node-version is "24.21.0"`,
      },
      {
        file: 'deploy/Dockerfile',
        message: `FROM gcr.io/distroless/nodejs22-debian12:nonroot@${DIGEST}: Node.js 22, but .node-version is "24.21.0"`,
      },
    ]);
  });

  it('checks the official image under docker.io/node', () => {
    const dockerfile = `FROM docker.io/node:22.1.0-slim@${DIGEST}\n`;
    expect(check({ 'deploy/Dockerfile': dockerfile })).toEqual([
      {
        file: 'deploy/Dockerfile',
        message: `FROM docker.io/node:22.1.0-slim@${DIGEST}: Node.js 22.1.0, but .node-version is "24.21.0"`,
      },
    ]);
  });

  it('reports a missing .node-version and a missing nodeVersion', () => {
    expect(check({ '.node-version': '', 'pnpm-workspace.yaml': 'packages: []\n' })).toEqual([
      {
        file: '.node-version',
        message: 'must contain an exact Node.js version, for example 24.21.0',
      },
    ]);
    expect(check({ 'pnpm-workspace.yaml': 'packages: []\n' })).toEqual([
      {
        file: 'pnpm-workspace.yaml',
        message: 'nodeVersion is missing, but .node-version is "24.21.0"',
      },
    ]);
  });
});

describe('pnpm version in Dockerfiles', () => {
  it('requires the packageManager version', () => {
    const file = 'deploy/Dockerfile';
    expect(check({ [file]: 'RUN npm install -g pnpm@12.9.0\n' })).toEqual([]);
    expect(check({ [file]: 'RUN npm install -g pnpm@12.8.0\n' })).toEqual([
      { file, message: 'pnpm@12.8.0, but packageManager is "pnpm@12.9.0"' },
    ]);
  });
});

describe('Traefik entry point timeouts', () => {
  const same =
    '            readTimeout: 0\n            writeTimeout: 0\n            idleTimeout: 600s';

  it('passes when both files are absent', () => {
    expect(check({})).toEqual([]);
  });

  it('fails when only one file exists', () => {
    expect(check({ 'deploy/traefik/prod.yaml': traefik(same) })).toEqual([
      {
        file: 'deploy/traefik/dev.yaml',
        message:
          'is missing, but deploy/traefik/prod.yaml exists (both set the entry point timeouts)',
      },
    ]);
    expect(check({ 'deploy/traefik/dev.yaml': traefik(same) })).toEqual([
      {
        file: 'deploy/traefik/prod.yaml',
        message:
          'is missing, but deploy/traefik/dev.yaml exists (both set the entry point timeouts)',
      },
    ]);
  });

  it('passes when both files set the same timeouts', () => {
    expect(
      check({
        'deploy/traefik/prod.yaml': traefik(same),
        'deploy/traefik/dev.yaml': traefik(same),
      }),
    ).toEqual([]);
  });

  it('fails when a value differs or is missing in one file', () => {
    const dev = '            readTimeout: 60s\n            writeTimeout: 0';
    expect(
      check({ 'deploy/traefik/prod.yaml': traefik(same), 'deploy/traefik/dev.yaml': traefik(dev) }),
    ).toEqual([
      {
        file: 'deploy/traefik/dev.yaml',
        message:
          'timeout spec.valuesContent.ports.websecure.transport.respondingTimeouts.idleTimeout is not set, but deploy/traefik/prod.yaml has "600s"',
      },
      {
        file: 'deploy/traefik/dev.yaml',
        message:
          'timeout spec.valuesContent.ports.websecure.transport.respondingTimeouts.readTimeout is "60s", but deploy/traefik/prod.yaml has "0"',
      },
    ]);
  });

  it('fails when the files set no timeouts', () => {
    const none =
      'spec:\n  valuesContent: |-\n    service:\n      spec:\n        externalTrafficPolicy: Local\n';
    expect(check({ 'deploy/traefik/prod.yaml': none, 'deploy/traefik/dev.yaml': none })).toEqual([
      { file: 'deploy/traefik/prod.yaml', message: 'sets no entry point timeouts' },
      { file: 'deploy/traefik/dev.yaml', message: 'sets no entry point timeouts' },
    ]);
  });

  it('reads nested keys and command-line flags', () => {
    const text = [
      'spec:',
      '  valuesContent: |-',
      '    ports:',
      '      web:',
      '        transport:',
      '          respondingTimeouts:',
      '            readTimeout: "0" # no limit for MCP streams',
      '    additionalArguments:',
      '      - "--entryPoints.web.transport.lifeCycle.graceTimeOut=10s"',
      '      - --log.level=INFO',
    ].join('\n');
    expect([...traefikTimeouts(text)]).toEqual([
      ['spec.valuesContent.ports.web.transport.respondingTimeouts.readTimeout', '0'],
      ['entryPoints.web.transport.lifeCycle.graceTimeOut', '10s'],
    ]);
  });
});

describe('parseImage', () => {
  it('splits name, tag, and digest, also with a registry port', () => {
    expect(parseImage(`localhost:5000/hydra-gateway:abc@${DIGEST}`)).toEqual({
      name: 'localhost:5000/hydra-gateway',
      tag: 'abc',
      digest: DIGEST,
    });
    expect(parseImage('hydra-gateway')).toEqual({ name: 'hydra-gateway', tag: null, digest: null });
  });
});
