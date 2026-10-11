#!/usr/bin/env node
import { runCli } from './commands.js';
import { createSecretReader, isInteractive } from './prompt.js';

let readSecret: ((prompt: string) => Promise<string>) | undefined;

// Runs when the file is loaded, also by `import()` from the launcher of the gateway image
// (plan 08), so there is no "main module" check.
const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  interactive: isInteractive(process.stdin),
  // Created on first use, so `hydra keygen` does not read stdin.
  readSecret: (prompt) => (readSecret ??= createSecretReader())(prompt),
});
process.exit(code);
