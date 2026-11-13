// V2 web server tests: authentication, ownership, revocation after a sale, cross-instance replay,
// companion memory scoped to the ownership epoch, creator permissions, event access, tier gating
// and honest history. Threat-model rows P1–P3 and the brief's web-test list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { createApp, SIGN_IN_MESSAGE, type CompanionDeps } from "./app.js";
import type { AccountState, Chain, ChainEvent, EventPage } from "./near.js";
import { InMemoryKv, MemoryStore } from "./memory.js";
import { OfflineProvider } from "./companion.js";
import type { PassV2 } from "./v2.js";

const RECIPIENT = "crewpass.app";
const V2 = "crewpass-v2.testnet";
const secret = new TextEncoder().encode("test-secret-test-secret-test-secret");
const encKey = Buffer.alloc(32, 9);

/** In-memory stand-in for the registry, with the same view names and shapes. */
function fakeV2() {
  const owners = new Map<string, string>([["1", "alice.testnet"], ["2", "bob.testnet"]]);
  const epochs = new Map<string, number>([["1", 1], ["2", 1]]);
  const points = new Map<string, number>([["1", 0], ["2", 85]]);
  const tickets = new Map<string, { event_id: number; buyer: string; token_id: string | null; checked_in: boolean }>();
  const keys = new Map<string, Map<string, "FullAccess">>();
  let historyComplete = true;
  let down = false;
  const tier = (p: number) => (p >= 150 ? "Platinum" : p >= 80 ? "Gold" : p >= 30 ? "Silver" : "Bronze");
  const pass = (id: string): PassV2 => ({
    token_id: id, owner_id: owners.get(id)!, account_id: `${id}.${V2}`, programme_id: 1,
    tier: tier(points.get(id)!), points: points.get(id)!, next_tier: null, points_to_next_tier: null,
    owner_epoch: epochs.get(id)!, lock: null, listing: null, rewards_available: "12500000000000000000000",
    referrals: 0, referral_earned: "0", rewards_claimed: "0", transfers: epochs.get(id)! - 1,
    tickets: 0, check_ins: 0, achievements: 0, minted_at_ms: "0",
  });
  const programme = { id: 1, creator: "creator.testnet", name: "Study Crew", description: "demo", mint_price: "100000000000000000000000",
    referral_bps: 1000, member_share_bps: 5000, max_supply: null, minted: 2, active_passes: 2, reward_index: "0", carry: "0",
    treasury: "0", reserved: "0", distributed_total: "0", claimed_total: "0", ticket_revenue_total: "0", funded_total: "0", events: 1 };
  const event = { id: 1, programme_id: 1, title: "Live session", price: "50000000000000000000000", capacity: 10, sold: 1, points: 20, starts_at_ms: "0", checked_in: 0 };

  const v2chain: Chain = {
    async accessKeyPermission() {
      throw new Error("not used");
    },
    async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
      if (down) throw new TypeError("fetch failed");
      const id = String(args.token_id ?? "");
      switch (method) {
        case "nft_token": return (owners.has(id) ? { token_id: id, owner_id: owners.get(id) } : null) as T;
        case "pass_info": return (owners.has(id) ? pass(id) : null) as T;
        case "nft_tokens": return [...owners].map(([token_id, owner_id]) => ({ token_id, owner_id })) as T;
        case "nft_tokens_for_owner": return [...owners].filter(([, o]) => o === args.account_id).map(([token_id, owner_id]) => ({ token_id, owner_id })) as T;
        case "programme": return (args.programme_id === 1 ? programme : null) as T;
        case "programmes": return [programme] as T;
        case "events": return [event] as T;
        case "event": return (String(args.event_id) === "1" ? event : null) as T;
        case "ticket_of": return (tickets.get(`1:${args.account_id}`) ?? null) as T;
        case "pass_ticket": return ([...tickets.values()].find((t) => t.token_id === id) ?? null) as T;
        case "config": return { pass_code_hash: "HASH" } as T;
        case "accounting": return { solvent: true } as T;
        default: throw new Error(`unexpected view ${method}`);
      }
    },
    async recentEvents() {
      return [];
    },
    async allEvents(): Promise<EventPage> {
      const e: ChainEvent = { txHash: "tx1", timestampMs: 0, signer: "alice.testnet", standard: "crewpass", event: "pass_account_created", data: { token_id: "1" } };
      return { events: [e], complete: historyComplete, transactionsRead: 1, pagesRead: 1 };
    },
    async account(accountId: string): Promise<AccountState> {
      return { accountId, balance: "10000000000000000000000", storageUsage: 100, globalContractHash: "HASH", accessKeys: 0 };
    },
  };
  // V1 chain only answers sign-in key checks here.
  const v1chain: Chain = {
    async accessKeyPermission(a, k) {
      return keys.get(a)?.get(k) ?? null;
    },
    async view() {
      throw new Error("v1 not used");
    },
    async recentEvents() {
      return [];
    },
  };
  return {
    v1chain, v2chain, owners, epochs, points, tickets, keys,
    setComplete: (v: boolean) => (historyComplete = v),
    setDown: (v: boolean) => (down = v),
    sell(id: string, to: string) {
      owners.set(id, to);
      epochs.set(id, epochs.get(id)! + 1);
    },
  };
}

function setup(sharedNonces?: InMemoryKv, f = fakeV2()) {
  const kv = new InMemoryKv();
  const companion: CompanionDeps = { kv, memory: new MemoryStore(kv, encKey), provider: new OfflineProvider(), durable: false, dataNotice: "test" };
  const app = createApp({
    chain: f.v1chain, secret, contract: "crewpass.testnet", recipient: RECIPIENT, companion,
    nonceStore: sharedNonces, v2: { chain: f.v2chain, contract: V2 },
  });
  const req = (method: string, path: string, token?: string, body?: object) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  async function signedPayload(accountId: string) {
    const kp = KeyPair.fromRandom("ed25519");
    const publicKey = kp.getPublicKey().toString();
    f.keys.set(accountId, new Map([[publicKey, "FullAccess"]]));
    const { nonce } = (await (await app.request("/api/challenge")).json()) as { nonce: string };
    const signed = await new KeyPairSigner(kp).signNep413Message(accountId, {
      message: SIGN_IN_MESSAGE, recipient: RECIPIENT, nonce: Uint8Array.from(Buffer.from(nonce, "base64")),
    });
    return { accountId, publicKey, signature: Buffer.from(signed.signature).toString("base64"), nonce };
  }
  async function signIn(accountId: string) {
    const res = await req("POST", "/api/session", undefined, await signedPayload(accountId));
    return ((await res.json()) as { token: string }).token;
  }
  return { f, app, req, signIn, signedPayload, kv };
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

// ---- authentication and ownership (P3) ---------------------------------------------------------

test("V2 members area needs a session", async () => {
  const s = setup();
  assert.equal((await s.req("GET", "/api/v2/members/1")).status, 401);
});

test("V2 members area: only the current holder of that pass", async () => {
  const s = setup();
  const bob = await s.signIn("bob.testnet");
  assert.equal((await s.req("GET", "/api/v2/members/1", bob)).status, 403);
  assert.equal((await s.req("GET", "/api/v2/members/2", bob)).status, 200);
});

test("V2 access ends on the next request after a sale, even with a live session", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  assert.equal((await s.req("GET", "/api/v2/members/1", alice)).status, 200);
  s.f.sell("1", "carol.testnet");
  assert.equal((await s.req("GET", "/api/v2/members/1", alice)).status, 403);
  assert.equal((await s.req("GET", "/api/v2/companion/1", alice)).status, 403);
});

test("V2 fails closed when the chain cannot be read", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  s.f.setDown(true);
  const res = await s.req("GET", "/api/v2/members/1", alice);
  assert.equal(res.status, 502);
  assert.equal((await json(res)).content, undefined);
});

// ---- replay across instances (P2) --------------------------------------------------------------

test("a nonce used on one instance is refused on another", async () => {
  const shared = new InMemoryKv();
  const f = fakeV2();
  const one = setup(shared, f);
  const two = setup(shared, f);
  const payload = await one.signedPayload("alice.testnet");
  assert.equal((await one.req("POST", "/api/session", undefined, payload)).status, 200);
  const replay = await two.req("POST", "/api/session", undefined, payload);
  assert.equal(replay.status, 401);
  assert.match((await json(replay)).error, /already used/);
});

test("without a shared store, each instance still refuses its own replays", async () => {
  const s = setup();
  const payload = await s.signedPayload("alice.testnet");
  assert.equal((await s.req("POST", "/api/session", undefined, payload)).status, 200);
  assert.equal((await s.req("POST", "/api/session", undefined, payload)).status, 401);
});

// ---- companion memory scoped to ownership epoch (P1) -------------------------------------------

test("companion memory is scoped to the ownership epoch", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  assert.equal((await s.req("POST", "/api/v2/companion/1", alice, { message: "my goal is to ship a dapp" })).status, 200);
  assert.equal((await json(await s.req("GET", "/api/v2/companion/1", alice))).history.length, 2);

  s.f.sell("1", "carol.testnet"); // epoch 2
  const carol = await s.signIn("carol.testnet");
  const carolView = await json(await s.req("GET", "/api/v2/companion/1", carol));
  assert.equal(carolView.history.length, 0, "buyer never sees the seller's chats");
  assert.equal(carolView.ownerEpoch, 2);

  s.f.sell("1", "alice.testnet"); // epoch 3: Alice buys it back
  const back = await json(await s.req("GET", "/api/v2/companion/1", alice));
  assert.equal(back.history.length, 0, "a returning holder does not get the old conversation back");
});

test("a seller can still delete what they told the companion, for every epoch they had", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  await s.req("POST", "/api/v2/companion/1", alice, { message: "remember this" });
  s.f.sell("1", "carol.testnet");
  const del = await json(await s.req("DELETE", "/api/v2/companion/1/memory", alice));
  assert.equal(del.cleared, true);
  s.f.sell("1", "alice.testnet");
  s.f.epochs.set("1", 1); // look at epoch 1 directly
  assert.equal((await json(await s.req("GET", "/api/v2/companion/1", alice))).history.length, 0);
});

test("V2 companion knows tier, account and events from the chain", async () => {
  const s = setup();
  const bob = await s.signIn("bob.testnet");
  const r = await json(await s.req("POST", "/api/v2/companion/2", bob, { message: "what tier am I and what can I earn from events?" }));
  assert.match(r.reply, /Gold with 85 points/);
  assert.match(r.reply, /Live session/);
  assert.equal(r.pass.pass_account, `2.${V2}`);
});

// ---- creator permissions, event access, tier gating --------------------------------------------

test("creator dashboard is for the programme's creator only", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  assert.equal((await s.req("GET", "/api/v2/creator/1", alice)).status, 403);
  const creator = await s.signIn("creator.testnet");
  const res = await s.req("GET", "/api/v2/creator/1", creator);
  assert.equal(res.status, 200);
  assert.equal((await json(res)).passes.length, 2);
});

test("event access needs a ticket on your account or on a pass you hold", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet");
  assert.equal((await s.req("GET", "/api/v2/events/1/access", alice)).status, 403);
  s.f.tickets.set("1:dave.testnet", { event_id: 1, buyer: "dave.testnet", token_id: "1", checked_in: false });
  const res = await json(await s.req("GET", "/api/v2/events/1/access", alice));
  assert.equal(res.access, true);
  assert.equal(res.via, "pass #1");
  s.f.sell("1", "carol.testnet");
  assert.equal((await s.req("GET", "/api/v2/events/1/access", alice)).status, 403, "the ticket went with the pass");
});

test("a ticket the seller bought for their pass opens the event only for the pass's current holder", async () => {
  const s = setup();
  s.f.tickets.set("1:alice.testnet", { event_id: 1, buyer: "alice.testnet", token_id: "1", checked_in: false });
  const alice = await s.signIn("alice.testnet");
  assert.equal((await json(await s.req("GET", "/api/v2/events/1/access", alice))).via, "pass #1");
  s.f.sell("1", "carol.testnet");
  assert.equal((await s.req("GET", "/api/v2/events/1/access", alice)).status, 403, "one seat, one person");
  const carol = await s.signIn("carol.testnet");
  assert.equal((await json(await s.req("GET", "/api/v2/events/1/access", carol))).via, "pass #1");
});

test("a visitor ticket (no pass) opens the event for its buyer", async () => {
  const s = setup();
  s.f.tickets.set("1:dave.testnet", { event_id: 1, buyer: "dave.testnet", token_id: null, checked_in: false });
  const dave = await s.signIn("dave.testnet");
  assert.equal((await json(await s.req("GET", "/api/v2/events/1/access", dave))).via, "your ticket");
});

test("members content is gated by the on-chain tier", async () => {
  const s = setup();
  const alice = await s.signIn("alice.testnet"); // Bronze
  const bronze = await json(await s.req("GET", "/api/v2/members/1", alice));
  const gold = bronze.content.posts.find((p: any) => p.minTier === "Gold");
  assert.equal(gold.unlocked, false);
  assert.equal(gold.body, null, "locked content is not sent at all");
  const bob = await s.signIn("bob.testnet"); // Gold
  const g = await json(await s.req("GET", "/api/v2/members/2", bob));
  assert.ok(g.content.posts.find((p: any) => p.minTier === "Gold").body);
  assert.equal(g.content.posts.find((p: any) => p.minTier === "Platinum").body, null);
});

// ---- public data and honest history ------------------------------------------------------------

test("pass detail proves the account is keyless and runs the pass-account code", async () => {
  const s = setup();
  const r = await json(await s.req("GET", "/api/v2/passes/1"));
  assert.equal(r.account.keyless, true);
  assert.equal(r.account.runsPassAccountCode, true);
});

test("history says when it is incomplete", async () => {
  const s = setup();
  assert.equal((await json(await s.req("GET", "/api/v2/passes/1/history"))).complete, true);
  s.f.setComplete(false);
  const h = await json(await s.req("GET", "/api/v2/passes/1/history"));
  assert.equal(h.complete, false);
  assert.match(h.note, /Only part of the history/);
});

test("bad ids and account names are refused", async () => {
  const s = setup();
  assert.equal((await s.req("GET", "/api/v2/passes/../1")).status, 404);
  assert.equal((await s.req("GET", "/api/v2/passes?owner=Not%20An%20Account")).status, 400);
});
