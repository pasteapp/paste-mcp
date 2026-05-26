import { describe, it, expect } from 'vitest';
import {
  PASTE_STATUS_TOOL,
  SETUP_MESSAGE,
  buildFallbackServer,
  callPasteStatus,
} from '../src/fallback.js';

describe('callPasteStatus', () => {
  it('returns the setup message for paste_status', () => {
    const result = callPasteStatus(PASTE_STATUS_TOOL.name);
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: SETUP_MESSAGE });
  });

  it('tells the user to start Paste and enable MCP', () => {
    expect(SETUP_MESSAGE.toLowerCase()).toContain('start paste');
    expect(SETUP_MESSAGE.toLowerCase()).toContain('enable mcp');
  });

  it('throws on unknown tool names', () => {
    expect(() => callPasteStatus('paste_unknown')).toThrow(/Unknown tool/);
  });
});

describe('PASTE_STATUS_TOOL', () => {
  it('is named paste_status with an empty object schema', () => {
    expect(PASTE_STATUS_TOOL.name).toBe('paste_status');
    expect(PASTE_STATUS_TOOL.inputSchema.type).toBe('object');
    expect(PASTE_STATUS_TOOL.inputSchema.properties).toEqual({});
    expect(PASTE_STATUS_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  it('has a description that mentions Paste', () => {
    expect(PASTE_STATUS_TOOL.description.toLowerCase()).toContain('paste');
  });
});

describe('buildFallbackServer', () => {
  it('constructs a server without throwing', () => {
    const server = buildFallbackServer();
    expect(server).toBeDefined();
  });
});
