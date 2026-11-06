// Vercel Function entry point. vercel.json rewrites every /api/* path here; Hono routes by pathname.
import { createApp } from "../server/app.js";
import { nearChain, testnetConfig } from "../server/near.js";

const contract = process.env.CREWPASS_CONTRACT ?? "crewpass.testnet";
const secretEnv = process.env.SESSION_SECRET ?? "";

// No fallback secret in production: without a real one, sessions could be forged or would reset on
// every cold start. Fail closed and say why.
const misconfigured = secretEnv.length < 32;

const app = createApp({
  chain: nearChain(testnetConfig(contract)),
  secret: new TextEncoder().encode(secretEnv || "unused-because-misconfigured"),
  contract,
  recipient: process.env.NEP413_RECIPIENT ?? "crewpass.app",
});

export default {
  fetch(request: Request) {
    if (misconfigured && new URL(request.url).pathname.match(/^\/api\/(challenge|session|members)/)) {
      return Response.json(
        { error: "Sign-in is switched off: the server has no SESSION_SECRET (at least 32 characters) configured." },
        { status: 503 },
      );
    }
    return app.fetch(request);
  },
};
