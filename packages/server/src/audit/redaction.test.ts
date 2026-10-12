import { describe, expect, it } from 'vitest';
import {
  MAX_ARGUMENTS_BYTES,
  MAX_STRING_CHARS,
  REDACTION_RULES,
  redactArguments,
  redactedStrings,
  truncateString,
} from './redaction.js';

interface Case {
  tool: string;
  args: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const keep = (tool: string, args: Record<string, unknown>): Case => ({
  tool,
  args,
  expected: args,
});

// One case for each tool of @playwright/mcp 0.0.83 (all capabilities), plus a second case for browser_press_key.
const CASES: Case[] = [
  // Default tools
  keep('browser_click', {
    element: 'Submit button',
    target: 'e12',
    doubleClick: false,
    button: 'left',
    modifiers: ['Shift'],
  }),
  keep('browser_close', {}),
  keep('browser_console_messages', { level: 'info', all: false }),
  keep('browser_drag', {
    startElement: 'Card',
    startTarget: 'e3',
    endElement: 'Column',
    endTarget: 'e9',
  }),
  {
    tool: 'browser_drop',
    args: {
      element: 'Drop zone',
      target: 'e5',
      paths: ['/tmp/a.txt'],
      data: { 'text/plain': 'secret note', 'text/uri-list': 'https://example.com' },
    },
    expected: {
      element: 'Drop zone',
      target: 'e5',
      paths: ['/tmp/a.txt'],
      data: { 'text/plain': '[redacted: 11 chars]', 'text/uri-list': '[redacted: 19 chars]' },
    },
  },
  keep('browser_emulate_media', { colorScheme: 'dark', reducedMotion: null }),
  keep('browser_evaluate', { element: 'Page', target: 'e1', function: '() => document.title' }),
  keep('browser_file_upload', { paths: ['/tmp/report.pdf'] }),
  {
    tool: 'browser_fill_form',
    args: {
      fields: [
        { name: 'Email', type: 'textbox', target: 'e4', value: 'me@example.com' },
        { name: 'Remember me', type: 'checkbox', target: 'e5', value: 'true' },
      ],
    },
    expected: {
      fields: [
        { name: 'Email', type: 'textbox', target: 'e4', value: '[redacted: 14 chars]' },
        { name: 'Remember me', type: 'checkbox', target: 'e5', value: '[redacted: 4 chars]' },
      ],
    },
  },
  keep('browser_find', { text: 'Sign in' }),
  {
    tool: 'browser_handle_dialog',
    args: { accept: true, promptText: 'my answer' },
    expected: { accept: true, promptText: '[redacted: 9 chars]' },
  },
  keep('browser_hover', { element: 'Menu', target: 'e7' }),
  keep('browser_navigate', { url: 'https://example.com/login' }),
  keep('browser_navigate_back', {}),
  keep('browser_network_request', { index: 3, part: 'body' }),
  keep('browser_network_requests', { static: false, filter: '/api/.*' }),
  keep('browser_press_key', { key: 'Enter' }),
  { tool: 'browser_press_key', args: { key: 'x' }, expected: { key: '[redacted: 1 chars]' } },
  keep('browser_resize', { width: 1280, height: 720 }),
  keep('browser_run_code_unsafe', { code: 'async (page) => page.title()' }),
  keep('browser_select_option', { element: 'Country', target: 'e8', values: ['DE'] }),
  keep('browser_snapshot', { depth: 3 }),
  keep('browser_tabs', { action: 'new', url: 'https://example.com' }),
  keep('browser_take_screenshot', { type: 'png', fullPage: true, scale: 'css' }),
  {
    tool: 'browser_type',
    args: { element: 'Password', target: 'e6', text: 'hunter2', submit: true },
    expected: { element: 'Password', target: 'e6', text: '[redacted: 7 chars]', submit: true },
  },
  keep('browser_wait_for', { text: 'Welcome', time: 2 }),
  // --caps=config
  keep('browser_get_config', {}),
  // --caps=network
  keep('browser_network_state_set', { state: 'offline' }),
  keep('browser_route', {
    pattern: '**/api/users',
    status: 200,
    body: '[]',
    contentType: 'application/json',
    headers: ['X-Test: 1'],
  }),
  keep('browser_route_list', {}),
  keep('browser_unroute', { pattern: '**/api/users' }),
  // --caps=storage
  keep('browser_cookie_clear', {}),
  keep('browser_cookie_delete', { name: 'sid' }),
  keep('browser_cookie_get', { name: 'sid' }),
  keep('browser_cookie_list', { domain: 'example.com' }),
  {
    tool: 'browser_cookie_set',
    args: { name: 'sid', value: 'abc123', domain: 'example.com', httpOnly: true },
    expected: { name: 'sid', value: '[redacted: 6 chars]', domain: 'example.com', httpOnly: true },
  },
  keep('browser_localstorage_clear', {}),
  keep('browser_localstorage_delete', { key: 'token' }),
  keep('browser_localstorage_get', { key: 'token' }),
  keep('browser_localstorage_list', {}),
  {
    tool: 'browser_localstorage_set',
    args: { key: 'token', value: 'eyJhbGci' },
    expected: { key: 'token', value: '[redacted: 8 chars]' },
  },
  keep('browser_sessionstorage_clear', {}),
  keep('browser_sessionstorage_delete', { key: 'k' }),
  keep('browser_sessionstorage_get', { key: 'k' }),
  keep('browser_sessionstorage_list', {}),
  {
    tool: 'browser_sessionstorage_set',
    args: { key: 'k', value: 'v1' },
    expected: { key: 'k', value: '[redacted: 2 chars]' },
  },
  keep('browser_set_storage_state', { filename: 'state.json' }),
  keep('browser_storage_state', { filename: 'state.json' }),
  // --caps=devtools
  keep('browser_annotate', {}),
  keep('browser_hide_highlight', { element: 'Logo', target: 'e2' }),
  keep('browser_highlight', { element: 'Logo', target: 'e2', style: 'outline: 2px dashed red' }),
  keep('browser_resume', { step: true, location: 'example.spec.ts:42' }),
  keep('browser_start_recording', {}),
  keep('browser_start_tracing', {}),
  keep('browser_start_video', { filename: 'run.webm', fps: 25 }),
  keep('browser_stop_recording', {}),
  keep('browser_stop_tracing', {}),
  keep('browser_stop_video', {}),
  keep('browser_video_chapter', { title: 'Login', duration: 1000 }),
  keep('browser_video_hide_actions', {}),
  keep('browser_video_show_actions', { duration: 500, position: 'top-right' }),
  // --caps=vision
  keep('browser_mouse_click_xy', { x: 10, y: 20, button: 'left', clickCount: 1 }),
  keep('browser_mouse_down', { button: 'left' }),
  keep('browser_mouse_drag_xy', { startX: 1, startY: 2, endX: 3, endY: 4 }),
  keep('browser_mouse_move_xy', { x: 5, y: 6 }),
  keep('browser_mouse_up', { button: 'left' }),
  keep('browser_mouse_wheel', { deltaX: 0, deltaY: 300 }),
  // --caps=pdf
  keep('browser_pdf_save', { filename: 'page.pdf' }),
  // --caps=testing
  keep('browser_generate_locator', { element: 'Submit', target: 'e12' }),
  keep('browser_verify_element_visible', { role: 'button', accessibleName: 'Submit' }),
  keep('browser_verify_list_visible', { element: 'Results', target: 'e20', items: ['One', 'Two'] }),
  keep('browser_verify_text_visible', { text: 'Welcome back' }),
  {
    tool: 'browser_verify_value',
    args: { type: 'textbox', element: 'Password', target: 'e6', value: 'hunter2' },
    expected: { type: 'textbox', element: 'Password', target: 'e6', value: '[redacted: 7 chars]' },
  },
  // Hydra vault tools (spec section 8.6): their arguments contain no vault value
  keep('vault_fill', {
    credentialId: '01J9ZC0000000000000000CRD1',
    field: 'password',
    target: 'e5',
    submit: true,
  }),
  keep('vault_list', {}),
];

describe('REDACTION_RULES', () => {
  it('has a rule for each of the 72 tools of @playwright/mcp 0.0.83 and the 2 vault tools, and a test case for each rule', () => {
    const tested = [...new Set(CASES.map((testCase) => testCase.tool))].sort();
    expect(Object.keys(REDACTION_RULES).sort()).toEqual(tested);
    expect(tested).toHaveLength(74);
  });
});

describe('redactArguments', () => {
  it.each(CASES)('$tool: $args', ({ tool, args, expected }) => {
    expect(redactArguments(tool, args)).toEqual(expected);
  });

  it('does not change the input object', () => {
    const args = { target: 'e6', text: 'hunter2' };
    redactArguments('browser_type', args);
    expect(args).toEqual({ target: 'e6', text: 'hunter2' });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(redactArguments('browser_type', { target: 'e1', text: 'pässwörd😀' })).toEqual({
      target: 'e1',
      text: '[redacted: 9 chars]',
    });
  });

  it('redacts a value that is not a string, and keeps a missing value', () => {
    expect(redactArguments('browser_type', { target: 'e1', text: 1234 })).toEqual({
      target: 'e1',
      text: '[redacted]',
    });
    expect(redactArguments('browser_type', { target: 'e1' })).toEqual({ target: 'e1' });
  });

  it('redacts every string where a container of the rule has the wrong shape (fail closed)', () => {
    expect(redactArguments('browser_fill_form', { fields: 'secret' })).toEqual({
      fields: '[redacted: 6 chars]',
    });
    expect(redactArguments('browser_fill_form', { fields: ['secret'] })).toEqual({
      fields: ['[redacted: 6 chars]'],
    });
    expect(
      redactArguments('browser_fill_form', { fields: { value: 'secret', name: 'n' } }),
    ).toEqual({ fields: { value: '[redacted: 6 chars]', name: '[redacted: 1 chars]' } });
    expect(
      redactArguments('browser_fill_form', { fields: [{ value: 'secret' }, [['deep']]] }),
    ).toEqual({ fields: [{ value: '[redacted: 6 chars]' }, [['[redacted: 4 chars]']]] });
    expect(redactArguments('browser_drop', { data: 'secret' })).toEqual({
      data: '[redacted: 6 chars]',
    });
    expect(redactArguments('browser_drop', { data: ['secret'] })).toEqual({
      data: ['[redacted: 6 chars]'],
    });
    expect(redactArguments('browser_fill_form', { fields: [{ name: 'user' }] })).toEqual({
      fields: [{ name: 'user' }],
    });
  });

  it('redacts every string of a tool without a rule (WebMCP tools of a page, tools of a newer version)', () => {
    expect(
      redactArguments('checkout', {
        card: '4111111111111111',
        amount: 12,
        items: [{ sku: 'A-1' }],
      }),
    ).toEqual({
      card: '[redacted: 16 chars]',
      amount: 12,
      items: [{ sku: '[redacted: 3 chars]' }],
    });
  });

  it('does not take a rule from Object.prototype', () => {
    expect(redactArguments('constructor', { a: 'b' })).toEqual({ a: '[redacted: 1 chars]' });
    expect(redactArguments('__proto__', { a: 'b' })).toEqual({ a: '[redacted: 1 chars]' });
  });

  it('keeps a "__proto__" key as data', () => {
    const args = JSON.parse(
      '{"url":"https://example.com","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const result = redactArguments('browser_navigate', args);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns {} for missing arguments and marks arguments that are not an object', () => {
    expect(redactArguments('browser_close', undefined)).toEqual({});
    expect(redactArguments('browser_close', null)).toEqual({});
    expect(redactArguments('browser_close', ['a'])).toEqual({ $invalid: 'array' });
    expect(redactArguments('browser_close', 'text')).toEqual({ $invalid: 'string' });
  });

  it('cuts each string to 2,000 characters', () => {
    const code = 'x'.repeat(5000);
    const result = redactArguments('browser_evaluate', { function: code });
    const cut = result.function as string;
    expect(cut).toHaveLength(MAX_STRING_CHARS);
    expect(cut.endsWith('… [cut, 5000 chars]')).toBe(true);
    expect(cut.startsWith('xxxx')).toBe(true);
  });

  it('redacts before it cuts, so the marker shows the full length', () => {
    expect(redactArguments('browser_type', { target: 'e1', text: 'y'.repeat(3000) })).toEqual({
      target: 'e1',
      text: '[redacted: 3000 chars]',
    });
  });

  it('cuts the whole arguments object to 8 KiB', () => {
    const fields = Array.from({ length: 20 }, (_, index) => ({
      name: `Field ${String(index)} ${'n'.repeat(1900)}`,
      type: 'textbox',
      target: `e${String(index)}`,
      value: 'v',
    }));
    const result = redactArguments('browser_fill_form', { fields });
    expect(result.$truncated).toBe(true);
    expect(typeof result.$json).toBe('string');
    expect((result.$json as string).startsWith('{"fields":[{"name":"Field 0 nnn')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      MAX_ARGUMENTS_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(
      MAX_ARGUMENTS_BYTES - 64,
    );
    expect(result.$json as string).not.toContain('"value":"v"');
  });

  it('keeps an object of exactly 8 KiB and cuts an object of 8 KiB + 1 byte', () => {
    const make = (extra: number): Record<string, unknown> => ({
      a: 'a'.repeat(2000),
      b: 'b'.repeat(2000),
      c: 'c'.repeat(2000),
      d: 'd'.repeat(2000),
      e: 'e'.repeat(extra),
    });
    const overhead = Buffer.byteLength(JSON.stringify(make(0)), 'utf8');
    const exact = make(MAX_ARGUMENTS_BYTES - overhead);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(MAX_ARGUMENTS_BYTES);
    expect(redactArguments('browser_route', exact)).toEqual(exact);
    expect(
      redactArguments('browser_route', make(MAX_ARGUMENTS_BYTES - overhead + 1)).$truncated,
    ).toBe(true);
  });
});

describe('redactedStrings', () => {
  it('returns the raw strings that the rule redacts', () => {
    expect(redactedStrings('browser_type', { target: 'e1', text: 'hunter2' })).toEqual(['hunter2']);
    expect(
      redactedStrings('browser_fill_form', {
        fields: [
          { target: 'e1', value: 'a-1' },
          { target: 'e2', value: 'b-2' },
        ],
      }),
    ).toEqual(['a-1', 'b-2']);
    expect(
      redactedStrings('browser_drop', { data: { 'text/plain': 'x1', 'text/html': 'y2' } }),
    ).toEqual(['x1', 'y2']);
    expect(redactedStrings('browser_navigate', { url: 'https://example.com' })).toEqual([]);
  });

  it('follows the fail-closed paths of redactArguments', () => {
    expect(redactedStrings('browser_fill_form', { fields: ['secret'] })).toEqual(['secret']);
    expect(redactedStrings('browser_fill_form', { fields: { value: 'secret' } })).toEqual([
      'secret',
    ]);
    expect(redactedStrings('browser_drop', { data: 'secret' })).toEqual(['secret']);
  });

  it('takes only single characters of browser_press_key, and every string of an unknown tool', () => {
    expect(redactedStrings('browser_press_key', { key: 'a' })).toEqual(['a']);
    expect(redactedStrings('browser_press_key', { key: 'Enter' })).toEqual([]);
    expect(redactedStrings('checkout', { card: '4111', items: [{ sku: 'A-1' }] })).toEqual([
      '4111',
      'A-1',
    ]);
    expect(redactedStrings('browser_type', undefined)).toEqual([]);
  });
});

describe('truncateString', () => {
  it('keeps short strings and does not split a surrogate pair', () => {
    expect(truncateString('short', 10)).toBe('short');
    const value = `${'a'.repeat(4)}😀${'b'.repeat(40)}`;
    const cut = truncateString(value, 25);
    expect(cut.length).toBeLessThanOrEqual(25);
    expect(cut.startsWith('aaaa')).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
  });
});
