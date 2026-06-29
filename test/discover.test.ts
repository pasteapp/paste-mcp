import { describe, it, expect } from 'vitest';
import { discoverServerURL } from '../src/discover.js';

// Treat only the listed ports as "listening" so tests never touch the network.
const liveOn =
  (...ports: number[]) =>
  async (url: URL) =>
    ports.includes(Number(url.port));

describe('discoverServerURL', () => {
  it('returns the plist port when it is live', async () => {
    const url = await discoverServerURL({
      paths: ['/container.plist', '/preferences.plist'],
      read: async (path) => (path === '/container.plist' ? '54321' : null),
      probe: liveOn(54321),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:54321/mcp');
  });

  it('falls through to the next plist path for the port', async () => {
    const url = await discoverServerURL({
      paths: ['/container.plist', '/preferences.plist'],
      read: async (path) => (path === '/preferences.plist' ? '50000' : null),
      probe: liveOn(50000),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:50000/mcp');
  });

  it('falls back to the default port when the plist read is blocked', async () => {
    // The case that matters for Claude Desktop: it can't read Paste's App Store
    // sandbox container, so the plist read yields nothing.
    const url = await discoverServerURL({
      paths: ['/blocked'],
      read: async () => null,
      probe: liveOn(39725),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:39725/mcp');
  });

  it('prefers a live plist port over the default', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => '54321',
      probe: liveOn(54321, 39725),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:54321/mcp');
  });

  it('falls back to the default when the plist port is stale (not listening)', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => '54321',
      probe: liveOn(39725),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:39725/mcp');
  });

  it('returns null when nothing is listening', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => '54321',
      probe: async () => false,
    });
    expect(url).toBeNull();
  });

  it('ignores out-of-range plist ports but still tries the default', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => '99999',
      probe: liveOn(39725),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:39725/mcp');
  });

  it('ignores non-numeric plist values', async () => {
    const url = await discoverServerURL({
      paths: ['/a'],
      read: async () => 'not-a-port',
      probe: liveOn(39725),
    });
    expect(url?.toString()).toBe('http://127.0.0.1:39725/mcp');
  });
});
