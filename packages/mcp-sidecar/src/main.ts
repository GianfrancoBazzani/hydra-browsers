#!/usr/bin/env node
// hydra-mcp: Playwright MCP with the Hydra vault fill (spec sections 7.4 and 8.8.3).
import { createConnection } from '@playwright/mcp';
import { parseSidecarArgs } from './args.js';
import { CdpBrowser, type Log } from './browser.js';
import { vaultFill } from './fill.js';
import { InterceptingTransport } from './interceptor.js';
import { SidecarServer } from './server.js';

const log: Log = {
  info: (message) => {
    process.stderr.write(`hydra-mcp: ${message}\n`);
  },
  error: (message, err) => {
    // Never the arguments of a call: an error can come from a fill.
    const reason = err instanceof Error ? `: ${err.message.split('\n')[0] ?? ''}` : '';
    process.stderr.write(`hydra-mcp: ${message}${reason}\n`);
  },
};

async function main(): Promise<void> {
  const options = parseSidecarArgs(process.argv.slice(2));
  const browser = new CdpBrowser(options.cdpEndpoint, log);
  const server = new SidecarServer({
    allowedHosts: options.allowedHosts,
    log,
    connectSession: async (transport) => {
      const context = browser.context;
      if (context === null) throw new Error('The browser is not connected.');
      // sharedBrowserContext: all MCP sessions share the Chromium context (spec section 8.4), so
      // browser_close cannot close it (spike V2).
      const playwright = await createConnection(
        {
          sharedBrowserContext: true,
          outputDir: options.outputDir,
          capabilities: options.caps as never,
        },
        () => Promise.resolve(context),
      );
      const interceptor = new InterceptingTransport(transport, (args, internal) =>
        vaultFill(args, browser.context, internal),
      );
      await playwright.connect(interceptor);
      return interceptor;
    },
  });
  browser.onDisconnect(() => {
    log.error('the CDP connection closed, all MCP sessions end');
    server.setConnected(false);
    void browser.connect().then(() => {
      server.setConnected(true);
    });
  });
  await browser.connect();
  server.setConnected(true);
  const port = await server.listen(options.host, options.port);
  process.stderr.write(`Listening on http://localhost:${String(port)}\n`);
  const stop = (): void => {
    browser.stop();
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((err: unknown) => {
  log.error('start failed', err);
  process.exit(1);
});
