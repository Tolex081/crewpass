// Off-chain content for V2 programmes: what members see and what the companion may quote.
// Everything about money, ownership and tiers comes from the registry contract, never from here.
// An entry is used only when its `creator` matches the programme's creator on chain, so nobody can
// attach content to someone else's programme by reusing an id.

export const TIER_ORDER = ["Bronze", "Silver", "Gold", "Platinum"] as const;
export type Tier = (typeof TIER_ORDER)[number];

export function tierRank(t: string): number {
  const i = TIER_ORDER.indexOf(t as Tier);
  return i < 0 ? 0 : i;
}

export interface CatalogEntry {
  programmeId: number;
  creator: string;
  label: string;
  summary: string;
  companion: { name: string; tone: string };
  benefits: { text: string; minTier: Tier }[];
  posts: { title: string; body: string; minTier: Tier }[];
  knowledge: { title: string; body: string }[];
}

const STUDY_CREW: Omit<CatalogEntry, "programmeId" | "creator"> = {
  label: "Demo programme for the NEAR hackathon",
  summary:
    "A small learning community for people starting to build on NEAR. Every pass owns its own NEAR account, earns a share of event ticket sales, and moves up from Bronze to Platinum as its holder takes part.",
  companion: { name: "Crew Companion", tone: "Friendly, concise and practical. Plain English. Short answers with a clear next step." },
  benefits: [
    { text: "The lesson path and weekly live study sessions", minTier: "Bronze" },
    { text: "A share of every ticket sold, paid into your pass's own NEAR account", minTier: "Bronze" },
    { text: "A private study companion that knows your pass", minTier: "Bronze" },
    { text: "Silver: recordings of past sessions", minTier: "Silver" },
    { text: "Gold: monthly small-group code review", minTier: "Gold" },
    { text: "Platinum: a seat on the programme's content panel", minTier: "Platinum" },
  ],
  posts: [
    { title: "Welcome to the Study Crew", body: "Start with Lesson 1, then buy a ticket for the next live session with your pass attached: attending earns points for the pass.", minTier: "Bronze" },
    { title: "Session recordings", body: "Recordings of past sessions are listed here for Silver passes and above (demo content).", minTier: "Silver" },
    { title: "Code review sign-up", body: "Gold passes can book a monthly small-group code review (demo content).", minTier: "Gold" },
    { title: "Content panel", body: "Platinum holders help choose next month's lessons (demo content).", minTier: "Platinum" },
  ],
  knowledge: [
    { title: "Your pass account", body: "Every CrewPass V2 pass has its own NEAR account named after it, like 1.crewpass-v2.testnet. It has no keys. Only the registry contract can move its NEAR, and the registry only does that for the pass's current holder. When the pass is sold, the buyer controls the account from that moment and the seller cannot." },
    { title: "Earning", body: "Part of every event ticket goes into a reward pool shared equally by all passes of the programme. Your share builds up on the pass; Claim rewards pays it into the pass account. Referral commissions go straight into the referring pass's account." },
    { title: "Tiers", body: "Passes earn points on chain: 10 per successful referral, the event's points when the creator checks you in, and creator-awarded achievements. Silver at 30 points, Gold at 80, Platinum at 150. The tier is computed by the contract and shown in the NFT's metadata." },
    { title: "Withdrawing", body: "On your pass page, Withdraw from account asks the registry to send NEAR from the pass account to your wallet. You approve it in your wallet. While it runs, the pass cannot be sold or moved." },
    { title: "Selling", body: "List the pass on its page. While listed, nothing can leave its account, so the buyer gets the balance they saw. After a sale the buyer controls the account; your private chats stay yours." },
    { title: "Lesson 1: Accounts and keys", body: "NEAR accounts have readable names. Full-access keys can do anything; function-call keys can only call chosen methods. A pass account has no keys at all." },
    { title: "Lesson 2: Calling a contract", body: "View methods read state for free. Change methods are transactions that cost gas and may attach NEAR." },
  ],
};

/** Content keyed by registry contract. Programme 1 on crewpass-v2.testnet is the demo programme. */
export function catalogFor(contract: string, programmeId: number, creator: string): CatalogEntry | null {
  const known: CatalogEntry[] = [
    { programmeId: 1, creator: "crewpass-creator.testnet", ...STUDY_CREW },
    { programmeId: 1, creator: "creator.testnet", ...STUDY_CREW }, // unit tests
  ];
  void contract;
  return known.find((e) => e.programmeId === programmeId && e.creator === creator) ?? null;
}

/** Fallback for programmes without curated content: only what the creator put on chain. */
export function genericEntry(programmeId: number, creator: string, name: string, description: string): CatalogEntry {
  return {
    programmeId,
    creator,
    label: "Content from the programme's on-chain description",
    summary: description || name,
    companion: { name: `${name} companion`, tone: "Friendly, concise, plain English." },
    benefits: [
      { text: "Members area and private companion for current holders", minTier: "Bronze" },
      { text: "A share of ticket revenue paid into the pass account", minTier: "Bronze" },
    ],
    posts: [{ title: `Welcome to ${name}`, body: description || "This creator has not added member posts yet.", minTier: "Bronze" }],
    knowledge: [
      { title: name, body: description || "No description yet." },
      ...STUDY_CREW.knowledge.slice(0, 5),
    ],
  };
}
