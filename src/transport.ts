// Stateful stdio↔HTTP bridge with an injected token provider. Mirrors
// PasteMCP/Stdio/StdioAdapter.swift (Streamable HTTP transport): NDJSON in
// from stdin, POST each frame to /mcp with Bearer + Mcp-Session-Id, emit
// JSON or SSE-decoded payloads on stdout. On 401 we ask the caller to
// invalidate its token cache and retry the same frame once.

import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';

export interface TransportConfig {
  url: URL;
  tokenProvider: () => Promise<string>;
  onUnauthorized?: () => Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /// Cap on a single response body — defense against a runaway server. Default
  /// 16 MiB. We bail (without consuming the body) when Content-Length exceeds
  /// the cap; servers that omit Content-Length get the body trusted as-is.
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class Transport {
  private sessionId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: TransportConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async run(input: NodeJS.ReadableStream, output: Writable): Promise<void> {
    // When the host (Claude, Cursor) dies, the stdout pipe goes EPIPE. The
    // listener prevents `ERR_UNHANDLED_ERROR`; `output.destroyed` (set
    // synchronously by Node when the stream tears down) is what we actually
    // check between frames to exit promptly.
    output.on('error', () => { /* swallow; we read `destroyed` instead */ });

    const rl = createInterface({ input, terminal: false });
    for await (const line of rl) {
      if (output.destroyed || output.writableEnded) {
        rl.close();
        return;
      }
      if (line.length === 0) continue;
      const responses = await this.forward(line);
      for (const payload of responses) {
        if (output.destroyed || output.writableEnded) return;
        output.write(payload + '\n');
      }
    }
  }

  async forward(line: string): Promise<string[]> {
    try {
      const first = await this.sendOnce(line, await this.config.tokenProvider());
      if (first.status === 401 && this.config.onUnauthorized) {
        await this.config.onUnauthorized();
        const second = await this.sendOnce(line, await this.config.tokenProvider());
        return this.emit(second);
      }
      return this.emit(first);
    } catch (error) {
      return [transportErrorEnvelope(line, error)];
    }
  }

  private async sendOnce(line: string, token: string): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers,
        body: line,
        signal: controller.signal,
      });
      this.captureSessionId(response.headers);
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new Error(`Response body declares ${declaredLength} bytes (cap ${this.maxResponseBytes})`);
      }
      const body = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private captureSessionId(headers: Headers): void {
    if (this.sessionId) return;
    const returned = headers.get('Mcp-Session-Id');
    if (returned && returned.length > 0) this.sessionId = returned;
  }

  private emit({ status, contentType, body }: TransportResponse): string[] {
    // 202 Accepted is a one-way notification ack — emitting anything on stdout
    // would confuse the host's NDJSON parser.
    if (status === 202) return [];
    if (body.length === 0) return [];
    if (!contentType.toLowerCase().startsWith('text/event-stream')) {
      return [body];
    }
    return parseSSE(body);
  }
}

interface TransportResponse {
  status: number;
  contentType: string;
  body: string;
}

// WHATWG-compliant SSE decoder: handles CR/LF/CRLF terminators, multi-`data:`
// concatenation with U+000A, a leading-SPACE strip per line, BOM stripping,
// and ignores `event:`/`id:`/`retry:`/comment lines. Each event with a
// non-empty data buffer becomes one stdout line.
export function parseSSE(body: string): string[] {
  let stream = body;
  if (stream.charCodeAt(0) === 0xFEFF) stream = stream.slice(1);
  // Normalize line terminators so an event boundary is always `\n\n`.
  const normalized = stream.replace(/\r\n|\r/g, '\n');
  const messages: string[] = [];
  for (const event of normalized.split('\n\n')) {
    if (event === '') continue;
    const dataLines: string[] = [];
    for (const rawLine of event.split('\n')) {
      if (rawLine === '' || rawLine.startsWith(':')) continue;
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    messages.push(dataLines.join('\n'));
  }
  return messages;
}

function transportErrorEnvelope(requestLine: string, error: unknown): string {
  const id = extractId(requestLine);
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32603, message: `Transport error: ${message}` },
  });
}

function extractId(line: string): unknown {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed.id;
  } catch {
    return undefined;
  }
}
