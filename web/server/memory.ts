// Private companion memory: encrypted at rest, one record per (contract, pass, holder account).
// Stores: Upstash Redis (production, via its REST API) or in-process memory (local development, tests).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number; // ms
}

export interface MemoryRecord {
  messages: ChatMessage[];
}

export const MAX_MESSAGES = 20;
export const MEMORY_TTL_SECONDS = 90 * 24 * 60 * 60;

export function memoryKey(contract: string, tokenId: string, accountId: string): string {
  return `mem:v1:${contract}:${tokenId}:${accountId}`;
}

/** Raw key-value store. Values are already encrypted when they get here. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment a counter that expires `windowSeconds` after its first hit; returns the new count. */
  incr(key: string, windowSeconds: number): Promise<number>;
}

export class InMemoryKv implements KvStore {
  private data = new Map<string, { value: string; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  private live(key: string) {
    const v = this.data.get(key);
    if (v && v.exp <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return v;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, exp: this.now() + ttlSeconds * 1000 });
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async incr(key: string, windowSeconds: number) {
    const cur = this.live(key);
    const n = (cur ? Number(cur.value) : 0) + 1;
    this.data.set(key, { value: String(n), exp: cur?.exp ?? this.now() + windowSeconds * 1000 });
    return n;
  }
  /** Test helper: the raw stored value, to prove it is encrypted. */
  raw(key: string) {
    return this.data.get(key)?.value;
  }
}

/** Upstash Redis over REST: POST a JSON command array, answer {"result": ...} or {"error": ...}. */
export class UpstashKv implements KvStore {
  constructor(private url: string, private token: string) {}

  private async send<T>(body: unknown, path = ""): Promise<T> {
    const res = await fetch(this.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok || (json && typeof json === "object" && "error" in json && json.error)) {
      throw new Error(`Upstash error: ${(json as { error?: string }).error ?? res.status}`);
    }
    return json;
  }

  async get(key: string) {
    return (await this.send<{ result: string | null }>(["GET", key])).result;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await this.send(["SET", key, value, "EX", ttlSeconds]);
  }
  async del(key: string) {
    await this.send(["DEL", key]);
  }
  async incr(key: string, windowSeconds: number) {
    // Create the counter with its window only if it does not exist (SET NX EX), then INCR.
    // Both are long-standing Redis commands; one round trip via the pipeline endpoint.
    const out = await this.send<{ result?: unknown; error?: string }[]>(
      [["SET", key, "0", "EX", windowSeconds, "NX"], ["INCR", key]],
      "/pipeline",
    );
    const counted = out[1];
    if (!counted || counted.error) throw new Error(`Upstash error: ${counted?.error ?? "no result"}`);
    return Number(counted.result);
  }
}

/** Pick the store from the environment: Upstash when configured (either variable naming), else memory. */
export function kvFromEnv(env: NodeJS.ProcessEnv = process.env): { kv: KvStore; durable: boolean } {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) return { kv: new UpstashKv(url, token), durable: true };
  return { kv: new InMemoryKv(), durable: false };
}

// ---- encryption ---------------------------------------------------------------------------------

/** 32-byte key from hex (64 chars) or base64. Returns null if absent or the wrong length. */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : null;
}

/** AES-256-GCM. The record's own key is the associated data, so a value cannot be moved to another holder. */
export function seal(key: Buffer, recordKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(recordKey));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function open(key: Buffer, recordKey: string, sealed: string): string | null {
  if (!sealed.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(recordKey));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // tampered, moved or wrong key: treat as no memory
  }
}

export class MemoryStore {
  constructor(private kv: KvStore, private key: Buffer) {}

  async load(recordKey: string): Promise<MemoryRecord> {
    const sealed = await this.kv.get(recordKey);
    const json = sealed ? open(this.key, recordKey, sealed) : null;
    if (!json) return { messages: [] };
    try {
      const rec = JSON.parse(json) as MemoryRecord;
      return Array.isArray(rec.messages) ? rec : { messages: [] };
    } catch {
      return { messages: [] };
    }
  }

  async save(recordKey: string, rec: MemoryRecord): Promise<void> {
    const trimmed = { messages: rec.messages.slice(-MAX_MESSAGES) };
    await this.kv.set(recordKey, seal(this.key, recordKey, JSON.stringify(trimmed)), MEMORY_TTL_SECONDS);
  }

  async clear(recordKey: string): Promise<void> {
    await this.kv.del(recordKey);
  }
}
