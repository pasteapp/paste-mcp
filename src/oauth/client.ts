// OAuth client for Paste's loopback MCP server. Implements the canonical MCP
// authorization dance: RFC 9728 protected-resource metadata → RFC 8414 auth
// server metadata → RFC 7591 dynamic client registration → authorization code
// + PKCE → token exchange. Tokens cached on disk between invocations.

import { spawn } from 'node:child_process';
import { startCallbackServer, type CallbackServer } from './callback.js';
import { generatePKCE } from './pkce.js';
import { TokenStore, type StoredToken } from './store.js';

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface ResourceMetadata {
  authorization_servers?: string[];
}

interface RegistrationResponse {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

const CLIENT_NAME = 'Paste MCP Bridge';
const TOKEN_ERROR_BODY_CAP = 500;

export type StartCallbackServer = () => Promise<CallbackServer>;
export type OpenBrowser = (url: string) => void | Promise<void>;

export interface OAuthClientOptions {
  fetch?: typeof fetch;
  openBrowser?: OpenBrowser;
  startCallbackServer?: StartCallbackServer;
  now?: () => Date;
}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly openBrowserImpl: OpenBrowser;
  private readonly startCallbackServerImpl: StartCallbackServer;
  private readonly nowImpl: () => Date;

  constructor(
    public readonly serverURL: URL,
    private readonly store: TokenStore = new TokenStore(),
    opts: OAuthClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.openBrowserImpl = opts.openBrowser ?? defaultOpenBrowser;
    this.startCallbackServerImpl = opts.startCallbackServer ?? startCallbackServer;
    this.nowImpl = opts.now ?? (() => new Date());
  }

  async accessToken(): Promise<string> {
    const cached = await this.store.load();
    if (cached && cached.accessToken && cached.serverURL === this.serverURL.toString() && !this.isExpired(cached)) {
      return cached.accessToken;
    }
    return await this.runFlow();
  }

  async invalidate(): Promise<void> {
    await this.store.clear();
  }

  private isExpired(token: StoredToken): boolean {
    if (token.expiresAt === null) return false;
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    // 30-second skew so we don't hand out a token that's about to die in flight.
    return expiresAt <= this.nowImpl().getTime() + 30_000;
  }

  private async runFlow(): Promise<string> {
    const metadata = await discoverAuthServer(this.serverURL, this.fetchImpl);
    const callback = await this.startCallbackServerImpl();
    const redirectUri = `http://127.0.0.1:${callback.port}/cb`;
    try {
      const clientId = await registerClient(metadata, redirectUri, this.fetchImpl);
      const { accessToken, expiresIn } = await this.authorize(metadata, clientId, redirectUri, callback);
      const expiresAt = expiresIn != null
        ? new Date(this.nowImpl().getTime() + expiresIn * 1_000).toISOString()
        : null;
      const stored: StoredToken = {
        serverURL: this.serverURL.toString(),
        clientId,
        accessToken,
        expiresAt,
        createdAt: this.nowImpl().toISOString(),
      };
      await this.store.save(stored);
      return accessToken;
    } finally {
      await callback.shutdown();
    }
  }

  private async authorize(
    metadata: AuthServerMetadata,
    clientId: string,
    redirectUri: string,
    callback: CallbackServer,
  ): Promise<{ accessToken: string; expiresIn?: number }> {
    const pkce = generatePKCE();
    await this.openBrowserImpl(buildAuthURL(metadata, clientId, redirectUri, pkce.challenge, callback.state));

    const result = await callback.waitForCallback();
    if (result.error) {
      const detail = result.errorDescription ? ` — ${result.errorDescription}` : '';
      throw new Error(`OAuth error: ${result.error}${detail}`);
    }
    if (!result.code) throw new Error('OAuth callback missing `code`');
    // Belt-and-braces: CallbackServer enforces state too, but a mismatch here
    // means the callback contract drifted — fail loud rather than proceed.
    if (result.state !== callback.state) throw new Error('OAuth state mismatch');

    return await exchangeCode(metadata, clientId, result.code, redirectUri, pkce.verifier, this.fetchImpl);
  }
}

async function discoverAuthServer(serverURL: URL, fetchImpl: typeof fetch): Promise<AuthServerMetadata> {
  const origin = serverURL.origin;
  let authBase = origin;
  try {
    const meta = await fetchJSON<ResourceMetadata>(
      `${origin}/.well-known/oauth-protected-resource`,
      fetchImpl,
    );
    const first = meta.authorization_servers?.[0];
    if (first) authBase = first.replace(/\/$/, '');
  } catch {
    // Resource metadata is optional per the spec — fall back to assuming the
    // server is its own authorization server (Paste's setup).
  }
  const metadata = await fetchJSON<AuthServerMetadata>(
    `${authBase}/.well-known/oauth-authorization-server`,
    fetchImpl,
  );
  if (
    typeof metadata.authorization_endpoint !== 'string'
    || typeof metadata.token_endpoint !== 'string'
    || typeof metadata.registration_endpoint !== 'string'
  ) {
    throw new Error('Authorization server metadata is missing required endpoints');
  }
  return metadata;
}

async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  if (!response.ok) {
    throw new Error(`Dynamic client registration failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as RegistrationResponse;
  if (typeof data.client_id !== 'string' || data.client_id.length === 0) {
    throw new Error('Dynamic client registration response missing `client_id`');
  }
  return data.client_id;
}

async function exchangeCode(
  metadata: AuthServerMetadata,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }).toString();
  const response = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!response.ok) {
    // Capping the error body keeps verifier/code material out of stderr if
    // the AS ever echoes them back in a regression.
    const detail = (await response.text()).slice(0, TOKEN_ERROR_BODY_CAP);
    throw new Error(`Token exchange failed: HTTP ${response.status}: ${detail}`);
  }
  const data = (await response.json()) as TokenResponse;
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Token response missing `access_token`');
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.expires_in === 'number' && data.expires_in > 0
      ? { expiresIn: data.expires_in }
      : {}),
  };
}

function buildAuthURL(
  metadata: AuthServerMetadata,
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

// Refuse to launch anything but an HTTP(S) URL pointing at loopback. An
// attacker who took over the discovered port could otherwise feed us an
// arbitrary URL handler (file:, vscode:, javascript:, etc.) via the AS
// metadata's `authorization_endpoint`. Exported for direct unit testing.
export function assertLoopbackHTTPURL(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open non-HTTP(S) URL: ${parsed.protocol}`);
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    throw new Error(`Refusing to open non-loopback URL: ${parsed.hostname}`);
  }
  return parsed;
}

function defaultOpenBrowser(url: string): void {
  assertLoopbackHTTPURL(url);
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
  // Without this listener, a missing `/usr/bin/open` (non-macOS) would crash
  // the process with ERR_UNHANDLED_ERROR; here it fails silently and the
  // OAuth flow surfaces "callback timed out" instead.
  child.on('error', () => { /* swallow */ });
  child.unref();
}

async function fetchJSON<T>(url: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return (await response.json()) as T;
}
