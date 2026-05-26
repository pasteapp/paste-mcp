import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generatePKCE, generateState } from '../../src/oauth/pkce.js';

describe('generatePKCE', () => {
  it('produces a verifier within the RFC 7636 length range', () => {
    const { verifier } = generatePKCE();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a base64url verifier (no +/=)', () => {
    const { verifier } = generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a challenge that is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = generatePKCE();
    const expected = createHash('sha256').update(verifier).digest().toString('base64url');
    expect(challenge).toBe(expected);
  });

  it('generates distinct pairs each call', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('generateState', () => {
  it('produces a base64url state token', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces distinct tokens', () => {
    expect(generateState()).not.toBe(generateState());
  });
});
