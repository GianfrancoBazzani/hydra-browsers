/** Finds "name=value" in a document.cookie string. */
export function findCookie(cookies: unknown, name: string): string | undefined {
  if (typeof cookies !== 'string') {
    return undefined;
  }
  return cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
}
