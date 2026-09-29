import { customAlphabet } from "nanoid";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const ulidFactory = customAlphabet(ALPHABET, 16);

export function ulid(prefix?: string): string {
  return prefix ? `${prefix}_${ulidFactory()}` : ulidFactory();
}

/** "pds_" + 32 chars of base32. Mirrors the SDK/CLI token shape. */
export async function apiToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const body = ulidFactory().padEnd(32, "0");
  const token = `pds_${body}`;
  return {
    token,
    prefix: token.slice(0, 12),
    hash: await sha256Hex(token),
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare for two equal-length hex strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
