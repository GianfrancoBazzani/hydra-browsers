/** The MCP endpoint of a session (spec section 8.1). `origin` is HYDRA_PUBLIC_URL. */
export function mcpEndpoint(origin: string, sid: string): string {
  return `${origin}/s/${sid}/mcp`;
}

/**
 * The Claude Code command of spec section 10.2. `name` is the token name: the shared
 * CreateTokenRequestSchema permits only letters, digits, "-", and "_", so it is safe in a shell.
 */
export function claudeMcpAddCommand(name: string, endpoint: string, secret: string): string {
  return `claude mcp add --transport http ${name} ${endpoint} --header "Authorization: Bearer ${secret}"`;
}

/** The JSON `mcpServers` config for other MCP clients (spec section 10.2). */
export function mcpServersJson(name: string, endpoint: string, secret: string): string {
  const config = {
    mcpServers: {
      [name]: {
        type: 'http',
        url: endpoint,
        headers: { Authorization: `Bearer ${secret}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
