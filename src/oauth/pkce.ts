import { createHash, randomBytes } from 'node:crypto';

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

function base64URL(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generatePKCE(): PKCEPair {
  const verifier = base64URL(randomBytes(32));
  const challenge = base64URL(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64URL(randomBytes(16));
}
