// On-disk cache of an OAuth client_id + access token, keyed implicitly to the
// server URL it was issued for. Mode 0600 — same convention as ~/.pgpass,
// ~/.aws/credentials, mcp-remote's ~/.mcp-auth, and ssh keys.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export interface StoredToken {
  serverURL: string;
  clientId: string;
  accessToken: string;
  /// ISO 8601 — when the AS-issued `expires_in` runs out. `null` if the AS
  /// didn't return one (treat as non-expiring).
  expiresAt: string | null;
  createdAt: string;
}

const DEFAULT_PATH = `${homedir()}/Library/Application Support/paste-mcp/tokens.json`;

export class TokenStore {
  constructor(public readonly path: string = DEFAULT_PATH) {}

  async load(): Promise<StoredToken | null> {
    let data: string;
    try {
      data = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // A corrupt cache (partial write, garbage on disk) should not crash the
    // bridge — treat it as absent so the OAuth flow runs and overwrites.
    let parsed: Partial<StoredToken>;
    try {
      parsed = JSON.parse(data) as Partial<StoredToken>;
    } catch {
      return null;
    }
    if (
      typeof parsed.serverURL !== 'string'
      || typeof parsed.clientId !== 'string'
      || typeof parsed.accessToken !== 'string'
    ) {
      return null;
    }
    return {
      serverURL: parsed.serverURL,
      clientId: parsed.clientId,
      accessToken: parsed.accessToken,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  }

  async save(token: StoredToken): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    // Atomic write: stage to a unique temp file then rename. POSIX rename is
    // atomic within a filesystem, so a reader never sees a partial file.
    // The suffix is per-call (not per-pid) so concurrent saves in the same
    // process don't collide on the temp path.
    const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
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
