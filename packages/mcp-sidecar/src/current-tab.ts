// The current tab of an MCP session, from the browser_tabs "list" text of Playwright MCP (spec 8.8.3 step 2).
// Each line is "- <index>: [(current) ][<title>](<url>)[ [crashed]]".

export function currentTabIndex(text: string): number | null {
  const match = /^- (\d+): \(current\) /m.exec(text);
  return match === null ? null : Number(match[1]);
}

/** True if the line of the current tab with this index ends with the URL. */
export function tabLineMatchesUrl(text: string, index: number, url: string): boolean {
  const prefix = `- ${String(index)}: (current) `;
  const line = text.split('\n').find((entry) => entry.startsWith(prefix));
  return line !== undefined && (line.endsWith(`(${url})`) || line.endsWith(`(${url}) [crashed]`));
}
