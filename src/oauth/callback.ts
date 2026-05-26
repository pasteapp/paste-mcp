// Local HTTP listener that catches the OAuth authorization-code redirect.
// Binds to a random loopback port, accepts the redirect, hands back a friendly
// confirmation page, and resolves the awaiting promise with the parsed query.
//
// Defense layers against same-machine attackers who race-bind the loopback
// port: only requests that carry the per-flow `state` token AND a non-empty
// `code` or `error` settle the wait. Stray requests (favicon, scans, forged
// callbacks with the wrong state) get a benign HTML response but the wait
// stays open. The state is also exposed via `server.state` so the caller can
// embed it in the `/authorize` request.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateState } from './pkce.js';

export interface CallbackResult {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export interface CallbackServer {
  port: number;
  state: string;
  waitForCallback(opts?: { timeoutMs?: number }): Promise<CallbackResult>;
  shutdown(): Promise<void>;
}

const PAGE_HTML = '<!doctype html>'
  + '<html lang="en"><head><meta charset="utf-8"><title>Paste connected</title>'
  + '<style>body{font:14px -apple-system,sans-serif;color:#333;text-align:center;padding:64px}</style>'
  + '</head><body><h2>Paste is connected.</h2>'
  + '<p>You can close this tab and return to your AI app.</p></body></html>';

export async function startCallbackServer(): Promise<CallbackServer> {
  const expectedState = generateState();
  let settled = false;
  let resolveCallback: ((value: CallbackResult) => void) | null = null;
  let rejectCallback: ((err: Error) => void) | null = null;
  const pending = new Promise<CallbackResult>((res, rej) => {
    resolveCallback = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    rejectCallback = (err) => {
      if (settled) return;
      settled = true;
      rej(err);
    };
  });
  // Avoid an unhandled rejection if nobody awaits `pending`.
  pending.catch(() => {});

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(PAGE_HTML);
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = nullIfEmpty(parsed.searchParams.get('code'));
    const state = parsed.searchParams.get('state');
    const error = nullIfEmpty(parsed.searchParams.get('error'));
    const errorDescription = nullIfEmpty(parsed.searchParams.get('error_description'));
    // Drop stray probes (favicon, scans) AND forged callbacks that don't carry
    // our per-flow state — both classes can otherwise DoS the wait.
    if (code === null && error === null) return;
    if (state !== expectedState) return;
    resolveCallback?.({ code, state, error, errorDescription });
  });

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    state: expectedState,
    async waitForCallback({ timeoutMs = 300_000 } = {}): Promise<CallbackResult> {
      const timer = setTimeout(() => {
        rejectCallback?.(new Error('OAuth callback timed out'));
      }, timeoutMs);
      try {
        return await pending;
      } finally {
        clearTimeout(timer);
      }
    },
    async shutdown(): Promise<void> {
      // If the flow aborted before a callback arrived, settle the promise so
      // any straggling awaiter unwinds instead of hanging forever.
      rejectCallback?.(new Error('Callback server shut down'));
      // Browsers keep the success-page connection alive — `server.close()` on
      // its own waits for those sockets to time out. Force them shut so the
      // shutdown returns promptly.
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

function nullIfEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}
