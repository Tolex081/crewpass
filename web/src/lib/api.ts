// Read-only data comes through our API; transactions go straight from the wallet to the chain.
export interface PassInfo {
  token_id: string;
  owner_id: string;
  vault: string;
  listing: { seller: string; price: string } | null;
  in_transfer_call: boolean;
  stats: { minted_at_ns: string; referrals: number; earned: string; withdrawn: string; transfers: number };
}

export interface Config {
  contract: string;
  network: string;
  recipient: string;
  creator: string;
  mint_price: string;
  commission_bps: number;
  list_deposit: string;
}

export interface HistoryEvent {
  txHash: string;
  timestampMs: number;
  signer: string;
  standard: string;
  event: string;
  data: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export const api = {
  config: () => get<Config>("/config"),
  passes: () => get<PassInfo[]>("/passes"),
  pass: (id: string) => get<PassInfo>(`/passes/${encodeURIComponent(id)}`),
  history: (id: string) => get<{ complete: boolean; events: HistoryEvent[]; note?: string }>(`/passes/${encodeURIComponent(id)}/history`),
  challenge: () => get<{ message: string; recipient: string; nonce: string }>("/challenge"),
  async session(body: { accountId: string; publicKey: string; signature: string; nonce: string }) {
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !data.token) throw new ApiError(data.error ?? "Sign-in failed", res.status);
    return data.token;
  },
  members: (token: string) =>
    get<{
      accountId: string;
      checkedAt: string;
      passes: PassInfo[];
      content: { creator: string; label: string; posts: { title: string; body: string }[] };
    }>("/members", token),
};
