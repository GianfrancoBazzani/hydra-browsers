// Redaction of tool call arguments for the audit log (spec section 8.6).
//
// REDACTION_RULES has one entry for each tool that @playwright/mcp 0.0.83 can expose over MCP: the 25 default
// tools (capabilities core, core-navigation, core-input, core-tabs) and the opt-in tools of --caps config,
// network, storage, devtools, vision, pdf, and testing (72 tools), plus the two Hydra vault tools of the sidecar
// (vault_list, vault_fill; spec section 8.8). The CLI-only ("skillOnly") tools of
// playwright-core are not callable over MCP and are not in the table.
//
// Order: redact, then cut each string to MAX_STRING_CHARS, then cut the whole object to MAX_ARGUMENTS_BYTES.

export const MAX_STRING_CHARS = 2000;
export const MAX_ARGUMENTS_BYTES = 8 * 1024;
const MAX_DEPTH = 20;

export interface RedactionRule {
  /**
   * Paths of values that become "[redacted: N chars]":
   * "text" = top-level key, "fields[].value" = key "value" of each element of the array "fields",
   * "data.*" = each value of the object "data", "**" = every string value (tools without a rule).
   */
  readonly redact: readonly string[];
  /** Redact only values of one character (browser_press_key: "a" is text, "Enter" is a key name). */
  readonly singleCharactersOnly?: boolean;
}

const KEEP: RedactionRule = { redact: [] };

export const UNKNOWN_TOOL_RULE: RedactionRule = { redact: ['**'] };

export const REDACTION_RULES: Readonly<Record<string, RedactionRule>> = {
  // Default tools (capabilities core, core-navigation, core-input, core-tabs)
  browser_click: KEEP,
  browser_close: KEEP,
  browser_console_messages: KEEP,
  browser_drag: KEEP,
  browser_drop: { redact: ['data.*'] }, // text dropped into the page, like typing
  browser_emulate_media: KEEP,
  browser_evaluate: KEEP, // the code is kept (spec section 8.6)
  browser_file_upload: KEEP,
  browser_fill_form: { redact: ['fields[].value'] }, // typing tool (spec section 8.6)
  browser_find: KEEP,
  browser_handle_dialog: { redact: ['promptText'] }, // text typed into a prompt() dialog
  browser_hover: KEEP,
  browser_navigate: KEEP,
  browser_navigate_back: KEEP,
  browser_network_request: KEEP,
  browser_network_requests: KEEP,
  browser_press_key: { redact: ['key'], singleCharactersOnly: true }, // typing one character at a time
  browser_resize: KEEP,
  browser_run_code_unsafe: KEEP, // blocked by tool-policy.ts; the code of the attempt is kept, as for browser_evaluate
  browser_select_option: KEEP,
  browser_snapshot: KEEP,
  browser_tabs: KEEP,
  browser_take_screenshot: KEEP,
  browser_type: { redact: ['text'] }, // typing tool (spec section 8.6)
  browser_wait_for: KEEP,
  // --caps=config
  browser_get_config: KEEP,
  // --caps=network
  browser_network_state_set: KEEP,
  browser_route: KEEP,
  browser_route_list: KEEP,
  browser_unroute: KEEP,
  // --caps=storage: values can be session tokens
  browser_cookie_clear: KEEP,
  browser_cookie_delete: KEEP,
  browser_cookie_get: KEEP,
  browser_cookie_list: KEEP,
  browser_cookie_set: { redact: ['value'] },
  browser_localstorage_clear: KEEP,
  browser_localstorage_delete: KEEP,
  browser_localstorage_get: KEEP,
  browser_localstorage_list: KEEP,
  browser_localstorage_set: { redact: ['value'] },
  browser_sessionstorage_clear: KEEP,
  browser_sessionstorage_delete: KEEP,
  browser_sessionstorage_get: KEEP,
  browser_sessionstorage_list: KEEP,
  browser_sessionstorage_set: { redact: ['value'] },
  browser_set_storage_state: KEEP,
  browser_storage_state: KEEP,
  // --caps=devtools
  browser_annotate: KEEP,
  browser_hide_highlight: KEEP,
  browser_highlight: KEEP,
  browser_resume: KEEP,
  browser_start_recording: KEEP,
  browser_start_tracing: KEEP,
  browser_start_video: KEEP,
  browser_stop_recording: KEEP,
  browser_stop_tracing: KEEP,
  browser_stop_video: KEEP,
  browser_video_chapter: KEEP,
  browser_video_hide_actions: KEEP,
  browser_video_show_actions: KEEP,
  // --caps=vision
  browser_mouse_click_xy: KEEP,
  browser_mouse_down: KEEP,
  browser_mouse_drag_xy: KEEP,
  browser_mouse_move_xy: KEEP,
  browser_mouse_up: KEEP,
  browser_mouse_wheel: KEEP,
  // --caps=pdf
  browser_pdf_save: KEEP,
  // --caps=testing
  browser_generate_locator: KEEP,
  browser_verify_element_visible: KEEP,
  browser_verify_list_visible: KEEP,
  browser_verify_text_visible: KEEP,
  browser_verify_value: { redact: ['value'] }, // the value of a field, for example a typed password
  // Hydra vault tools (spec section 8.6): their arguments contain no vault value
  vault_fill: KEEP,
  vault_list: KEEP,
};

export function ruleFor(tool: string): RedactionRule {
  return Object.hasOwn(REDACTION_RULES, tool)
    ? (REDACTION_RULES[tool] ?? UNKNOWN_TOOL_RULE)
    : UNKNOWN_TOOL_RULE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapObject(
  value: Record<string, unknown>,
  fn: (child: unknown, key: string) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fn(child, key)]));
}

function redactValue(value: unknown, singleCharactersOnly: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const chars = Array.from(value).length;
    if (singleCharactersOnly && chars !== 1) return value;
    return `[redacted: ${String(chars)} chars]`;
  }
  return '[redacted]';
}

function redactAllStrings(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactValue(value, false);
  if (depth >= MAX_DEPTH) return '[redacted]';
  if (Array.isArray(value)) return value.map((child) => redactAllStrings(child, depth + 1));
  if (isPlainObject(value)) return mapObject(value, (child) => redactAllStrings(child, depth + 1));
  return value;
}

function redactPath(
  value: unknown,
  segments: readonly string[],
  singleCharactersOnly: boolean,
): unknown {
  const [segment, ...rest] = segments;
  if (segment === undefined) return redactValue(value, singleCharactersOnly);
  // A container of the wrong shape ("fields" is a string, "data" is an array): the path cannot
  // be followed, so every string found there is redacted (fail closed).
  if (segment === '[]') {
    return Array.isArray(value)
      ? value.map((child) => redactPath(child, rest, singleCharactersOnly))
      : redactAllStrings(value, 0);
  }
  if (segment === '*') {
    return isPlainObject(value)
      ? mapObject(value, (child) => redactPath(child, rest, singleCharactersOnly))
      : redactAllStrings(value, 0);
  }
  if (!isPlainObject(value)) return redactAllStrings(value, 0);
  if (!Object.hasOwn(value, segment)) return value;
  return mapObject(value, (child, key) =>
    key === segment ? redactPath(child, rest, singleCharactersOnly) : child,
  );
}

function pathSegments(path: string): string[] {
  return path
    .split('.')
    .flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]));
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (typeof value === 'string') out.push(value);
  else if (depth >= MAX_DEPTH) return;
  else if (Array.isArray(value)) for (const child of value) collectStrings(child, out, depth + 1);
  else if (isPlainObject(value))
    for (const child of Object.values(value)) collectStrings(child, out, depth + 1);
}

function collectPath(
  value: unknown,
  segments: readonly string[],
  singleCharactersOnly: boolean,
  out: string[],
): void {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    const found: string[] = [];
    collectStrings(value, found, 0);
    for (const text of found) {
      if (!singleCharactersOnly || Array.from(text).length === 1) out.push(text);
    }
    return;
  }
  if (segment === '[]') {
    if (Array.isArray(value)) {
      for (const child of value) collectPath(child, rest, singleCharactersOnly, out);
    } else collectStrings(value, out, 0);
    return;
  }
  if (segment === '*') {
    if (isPlainObject(value)) {
      for (const child of Object.values(value)) collectPath(child, rest, singleCharactersOnly, out);
    } else collectStrings(value, out, 0);
    return;
  }
  if (!isPlainObject(value)) collectStrings(value, out, 0);
  else if (Object.hasOwn(value, segment))
    collectPath(value[segment], rest, singleCharactersOnly, out);
}

/**
 * The raw strings that redactArguments() replaces for these arguments (the same rule and the same
 * paths, so also the fail-closed cases). The exchange removes them from the error text of a failed call.
 */
export function redactedStrings(tool: string, args: unknown): string[] {
  if (!isPlainObject(args)) return [];
  const rule = ruleFor(tool);
  const out: string[] = [];
  if (rule.redact.includes('**')) collectStrings(args, out, 0);
  else {
    for (const path of rule.redact)
      collectPath(args, pathSegments(path), rule.singleCharactersOnly === true, out);
  }
  return out;
}

/** Cuts a string to at most maxChars characters. The end shows the original length. */
export function truncateString(value: string, maxChars: number = MAX_STRING_CHARS): string {
  if (value.length <= maxChars) return value;
  const suffix = `… [cut, ${String(value.length)} chars]`;
  let head = value.slice(0, Math.max(0, maxChars - suffix.length));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // do not split a surrogate pair
  return head + suffix;
}

function truncateStrings(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return truncateString(value);
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((child) => truncateStrings(child, depth + 1));
  if (isPlainObject(value)) return mapObject(value, (child) => truncateStrings(child, depth + 1));
  return value;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function limitSize(value: Record<string, unknown>): Record<string, unknown> {
  if (byteLength(value) <= MAX_ARGUMENTS_BYTES) return value;
  const json = JSON.stringify(value);
  const marker = (preview: string): Record<string, unknown> => ({
    $truncated: true,
    $json: preview,
  });
  let low = 0;
  let high = Math.min(json.length, MAX_ARGUMENTS_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(marker(json.slice(0, mid))) <= MAX_ARGUMENTS_BYTES) low = mid;
    else high = mid - 1;
  }
  return marker(json.slice(0, low));
}

/** Returns the arguments of a tool call in the form that the audit log stores (spec section 8.6). */
export function redactArguments(tool: string, args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) return { $invalid: Array.isArray(args) ? 'array' : typeof args };
  const rule = ruleFor(tool);
  let redacted: unknown = args;
  if (rule.redact.includes('**')) {
    redacted = redactAllStrings(args, 0);
  } else {
    for (const path of rule.redact)
      redacted = redactPath(redacted, pathSegments(path), rule.singleCharactersOnly === true);
  }
  return limitSize(truncateStrings(redacted, 0) as Record<string, unknown>);
}
