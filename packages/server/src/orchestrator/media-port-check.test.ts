import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { testConfig } from '../../test/helpers/config.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { checkMediaPortRange, MediaPortRangeError } from './media-port-check.js';

describe('checkMediaPortRange', () => {
  it('passes when the API server accepts the first and the last port', async () => {
    const kube = new FakeKubeClient();
    const check = vi.spyOn(kube, 'checkNodePorts');
    await checkMediaPortRange({ kube, config: testConfig(), logger: createLogger('fatal') });
    expect(check).toHaveBeenCalledWith([52000, 52099]);
  });

  it('stops with an error that names HYDRA_MEDIA_PORT_RANGE', async () => {
    const kube = new FakeKubeClient();
    kube.nodePortRange = { first: 30000, last: 32767 };
    const check = checkMediaPortRange({
      kube,
      config: testConfig(),
      logger: createLogger('fatal'),
    });
    await expect(check).rejects.toBeInstanceOf(MediaPortRangeError);
    await expect(check).rejects.toThrow(
      /HYDRA_MEDIA_PORT_RANGE 52000-52099 is not inside the service-node-port-range/,
    );
  });

  it('checks one port for a range of one port', async () => {
    const kube = new FakeKubeClient();
    kube.nodePortRange = { first: 30000, last: 52000 };
    const check = vi.spyOn(kube, 'checkNodePorts');
    const config = testConfig({ mediaPortRange: { first: 52000, last: 52000 }, maxRunning: 1 });
    await checkMediaPortRange({ kube, config, logger: createLogger('fatal') });
    expect(check).toHaveBeenCalledWith([52000]);
  });

  it('logs a warning and passes when the API server does not answer', async () => {
    const kube = new FakeKubeClient();
    kube.failNext('checkNodePorts', new Error('connect ECONNREFUSED'));
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn');
    const anyError: unknown = expect.any(Error);
    await checkMediaPortRange({ kube, config: testConfig(), logger });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: anyError }),
      expect.stringContaining('HYDRA_MEDIA_PORT_RANGE'),
    );
  });
});
