import {
  CreateTokenRequestSchema,
  TOKEN_EXPIRY_DAYS,
  type CreateTokenResponse,
  type SessionResource,
} from '@hydra/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { useCreateToken } from '../../api/tokens';
import {
  Banner,
  Button,
  CodeBlock,
  RadioGroup,
  Sheet,
  SheetBody,
  SheetFooter,
  TextField,
} from '../../components/os';
import { claudeMcpAddCommand, mcpEndpoint, mcpServersJson } from '../../lib/mcp-config';

type ExpiryValue = `${(typeof TOKEN_EXPIRY_DAYS)[number]}`;

/** The rule of the token name in @hydra/shared (CreateTokenRequestSchema). */
const NAME_RULE = 'Use 1 to 64 letters, digits, "-", or "_".';

const EXPIRY_OPTIONS = TOKEN_EXPIRY_DAYS.map((days) => ({
  value: String(days) as ExpiryValue,
  label: days === 1 ? '1 day' : `${String(days)} days`,
}));

export interface NewTokenSheetProps {
  sid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: CreateTokenResponse) => void;
}

/** Name and expiry of a new agent token (spec sections 6.6 and 10.2). */
export function NewTokenSheet({ sid, open, onOpenChange, onCreated }: NewTokenSheetProps) {
  const create = useCreateToken(sid);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('30');
  const [nameError, setNameError] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    setName('');
    setExpiry('30');
    setNameError(null);
    create.reset();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // While the request is pending, Escape and the backdrop do not close the sheet: a
        // reset now would orphan the token that the server is creating.
        if (!next && !create.isPending) close();
      }}
      title="New token"
      description="An agent with this token controls the browser of this session through MCP."
    >
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = CreateTokenRequestSchema.safeParse({
            name: name.trim(),
            expiresInDays: Number(expiry),
          });
          if (!parsed.success) {
            setNameError(NAME_RULE);
            return;
          }
          setNameError(null);
          create.mutate(parsed.data, {
            onSuccess: (created) => {
              close();
              onCreated(created);
            },
          });
        }}
      >
        <SheetBody>
          <TextField
            label="Name"
            placeholder="For example: laptop"
            hint="MCP clients show this name for the server."
            value={name}
            error={nameError}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <RadioGroup
            label="Expires after"
            value={expiry}
            options={EXPIRY_OPTIONS}
            onValueChange={setExpiry}
          />
          {create.error ? (
            <Banner variant="warning" role="alert">
              {errorMessage(create.error)}
            </Banner>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}

export interface TokenCreatedSheetProps {
  session: SessionResource;
  created: CreateTokenResponse | null;
  onClose: () => void;
}

/** Shows the token one time, as the Claude Code command and as JSON (spec section 10.2). */
export function TokenCreatedSheet({ session, created, onClose }: TokenCreatedSheetProps) {
  const endpoint = mcpEndpoint(window.location.origin, session.id);
  // The token name is the MCP server name in both configs.
  const name = created?.token.name ?? '';
  const secret = created?.secret ?? '';
  return (
    <Sheet
      open={created !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Token “${created?.token.name ?? ''}” created`}
      description="Copy the token now. Hydra shows it only one time."
      wide
    >
      <SheetBody>
        <div className="flex flex-col gap-1">
          <h3 className="text-os-base font-semibold">Claude Code</h3>
          <CodeBlock
            label="Claude Code command"
            code={claudeMcpAddCommand(name, endpoint, secret)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-os-base font-semibold">Other MCP clients</h3>
          <CodeBlock label="mcpServers config" code={mcpServersJson(name, endpoint, secret)} />
        </div>
      </SheetBody>
      <SheetFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </SheetFooter>
    </Sheet>
  );
}
