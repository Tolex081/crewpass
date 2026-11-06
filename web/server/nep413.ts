// NEP-413 signed-message verification (https://github.com/near/NEPs/blob/master/neps/nep-0413.md).
// The wallet signs sha256( borsh(u32 2^31+413) || borsh(Payload) ) with an ed25519 full-access key.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NEP413_TAG = 2147484061; // 2**31 + 413

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array; // exactly 32 bytes
  recipient: string;
  callbackUrl?: string;
}

const utf8 = new TextEncoder();

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const bytes = utf8.encode(s);
  return concat(u32le(bytes.length), bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The exact bytes a NEP-413 wallet hashes and signs. */
export function nep413Bytes(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const callback =
    p.callbackUrl === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), borshString(p.callbackUrl));
  return concat(u32le(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), callback);
}

export function nep413Hash(p: Nep413Payload): Uint8Array {
  return sha256(nep413Bytes(p));
}

// ---- encodings ---------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** "ed25519:<base58>" -> 32 raw bytes. Only ed25519 keys are accepted. */
export function parseEd25519PublicKey(key: string): Uint8Array {
  const [type, data] = key.split(":");
  if (type !== "ed25519" || !data) throw new Error("only ed25519 public keys are supported");
  const raw = base58Decode(data);
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return raw;
}

/** NEP-413 says base64; some wallets return base58. Accept both, strictly 64 bytes. */
export function decodeSignature(sig: string): Uint8Array {
  const s = sig.startsWith("ed25519:") ? sig.slice(8) : sig;
  try {
    const b64 = Uint8Array.from(Buffer.from(s, "base64"));
    if (b64.length === 64 && Buffer.from(b64).toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "")) return b64;
  } catch {
    /* fall through */
  }
  const b58 = base58Decode(s);
  if (b58.length === 64) return b58;
  throw new Error("signature must be 64 bytes, base64 or base58");
}

/** True when `signature` is a valid NEP-413 signature of `payload` by `publicKey`. */
export function verifyNep413(payload: Nep413Payload, publicKey: string, signature: string): boolean {
  try {
    return ed25519.verify(decodeSignature(signature), nep413Hash(payload), parseEd25519PublicKey(publicKey));
  } catch {
    return false;
  }
}
