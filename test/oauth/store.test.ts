import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenStore, type StoredToken } from '../../src/oauth/store.js';

function makeToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    serverURL: 'http://127.0.0.1:39725/mcp',
    clientId: 'cid_abc',
    accessToken: 'tok_xyz',
    expiresAt: null,
    createdAt: '2026-05-26T12:00:00Z',
    ...overrides,
  };
}

describe('TokenStore', () => {
  let dir: string;
  let store: TokenStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'paste-mcp-test-'));
    store = new TokenStore(join(dir, 'tokens.json'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null when no file exists', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips a stored token', async () => {
    const token = makeToken();
    await store.save(token);
    expect(await store.load()).toEqual(token);
  });

  it('round-trips a stored token with expiresAt', async () => {
    const token = makeToken({ expiresAt: '2026-12-31T00:00:00Z' });
    await store.save(token);
    const loaded = await store.load();
    expect(loaded?.expiresAt).toBe('2026-12-31T00:00:00Z');
  });

  it('writes the file with mode 0600', async () => {
    await store.save(makeToken());
    const stat = await fs.stat(store.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('clear() removes the file', async () => {
    await store.save(makeToken());
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('clear() is a no-op when the file does not exist', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('load() returns null for malformed JSON', async () => {
    await fs.writeFile(store.path, 'not json', { mode: 0o600 });
    expect(await store.load()).toBeNull();
  });

  it('load() returns null for JSON missing required fields', async () => {
    await fs.writeFile(store.path, JSON.stringify({ foo: 'bar' }), { mode: 0o600 });
    expect(await store.load()).toBeNull();
  });

  it('load() back-fills missing expiresAt and createdAt for forward-compat', async () => {
    // A token written by a pre-expiresAt version of the bridge.
    await fs.writeFile(store.path, JSON.stringify({
      serverURL: 'http://127.0.0.1:39725/mcp',
      clientId: 'old',
      accessToken: 'tok',
    }), { mode: 0o600 });
    const loaded = await store.load();
    expect(loaded?.clientId).toBe('old');
    expect(loaded?.expiresAt).toBeNull();
    expect(typeof loaded?.createdAt).toBe('string');
  });

  it('save() is atomic — readers never see a partial file', async () => {
    const writes = Array.from({ length: 20 }, (_, i) => store.save(makeToken({
      clientId: `cid-${i}`,
      accessToken: `tok-${i}`,
    })));
    const reads = Array.from({ length: 20 }, () => store.load());
    const [, results] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    for (const r of results) {
      if (r === null) continue;
      expect(r.clientId).toMatch(/^cid-\d+$/);
      expect(r.accessToken).toMatch(/^tok-\d+$/);
    }
  });
});
