/** The lowest port of the range that is not in use (spec section 7.8), or null if all are in use. */
export function lowestFreePort(
  range: { first: number; last: number },
  used: Iterable<number>,
): number | null {
  const taken = new Set(used);
  for (let port = range.first; port <= range.last; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}
