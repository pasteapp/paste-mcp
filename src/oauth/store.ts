// On-disk cache of an OAuth flow's state — client registration (DCR), the
// access/refresh tokens, and the transient PKCE code verifier the SDK needs
// to bridge two `auth()` calls. Mode 0600 — same convention as ~/.pgpass,
// ~/.aws/credentials, mcp-remote's ~/.mcp-auth, and ssh keys.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CachedOAuthState {
  /// Cache key — when Paste's port changes we drop the whole cache.
  serverURL: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

const DEFAULT_PATH = `${homedir()}/Library/Application Support/paste-mcp/tokens.json`;

export class TokenStore {
  constructor(public readonly path: string = DEFAULT_PATH) {}

  async load(): Promise<CachedOAuthState | null> {
    let data: string;
    try {
      data = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // A corrupt cache (partial write, garbage on disk) should not crash the
    // bridge — treat it as absent so the OAuth flow runs and overwrites.
    let parsed: Partial<CachedOAuthState>;
    try {
      parsed = JSON.parse(data) as Partial<CachedOAuthState>;
    } catch {
      return null;
    }
    if (typeof parsed.serverURL !== 'string') return null;
    return {
      serverURL: parsed.serverURL,
      ...(parsed.clientInformation ? { clientInformation: parsed.clientInformation } : {}),
      ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
      ...(parsed.codeVerifier ? { codeVerifier: parsed.codeVerifier } : {}),
    };
  }

  async save(state: CachedOAuthState): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    // Atomic write: stage to a unique temp file then rename. POSIX rename is
    // atomic within a filesystem, so a reader never sees a partial file.
    // The suffix is per-call (not per-pid) so concurrent saves in the same
    // process don't collide on the temp path.
    const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.chmod(tmp, 0o600); // umask-resistant
      await fs.rename(tmp, this.path);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
