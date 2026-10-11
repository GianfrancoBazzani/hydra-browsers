import { localeParts } from './locale.js';

/** Content of /etc/chromium.d/hydra (spec section 7.6). */
export function buildChromiumFlags(language: string): string {
  const { tag, base } = localeParts(language);
  const acceptLang = tag === base ? tag : `${tag},${base}`;
  return `export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=${tag} --accept-lang=${acceptLang}"\n`;
}
