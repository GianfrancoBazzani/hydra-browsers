export interface LocaleParts {
  /** BCP 47 tag without extensions, for example `en-US`. */
  tag: string;
  /** Base language, for example `en`. */
  base: string;
  /** POSIX form, for example `en_US` (`de` if the tag has no region). */
  posix: string;
}

const SAFE_TAG = /^[A-Za-z0-9-]+$/;

/**
 * Splits a session language. The API validates the tag (index section 5.1). The check here is a
 * second guard, because the tag goes into a shell file (spec section 7.6).
 */
export function localeParts(language: string): LocaleParts {
  const locale = new Intl.Locale(language);
  const tag = locale.baseName;
  if (!SAFE_TAG.test(tag)) throw new Error(`unsafe language tag: ${language}`);
  const base = locale.language;
  const posix = locale.region ? `${base}_${locale.region}` : base;
  return { tag, base, posix };
}
