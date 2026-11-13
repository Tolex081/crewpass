// Local API server on :8787. Vite proxies /api here.
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { nearChain, testnetConfig } from "./near.js";
import { companionFromEnv } from "./setup.js";
import { kvFromEnv } from "./memory.js";

const secretEnv = process.env.SESSION_SECRET;
if (!secretEnv) console.warn("SESSION_SECRET not set: using a random one; sessions end when the server restarts.");
const secret = secretEnv ? new TextEncoder().encode(secretEnv) : randomBytes(32);

const contract = process.env.CREWPASS_CONTRACT ?? "crewpass.testnet";
const v2Contract = process.env.CREWPASS_V2_CONTRACT ?? "crewpass-v2.testnet";
// Single-use sign-in nonces across all instances when a shared store (Upstash) is configured.
const shared = kvFromEnv(process.env);
const companion = companionFromEnv(process.env, true);
for (const note of companion.notes) console.warn(note);
const app = createApp({
  chain: nearChain(testnetConfig(contract)),
  secret,
  contract,
  recipient: process.env.NEP413_RECIPIENT ?? "crewpass.app",
  companion: companion.deps,
  nonceStore: shared.durable ? shared.kv : undefined,
  v2: { chain: nearChain(testnetConfig(v2Contract)), contract: v2Contract },
});

// Not PORT: dev launchers set PORT for the page server (Vite), which would collide.
const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`CrewPass API on http://localhost:${port}/api`));
