import { describe, expect, it } from 'vitest';
import { claudeMcpAddCommand, mcpEndpoint, mcpServersJson } from './mcp-config';

describe('mcp-config', () => {
  const endpoint = mcpEndpoint('https://hydra.example.com', 'q2w3e4r5t6y7');

  it('builds the MCP endpoint of a session', () => {
    expect(endpoint).toBe('https://hydra.example.com/s/q2w3e4r5t6y7/mcp');
  });

  it('builds the claude mcp add command of spec section 10.2', () => {
    expect(claudeMcpAddCommand('laptop', endpoint, 'hyd_secret')).toBe(
      'claude mcp add --transport http laptop https://hydra.example.com/s/q2w3e4r5t6y7/mcp --header "Authorization: Bearer hyd_secret"',
    );
  });

  it('builds the mcpServers JSON config', () => {
    expect(JSON.parse(mcpServersJson('laptop', endpoint, 'hyd_secret'))).toEqual({
      mcpServers: {
        laptop: {
          type: 'http',
          url: 'https://hydra.example.com/s/q2w3e4r5t6y7/mcp',
          headers: { Authorization: 'Bearer hyd_secret' },
        },
      },
    });
  });
});
