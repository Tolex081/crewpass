// Minimal NEAR RPC + NearBlocks v3 client. Everything the server believes about ownership comes from here.

export interface Chain {
  /** "FullAccess", "FunctionCall", or null when the key is not on the account. */
  accessKeyPermission(accountId: string, publicKey: string): Promise<"FullAccess" | "FunctionCall" | null>;
  view<T>(method: string, args: object): Promise<T>;
  /** CrewPass events from the contract's recent transactions, newest first. */
  recentEvents(): Promise<ChainEvent[]>;
}

export interface ChainEvent {
  txHash: string;
  timestampMs: number;
  signer: string;
  standard: string; // "crewpass" | "nep171"
  event: string;
  data: Record<string, unknown>;
}

export interface ChainConfig {
  rpcUrl: string;
  contract: string;
  nearblocksUrl: string; // e.g. https://api-testnet.nearblocks.io
}

export const testnetConfig = (contract = "crewpass.testnet"): ChainConfig => ({
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
  contract,
  nearblocksUrl: process.env.NEARBLOCKS_URL ?? "https://api-testnet.nearblocks.io",
});

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
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

export function nearChain(cfg: ChainConfig): Chain {
  let cache: { at: number; events: ChainEvent[] } | null = null;

  return {
    async accessKeyPermission(accountId, publicKey) {
      try {
        const r = await rpc<{ permission: "FullAccess" | { FunctionCall: unknown } }>(cfg.rpcUrl, "query", {
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

    async view<T>(method: string, args: object) {
      const r = await rpc<{ result: number[] }>(cfg.rpcUrl, "query", {
        request_type: "call_function",
        finality: "final",
        account_id: cfg.contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
    },

    async recentEvents() {
      if (cache && Date.now() - cache.at < 30_000) return cache.events;
      const list = await fetch(`${cfg.nearblocksUrl}/v3/accounts/${cfg.contract}/txns`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!list.ok) throw new Error(`NearBlocks ${list.status}`);
      const txns = ((await list.json()) as {
        data?: { transaction_hash: string; signer_account_id: string; block_timestamp: string; receiver_account_id: string }[];
      }).data ?? [];
      const events: ChainEvent[] = [];
      for (const tx of txns.filter((t) => t.receiver_account_id === cfg.contract)) {
        const status = await rpc<{ receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[] }>(
          cfg.rpcUrl,
          "EXPERIMENTAL_tx_status",
          { tx_hash: tx.transaction_hash, sender_account_id: tx.signer_account_id, wait_until: "FINAL" },
        ).catch(() => null);
        if (!status) continue;
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
      cache = { at: Date.now(), events };
      return events;
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
