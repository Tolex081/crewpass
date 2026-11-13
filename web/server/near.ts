// Minimal NEAR RPC + NearBlocks v3 client. Everything the server believes about ownership comes from here.

export interface Chain {
  /** "FullAccess", "FunctionCall", or null when the key is not on the account. */
  accessKeyPermission(accountId: string, publicKey: string): Promise<"FullAccess" | "FunctionCall" | null>;
  /** `fresh` skips the short view cache: use it for every access decision. */
  view<T>(method: string, args: object, opts?: { fresh?: boolean }): Promise<T>;
  /** CrewPass events from the contract's recent transactions, newest first. */
  recentEvents(): Promise<ChainEvent[]>;
  /** Every page of the contract's transactions (up to a cap). `complete` is false if the cap was
   *  reached or a page could not be read. Optional: V1-only chains may not implement it. */
  allEvents?(): Promise<EventPage>;
  /** A plain NEAR account as the chain sees it (balance, code, number of access keys). */
  account?(accountId: string): Promise<AccountState | null>;
}

export interface EventPage {
  events: ChainEvent[];
  complete: boolean;
  transactionsRead: number;
  pagesRead: number;
}

export interface AccountState {
  accountId: string;
  balance: string; // yoctoNEAR
  storageUsage: number;
  /** Base58 hash of the global contract the account runs, if any. */
  globalContractHash: string | null;
  accessKeys: number;
}

/** Upper bound on NearBlocks pages read for one history (100 transactions each). */
export const MAX_HISTORY_PAGES = 20;

export interface ChainEvent {
  txHash: string;
  timestampMs: number;
  signer: string;
  standard: string; // "crewpass" | "nep171"
  event: string;
  data: Record<string, unknown>;
}

export interface ChainConfig {
  /** Tried in order; the next one is used only when a node cannot be reached. */
  rpcUrls: string[];
  contract: string;
  nearblocksUrl: string; // e.g. https://api-testnet.nearblocks.io
}

export const testnetConfig = (contract = "crewpass.testnet"): ChainConfig => ({
  rpcUrls: process.env.NEAR_RPC_URL
    ? [process.env.NEAR_RPC_URL]
    : ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
  contract,
  nearblocksUrl: process.env.NEARBLOCKS_URL ?? "https://api-testnet.nearblocks.io",
});

async function rpc<T>(urls: string[], method: string, params: unknown): Promise<T> {
  let lastNetworkError: unknown;
  for (const url of urls) {
    try {
      return await rpcOnce<T>(url, method, params);
    } catch (e) {
      // Only an unreachable node moves on to the next one; an answer from the chain is final.
      if (e instanceof TypeError || (e as Error).name === "TimeoutError") {
        lastNetworkError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastNetworkError;
}

async function rpcOnce<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "crewpass", method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string } };
  if (json.error) {
    const err = new Error(json.error.cause?.name ?? json.error.message ?? "rpc error");
    (err as Error & { cause_name?: string }).cause_name = json.error.cause?.name;
    throw err;
  }
  if (json.result && typeof json.result === "object" && "error" in json.result && json.result.error) {
    throw new Error(String(json.result.error));
  }
  return json.result as T;
}

/** Read-only views are cached briefly so one page load doesn't repeat the same calls.
 *  Access-key checks are never cached: they decide who may sign in. */
const VIEW_CACHE_MS = 4_000;

export function nearChain(cfg: ChainConfig): Chain {
  let cache: { at: number; page: EventPage } | null = null;
  const views = new Map<string, { at: number; value: Promise<unknown> }>();

  return {
    async accessKeyPermission(accountId, publicKey) {
      try {
        const r = await rpc<{ permission: "FullAccess" | { FunctionCall: unknown } }>(cfg.rpcUrls, "query", {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        });
        return r.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
      } catch (e) {
        const name = (e as { cause_name?: string }).cause_name ?? (e as Error).message;
        if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(name)) return null;
        throw e;
      }
    },

    async view<T>(method: string, args: object, opts?: { fresh?: boolean }) {
      const key = `${method}:${JSON.stringify(args)}`;
      const hit = views.get(key);
      if (!opts?.fresh && hit && Date.now() - hit.at < VIEW_CACHE_MS) return hit.value as Promise<T>;
      const value = rpc<{ result: number[] }>(cfg.rpcUrls, "query", {
        request_type: "call_function",
        finality: "final",
        account_id: cfg.contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      }).then((r) => JSON.parse(Buffer.from(r.result).toString("utf8")) as T);
      views.set(key, { at: Date.now(), value });
      value.catch(() => views.delete(key));
      return value;
    },

    async recentEvents() {
      return (await this.allEvents!()).events;
    },

    async allEvents() {
      if (cache && Date.now() - cache.at < 30_000) return cache.page;
      type Tx = { transaction_hash: string; signer_account_id: string; block_timestamp: string; receiver_account_id: string };
      const txns: Tx[] = [];
      let next: string | undefined;
      let pagesRead = 0;
      let complete = false;
      // NearBlocks v3 pages newest-first with `limit` (max 100) and an opaque `meta.next_page` cursor.
      while (pagesRead < MAX_HISTORY_PAGES) {
        const url = new URL(`${cfg.nearblocksUrl}/v3/accounts/${cfg.contract}/txns`);
        url.searchParams.set("limit", "100");
        if (next) url.searchParams.set("next", next);
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          if (pagesRead === 0) throw new Error(`NearBlocks ${res.status}`);
          break; // keep what we have; marked incomplete
        }
        const body = (await res.json()) as { data?: Tx[]; meta?: { next_page?: string } };
        txns.push(...(body.data ?? []));
        pagesRead += 1;
        next = body.meta?.next_page;
        if (!next) {
          complete = true;
          break;
        }
      }
      const events: ChainEvent[] = [];
      let unreadable = 0;
      for (const tx of txns.filter((t) => t.receiver_account_id === cfg.contract)) {
        const status = await rpc<{ receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[] }>(
          cfg.rpcUrls,
          "EXPERIMENTAL_tx_status",
          { tx_hash: tx.transaction_hash, sender_account_id: tx.signer_account_id, wait_until: "FINAL" },
        ).catch(() => null);
        if (!status) {
          unreadable += 1;
          continue;
        }
        for (const r of status.receipts_outcome) {
          if (r.outcome.executor_id !== cfg.contract) continue;
          for (const log of r.outcome.logs) {
            if (!log.startsWith("EVENT_JSON:")) continue;
            try {
              const e = JSON.parse(log.slice(11)) as { standard: string; event: string; data: Record<string, unknown>[] };
              for (const d of e.data ?? []) {
                events.push({
                  txHash: tx.transaction_hash,
                  timestampMs: Math.floor(Number(BigInt(tx.block_timestamp) / 1_000_000n)),
                  signer: tx.signer_account_id,
                  standard: e.standard,
                  event: e.event,
                  data: d,
                });
              }
            } catch {
              /* not our event format */
            }
          }
        }
      }
      const page: EventPage = { events, complete: complete && unreadable === 0, transactionsRead: txns.length, pagesRead };
      cache = { at: Date.now(), page };
      return page;
    },

    async account(accountId) {
      try {
        const a = await rpc<{ amount: string; storage_usage: number; global_contract_hash?: string | null }>(cfg.rpcUrls, "query", {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        });
        const keys = await rpc<{ keys: unknown[] }>(cfg.rpcUrls, "query", {
          request_type: "view_access_key_list",
          finality: "final",
          account_id: accountId,
        });
        return {
          accountId,
          balance: a.amount,
          storageUsage: a.storage_usage,
          globalContractHash: a.global_contract_hash ?? null,
          accessKeys: keys.keys.length,
        };
      } catch (e) {
        const name = (e as { cause_name?: string }).cause_name ?? (e as Error).message;
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(name)) return null;
        throw e;
      }
    },
  };
}

/** Does this event concern the given pass? */
export function eventTouchesPass(e: ChainEvent, tokenId: string): boolean {
  const d = e.data;
  if (d.token_id === tokenId) return true;
  if (d.referrer_token_id === tokenId) return true;
  return Array.isArray(d.token_ids) && (d.token_ids as unknown[]).includes(tokenId);
}
