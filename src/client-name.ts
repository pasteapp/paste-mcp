// Identify which AI tool spawned the bridge so Paste's `Client.Kind.inferred`
// can pick the right icon and label in the MCP & AI Tools list. Walks the
// parent-process tree via `ps`, stepping past shell/node/npx wrappers, and
// matches the first ancestor whose argv mentions a known AI tool. Falls back
// to the npm package slug when nothing matches.
//
// The returned name MUST contain a substring that Paste's Swift
// `Client.Kind.inferred(fromClientName:)` recognizes — "claude code",
// "claude", "cursor", "codex", "windsurf", "vscode"/"vs code" — otherwise
// the client lands as `.custom` with the bare package slug.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_NAME = '@pasteapp/mcp';

// More specific first — `Claude Code` must be tested before `Claude Desktop`
// because the Code CLI's argv also contains the substring "claude".
const CLIENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /@anthropic-ai\/claude-code|\.claude\/local\/.*\bclaude\b|\bclaude\b[^ ]*cli/i, name: 'Claude Code' },
  { pattern: /Claude\.app\b/, name: 'Claude Desktop' },
  { pattern: /Cursor\.app\b/, name: 'Cursor' },
  { pattern: /Windsurf\.app\b/i, name: 'Windsurf' },
  { pattern: /Visual Studio Code\.app\b|\/Code\.app\b/i, name: 'VS Code' },
  { pattern: /@openai\/codex|\bcodex\b/i, name: 'Codex' },
];

// Processes we step past when walking up — they're shell/runtime wrappers,
// not the actual host. Matched only AFTER the client patterns fail.
const WRAPPER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnpx\b/,
  /\bnode\b/,
  /\bsh\b|\bbash\b|\bzsh\b|\bfish\b/,
];

export interface ProcessInfo {
  ppid: number;
  args: string;
}

export interface DetectOptions {
  startPid?: number;
  readProcessArgs?: (pid: number) => Promise<ProcessInfo | null>;
}

async function defaultReadProcessArgs(pid: number): Promise<ProcessInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'ppid=,args='],
      { timeout: 500 },
    );
    const match = stdout.trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    return { ppid: Number.parseInt(match[1]!, 10), args: match[2]! };
  } catch {
    return null;
  }
}

function matchClient(args: string): string | null {
  for (const { pattern, name } of CLIENT_PATTERNS) {
    if (pattern.test(args)) return name;
  }
  return null;
}

function isWrapper(args: string): boolean {
  return WRAPPER_PATTERNS.some((p) => p.test(args));
}

export async function detectClientName(opts: DetectOptions = {}): Promise<string> {
  const read = opts.readProcessArgs ?? defaultReadProcessArgs;
  let pid = opts.startPid ?? process.ppid;
  for (let i = 0; i < 8; i++) {
    const result = await read(pid);
    if (!result) break;
    const matched = matchClient(result.args);
    if (matched) return matched;
    // Stop the moment we hit a non-wrapper we don't recognize — going past it
    // would just walk into the user's shell / WindowServer / launchd.
    if (!isWrapper(result.args)) break;
    if (result.ppid <= 1 || result.ppid === pid) break;
    pid = result.ppid;
  }
  return DEFAULT_NAME;
}
