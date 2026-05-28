import { describe, it, expect } from 'vitest';
import { startCallbackServer } from '../../src/oauth/callback.js';

async function hit(port: number, path: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`);
}

describe('startCallbackServer', () => {
  it('exposes a per-flow state and resolves only when the callback carries it', async () => {
    const cb = await startCallbackServer();
    expect(cb.state).toMatch(/^[A-Za-z0-9_-]+$/);
    const fetched = hit(cb.port, `/cb?code=abc123&state=${encodeURIComponent(cb.state)}`);
    const result = await cb.waitForCallback();
    await fetched;
    expect(result).toEqual({
      code: 'abc123',
      state: cb.state,
      error: null,
      errorDescription: null,
    });
    await cb.shutdown();
  });

  it('resolves with error when the user denies consent (with matching state)', async () => {
    const cb = await startCallbackServer();
    const fetched = hit(
      cb.port,
      `/cb?error=access_denied&error_description=user+said+no&state=${encodeURIComponent(cb.state)}`,
    );
    const result = await cb.waitForCallback();
    await fetched;
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('user said no');
    expect(result.code).toBeNull();
    await cb.shutdown();
  });

  it('ignores favicon / scan requests', async () => {
    const cb = await startCallbackServer();
    const faviconResp = await hit(cb.port, '/favicon.ico');
    expect(faviconResp.status).toBe(200);
    // The wait should still be pending.
    const racer = Promise.race([
      cb.waitForCallback({ timeoutMs: 5_000 }).then(() => 'resolved'),
      new Promise<string>((res) => setTimeout(() => res('still-waiting'), 100)),
    ]);
    expect(await racer).toBe('still-waiting');
    await hit(cb.port, `/cb?code=ok&state=${encodeURIComponent(cb.state)}`);
    await cb.shutdown();
  });

  it('ignores forged callbacks that omit `code` (e.g. `?code=&state=…`)', async () => {
    const cb = await startCallbackServer();
    await hit(cb.port, `/cb?code=&state=${encodeURIComponent(cb.state)}`);
    const racer = Promise.race([
      cb.waitForCallback({ timeoutMs: 5_000 }).then(() => 'resolved'),
      new Promise<string>((res) => setTimeout(() => res('still-waiting'), 100)),
    ]);
    expect(await racer).toBe('still-waiting');
    await hit(cb.port, `/cb?code=real&state=${encodeURIComponent(cb.state)}`);
    await cb.shutdown();
  });

  it('ignores callbacks with the wrong state (forged by a loopback attacker)', async () => {
    const cb = await startCallbackServer();
    await hit(cb.port, `/cb?code=attacker&state=guessed-wrong`);
    const racer = Promise.race([
      cb.waitForCallback({ timeoutMs: 5_000 }).then(() => 'resolved'),
      new Promise<string>((res) => setTimeout(() => res('still-waiting'), 100)),
    ]);
    expect(await racer).toBe('still-waiting');
    await hit(cb.port, `/cb?code=real&state=${encodeURIComponent(cb.state)}`);
    await cb.shutdown();
  });

  it('times out when no callback arrives within timeoutMs', async () => {
    const cb = await startCallbackServer();
    await expect(cb.waitForCallback({ timeoutMs: 50 })).rejects.toThrow(/timed out/i);
    await cb.shutdown();
  });

  it('shutdown before any request settles a pending awaiter', async () => {
    const cb = await startCallbackServer();
    const wait = cb.waitForCallback({ timeoutMs: 60_000 });
    await cb.shutdown();
    await expect(wait).rejects.toThrow(/shut down/i);
  });

  it('shutdown closes keep-alive connections promptly (no hang)', async () => {
    const cb = await startCallbackServer();
    const fetched = hit(cb.port, `/cb?code=ok&state=${encodeURIComponent(cb.state)}`);
    await cb.waitForCallback();
    await fetched;
    // Without `closeAllConnections()` this would block until the kept-alive
    // socket's idle timer fires. Cap with a fail-fast race.
    const shutdownDone = cb.shutdown().then(() => 'shutdown');
    const ticked = new Promise<string>((res) => setTimeout(() => res('timed-out'), 2_000));
    expect(await Promise.race([shutdownDone, ticked])).toBe('shutdown');
  });

  it('shutdown is idempotent', async () => {
    const cb = await startCallbackServer();
    const fetched = hit(cb.port, `/cb?code=ok&state=${encodeURIComponent(cb.state)}`);
    await cb.waitForCallback();
    await fetched;
    await expect(cb.shutdown()).resolves.toBeUndefined();
    await expect(cb.shutdown()).resolves.toBeUndefined();
  });
});
