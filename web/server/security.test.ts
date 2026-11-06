// Server security tests. Signatures are made with near-api-js (NEAR's own NEP-413 signer) and
// checked with our verifier, so a mistake in our byte layout fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { createApp, SIGN_IN_MESSAGE } from "./app.js";
import type { Chain } from "./near.js";
import { nep413Bytes, verifyNep413, NEP413_TAG } from "./nep413.js";
import { issueNonce, NONCE_TTL_MS, SESSION_TTL_MS } from "./tokens.js";

const RECIPIENT = "crewpass.app";
const secret = new TextEncoder().encode("test-secret-test-secret-test-secret");

/** A chain we control: who owns which pass, and which keys each account has. */
function fakeChain() {
  const owners = new Map<string, string>([["1", "alice.testnet"]]);
  const keys = new Map<string, Map<string, "FullAccess" | "FunctionCall">>();
  const chain: Chain = {
    async accessKeyPermission(accountId, publicKey) {
      return keys.get(accountId)?.get(publicKey) ?? null;
    },
    async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
      if (method === "nft_tokens_for_owner") {
        return [...owners].filter(([, o]) => o === args.account_id).map(([token_id, owner_id]) => ({ token_id, owner_id })) as T;
      }
      if (method === "pass_info") {
        const owner = owners.get(String(args.token_id));
        return (owner ? { token_id: args.token_id, owner_id: owner, vault: "0", listing: null, in_transfer_call: false, stats: {} } : null) as T;
      }
      throw new Error(`unexpected view ${method}`);
    },
    async recentEvents() {
      return [];
    },
  };
  return { chain, owners, keys };
}

async function wallet(accountId: string) {
  const kp = KeyPair.fromRandom("ed25519");
  const signer = new KeyPairSigner(kp);
  const publicKey = kp.getPublicKey().toString();
  return {
    accountId,
    publicKey,
    async sign(nonceB64: string, overrides: Partial<{ message: string; recipient: string }> = {}) {
      const signed = await signer.signNep413Message(accountId, {
        message: overrides.message ?? SIGN_IN_MESSAGE,
        recipient: overrides.recipient ?? RECIPIENT,
        nonce: Uint8Array.from(Buffer.from(nonceB64, "base64")),
      });
      return Buffer.from(signed.signature).toString("base64");
    },
  };
}

function setup(start = 1_800_000_000_000) {
  const f = fakeChain();
  let clock = start;
  const app = createApp({ chain: f.chain, secret, contract: "crewpass.testnet", recipient: RECIPIENT, now: () => clock });
  return {
    ...f,
    app,
    advance: (ms: number) => (clock += ms),
    async challenge() {
      return ((await (await app.request("/api/challenge")).json()) as { nonce: string }).nonce;
    },
    session: (body: object) =>
      app.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    members: (token?: string) => app.request("/api/members", { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  };
}

async function signIn(s: ReturnType<typeof setup>, w: Awaited<ReturnType<typeof wallet>>) {
  const nonce = await s.challenge();
  const res = await s.session({ accountId: w.accountId, publicKey: w.publicKey, signature: await w.sign(nonce), nonce });
  return { res, nonce, body: (await res.json()) as { token?: string; error?: string } };
}

// ---- NEP-413 byte layout ---------------------------------------------------------------------

test("nep413 bytes start with the borsh tag 2^31+413", () => {
  const b = nep413Bytes({ message: "hi", nonce: new Uint8Array(32), recipient: "myapp.com" });
  assert.equal(new DataView(b.buffer).getUint32(0, true), NEP413_TAG);
  assert.equal(NEP413_TAG, 2 ** 31 + 413);
});

test("our verifier accepts a near-api-js NEP-413 signature and rejects any changed field", async () => {
  const w = await wallet("alice.testnet");
  const nonce = Buffer.from(new Uint8Array(32).map((_, i) => i)).toString("base64");
  const sig = await w.sign(nonce);
  const payload = { message: SIGN_IN_MESSAGE, nonce: Uint8Array.from(Buffer.from(nonce, "base64")), recipient: RECIPIENT };
  assert.ok(verifyNep413(payload, w.publicKey, sig), "valid signature must verify");
  assert.ok(!verifyNep413({ ...payload, recipient: "evil.app" }, w.publicKey, sig), "other recipient");
  assert.ok(!verifyNep413({ ...payload, message: "send me your NEAR" }, w.publicKey, sig), "other message");
  assert.ok(!verifyNep413({ ...payload, nonce: new Uint8Array(32) }, w.publicKey, sig), "other nonce");
  const other = await wallet("bob.testnet");
  assert.ok(!verifyNep413(payload, other.publicKey, sig), "other key");
});

// ---- sign-in (T4) ------------------------------------------------------------------------------

test("holder signs in with a full-access key and opens the members area", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const { res, body } = await signIn(s, alice);
  assert.equal(res.status, 200, body.error);
  const m = await s.members(body.token);
  assert.equal(m.status, 200);
  const data = (await m.json()) as { accountId: string; passes: { token_id: string }[] };
  assert.equal(data.accountId, "alice.testnet");
  assert.deepEqual(data.passes.map((p) => p.token_id), ["1"]);
});

test("replayed_signin_is_refused: the same signed nonce works once", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const nonce = await s.challenge();
  const body = { accountId: alice.accountId, publicKey: alice.publicKey, signature: await alice.sign(nonce), nonce };
  assert.equal((await s.session(body)).status, 200);
  const replay = await s.session(body);
  assert.equal(replay.status, 401);
  assert.match(((await replay.json()) as { error: string }).error, /already used/);
});

test("an expired sign-in request is refused", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const nonce = await s.challenge();
  s.advance(NONCE_TTL_MS + 1);
  const res = await s.session({ accountId: alice.accountId, publicKey: alice.publicKey, signature: await alice.sign(nonce), nonce });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /expired/);
});

test("a nonce this site did not issue is refused", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const forged = Buffer.from(issueNonce(new TextEncoder().encode("another site's secret"), 1_800_000_000_000)).toString("base64");
  const res = await s.session({ accountId: alice.accountId, publicKey: alice.publicKey, signature: await alice.sign(forged), nonce: forged });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /not issued/);
});

test("a signature made for another site is refused", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const nonce = await s.challenge();
  const res = await s.session({ accountId: alice.accountId, publicKey: alice.publicKey, signature: await alice.sign(nonce, { recipient: "other.app" }), nonce });
  assert.equal(res.status, 401);
});

test("someone else's key cannot sign in as the holder", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  const mallory = await wallet("mallory.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const nonce = await s.challenge();
  // Mallory signs with her own valid key but claims to be Alice: the key is not on Alice's account.
  const res = await s.session({ accountId: "alice.testnet", publicKey: mallory.publicKey, signature: await mallory.sign(nonce), nonce });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /full-access key/);
});

test("a function-call key is not enough to sign in", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FunctionCall"]]));
  const { res } = await signIn(s, alice);
  assert.equal(res.status, 401);
});

// ---- members area (T3) -------------------------------------------------------------------------

test("old_owner_gets_403_after_sale: ownership is re-checked on every request", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const { body } = await signIn(s, alice);
  assert.equal((await s.members(body.token)).status, 200);
  s.owners.set("1", "carol.testnet"); // the sale lands on chain
  const after = await s.members(body.token); // same, still-valid session
  assert.equal(after.status, 403);
  assert.match(((await after.json()) as { error: string }).error, /does not hold a CrewPass/);
});

test("members area refuses a missing, tampered or expired session", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const { body } = await signIn(s, alice);
  assert.equal((await s.members()).status, 401);
  const [b, sig] = body.token!.split(".");
  const forged = Buffer.from(JSON.stringify({ accountId: "carol.testnet", publicKey: alice.publicKey, exp: 9e15 })).toString("base64url");
  assert.equal((await s.members(`${forged}.${sig}`)).status, 401, "tampered session body");
  assert.equal((await s.members(`${b}.${sig}x`)).status, 401, "tampered session signature");
  s.advance(SESSION_TTL_MS + 1);
  assert.equal((await s.members(body.token)).status, 401, "expired session");
});

test("removing the signed-in key from the account ends access", async () => {
  const s = setup();
  const alice = await wallet("alice.testnet");
  s.keys.set("alice.testnet", new Map([[alice.publicKey, "FullAccess"]]));
  const { body } = await signIn(s, alice);
  s.keys.get("alice.testnet")!.delete(alice.publicKey);
  assert.equal((await s.members(body.token)).status, 401);
});
