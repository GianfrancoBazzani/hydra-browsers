import { describe, expect, it } from 'vitest';
import { buildNekoEnv, VIEWER_PROFILE_ENV } from './neko-env.js';

const settings = {
  allowlist: ['example.com'],
  timezone: 'Europe/Zurich',
  language: 'de-CH',
  screen: '1600x900' as const,
};

describe('buildNekoEnv', () => {
  it('gives the env table of spec section 7.4', () => {
    expect(
      buildNekoEnv({ sid: 'abcdefghij23', settings, mediaPort: 52003, publicIp: '203.0.113.10' }),
    ).toEqual([
      { name: 'NEKO_DESKTOP_SCREEN', value: '1600x900@25' },
      { name: 'NEKO_WEBRTC_UDPMUX', value: '52003' },
      { name: 'NEKO_WEBRTC_TCPMUX', value: '52003' },
      { name: 'NEKO_WEBRTC_NAT1TO1', value: '203.0.113.10' },
      { name: 'NEKO_WEBRTC_ICELITE', value: 'true' },
      { name: 'NEKO_SERVER_PROXY', value: 'true' },
      { name: 'NEKO_MEMBER_PROVIDER', value: 'multiuser' },
      {
        name: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'neko-abcdefghij23', key: 'admin-password' } },
      },
      {
        name: 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'neko-abcdefghij23', key: 'user-password' } },
      },
      { name: 'NEKO_MEMBER_MULTIUSER_USER_PROFILE', value: '{"can_host":false}' },
      { name: 'NEKO_SESSION_IMPLICIT_HOSTING', value: 'true' },
      { name: 'NEKO_FILETRANSFER_ENABLED', value: 'false' },
      { name: 'TZ', value: 'Europe/Zurich' },
      { name: 'LANG', value: 'de_CH.UTF-8' },
      { name: 'LANGUAGE', value: 'de_CH:de' },
    ]);
  });

  it('has no mux ports while the session holds no media port', () => {
    const names = buildNekoEnv({
      sid: 'abcdefghij23',
      settings,
      mediaPort: null,
      publicIp: '203.0.113.10',
    }).map((e) => e.name);
    expect(names).not.toContain('NEKO_WEBRTC_UDPMUX');
    expect(names).not.toContain('NEKO_WEBRTC_TCPMUX');
  });

  it('keeps the viewer profile in one constant (spike S3)', () => {
    expect(JSON.parse(VIEWER_PROFILE_ENV.value ?? '')).toEqual({ can_host: false });
  });
});
