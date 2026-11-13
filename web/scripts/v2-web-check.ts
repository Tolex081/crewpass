// End-to-end check of the off-chain half of the V2 journey, against the live testnet registry:
// real NEP-413 sign-ins with the demo accounts' own testnet keys, sent only to the local API.
//   (API running on :8787)  npx tsx scripts/v2-web-check.ts <credentials dir>   > deploy/v2-web-check.md
// Keys are read from the near-cli legacy keychain and never printed or sent anywhere; only
// signatures go to the local server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, KeyPairSigner } from "near-api-js";

const API = process.env.API ?? "http://localhost:8787/api";
const dir = process.argv[2];
if (!dir) throw new Error("usage: tsx scripts/v2-web-check.ts <~/.near-credentials/testnet>");

const rows: string[] = [];
let unexpected = 0;
function record(who: string, what: string, expected: number, got: number, detail: string) {
  const ok = expected === got;
  if (!ok) unexpected++;
  rows.push(`| ${who} | ${what} | ${expected} | ${got} | ${ok ? "as expected" : "**UNEXPECTED**"} | ${detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} |`);
}

async function signIn(account: string): Promise<string> {
  const cred = JSON.parse(readFileSync(join(dir, `${account}.json`), "utf8")) as { private_key: string };
  const kp = KeyPair.fromString(cred.private_key as `ed25519:${string}`);
  const c = (await (await fetch(`${API}/challenge`)).json()) as { message: string; recipient: string; nonce: string };
  const signed = await new KeyPairSigner(kp).signNep413Message(account, {
    message: c.message,
    recipient: c.recipient,
    nonce: Uint8Array.from(Buffer.from(c.nonce, "base64")),
  });
  const body = { accountId: account, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString("base64"), nonce: c.nonce };
  const res = await fetch(`${API}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  record(account.replace(".testnet", ""), "NEP-413 sign-in with own testnet key", 200, res.status, "session issued");
  const replay = await fetch(`${API}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  record(account.replace(".testnet", ""), "Replay the same signed sign-in", 401, replay.status, ((await replay.json()) as { error?: string }).error ?? "");
  return ((await res.json()) as { token: string }).token;
}

async function call(token: string, method: string, path: string, body?: object) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const alice = await signIn("crewpass-alice.testnet");
const carol = await signIn("crewpass-carol.testnet");

let r = await call(alice, "GET", "/v2/members/1");
record("alice", "Open pass #1's members area after selling it", 403, r.status, r.json.error ?? "");
r = await call(alice, "POST", "/v2/companion/1", { message: "what is in my account?" });
record("alice", "Use pass #1's companion after selling it", 403, r.status, r.json.error ?? "");
r = await call(alice, "GET", "/v2/events/1/access");
record("alice", "Event 1 access (her ticket was attached to pass #1)", 403, r.status, r.json.error ?? "");

r = await call(carol, "GET", "/v2/members/1");
const gold = r.json.content?.posts?.find((p: any) => p.minTier === "Gold");
const plat = r.json.content?.posts?.find((p: any) => p.minTier === "Platinum");
record("carol", "Open pass #1's members area (inherited, Gold)", 200, r.status,
  `tier ${r.json.pass?.tier}; Gold post ${gold?.unlocked ? "unlocked" : "locked"}; Platinum post ${plat?.unlocked ? "unlocked" : "locked (body not sent)"}`);
r = await call(carol, "GET", "/v2/companion/1");
record("carol", "Companion history for her ownership period", 200, r.status, `owner epoch ${r.json.ownerEpoch}; ${r.json.history?.length ?? "?"} earlier messages`);
r = await call(carol, "POST", "/v2/companion/1", { message: "What tier is my pass and what is in its account?" });
record("carol", "Ask the companion about tier and account", 200, r.status, r.json.reply ?? r.json.error ?? "");
r = await call(carol, "GET", "/v2/events/1/access");
record("carol", "Event 1 access via the ticket attached to pass #1", 200, r.status, r.json.via ? `via ${r.json.via}` : r.json.error ?? "");
r = await call(carol, "GET", "/v2/creator/1");
record("carol", "Open the creator dashboard of programme 1", 403, r.status, r.json.error ?? "");

console.log(`# CrewPass V2 web check (members access, companion, events)

Run ${new Date().toISOString()} by \`web/scripts/v2-web-check.ts\` against the local API reading the live
registry \`crewpass-v2.testnet\`, right after \`deploy/v2-live-run.sh\`. Sign-ins are real NEP-413 signatures
made with the demo accounts' own testnet keys.

| Who | Action | Expected HTTP | Got | Result | Detail |
|---|---|---|---|---|---|
${rows.join("\n")}

Unexpected results: **${unexpected}**.`);
