import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { missingTraefikArgs, TRAEFIK_DEV_ARGS } from './traefik.js';

describe('missingTraefikArgs', () => {
  it('names the six dev timeout arguments of web and websecure', () => {
    expect(TRAEFIK_DEV_ARGS).toHaveLength(6);
    expect(TRAEFIK_DEV_ARGS).toContain(
      '--entryPoints.web.transport.respondingTimeouts.idleTimeout=180s',
    );
    expect(TRAEFIK_DEV_ARGS).toContain(
      '--entryPoints.websecure.transport.respondingTimeouts.writeTimeout=0s',
    );
  });

  it('returns nothing when every dev argument is present among others', () => {
    expect(missingTraefikArgs(['--ping=true', ...TRAEFIK_DEV_ARGS, '--log.level=INFO'])).toEqual(
      [],
    );
  });

  it('returns the missing arguments, for the chart defaults without the dev values', () => {
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.transport.respondingTimeouts.readTimeout=0s',
    ];
    expect(missingTraefikArgs(args)).toEqual(
      TRAEFIK_DEV_ARGS.filter(
        (arg) => arg !== '--entryPoints.web.transport.respondingTimeouts.readTimeout=0s',
      ),
    );
  });

  it('accepts a custom expected list', () => {
    expect(missingTraefikArgs(['--a'], ['--a', '--b'])).toEqual(['--b']);
  });
});

const DEV_YAML = new URL('../../../deploy/traefik/dev.yaml', import.meta.url);

/**
 * The respondingTimeouts of the entry points in the Helm values of dev.yaml, as the Traefik
 * arguments that the chart produces. The package has no YAML parser, so this scans the lines: an
 * entry point is a key with no value at an indent of 6 spaces (under `ports:`), and each timeout is
 * a `readTimeout`, `writeTimeout`, or `idleTimeout` line with a quoted or plain value.
 */
function traefikArgsFromYaml(text: string): string[] {
  const args: string[] = [];
  let entryPoint: string | undefined;
  for (const line of text.split('\n')) {
    const header = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      entryPoint = header[1];
      continue;
    }
    const timeout = /^\s+(readTimeout|writeTimeout|idleTimeout):\s*"?([^"\s#]+)"?\s*(#.*)?$/.exec(
      line,
    );
    if (timeout && entryPoint) {
      args.push(
        `--entryPoints.${entryPoint}.transport.respondingTimeouts.${timeout[1]}=${timeout[2]}`,
      );
    }
  }
  return args;
}

describe('TRAEFIK_DEV_ARGS and deploy/traefik/dev.yaml', () => {
  const yaml = readFileSync(DEV_YAML, 'utf8');

  it('equals the respondingTimeouts of dev.yaml (change both, or neither)', () => {
    expect(
      [...traefikArgsFromYaml(yaml)].sort(),
      'update TRAEFIK_DEV_ARGS in packages/e2e/src/traefik.ts to match deploy/traefik/dev.yaml',
    ).toEqual([...TRAEFIK_DEV_ARGS].sort());
  });

  it('fails when one timeout value of dev.yaml changes, or one key goes away', () => {
    const changed = yaml.replace('idleTimeout: "180s"', 'idleTimeout: "181s"');
    expect(changed).not.toBe(yaml);
    expect([...traefikArgsFromYaml(changed)].sort()).not.toEqual([...TRAEFIK_DEV_ARGS].sort());
    const removed = yaml.replace(/^ +readTimeout: .*\n/m, '');
    expect(removed).not.toBe(yaml);
    expect([...traefikArgsFromYaml(removed)].sort()).not.toEqual([...TRAEFIK_DEV_ARGS].sort());
  });
});
