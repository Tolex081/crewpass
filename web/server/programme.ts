// The membership programme: what members see and what the companion may use as approved knowledge.
// Single programme, file-based for now (creator editor planned). Demo content for the pilot.

export interface KnowledgeEntry {
  id: string;
  title: string;
  body: string;
}

export interface Programme {
  name: string;
  creator: string;
  label: string; // shown so nobody mistakes demo content for a real creator's
  summary: string;
  companion: { name: string; tone: string };
  benefits: string[];
  tiers: { status: "planned"; names: string[]; note: string };
  posts: { title: string; body: string }[];
  knowledge: KnowledgeEntry[];
}

export const programme: Programme = {
  name: "CrewPass Study Crew",
  creator: "crewpass-creator.testnet",
  label: "Demo programme for the NEAR hackathon",
  summary:
    "A small learning community for people starting to build on NEAR. Holders get the lesson path, weekly live study sessions and a personal study companion.",
  companion: {
    name: "Crew Companion",
    tone: "Friendly, concise and practical. Plain English. Short answers with a clear next step.",
  },
  benefits: [
    "The full lesson path, opened step by step in the members area",
    "Weekly live study session (demo schedule: Thursdays, 18:00 UTC)",
    "A personal study companion that remembers your goals, privately",
    "Early access to new lessons, 48 hours before the public",
  ],
  tiers: {
    status: "planned",
    names: ["Bronze", "Silver", "Gold"],
    note: "Tiers are not active yet. When they launch, progress will come from completed lessons and attended sessions, with the formula published here first.",
  },
  posts: [
    {
      title: "Welcome to the Study Crew",
      body: "Start with Lesson 1, then bring your questions to Thursday's session. Your companion can suggest what to read next.",
    },
    {
      title: "Early access",
      body: "Holders see new lessons 48 hours before everyone else. If you sell your pass, this page closes for you on your next visit.",
    },
  ],
  knowledge: [
    {
      id: "about",
      title: "What CrewPass is",
      body: "CrewPass is a membership pass on NEAR testnet. Your pass is an NFT that opens the members area and this companion. Each pass also has a vault inside the contract that can hold rewards.",
    },
    {
      id: "lesson-1",
      title: "Lesson 1: Accounts and keys on NEAR",
      body: "NEAR accounts have readable names like alice.testnet. An account can hold several access keys: full-access keys can do anything, function-call keys can only call chosen methods on one contract. Never share a full-access key.",
    },
    {
      id: "lesson-2",
      title: "Lesson 2: Calling a contract",
      body: "View methods read state for free. Change methods are transactions: they cost a little gas and can attach NEAR as a deposit. Many NFT methods require exactly 1 yoctoNEAR to prove the call came from a full-access key.",
    },
    {
      id: "lesson-3",
      title: "Lesson 3: NFTs and NEP-171",
      body: "NEP-171 is NEAR's NFT standard: nft_transfer moves a token, nft_transfer_call moves it to a contract and asks whether it wants to keep it, nft_token shows who owns it. CrewPass locks a pass during nft_transfer_call so a receiving contract cannot drain its vault.",
    },
    {
      id: "sessions",
      title: "Live study sessions",
      body: "Demo schedule: every Thursday at 18:00 UTC, one hour, a lesson walkthrough followed by questions. Holders get the link in the members area.",
    },
    {
      id: "vault",
      title: "Your pass vault",
      body: "The vault belongs to the pass, not to a person. Today it fills when someone mints a pass through your pass's referral link (10% of the 0.1 NEAR mint price). Only the current holder can withdraw it, using the Withdraw button on the pass page and approving in their wallet. If the pass is sold, the vault goes with it.",
    },
    {
      id: "selling",
      title: "Selling or moving your pass",
      body: "You can list your pass on its page and take it off sale at any time. While listed, the vault cannot be withdrawn, so the buyer gets the balance they saw. After a sale, the buyer gets the pass, its vault and members access. Your private chats with this companion stay yours and are never shown to the buyer.",
    },
    {
      id: "privacy",
      title: "Your companion memory",
      body: "Your conversation is stored encrypted and linked to your account and this pass. Nobody else, including the next holder of the pass, can read it. You can delete it at any time with Clear memory.",
    },
    {
      id: "tiers",
      title: "Tiers",
      body: "Bronze, Silver and Gold tiers are planned but not active yet. No pass has a tier today.",
    },
  ],
};
