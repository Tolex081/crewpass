// Stateless sign-in nonces and session tokens, both HMAC-signed with SESSION_SECRET.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 15 * 60 * 1000;

function mac(secret: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, secret, data);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---- nonces ------------------------------------------------------------------------------------
// 32 bytes = issued-at ms (8, big endian) | random (8) | HMAC(secret, first 16)[0..16].
// Any instance holding the secret can check it is ours and fresh; `used` makes it single-use
// within one instance (see web/README.md for the multi-instance limit).

export function issueNonce(secret: Uint8Array, now = Date.now()): Uint8Array {
  const head = new Uint8Array(16);
  new DataView(head.buffer).setBigUint64(0, BigInt(now));
  head.set(randomBytes(8), 8);
  const out = new Uint8Array(32);
  out.set(head, 0);
  out.set(mac(secret, head).slice(0, 16), 16);
  return out;
}

export type NonceCheck = "ok" | "forged" | "expired" | "future" | "reused";

/** Atomic "set if absent" in a store shared by every server instance (Upstash `SET NX EX`). */
export interface UsedNonceStore {
  /** True if the key was newly set, false if it already existed. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
}

export class NonceGuard {
  private used = new Map<string, number>(); // hex nonce -> expiry ms

  /** With `shared`, a nonce used on one instance is refused on every other instance too. */
  constructor(private secret: Uint8Array, private shared?: UsedNonceStore) {}

  async check(nonce: Uint8Array, now = Date.now()): Promise<NonceCheck> {
    if (nonce.length !== 32) return "forged";
    const head = nonce.slice(0, 16);
    if (!equal(nonce.slice(16), mac(this.secret, head).slice(0, 16))) return "forged";
    const issued = Number(new DataView(head.buffer, head.byteOffset).getBigUint64(0));
    if (issued > now + 30_000) return "future";
    if (now - issued > NONCE_TTL_MS) return "expired";
    this.sweep(now);
    const key = Buffer.from(nonce).toString("hex");
    if (this.used.has(key)) return "reused";
    if (this.shared) {
      const ttl = Math.max(1, Math.ceil((issued + NONCE_TTL_MS - now) / 1000));
      if (!(await this.shared.setIfAbsent(`nonce:${key}`, ttl))) return "reused";
    }
    this.used.set(key, issued + NONCE_TTL_MS);
    return "ok";
  }

  private sweep(now: number) {
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
  }
}

// ---- sessions ----------------------------------------------------------------------------------

export interface Session {
  accountId: string;
  publicKey: string;
  exp: number;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function issueSession(secret: Uint8Array, accountId: string, publicKey: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ accountId, publicKey, exp: now + SESSION_TTL_MS } satisfies Session));
  return `${b64url(body)}.${b64url(mac(secret, body))}`;
}

export function readSession(secret: Uint8Array, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const bodyBytes = Uint8Array.from(Buffer.from(body, "base64url"));
  if (!equal(Uint8Array.from(Buffer.from(sig, "base64url")), mac(secret, bodyBytes))) return null;
  try {
    const s = JSON.parse(Buffer.from(bodyBytes).toString("utf8")) as Session;
    if (typeof s.accountId !== "string" || typeof s.publicKey !== "string" || typeof s.exp !== "number") return null;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}
