// Locate Paste's running MCP server by reading the `mcpPort` UserDefaults key
// from Paste's plist. We try both the sandboxed App Store container path and
// the unsandboxed Direct/Setapp path because Paste writes to either depending
// on the install channel. `defaults read` against an explicit path bypasses
// cfprefsd's cache so we always see the latest write.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BUNDLE_ID = 'com.wiheads.paste';
const PORT_KEY = 'mcpPort';

function plistPaths(): string[] {
  const home = homedir();
  return [
    `${home}/Library/Containers/${BUNDLE_ID}/Data/Library/Preferences/${BUNDLE_ID}`,
    `${home}/Library/Preferences/${BUNDLE_ID}`,
  ];
}

async function readDefault(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/defaults',
      ['read', plistPath, key],
      { timeout: 1_000 },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function parsePort(raw: string): number | null {
  // `Number()` (not `parseInt`) rejects trailing junk, so a defaults value
  // like "39725 oops" doesn't slip through as 39725.
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export interface DiscoverOptions {
  paths?: string[];
  read?: (plistPath: string, key: string) => Promise<string | null>;
  probe?: (url: URL) => Promise<boolean>;
}

// Paste's default MCP port — fallback when the plist read is blocked (the App
// Store build keeps the port in its sandbox container, unreadable without FDA).
const DEFAULT_PORT = 39725;

// A live endpoint answers (even a 401); only a refused/timed-out connection means nothing's listening.
async function probeURL(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      signal: AbortSignal.timeout(800),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

export async function discoverServerURL(opts: DiscoverOptions = {}): Promise<URL | null> {
  const paths = opts.paths ?? plistPaths();
  const read = opts.read ?? readDefault;
  const probe = opts.probe ?? probeURL;

  // Plist port first (honors a custom port), then the default as a fallback.
  const ports: number[] = [];
  const results = await Promise.allSettled(paths.map((path) => read(path, PORT_KEY)));
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value === null) continue;
    const port = parsePort(result.value);
    if (port !== null && !ports.includes(port)) ports.push(port);
  }
  if (!ports.includes(DEFAULT_PORT)) ports.push(DEFAULT_PORT);

  for (const port of ports) {
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    if (await probe(url)) return url;
  }
  return null;
}
