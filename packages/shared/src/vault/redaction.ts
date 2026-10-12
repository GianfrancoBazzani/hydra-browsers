// Removal of vault values from MCP responses (spec section 8.9). No Node.js APIs: the sidecar uses it too.
import type { VaultField } from '../constants.js';

export interface RedactionEntry {
  value: string;
  /** The replacement, `[vault:<credentialId>.<field>]`. */
  label: string;
}

export function vaultLabel(credentialId: string, field: VaultField): string {
  return `[vault:${credentialId}.${field}]`;
}

export interface Redactor {
  /** True if there is nothing to replace: the caller sends the response without a change. */
  readonly empty: boolean;
  /** Replaces the values in a text. */
  text(input: string): string;
  /** Replaces the values in the strings of `result`, `error`, and `params` of one JSON-RPC message or a batch. */
  json(input: string): string;
}

const PASS_THROUGH: Redactor = { empty: true, text: (input) => input, json: (input) => input };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((child) => walk(child, replace));
  if (!isObject(value)) return value;
  const media = value.type === 'image' || value.type === 'audio';
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      media && key === 'data' ? child : walk(child, replace),
    ]),
  );
}

const REDACTED_MEMBERS = ['result', 'error', 'params'] as const;

function redactMessage(message: unknown, replace: (text: string) => string): unknown {
  if (!isObject(message)) return message;
  const out: Record<string, unknown> = { ...message };
  for (const member of REDACTED_MEMBERS) {
    if (Object.hasOwn(out, member)) out[member] = walk(out[member], replace);
  }
  return out;
}

/**
 * One pass over the text with all values: each value as it is and in its JSON string form (snapshot text
 * puts some values in quotes), longer values first. One pass, so that a value never matches inside a label.
 */
export function createRedactor(entries: readonly RedactionEntry[]): Redactor {
  const labels = new Map<string, string>();
  for (const { value, label } of entries) {
    if (value === '') continue;
    if (!labels.has(value)) labels.set(value, label);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (!labels.has(escaped)) labels.set(escaped, label);
  }
  if (labels.size === 0) return PASS_THROUGH;
  const pattern = new RegExp(
    [...labels.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'g',
  );
  const text = (input: string): string =>
    input.replace(pattern, (match) => labels.get(match) ?? match);
  return {
    empty: false,
    text,
    json: (input) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch {
        return text(input);
      }
      const out = Array.isArray(parsed)
        ? parsed.map((message) => redactMessage(message, text))
        : redactMessage(parsed, text);
      return JSON.stringify(out);
    },
  };
}
