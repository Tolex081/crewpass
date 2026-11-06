// Local API server on :8787. Vite proxies /api here.
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { nearChain, testnetConfig } from "./near.js";

const secretEnv = process.env.SESSION_SECRET;
if (!secretEnv) console.warn("SESSION_SECRET not set: using a random one; sessions end when the server restarts.");
const secret = secretEnv ? new TextEncoder().encode(secretEnv) : randomBytes(32);

const contract = process.env.CREWPASS_CONTRACT ?? "crewpass.testnet";
const app = createApp({
  chain: nearChain(testnetConfig(contract)),
  secret,
  contract,
  recipient: process.env.NEP413_RECIPIENT ?? "crewpass.app",
});

// Not PORT: dev launchers set PORT for the page server (Vite), which would collide.
const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`CrewPass API on http://localhost:${port}/api`));
