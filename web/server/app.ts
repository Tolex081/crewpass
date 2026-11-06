// CrewPass API. Members-only content is decided here, on every request, from the chain.
import { Hono } from "hono";
import type { Chain } from "./near.js";
import { eventTouchesPass } from "./near.js";
import { verifyNep413 } from "./nep413.js";
import { issueNonce, issueSession, NonceGuard, readSession } from "./tokens.js";
import { membersContent } from "./members-content.js";

export const SIGN_IN_MESSAGE = "Sign in to CrewPass to open the members area. This does not move any funds.";

export interface AppOptions {
  chain: Chain;
  secret: Uint8Array;
  contract: string;
  /** NEP-413 recipient: binds signatures to this site. */
  recipient: string;
  now?: () => number;
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
  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "The NEAR network did not answer. Try again in a moment." }, 502);
  });

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
    const auth = c.req.header("authorization");
    const session = readSession(o.secret, auth?.startsWith("Bearer ") ? auth.slice(7) : undefined, now());
    if (!session) return c.json({ error: "Sign in to open the members area." }, 401);

    const permission = await o.chain.accessKeyPermission(session.accountId, session.publicKey);
    if (permission !== "FullAccess") {
      return c.json({ error: "The key you signed in with is no longer on this account. Sign in again." }, 401);
    }
    const passes = await o.chain.view<Token[]>("nft_tokens_for_owner", { account_id: session.accountId, from_index: "0", limit: 50 });
    if (passes.length === 0) {
      return c.json({ error: "This account does not hold a CrewPass. Members content is only for current holders.", accountId: session.accountId }, 403);
    }
    const infos = await Promise.all(passes.map((p) => o.chain.view<PassInfo | null>("pass_info", { token_id: p.token_id })));
    return c.json({
      accountId: session.accountId,
      checkedAt: new Date(now()).toISOString(),
      passes: infos.filter((p): p is PassInfo => p !== null),
      content: membersContent,
    });
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
