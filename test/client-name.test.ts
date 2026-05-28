import { describe, it, expect } from 'vitest';
import { detectClientName, type ProcessInfo } from '../src/client-name.js';

function chain(...steps: ProcessInfo[]): (pid: number) => Promise<ProcessInfo | null> {
  let i = 0;
  return async () => (i < steps.length ? steps[i++]! : null);
}

describe('detectClientName', () => {
  it('recognizes Claude Desktop', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain({ ppid: 0, args: '/Applications/Claude.app/Contents/MacOS/Claude' }),
    })).toBe('Claude Desktop');
  });

  it('recognizes Claude Code by walking past npx + node wrappers', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain(
        { ppid: 2, args: 'npx -y @pasteapp/mcp' },
        { ppid: 3, args: '/usr/local/bin/node /Users/u/.claude/local/node_modules/.bin/claude' },
      ),
    })).toBe('Claude Code');
  });

  it('recognizes Cursor', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain({ ppid: 0, args: '/Applications/Cursor.app/Contents/MacOS/Cursor --type=renderer' }),
    })).toBe('Cursor');
  });

  it('recognizes Codex by argv', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain(
        { ppid: 2, args: 'npx -y @pasteapp/mcp' },
        { ppid: 3, args: '/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/dist/cli.js' },
      ),
    })).toBe('Codex');
  });

  it('recognizes Windsurf', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain({ ppid: 0, args: '/Applications/Windsurf.app/Contents/MacOS/Windsurf' }),
    })).toBe('Windsurf');
  });

  it('recognizes VS Code', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain({ ppid: 0, args: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' }),
    })).toBe('VS Code');
  });

  it('falls back to the package slug when nothing in the tree matches', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain(
        { ppid: 2, args: 'npx -y @pasteapp/mcp' },
        { ppid: 3, args: 'node /random/script.js' },
        { ppid: 4, args: '/bin/zsh' },
        { ppid: 0, args: '/sbin/launchd' },
      ),
    })).toBe('@pasteapp/mcp');
  });

  it('stops walking past an unknown non-wrapper process', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: chain(
        { ppid: 2, args: 'npx -y @pasteapp/mcp' },
        { ppid: 3, args: '/Applications/SomeWrapper.app/Contents/MacOS/SomeWrapper' },
        // Claude.app sits further up but we never reach it — SomeWrapper is
        // not a recognized wrapper.
        { ppid: 0, args: '/Applications/Claude.app/Contents/MacOS/Claude' },
      ),
    })).toBe('@pasteapp/mcp');
  });

  it('falls back when ps returns null at every step', async () => {
    expect(await detectClientName({
      startPid: 1,
      readProcessArgs: async () => null,
    })).toBe('@pasteapp/mcp');
  });
});
