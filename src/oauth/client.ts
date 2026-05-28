// OAuth client for Paste's loopback MCP server, built on the official
// `@modelcontextprotocol/sdk` `auth()` function. The SDK handles metadata
// discovery (RFC 9728 protected-resource + RFC 8414 + OIDC fallback),
// dynamic client registration (RFC 7591), PKCE generation/verification,
// the `resource` indicator (RFC 8707), token exchange, and refresh-token
// rotation. We provide the storage backing and the side effects (open
// browser, wait on the loopback callback).

import { spawn } from 'node:child_process';
import {
  auth,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { detectClientName } from '../client-name.js';
import { startCallbackServer, type CallbackServer } from './callback.js';
import { TokenStore, type CachedOAuthState } from './store.js';

export type StartCallbackServer = () => Promise<CallbackServer>;
export type OpenBrowser = (url: string) => void | Promise<void>;

export interface OAuthClientOptions {
  fetch?: typeof fetch;
  openBrowser?: OpenBrowser;
  startCallbackServer?: StartCallbackServer;
  /// Override the auto-detected AI tool name sent at DCR. Default: env
  /// `PASTE_MCP_CLIENT` → process-tree heuristic → `@pasteapp/mcp`.
  clientName?: string | (() => string | Promise<string>);
}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly openBrowserImpl: OpenBrowser;
  private readonly startCallbackServerImpl: StartCallbackServer;

  constructor(
    public readonly serverURL: URL,
    private readonly store: TokenStore = new TokenStore(),
    private readonly opts: OAuthClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.openBrowserImpl = opts.openBrowser ?? defaultOpenBrowser;
    this.startCallbackServerImpl = opts.startCallbackServer ?? startCallbackServer;
  }

  async accessToken(): Promise<string> {
    const cached = await this.store.load();
    if (cached && cached.serverURL === this.serverURL.toString() && cached.tokens?.access_token) {
      // Short-circuit: Paste issues long-lived access tokens without
      // refresh_tokens, so SDK's `auth()` would always fall through to a
      // fresh authorization. The bridge's transport will call `invalidate()`
      // on 401 if the token actually went stale.
      return cached.tokens.access_token;
    }
    // Different server URL (port changed, channel switched) → drop the cache.
    if (cached && cached.serverURL !== this.serverURL.toString()) {
      await this.store.clear();
    }
    const callback = await this.startCallbackServerImpl();
    const provider = new BridgeProvider({
      serverURL: this.serverURL.toString(),
      redirectUrl: `http://127.0.0.1:${callback.port}/cb`,
      state: callback.state,
      store: this.store,
      openBrowser: this.openBrowserImpl,
      clientName: await this.resolveClientName(),
    });
    try {
      const first = await auth(provider, {
        serverUrl: this.serverURL,
        fetchFn: this.fetchImpl,
      });
      if (first === 'AUTHORIZED') return await readToken(provider);

      const cb = await callback.waitForCallback();
      if (cb.error) {
        const detail = cb.errorDescription ? ` — ${cb.errorDescription}` : '';
        throw new Error(`OAuth error: ${cb.error}${detail}`);
      }
      if (!cb.code) throw new Error('OAuth callback missing `code`');

      const second = await auth(provider, {
        serverUrl: this.serverURL,
        authorizationCode: cb.code,
        fetchFn: this.fetchImpl,
      });
      if (second !== 'AUTHORIZED') {
        throw new Error(`OAuth handshake did not authorize (returned ${second})`);
      }
      return await readToken(provider);
    } finally {
      await callback.shutdown();
    }
  }

  async invalidate(): Promise<void> {
    await this.store.clear();
  }

  private async resolveClientName(): Promise<string> {
    const override = this.opts.clientName;
    if (typeof override === 'string') return override;
    if (typeof override === 'function') return await override();
    return await detectClientName();
  }
}

async function readToken(provider: OAuthClientProvider): Promise<string> {
  const tokens = await provider.tokens();
  if (!tokens?.access_token) throw new Error('OAuth flow completed but no access token was returned');
  return tokens.access_token;
}

interface BridgeProviderOptions {
  serverURL: string;
  redirectUrl: string;
  state: string;
  store: TokenStore;
  openBrowser: OpenBrowser;
  clientName: string;
}

class BridgeProvider implements OAuthClientProvider {
  constructor(private readonly opts: BridgeProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  // Per-flow state for CSRF defense. Our callback server validates this on
  // its side too — defense in depth.
  state(): string {
    return this.opts.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.loadCache()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.mergeCache({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loadCache()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // The verifier is single-use; once tokens land we don't need it on disk.
    const cached = await this.loadCache();
    const next: CachedOAuthState = {
      serverURL: this.opts.serverURL,
      tokens,
      ...(cached.clientInformation ? { clientInformation: cached.clientInformation } : {}),
    };
    await this.opts.store.save(next);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.mergeCache({ codeVerifier: verifier });
  }

  async codeVerifier(): Promise<string> {
    const cached = await this.loadCache();
    if (!cached.codeVerifier) {
      throw new Error('No PKCE code verifier in cache — OAuth state was cleared between auth() calls');
    }
    return cached.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Enforced here (not just in defaultOpenBrowser) so an injected opener
    // can't bypass the guard. The AS-supplied `authorization_endpoint` is
    // attacker-influenceable if the discovered port has been hijacked.
    assertLoopbackHTTPURL(authorizationUrl.toString());
    await this.opts.openBrowser(authorizationUrl.toString());
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') {
      await this.opts.store.clear();
      return;
    }
    const cached = await this.opts.store.load();
    if (!cached) return;
    const next = { ...cached };
    if (scope === 'client') delete next.clientInformation;
    if (scope === 'tokens') delete next.tokens;
    if (scope === 'verifier') delete next.codeVerifier;
    // 'discovery' — we don't cache discovery state, nothing to do.
    await this.opts.store.save(next);
  }

  private async loadCache(): Promise<CachedOAuthState> {
    const stored = await this.opts.store.load();
    // Cache must belong to the server we were constructed for. A stale entry
    // for a different server gets dropped here rather than overwritten — the
    // alternative (always stamping `serverURL: this.opts.serverURL` on save)
    // would silently graft another server's tokens onto our cache.
    if (stored && stored.serverURL === this.opts.serverURL) return stored;
    return { serverURL: this.opts.serverURL };
  }

  private async mergeCache(patch: Partial<CachedOAuthState>): Promise<void> {
    const cached = await this.loadCache();
    await this.opts.store.save({ ...cached, ...patch, serverURL: this.opts.serverURL });
  }
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
  // URL guard lives in BridgeProvider.redirectToAuthorization so an injected
  // opener can't bypass it; here we just spawn `/usr/bin/open`.
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
  // Without this listener, a missing `/usr/bin/open` (non-macOS) would crash
  // the process with ERR_UNHANDLED_ERROR; here it fails silently and the
  // OAuth flow surfaces "callback timed out" instead.
  child.on('error', () => { /* swallow */ });
  child.unref();
}
