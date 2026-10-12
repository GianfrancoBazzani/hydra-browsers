// The vault tools of the agent and their exact texts (spec sections 8.8.1, 8.8.2, 8.8.3).
import { VAULT_FIELDS } from '../constants.js';

export const VAULT_TOOL_NAMES = ['vault_list', 'vault_fill'] as const;

/** Spec section 8.8.1: a ref of a Playwright MCP snapshot, for example e12 or f1e5. */
export const VAULT_REF_PATTERN = /^(f\d+)?e\d+$/;

export const VAULT_TEXTS = {
  listDescription:
    'List the credentials in the Hydra vault of this session: ID, name, website, and the values that are set. This tool never shows the values.',
  fillDescription:
    'Fill one value of a vault credential into an editable element. You do not see the value. Get the credential ID from vault_list and the target from a page snapshot. The element must be on the website of the credential.',
  emptyVault:
    'The vault of this session is empty. A person adds credentials in the Vault view of the dashboard.',
  batchRejected:
    'Batch rejected, because it contains a vault tool call. Send vault tool calls one at a time.',
  listOnlyThroughGateway: 'vault_list works only through the Hydra gateway.',
  fillOnlyThroughGateway: 'vault_fill works only through the Hydra gateway.',
  currentTabNotFound: 'Cannot find the current tab. Take a new snapshot and try again.',
  notEditable: 'The element is not an editable text field.',
  internalIdRejected: 'Request IDs that start with hydra-internal- are reserved.',
} as const;

/** The tool definitions that the sidecar adds to each tools/list result (spec section 8.8.1). */
export const VAULT_TOOL_DEFINITIONS = [
  {
    name: 'vault_list',
    title: 'List vault credentials',
    description: VAULT_TEXTS.listDescription,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'vault_fill',
    title: 'Fill a vault value',
    description: VAULT_TEXTS.fillDescription,
    inputSchema: {
      type: 'object',
      properties: {
        credentialId: { type: 'string', description: 'ID from vault_list' },
        field: {
          type: 'string',
          enum: VAULT_FIELDS,
          description: 'The value to fill. totp fills the current code.',
        },
        target: {
          type: 'string',
          description: 'A ref from the newest page snapshot, for example e12 or f1e5',
        },
        element: { type: 'string', description: 'A description of the element' },
        submit: { type: 'boolean', description: 'Press Enter after the fill' },
        slowly: {
          type: 'boolean',
          description: 'Type one character at a time. For code fields with one box for each digit.',
        },
      },
      required: ['credentialId', 'field', 'target'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
] as const;
