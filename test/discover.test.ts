import { describe, it, expect } from 'vitest';
import { discoverServerURL } from '../src/discover.js';

describe('discoverServerURL', () => {
  it('returns http://127.0.0.1:<port>/mcp from the first path that yields a port', async () => {
    const url = await discoverServerURL({
      paths: ['/container.plist', '/preferences.plist'],
      read: async (path) => (path === '/container.plist' ? '54321' : null),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:54321/mcp');
  });

  it('falls through to the next path when the first is absent', async () => {
    const url = await discoverServerURL({
      paths: ['/container.plist', '/preferences.plist'],
      read: async (path) => (path === '/preferences.plist' ? '39725' : null),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:39725/mcp');
  });

  it('returns null when no path yields a port', async () => {
    const url = await discoverServerURL({
      paths: ['/a', '/b'],
      read: async () => null,
    });
    expect(url).toBeNull();
  });

  it('rejects out-of-range ports', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => '99999',
    });
    expect(url).toBeNull();
  });

  it('rejects non-numeric port values', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => 'not-a-port',
    });
    expect(url).toBeNull();
  });
});
