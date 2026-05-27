import { describe, it, expect } from 'vitest';
import {
  PASTE_STATUS_TOOL,
  buildFallbackServer,
  callPasteStatus,
} from '../src/fallback.js';

describe('fallback', () => {
  it('paste_status returns a message that tells the user to start Paste', () => {
    const result = callPasteStatus(PASTE_STATUS_TOOL.name);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text.toLowerCase()).toContain('start paste');
  });

  it('builds a server without throwing', () => {
    expect(buildFallbackServer()).toBeDefined();
  });
});
