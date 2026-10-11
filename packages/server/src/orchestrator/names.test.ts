import { describe, expect, it } from 'vitest';
import { objectNames, sessionLabels, sessionObjectRefs } from './names.js';
import { desiredStateOf, screenOf, stateOf } from './row-fields.js';

describe('session object names', () => {
  it('gives the names of spec section 7.3', () => {
    expect(objectNames('abcdefghij23')).toEqual({
      pvc: 'profile-abcdefghij23',
      secret: 'neko-abcdefghij23',
      configMap: 'chromium-abcdefghij23',
      headlessService: 'session-abcdefghij23',
      mediaService: 'media-abcdefghij23',
      statefulSet: 'session-abcdefghij23',
      pod: 'session-abcdefghij23-0',
    });
  });

  it('gives the labels of spec section 7.1', () => {
    expect(sessionLabels('abcdefghij23')).toEqual({
      'app.kubernetes.io/managed-by': 'hydra',
      'hydra/session-id': 'abcdefghij23',
    });
  });

  it('lists the deletable objects, StatefulSet first and without the pod', () => {
    expect(sessionObjectRefs('abcdefghij23').map((ref) => `${ref.kind}/${ref.name}`)).toEqual([
      'StatefulSet/session-abcdefghij23',
      'Service/media-abcdefghij23',
      'Service/session-abcdefghij23',
      'ConfigMap/chromium-abcdefghij23',
      'Secret/neko-abcdefghij23',
      'PersistentVolumeClaim/profile-abcdefghij23',
    ]);
  });

  it('reads the enum columns of a session row', () => {
    const row = { state: 'running', desiredState: 'stopped', screen: '1280x720' };
    expect([stateOf(row), desiredStateOf(row), screenOf(row)]).toEqual([
      'running',
      'stopped',
      '1280x720',
    ]);
  });
});
