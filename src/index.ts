#!/usr/bin/env node
import { discoverServerURL } from './discover.js';
import { serveFallback } from './fallback.js';
import { OAuthClient } from './oauth/client.js';
import { Transport } from './transport.js';

// If the host (Claude / Cursor) dies, the stdout pipe goes EPIPE. Without a
// listener Node crashes the process with ERR_UNHANDLED_ERROR before the
// transport loop can react. Belt to the Transport's suspenders.
process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => { /* swallow */ });

async function main(): Promise<number> {
  const url = await discoverServerURL();
  if (url === null) {
    await serveFallback();
    return 0;
  }
  const oauth = new OAuthClient(url);
  const transport = new Transport({
    url,
    tokenProvider: () => oauth.accessToken(),
    onUnauthorized: () => oauth.invalidate(),
  });
  await transport.run(process.stdin, process.stdout);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`paste-mcp: ${message}\n`);
    process.exit(1);
  },
);
