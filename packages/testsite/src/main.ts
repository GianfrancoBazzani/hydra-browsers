import { createTestsiteServer } from './server.js';

const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a port number, got "${process.env.PORT ?? ''}"`);
  process.exit(1);
}

const server = createTestsiteServer();
server.listen(port, '0.0.0.0', () => {
  console.log(`hydra-testsite listens on port ${port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
