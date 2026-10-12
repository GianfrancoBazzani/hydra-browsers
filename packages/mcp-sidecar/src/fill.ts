// The fill of a vault value (spec section 8.8.3, fill steps 1 to 7).
import {
  HydraFillSchema,
  VAULT_TEXTS,
  VaultFillArgumentsSchema,
  createRedactor,
  describeSiteMatch,
  vaultLabel,
  vaultSiteMatches,
} from '@hydra/shared';
import type { BrowserContext, ElementHandle } from 'playwright';
import { currentTabIndex, tabLineMatchesUrl } from './current-tab.js';
import { toolError, type InternalCaller, type ToolResult } from './interceptor.js';

/** Spec section 8.8.3 step 3. */
export const ELEMENT_TIMEOUT_MS = 5_000;
const EDITABLE_INPUT_TYPES = ['text', 'email', 'password', 'search', 'tel', 'number', 'url'];

function textOf(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? url : origin;
  } catch {
    return url === '' ? '(unknown)' : url;
  }
}

export async function vaultFill(
  rawArgs: unknown,
  context: BrowserContext | null,
  internal: InternalCaller,
): Promise<ToolResult> {
  const record =
    typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  // Step 1
  const hydra = HydraFillSchema.safeParse(record.hydraFill);
  if (!hydra.success) return toolError(VAULT_TEXTS.fillOnlyThroughGateway);
  const parsed = VaultFillArgumentsSchema.safeParse(record);
  if (!parsed.success) {
    return toolError(
      `The arguments of vault_fill are not valid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const args = parsed.data;
  const fill = hydra.data;
  const { text: clean } = createRedactor([
    { value: fill.value, label: vaultLabel(args.credentialId, args.field) },
  ]);
  try {
    // Step 2
    if (context === null) return toolError(VAULT_TEXTS.currentTabNotFound);
    const tabs = textOf(await internal.callTool('browser_tabs', { action: 'list' }));
    const index = currentTabIndex(tabs);
    const page = index === null ? undefined : context.pages()[index];
    if (index === null || page === undefined || !tabLineMatchesUrl(tabs, index, page.url())) {
      return toolError(VAULT_TEXTS.currentTabNotFound);
    }
    // Step 3
    let handle: ElementHandle | null;
    try {
      handle = await page
        .locator(`aria-ref=${args.target}`)
        .elementHandle({ timeout: ELEMENT_TIMEOUT_MS });
    } catch {
      handle = null;
    }
    if (handle === null)
      return toolError(
        `Ref ${args.target} is not in the current page snapshot. Take a new snapshot.`,
      );
    try {
      // Step 4: the browser gives the URL of the frame; the JavaScript of the page cannot change it.
      const frameUrl = (await handle.ownerFrame())?.url() ?? '';
      if (!vaultSiteMatches(frameUrl, fill)) {
        return toolError(
          `The element is on ${originOf(frameUrl)}. Credential ${args.credentialId} fills only on ${describeSiteMatch(fill)}.`,
        );
      }
      // Step 5
      const editable = await handle.evaluate((element: unknown, types: string[]) => {
        const field = element as {
          tagName?: string;
          type?: string;
          disabled?: boolean;
          readOnly?: boolean;
        };
        const tag = (field.tagName ?? '').toUpperCase();
        if (field.disabled === true || field.readOnly === true) return false;
        return tag === 'TEXTAREA' || (tag === 'INPUT' && types.includes(field.type ?? ''));
      }, EDITABLE_INPUT_TYPES);
      if (!editable) return toolError(VAULT_TEXTS.notEditable);
      // Step 6: the handle belongs to this document; after a navigation the fill fails.
      if (args.slowly === true) {
        await handle.fill('', { timeout: ELEMENT_TIMEOUT_MS });
        await handle.focus();
        await page.keyboard.type(fill.value);
      } else {
        await handle.fill(fill.value, { timeout: ELEMENT_TIMEOUT_MS });
      }
      if (args.submit === true) await handle.press('Enter', { timeout: ELEMENT_TIMEOUT_MS });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    // Step 7
    const into = args.element ?? args.target;
    return {
      content: [
        {
          type: 'text',
          text: `Filled the ${args.field} of credential ${args.credentialId} into ${into}.${args.submit === true ? ' Pressed Enter.' : ''}`,
        },
      ],
    };
  } catch (err) {
    return toolError(clean(`### Error\n${err instanceof Error ? err.message : String(err)}`));
  }
}
