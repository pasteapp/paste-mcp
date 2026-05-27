import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenStore, type CachedOAuthState } from '../../src/oauth/store.js';

function makeState(overrides: Partial<CachedOAuthState> = {}): CachedOAuthState {
  return {
    serverURL: 'http://127.0.0.1:39725/mcp',
    clientInformation: { client_id: 'cid_abc', redirect_uris: ['http://127.0.0.1:0/cb'] },
    tokens: { access_token: 'tok_xyz', token_type: 'Bearer' },
    codeVerifier: 'verifier_123',
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

  it('round-trips a fully-populated state', async () => {
    const state = makeState();
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it('round-trips a sparse state (just serverURL + verifier)', async () => {
    const state = { serverURL: 'http://127.0.0.1:5454/mcp', codeVerifier: 'v' };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it('writes the file with mode 0600', async () => {
    await store.save(makeState());
    const stat = await fs.stat(store.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('clear() removes the file', async () => {
    await store.save(makeState());
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

  it('load() returns null for JSON missing serverURL', async () => {
    await fs.writeFile(store.path, JSON.stringify({ tokens: { access_token: 't' } }), { mode: 0o600 });
    expect(await store.load()).toBeNull();
  });

  it('save() is atomic — readers never see a partial file', async () => {
    const writes = Array.from({ length: 20 }, (_, i) => store.save(makeState({
      tokens: { access_token: `tok-${i}`, token_type: 'Bearer' },
    })));
    const reads = Array.from({ length: 20 }, () => store.load());
    const [, results] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    for (const r of results) {
      if (r === null) continue;
      expect(r.tokens?.access_token).toMatch(/^tok-\d+$/);
    }
  });
});
