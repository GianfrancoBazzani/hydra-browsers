export interface ToolOutcome {
  isError: boolean;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Returns the error flag and the joined text parts of a tools/call result. */
export function toToolOutcome(result: unknown): ToolOutcome {
  if (!isRecord(result)) {
    throw new Error('The tools/call result is not an object');
  }
  const parts: unknown[] = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const text = parts
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .filter((partText) => partText !== '')
    .join('\n');
  return { isError: result.isError === true, text };
}

/** Parses the JSON value after "### Result" in a browser_evaluate text (Playwright MCP 0.0.83). */
export function parseEvaluateResult(text: string): unknown {
  const marker = '### Result\n';
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`No "### Result" section in: ${text}`);
  }
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf('\n### ');
  return JSON.parse(end === -1 ? rest : rest.slice(0, end)) as unknown;
}
