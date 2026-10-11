import type { V1EnvVar } from '@kubernetes/client-node';
import type { SessionSettings } from '@hydra/shared';
import { objectNames } from '../names.js';
import { localeParts } from './locale.js';

/**
 * Viewer profile with can_host false (spec section 6.7). Spike S3 fallback file (index section 6).
 * Main path: the multiuser provider reads the profile template of the `user` password from
 * `member.multiuser.user_profile` (Neko v3.1.6 server/internal/config/member.go). Neko maps the key to
 * the env variable NEKO_MEMBER_MULTIUSER_USER_PROFILE (viper prefix NEKO, "." → "_") and merges the
 * JSON over its default user profile, so only can_host changes.
 */
export const VIEWER_PROFILE_ENV: V1EnvVar = {
  name: 'NEKO_MEMBER_MULTIUSER_USER_PROFILE',
  value: JSON.stringify({ can_host: false }),
};

export interface NekoEnvInput {
  sid: string;
  settings: SessionSettings;
  mediaPort: number | null;
  publicIp: string;
}

/** Environment of the neko container (spec section 7.4 table). */
export function buildNekoEnv(input: NekoEnvInput): V1EnvVar[] {
  const secretName = objectNames(input.sid).secret;
  const locale = localeParts(input.settings.language);
  const mux: V1EnvVar[] =
    input.mediaPort === null
      ? []
      : [
          { name: 'NEKO_WEBRTC_UDPMUX', value: String(input.mediaPort) },
          { name: 'NEKO_WEBRTC_TCPMUX', value: String(input.mediaPort) },
        ];
  return [
    { name: 'NEKO_DESKTOP_SCREEN', value: `${input.settings.screen}@25` },
    ...mux,
    { name: 'NEKO_WEBRTC_NAT1TO1', value: input.publicIp },
    { name: 'NEKO_WEBRTC_ICELITE', value: 'true' },
    { name: 'NEKO_SERVER_PROXY', value: 'true' },
    { name: 'NEKO_MEMBER_PROVIDER', value: 'multiuser' },
    {
      name: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD',
      valueFrom: { secretKeyRef: { name: secretName, key: 'admin-password' } },
    },
    {
      name: 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD',
      valueFrom: { secretKeyRef: { name: secretName, key: 'user-password' } },
    },
    VIEWER_PROFILE_ENV,
    { name: 'NEKO_SESSION_IMPLICIT_HOSTING', value: 'true' },
    { name: 'NEKO_FILETRANSFER_ENABLED', value: 'false' },
    { name: 'TZ', value: input.settings.timezone },
    { name: 'LANG', value: `${locale.posix}.UTF-8` },
    {
      name: 'LANGUAGE',
      value: locale.posix === locale.base ? locale.base : `${locale.posix}:${locale.base}`,
    },
  ];
}
