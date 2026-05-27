import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthClient, assertLoopbackHTTPURL } from '../../src/oauth/client.js';
import { TokenStore, type CachedOAuthState } from '../../src/oauth/store.js';

interface MockOAuthServer {
  url: string;
  registerCalls: number;
  tokenCalls: number;
  lastTokenForm: URLSearchParams | null;
  setNextCode(code: string): void;
  setTokenResponse(body: object): void;
  shutdown(): Promise<void>;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function startMockOAuthServer(): Promise<MockOAuthServer> {
  const state = {
    nextCode: 'mock-code-1',
    registerCalls: 0,
    tokenCalls: 0,
    lastTokenForm: null as URLSearchParams | null,
    tokenResponse: null as object | null,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const base = `http://${req.headers.host}`;

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: base, authorization_servers: [base] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      state.registerCalls += 1;
      const body = await readBody(req);
      let parsed: { redirect_uris?: string[]; client_name?: string };
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: `mock-client-${state.registerCalls}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: parsed.client_name ?? 'Test Client',
        redirect_uris: parsed.redirect_uris ?? [],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri')!;
      const stateParam = url.searchParams.get('state') ?? '';
      const target = new URL(redirectUri);
      target.searchParams.set('code', state.nextCode);
      target.searchParams.set('state', stateParam);
      res.writeHead(302, { Location: target.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      state.tokenCalls += 1;
      state.lastTokenForm = new URLSearchParams(await readBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.tokenResponse ?? {
        access_token: `tok-for-${state.lastTokenForm.get('code')}`,
        token_type: 'Bearer',
      }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    get registerCalls() { return state.registerCalls; },
    get tokenCalls() { return state.tokenCalls; },
    get lastTokenForm() { return state.lastTokenForm; },
    setNextCode(code) { state.nextCode = code; },
    setTokenResponse(body) { state.tokenResponse = body; },
    async shutdown() {
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

function simulatedBrowser(): (url: string) => Promise<void> {
  return async (url: string) => {
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (location) await fetch(location);
  };
}

describe('OAuthClient', () => {
  let dir: string;
  let store: TokenStore;
  let mock: Awaited<ReturnType<typeof startMockOAuthServer>>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'paste-mcp-oauth-'));
    store = new TokenStore(join(dir, 'tokens.json'));
    mock = await startMockOAuthServer();
  });

  afterEach(async () => {
    await mock.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs the full DCR + PKCE flow on first call and caches state', async () => {
    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, {
      openBrowser: simulatedBrowser(),
    });
    const token = await client.accessToken();
    expect(token).toBe('tok-for-mock-code-1');
    expect(mock.registerCalls).toBe(1);
    expect(mock.tokenCalls).toBe(1);

    const cached = await store.load();
    expect(cached?.serverURL).toBe(`${mock.url}/mcp`);
    expect(cached?.tokens?.access_token).toBe('tok-for-mock-code-1');
    expect(cached?.clientInformation?.client_id).toBe('mock-client-1');

    // PKCE: verifier sent to /token must be RFC 7636 unreserved-shape
    // (alpha-num plus `-`, `.`, `_`, `~`).
    const verifier = mock.lastTokenForm?.get('code_verifier') ?? '';
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);

    // 0600 file permissions.
    const stat = await fs.stat(store.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reuses the cached token on subsequent calls — no second OAuth round-trip', async () => {
    const open = vi.fn(simulatedBrowser());
    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, { openBrowser: open });
    await client.accessToken();
    expect(open).toHaveBeenCalledTimes(1);
    expect(mock.tokenCalls).toBe(1);

    const second = await client.accessToken();
    expect(second).toBe('tok-for-mock-code-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(mock.tokenCalls).toBe(1);
  });

  it('drops a cached state that was issued for a different server URL', async () => {
    const stale: CachedOAuthState = {
      serverURL: 'http://127.0.0.1:99999/mcp',
      clientInformation: { client_id: 'old', redirect_uris: ['http://127.0.0.1:0/cb'] },
      tokens: { access_token: 'old-token', token_type: 'Bearer' },
    };
    await store.save(stale);

    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, {
      openBrowser: simulatedBrowser(),
    });
    const token = await client.accessToken();
    expect(token).toBe('tok-for-mock-code-1');
    expect((await store.load())?.serverURL).toBe(`${mock.url}/mcp`);
  });

  it('invalidate() clears the cache so the next call re-runs OAuth', async () => {
    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, {
      openBrowser: simulatedBrowser(),
    });
    await client.accessToken();
    await client.invalidate();
    expect(await store.load()).toBeNull();

    mock.setNextCode('mock-code-2');
    const token = await client.accessToken();
    expect(token).toBe('tok-for-mock-code-2');
    expect(mock.registerCalls).toBe(2);
  });

  it('throws when the OAuth provider returns an error in the callback', async () => {
    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, {
      openBrowser: async (authUrlStr) => {
        const authURL = new URL(authUrlStr);
        const redirectUri = authURL.searchParams.get('redirect_uri')!;
        const stateParam = authURL.searchParams.get('state') ?? '';
        const cb = new URL(redirectUri);
        cb.searchParams.set('error', 'access_denied');
        cb.searchParams.set('error_description', 'user denied');
        cb.searchParams.set('state', stateParam);
        await fetch(cb.toString());
      },
    });
    await expect(client.accessToken()).rejects.toThrow(/access_denied/);
    // Cache may have partial state (DCR'd client + verifier); the access token
    // itself never landed, so the next attempt will re-auth.
    expect((await store.load())?.tokens).toBeUndefined();
  });

  it('persists refresh_token from the token response', async () => {
    mock.setTokenResponse({
      access_token: 'tok',
      token_type: 'Bearer',
      refresh_token: 'rt-1',
      expires_in: 3600,
    });
    const client = new OAuthClient(new URL(`${mock.url}/mcp`), store, {
      openBrowser: simulatedBrowser(),
    });
    await client.accessToken();
    const cached = await store.load();
    expect(cached?.tokens?.refresh_token).toBe('rt-1');
    expect(cached?.tokens?.expires_in).toBe(3600);
  });
});

describe('assertLoopbackHTTPURL', () => {
  it('accepts http://127.0.0.1', () => {
    expect(() => assertLoopbackHTTPURL('http://127.0.0.1:5454/authorize')).not.toThrow();
  });

  it('accepts http://localhost', () => {
    expect(() => assertLoopbackHTTPURL('http://localhost:5454/authorize')).not.toThrow();
  });

  it('rejects javascript: URLs (attacker-supplied auth metadata)', () => {
    expect(() => assertLoopbackHTTPURL('javascript:alert(1)')).toThrow(/non-HTTP/);
  });

  it('rejects file: URLs', () => {
    expect(() => assertLoopbackHTTPURL('file:///etc/passwd')).toThrow(/non-HTTP/);
  });

  it('rejects vscode: and other custom URL handlers', () => {
    expect(() => assertLoopbackHTTPURL('vscode://settings')).toThrow(/non-HTTP/);
  });

  it('rejects HTTPS to a non-loopback host', () => {
    expect(() => assertLoopbackHTTPURL('https://evil.example.com/authorize')).toThrow(/non-loopback/);
  });

  it('rejects http://0.0.0.0 (not loopback)', () => {
    expect(() => assertLoopbackHTTPURL('http://0.0.0.0/authorize')).toThrow(/non-loopback/);
  });
});
