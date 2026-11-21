// ============================================================
// Edge + Node.js compatible signed session cookies for Local Hybrid Mode.
// Uses Web Crypto HMAC-SHA256 so Next.js Middleware (Edge or Node) can
// verify sessions without importing Node filesystem modules.
// ============================================================

import { isPlaceholderEnvValue, isValidEncryptionKey } from './mode';

export interface LocalSessionPayload {
  userId: string;
  email: string;
  fullName?: string;
  exp: number;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function getSecret(): string {
  const localSecret = process.env.LOCAL_AUTH_SECRET?.trim();
  if (localSecret && !isPlaceholderEnvValue(localSecret)) {
    return localSecret;
  }
  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (encKey && isValidEncryptionKey(encKey)) {
    return encKey;
  }
  return 'wacrm-local-hybrid-dev-session-secret-v1';
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hmacSign(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

export async function signLocalSession(input: {
  userId: string;
  email: string;
  fullName?: string;
}): Promise<string> {
  const payload: LocalSessionPayload = {
    userId: input.userId,
    email: input.email,
    fullName: input.fullName,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(encoded);
  return `${encoded}.${sig}`;
}

export async function verifyLocalSession(
  token: string | undefined | null
): Promise<LocalSessionPayload | null> {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig) return null;

  try {
    const expected = await hmacSign(encoded);
    if (expected.length !== sig.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    if (diff !== 0) return null;

    const json = new TextDecoder().decode(fromBase64Url(encoded));
    const parsed = JSON.parse(json) as LocalSessionPayload;
    if (!parsed?.userId || !parsed?.email || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
