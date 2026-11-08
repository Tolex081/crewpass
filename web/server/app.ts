// CrewPass API. Members-only content is decided here, on every request, from the chain.
import { Hono, type Context } from "hono";
import type { Chain } from "./near.js";
import { eventTouchesPass } from "./near.js";
import { verifyNep413 } from "./nep413.js";
import { issueNonce, issueSession, NonceGuard, readSession, type Session } from "./tokens.js";
import { programme as defaultProgramme, type Programme } from "./programme.js";
import { memoryKey, type KvStore, type MemoryStore } from "./memory.js";
import { contextBlock, MAX_INPUT_CHARS, ProviderError, RATE_LIMIT, systemPrompt, type PassFacts, type Provider } from "./companion.js";

export const SIGN_IN_MESSAGE = "Sign in to CrewPass to open the members area. This does not move any funds.";

export interface CompanionDeps {
  kv: KvStore; // also used for rate limiting
  memory: MemoryStore;
  provider: Provider;
  /** False when memory lives in process memory (local development only). */
  durable: boolean;
  dataNotice: string;
}

export interface AppOptions {
  chain: Chain;
  secret: Uint8Array;
  contract: string;
  /** NEP-413 recipient: binds signatures to this site. */
  recipient: string;
  programme?: Programme;
  /** Absent = companion switched off (routes answer 503). */
  companion?: CompanionDeps;
  now?: () => number;
}

const YOCTO = 10n ** 24n;
function near(yocto: string): string {
  const y = BigInt(yocto || "0");
  const frac = (y % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${y / YOCTO}.${frac}` : (y / YOCTO).toString();
}

function passFacts(info: PassInfo): PassFacts {
  return {
    token_id: info.token_id,
    holder: info.owner_id,
    vault_near: near(info.vault),
    earned_near: near(info.stats.earned),
    withdrawn_near: near(info.stats.withdrawn),
    referrals: info.stats.referrals,
    times_sold_or_moved: info.stats.transfers,
    listed_for_near: info.listing ? near(info.listing.price) : null,
    locked_in_transfer: info.in_transfer_call,
    tier: "none (tiers are not active yet)",
  };
}

interface PassInfo {
  token_id: string;
  owner_id: string;
  vault: string;
  listing: { seller: string; price: string } | null;
  in_transfer_call: boolean;
  stats: { minted_at_ns: string; referrals: number; earned: string; withdrawn: string; transfers: number };
}

interface Token {
  token_id: string;
  owner_id: string;
}

export function createApp(o: AppOptions) {
  const now = o.now ?? Date.now;
  const nonces = new NonceGuard(o.secret);
  const prog = o.programme ?? defaultProgramme;
  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "A service CrewPass depends on did not answer. Try again in a moment." }, 502);
  });

  /** Valid session whose signing key is still a full-access key of the account. Else a 401 response. */
  async function signedIn(c: Context): Promise<Session | Response> {
    const auth = c.req.header("authorization");
    const session = readSession(o.secret, auth?.startsWith("Bearer ") ? auth.slice(7) : undefined, now());
    if (!session) return c.json({ error: "Sign in to open the members area." }, 401);
    const permission = await o.chain.accessKeyPermission(session.accountId, session.publicKey);
    if (permission !== "FullAccess") {
      return c.json({ error: "The key you signed in with is no longer on this account. Sign in again." }, 401);
    }
    return session;
  }

  app.get("/config", async (c) => {
    const config = await o.chain.view<Record<string, unknown>>("config", {});
    return c.json({ contract: o.contract, network: "testnet", recipient: o.recipient, ...config });
  });

  // ---- sign-in (T4) ------------------------------------------------------------------------------

  app.get("/challenge", (c) =>
    c.json({
      message: SIGN_IN_MESSAGE,
      recipient: o.recipient,
      nonce: Buffer.from(issueNonce(o.secret, now())).toString("base64"),
    }),
  );

  app.post("/session", async (c) => {
    const body = await c.req.json<{ accountId?: string; publicKey?: string; signature?: string; nonce?: string }>().catch(() => ({}));
    const { accountId, publicKey, signature, nonce } = body as Record<string, string | undefined>;
    if (!accountId || !publicKey || !signature || !nonce) {
      return c.json({ error: "Missing accountId, publicKey, signature or nonce." }, 400);
    }
    const nonceBytes = Uint8Array.from(Buffer.from(nonce, "base64"));
    const payload = { message: SIGN_IN_MESSAGE, nonce: nonceBytes, recipient: o.recipient };
    if (!verifyNep413(payload, publicKey, signature)) {
      return c.json({ error: "The signature does not match this sign-in request." }, 401);
    }
    const nonceState = nonces.check(nonceBytes, now());
    if (nonceState !== "ok") {
      const why = { forged: "was not issued by this site", expired: "has expired", future: "is not valid yet", reused: "was already used" }[nonceState];
      return c.json({ error: `This sign-in request ${why}. Start again.` }, 401);
    }
    const permission = await o.chain.accessKeyPermission(accountId, publicKey);
    if (permission !== "FullAccess") {
      return c.json({ error: "Sign in with a full-access key of this account." }, 401);
    }
    return c.json({ token: issueSession(o.secret, accountId, publicKey, now()), accountId });
  });

  // ---- members area (T3): ownership checked on every request --------------------------------------

  app.get("/members", async (c) => {
    const session = await signedIn(c);
    if (session instanceof Response) return session;
    // fresh: never answer an access decision from cache, or a seller could get in for a few seconds after a sale.
    const passes = await o.chain.view<Token[]>(
      "nft_tokens_for_owner",
      { account_id: session.accountId, from_index: "0", limit: 50 },
      { fresh: true },
    );
    if (passes.length === 0) {
      return c.json({ error: "This account does not hold a CrewPass. Members content is only for current holders.", accountId: session.accountId }, 403);
    }
    const infos = await Promise.all(passes.map((p) => o.chain.view<PassInfo | null>("pass_info", { token_id: p.token_id })));
    return c.json({
      accountId: session.accountId,
      checkedAt: new Date(now()).toISOString(),
      passes: infos.filter((p): p is PassInfo => p !== null),
      content: { creator: prog.creator, label: prog.label, posts: prog.posts },
      programme: { name: prog.name, summary: prog.summary, benefits: prog.benefits, tiers: prog.tiers },
    });
  });

  // ---- AI companion: only the current holder of that pass, checked on chain every request -------

  /** Session + fresh on-chain ownership of this pass. Returns the session and the pass, or a response. */
  async function holderOf(c: Context, tokenId: string): Promise<{ session: Session; info: PassInfo } | Response> {
    if (!/^\d{1,12}$/.test(tokenId)) return c.json({ error: "No pass with that number." }, 404);
    const session = await signedIn(c);
    if (session instanceof Response) return session;
    const token = await o.chain.view<Token | null>("nft_token", { token_id: tokenId }, { fresh: true });
    if (!token) return c.json({ error: "No pass with that number." }, 404);
    if (token.owner_id !== session.accountId) {
      return c.json({ error: "Only the current holder of this pass can use its companion." }, 403);
    }
    const info = await o.chain.view<PassInfo | null>("pass_info", { token_id: tokenId }, { fresh: true });
    if (!info) return c.json({ error: "No pass with that number." }, 404);
    return { session, info };
  }

  const companionOff = (c: Context) => c.json({ error: "The companion is switched off on this server." }, 503);

  app.get("/companion/info", (c) => {
    if (!o.companion) return companionOff(c);
    return c.json({
      name: prog.companion.name,
      mode: o.companion.provider.mode,
      model: o.companion.provider.label,
      dataNotice: o.companion.dataNotice,
      memoryPersists: o.companion.durable,
      maxInputChars: MAX_INPUT_CHARS,
    });
  });

  app.get("/companion/:id", async (c) => {
    const companion = o.companion;
    if (!companion) return companionOff(c);
    const id = c.req.param("id");
    const h = await holderOf(c, id);
    if (h instanceof Response) return h;
    const rec = await companion.memory.load(memoryKey(o.contract, id, h.session.accountId));
    return c.json({ pass: passFacts(h.info), history: rec.messages });
  });

  app.post("/companion/:id", async (c) => {
    const companion = o.companion;
    if (!companion) return companionOff(c);
    const id = c.req.param("id");
    const body = (await c.req.json<{ message?: unknown }>().catch(() => ({}))) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "Type a message first." }, 400);
    if (message.length > MAX_INPUT_CHARS) return c.json({ error: `Keep messages under ${MAX_INPUT_CHARS} characters.` }, 400);

    const h = await holderOf(c, id);
    if (h instanceof Response) return h;

    const used = await companion.kv.incr(`rl:companion:${h.session.accountId}`, RATE_LIMIT.windowSeconds);
    if (used > RATE_LIMIT.messages) {
      return c.json({ error: `You have sent ${RATE_LIMIT.messages} messages in the last ${RATE_LIMIT.windowSeconds / 60} minutes. Try again shortly.` }, 429);
    }

    const key = memoryKey(o.contract, id, h.session.accountId);
    const rec = await companion.memory.load(key);
    const pass = passFacts(h.info);
    let reply: string;
    try {
      reply = await companion.provider.reply({
        system: systemPrompt(prog),
        context: contextBlock(prog, pass),
        history: rec.messages,
        message,
        programme: prog,
        pass,
      });
    } catch (e) {
      // Nothing is saved when the model fails, so memory never holds a question without its answer.
      const msg = e instanceof ProviderError ? e.message : "The AI service failed.";
      return c.json({ error: msg }, 502);
    }
    const t = now();
    rec.messages.push({ role: "user", content: message, at: t }, { role: "assistant", content: reply, at: t });
    await companion.memory.save(key, rec);
    return c.json({ reply, pass });
  });

  // Deleting your own memory needs only your session, not current ownership: a seller can still erase
  // what they told the companion while they held the pass.
  app.delete("/companion/:id/memory", async (c) => {
    const companion = o.companion;
    if (!companion) return companionOff(c);
    const id = c.req.param("id");
    if (!/^\d{1,12}$/.test(id)) return c.json({ error: "No pass with that number." }, 404);
    const session = await signedIn(c);
    if (session instanceof Response) return session;
    await companion.memory.clear(memoryKey(o.contract, id, session.accountId));
    return c.json({ cleared: true });
  });

  // ---- public pass data ------------------------------------------------------------------------

  app.get("/passes", async (c) => {
    const tokens = await o.chain.view<Token[]>("nft_tokens", { from_index: "0", limit: 100 });
    const infos = await Promise.all(tokens.map((t) => o.chain.view<PassInfo | null>("pass_info", { token_id: t.token_id })));
    return c.json(infos.filter(Boolean));
  });

  app.get("/passes/:id", async (c) => {
    const info = await o.chain.view<PassInfo | null>("pass_info", { token_id: c.req.param("id") });
    return info ? c.json(info) : c.json({ error: "No pass with that number." }, 404);
  });

  app.get("/passes/:id/history", async (c) => {
    const id = c.req.param("id");
    try {
      const events = (await o.chain.recentEvents()).filter((e) => eventTouchesPass(e, id));
      return c.json({ complete: true, events });
    } catch {
      return c.json({ complete: false, events: [], note: "Full history is temporarily unavailable; the counters above come straight from the contract." });
    }
  });

  return app;
}
