import { describe, expect, it } from 'vitest';
import * as viaPackage from '@hydra/shared';
import * as viaSource from '../../shared/src/index.js';

describe('workspace resolution', () => {
  it('resolves @hydra/shared to its source through the @hydra/source condition', () => {
    // The same module instance means that Vitest loaded packages/shared/src/index.ts, not dist.
    expect(viaPackage, '@hydra/shared must resolve to packages/shared/src/index.ts').toBe(
      viaSource,
    );
  });
});
