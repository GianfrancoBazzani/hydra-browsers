import { describe, expect, it } from 'vitest';
import { parseEvaluateResult, toToolOutcome } from './mcp-result.js';

// Texts as Playwright MCP 0.0.83 returns them (recorded on 2026-10-10).
const navigateOk =
  "### Ran Playwright code\n```js\nawait page.goto('http://testsite/set-cookie');\n```\n" +
  '### Page\n- Page URL: http://testsite/set-cookie\n- Page Title: cookie set\n' +
  '### Snapshot\n- [Snapshot](.playwright-mcp/page-2026-10-10T16-56-16-809Z.yml)';
const navigateBlocked =
  '### Error\nError: browserBackend.callTool: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://example.com/\n' +
  'Call log:\n  - navigating to "https://example.com/", waiting until "domcontentloaded"\n';
const evaluateObject =
  '### Result\n{\n  "language": "de-DE",\n  "timeZone": "Asia/Tokyo"\n}\n' +
  "### Ran Playwright code\n```js\nawait page.evaluate('() => ({})');\n```";

describe('toToolOutcome', () => {
  it('joins the text parts of a successful result', () => {
    expect(toToolOutcome({ content: [{ type: 'text', text: navigateOk }] })).toEqual({
      isError: false,
      text: navigateOk,
    });
  });

  it('keeps the error flag and skips parts that are not text', () => {
    const result = {
      content: [
        { type: 'text', text: navigateBlocked },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      isError: true,
    };
    expect(toToolOutcome(result)).toEqual({ isError: true, text: navigateBlocked });
  });

  it('rejects a value that is not a tool result', () => {
    expect(() => toToolOutcome(null)).toThrow('not an object');
  });
});

describe('parseEvaluateResult', () => {
  it('parses an object result', () => {
    expect(parseEvaluateResult(evaluateObject)).toEqual({
      language: 'de-DE',
      timeZone: 'Asia/Tokyo',
    });
  });

  it('parses a string result at the end of the text', () => {
    expect(parseEvaluateResult('### Result\n"hydra_test=abc123"')).toBe('hydra_test=abc123');
  });

  it('fails when the text has no result section', () => {
    expect(() => parseEvaluateResult(navigateBlocked)).toThrow('No "### Result" section');
  });
});
