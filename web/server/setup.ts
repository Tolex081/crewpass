// One place that turns environment variables into the companion's dependencies, shared by the local
// dev server and the Vercel function so the two cannot drift apart.
import { randomBytes } from "node:crypto";
import type { CompanionDeps } from "./app.js";
import { providerFromEnv } from "./companion.js";
import { kvFromEnv, MemoryStore, parseEncryptionKey } from "./memory.js";

const GEMINI_FREE_NOTICE =
  "Your messages are answered by Google Gemini on its free tier. Google says it may use free-tier content to improve its products, so do not share personal or sensitive information. Your history is stored encrypted and only you can read it here.";
const GENERIC_NOTICE =
  "Your messages are sent to this site's AI provider to write a reply. Do not share personal or sensitive information. Your history is stored encrypted and only you can read it here.";
const OFFLINE_NOTICE =
  "No AI model is configured, so answers come from the programme notes. Your messages are stored encrypted and only you can read them here.";

export interface CompanionSetup {
  deps?: CompanionDeps;
  /** Why the companion is off, or warnings about how it runs. Logged at start-up. */
  notes: string[];
}

/**
 * @param allowEphemeralKey local development only: generate a throwaway encryption key when none is set.
 *   In production a missing or malformed key switches the companion off rather than storing memory
 *   under a key that changes on every cold start.
 */
export function companionFromEnv(env: NodeJS.ProcessEnv, allowEphemeralKey: boolean): CompanionSetup {
  const notes: string[] = [];
  let key = parseEncryptionKey(env.MEMORY_ENCRYPTION_KEY);
  if (!key) {
    if (!allowEphemeralKey) {
      return { notes: ["Companion off: MEMORY_ENCRYPTION_KEY is missing or not 32 bytes (64 hex characters)."] };
    }
    key = randomBytes(32);
    notes.push("MEMORY_ENCRYPTION_KEY not set: using a throwaway key; companion memory is lost on restart.");
  }
  const { kv, durable } = kvFromEnv(env);
  if (!durable) notes.push("No Upstash configured: companion memory and rate limits live in this process only.");
  const provider = providerFromEnv(env);
  if (provider.mode === "offline") notes.push("No AI_BASE_URL/AI_API_KEY/AI_MODEL: companion runs in offline mode.");

  const isGemini = (env.AI_BASE_URL ?? "").includes("generativelanguage.googleapis.com");
  const dataNotice =
    env.AI_DATA_NOTICE ?? (provider.mode === "offline" ? OFFLINE_NOTICE : isGemini ? GEMINI_FREE_NOTICE : GENERIC_NOTICE);

  return { deps: { kv, memory: new MemoryStore(kv, key), provider, durable, dataNotice }, notes };
}
