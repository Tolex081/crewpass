// Vercel Function entry point. vercel.json rewrites every /api/* path here; Hono routes by pathname.
import { createApp } from "../server/app.js";
import { nearChain, testnetConfig } from "../server/near.js";
import { companionFromEnv } from "../server/setup.js";
import { kvFromEnv } from "../server/memory.js";

const contract = process.env.CREWPASS_CONTRACT ?? "crewpass.testnet";
const v2Contract = process.env.CREWPASS_V2_CONTRACT ?? "crewpass-v2.testnet";
// Single-use sign-in nonces across all instances when a shared store (Upstash) is configured.
const shared = kvFromEnv(process.env);
const secretEnv = process.env.SESSION_SECRET ?? "";

// No fallback secret in production: without a real one, sessions could be forged or would reset on
// every cold start. Fail closed and say why.
const misconfigured = secretEnv.length < 32;

// No throwaway encryption key in production either: a missing key switches the companion off.
const companion = companionFromEnv(process.env, false);
for (const note of companion.notes) console.warn(note);

const app = createApp({
  chain: nearChain(testnetConfig(contract)),
  secret: new TextEncoder().encode(secretEnv || "unused-because-misconfigured"),
  contract,
  recipient: process.env.NEP413_RECIPIENT ?? "crewpass.app",
  companion: companion.deps,
  nonceStore: shared.durable ? shared.kv : undefined,
  v2: { chain: nearChain(testnetConfig(v2Contract)), contract: v2Contract },
});

export default {
  fetch(request: Request) {
    if (misconfigured && new URL(request.url).pathname.match(/^\/api\/(challenge|session|members|companion)/)) {
      return Response.json(
        { error: "Sign-in is switched off: the server has no SESSION_SECRET (at least 32 characters) configured." },
        { status: 503 },
      );
    }
    return app.fetch(request);
  },
};
