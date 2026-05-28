import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { Transport, parseSSE } from '../src/transport.js';

function makeTransport(
  fetchImpl: typeof fetch,
  opts: { onUnauthorized?: () => Promise<void>; tokens?: string[]; timeoutMs?: number } = {},
) {
  const tokens = opts.tokens ?? ['token-1'];
  let index = 0;
  return new Transport({
    url: new URL('http://example.test/mcp'),
    tokenProvider: async () => tokens[Math.min(index++, tokens.length - 1)]!,
    fetch: fetchImpl,
    ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

describe('Transport.forward', () => {
  it('emits a JSON response as a single stdout line', async () => {
    const transport = makeTransport(async () => new Response(
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const out = await transport.forward('{"jsonrpc":"2.0","id":1,"method":"x"}');
    expect(out).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  it('splits SSE responses into one line per data payload', async () => {
    const sse = 'event: message\n'
      + 'data: {"jsonrpc":"2.0","id":1,"result":1}\n\n'
      + 'data: {"jsonrpc":"2.0","id":2,"result":2}\n\n';
    const transport = makeTransport(async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));
    const out = await transport.forward('req');
    expect(out).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":1}',
      '{"jsonrpc":"2.0","id":2,"result":2}',
    ]);
  });

  it('emits nothing on 202 Accepted', async () => {
    const transport = makeTransport(async () => new Response('', { status: 202 }));
    expect(await transport.forward('req')).toEqual([]);
  });

  it('captures Mcp-Session-Id on first response and echoes it thereafter', async () => {
    const observed: (string | null)[] = [];
    let count = 0;
    const transport = makeTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      observed.push(headers.get('Mcp-Session-Id'));
      count++;
      return new Response('{}', {
        status: 200,
        headers: count === 1
          ? { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' }
          : { 'content-type': 'application/json' },
      });
    });
    await transport.forward('a');
    await transport.forward('b');
    await transport.forward('c');
    expect(observed).toEqual([null, 'sess-42', 'sess-42']);
  });

  it('sends Bearer token and required transport headers', async () => {
    let observed: Headers | undefined;
    const transport = makeTransport(async (_url, init) => {
      observed = new Headers(init?.headers);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await transport.forward('x');
    expect(observed?.get('authorization')).toBe('Bearer token-1');
    expect(observed?.get('content-type')).toBe('application/json');
    expect(observed?.get('accept')).toBe('application/json, text/event-stream');
  });

  it('on 401 invalidates the cache, refreshes the token, and retries once', async () => {
    let invalidated = false;
    let call = 0;
    const transport = makeTransport(
      async (_url, init) => {
        call++;
        const headers = new Headers(init?.headers);
        const auth = headers.get('authorization');
        if (auth === 'Bearer stale') {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      {
        tokens: ['stale', 'fresh'],
        onUnauthorized: async () => { invalidated = true; },
      },
    );
    const out = await transport.forward('req');
    expect(invalidated).toBe(true);
    expect(call).toBe(2);
    expect(out).toEqual(['{"ok":1}']);
  });

  it('on persistent 401 returns the unauthorized body, not an error envelope', async () => {
    let calls = 0;
    const transport = makeTransport(
      async () => {
        calls += 1;
        return new Response('still bad', { status: 401, headers: { 'content-type': 'text/plain' } });
      },
      {
        tokens: ['stale', 'still-stale'],
        onUnauthorized: async () => { /* noop */ },
      },
    );
    const out = await transport.forward('req');
    expect(out).toEqual(['still bad']);
    // We must retry exactly once (no infinite loop, no third try).
    expect(calls).toBe(2);
  });

  it('emits a JSON-RPC error envelope on transport failure', async () => {
    const transport = makeTransport(async () => { throw new Error('boom'); });
    const out = await transport.forward('{"jsonrpc":"2.0","id":42,"method":"x"}');
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.id).toBe(42);
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toContain('boom');
  });

  it('rejects a response whose Content-Length exceeds the configured cap', async () => {
    // `new Response(body)` in Node doesn't set Content-Length on the headers
    // map, so we hand-craft a Response-like with the header explicitly set.
    const fake = {
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': '999999',
      }),
      text: async () => 'x',
    } as Response;
    const transport = new Transport({
      url: new URL('http://example.test/mcp'),
      tokenProvider: async () => 'tok',
      fetch: async () => fake,
      maxResponseBytes: 1024,
    });
    const out = await transport.forward('{"id":7}');
    const parsed = JSON.parse(out[0]!);
    expect(parsed.id).toBe(7);
    expect(parsed.error.message).toMatch(/exceeds|cap/i);
  });
});

describe('Transport.run', () => {
  it('forwards each stdin line and stops on EOF', async () => {
    const transport = makeTransport(async () => new Response(
      '{"ok":true}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));
    const done = transport.run(input, output);
    input.write('{"id":1}\n{"id":2}\n');
    input.end();
    await done;
    expect(collected.join('').trim().split('\n')).toEqual(['{"ok":true}', '{"ok":true}']);
  });

  it('stops processing when the output stream closes (parent died)', async () => {
    let calls = 0;
    const transport = makeTransport(async () => {
      calls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const done = transport.run(input, output);
    // Close output immediately — simulates parent process dying.
    output.destroy();
    input.write('{"id":1}\n{"id":2}\n{"id":3}\n');
    input.end();
    await done;
    // Should have stopped early, not POSTed all three frames.
    expect(calls).toBeLessThan(3);
  });
});

describe('parseSSE (WHATWG)', () => {
  it('decodes a single-event JSON `data:` line', () => {
    expect(parseSSE('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('handles CRLF terminators', () => {
    expect(parseSSE('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'))
      .toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles bare CR terminators', () => {
    expect(parseSSE('data: {"a":1}\r\rdata: {"b":2}\r\r'))
      .toEqual(['{"a":1}', '{"b":2}']);
  });

  it('concatenates multi-line `data:` within one event with LF', () => {
    // Per WHATWG spec: two `data:` lines in one event = one message joined by `\n`.
    expect(parseSSE('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2']);
  });

  it('strips a single leading SPACE after `data:` only', () => {
    // First line: leading space stripped → "x". Second line: no leading space
    // (just leading SPACE-SPACE after colon → strip one → " y").
    expect(parseSSE('data: x\ndata:  y\n\n')).toEqual(['x\n y']);
  });

  it('ignores comment lines (`:` prefix)', () => {
    expect(parseSSE(': keepalive\ndata: {"k":1}\n\n')).toEqual(['{"k":1}']);
  });

  it('ignores `event:`, `id:`, `retry:` fields', () => {
    const sse = 'event: message\nid: 42\nretry: 5000\ndata: {"x":1}\n\n';
    expect(parseSSE(sse)).toEqual(['{"x":1}']);
  });

  it('skips events with no `data:` lines', () => {
    expect(parseSSE('event: ping\n\ndata: {"x":1}\n\n')).toEqual(['{"x":1}']);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseSSE('﻿data: {"x":1}\n\n')).toEqual(['{"x":1}']);
  });

  it('returns empty for an empty stream', () => {
    expect(parseSSE('')).toEqual([]);
  });
});
