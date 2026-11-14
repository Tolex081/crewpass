// CrewPass V2 client: read-only data through our API; every change is a wallet transaction straight
// to the registry contract.
import { ApiError, type ChatMessage, type HistoryEvent } from "./api";

export interface ProgrammeV2 {
  id: number;
  creator: string;
  name: string;
  description: string;
  mint_price: string;
  referral_bps: number;
  member_share_bps: number;
  max_supply: number | null;
  minted: number;
  active_passes: number;
  reward_index: string;
  carry: string;
  treasury: string;
  reserved: string;
  distributed_total: string;
  claimed_total: string;
  ticket_revenue_total: string;
  funded_total: string;
  events: number;
  content?: { label: string; summary: string };
}

export interface PassV2 {
  token_id: string;
  owner_id: string;
  account_id: string;
  programme_id: number;
  tier: string;
  points: number;
  next_tier: string | null;
  points_to_next_tier: number | null;
  owner_epoch: number;
  lock: { kind: "AccountOp" | "TransferCall"; since_block: string } | null;
  listing: { id: string; seller: string; price: string } | null;
  rewards_available: string;
  referrals: number;
  referral_earned: string;
  rewards_claimed: string;
  transfers: number;
  tickets: number;
  check_ins: number;
  achievements: number;
  minted_at_ms: string;
}

export interface EventV2 {
  id: number;
  programme_id: number;
  title: string;
  price: string;
  capacity: number;
  sold: number;
  points: number;
  starts_at_ms: string;
  checked_in: number;
}

export interface ConfigV2 {
  contract: string;
  network: string;
  pass_code_hash: string;
  creator_royalty_bps: number;
  storage_byte_cost: string;
  campaign_claim_storage_bytes: number;
  account_seed: string;
  list_deposit: string;
  lock_timeout_blocks: string;
  tiers: [string, number][];
  next_token_id: string;
  accounting: { solvent: boolean; balance: string; liabilities: string; treasury: string; reserved: string; storage_cost: string };
}

export interface AccountProof {
  accountId: string;
  balance: string;
  storageUsage: number;
  globalContractHash: string | null;
  accessKeys: number;
  expectedCodeHash: string;
  runsPassAccountCode: boolean;
  keyless: boolean;
}

export interface PassDetail {
  pass: PassV2;
  metadata: { title?: string; media?: string; extra?: string; updated_at?: string } | null;
  account: AccountProof | null;
}

export interface History {
  complete: boolean;
  events: HistoryEvent[];
  note?: string;
  transactionsRead?: number;
  pagesRead?: number;
}

export interface Benefit {
  text: string;
  minTier: string;
  unlocked?: boolean;
}

export interface ProgrammeContentV2 {
  label: string;
  summary: string;
  companion_name: string;
  companion_tone: string;
  benefits: { text: string; min_tier: number }[];
  posts: { title: string; body: string; min_tier: number }[];
  knowledge: { title: string; body: string }[];
}

export interface RewardCampaignV2 {
  id: string;
  programme_id: number;
  title: string;
  reward_per_pass: string;
  max_claims: number;
  claimed: number;
  min_tier: number;
  starts_at_ms: string;
  ends_at_ms: string;
  remaining_budget: string;
  storage_reserve: string;
  closed: boolean;
  passes: { token_id: string; owner_id: string; account_id: string; tier: string; claimed: boolean; owed: string }[];
}

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`/api/v2${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export const v2 = {
  config: () => get<ConfigV2>("/config"),
  programmes: () => get<ProgrammeV2[]>("/programmes"),
  programme: (id: string | number) =>
    get<{
      programme: ProgrammeV2;
      content: { label: string; summary: string; benefits: Benefit[]; posts: { title: string; minTier: string }[] };
      events: EventV2[];
      passes: PassV2[];
    }>(`/programmes/${id}`),
  rewards: (id: string | number, owner?: string) =>
    get<{
      programme: ProgrammeV2;
      passes: (Pick<PassV2, "token_id" | "owner_id" | "account_id" | "rewards_available" | "rewards_claimed" | "referral_earned"> & { campaign_owed: string })[];
      campaigns: RewardCampaignV2[];
      history: { complete: boolean; events: HistoryEvent[] };
    }>(`/programmes/${id}/rewards${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`),
  passes: (owner?: string) => get<PassV2[]>(owner ? `/passes?owner=${encodeURIComponent(owner)}` : "/passes"),
  pass: (id: string) => get<PassDetail>(`/passes/${encodeURIComponent(id)}`),
  history: (id: string) => get<History>(`/passes/${encodeURIComponent(id)}/history`),
  events: (programme?: number) => get<EventV2[]>(programme ? `/events?programme=${programme}` : "/events"),
  eventAccess: (token: string, id: number) =>
    get<{ access: boolean; via: string; event: EventV2 }>(`/events/${id}/access`, token),
  members: (token: string, id: string) =>
    get<{
      accountId: string;
      checkedAt: string;
      pass: PassV2;
      programme: { id: number; name: string; summary: string };
      content: { label: string; benefits: Benefit[]; posts: { title: string; body: string | null; minTier: string; unlocked: boolean }[] };
    }>(`/members/${encodeURIComponent(id)}`, token),
  creator: (token: string, id: number) =>
    get<{ programme: ProgrammeV2; events: EventV2[]; passes: PassV2[]; passTickets: { event_id: number; token_id: string; checked_in: boolean }[]; content: ProgrammeContentV2 | null }>(
      `/creator/${id}`,
      token,
    ),
  companionHistory: (token: string, id: string) => get<{ history: ChatMessage[]; ownerEpoch: number; name: string }>(`/companion/${encodeURIComponent(id)}`, token),
  async companionSend(token: string, id: string, message: string) {
    const res = await fetch(`/api/v2/companion/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
    if (!res.ok || !data.reply) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    return data.reply;
  },
  async companionClear(token: string, id: string) {
    const res = await fetch(`/api/v2/companion/${encodeURIComponent(id)}/memory`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    }
  },
};

export const TIERS = ["Bronze", "Silver", "Gold", "Platinum"] as const;
export const tierClass = (t: string) => `tier-${t.toLowerCase()}`;
export const ONE_YOCTO = "1";
export const TGAS = (n: number) => (BigInt(n) * 1_000_000_000_000n).toString();
