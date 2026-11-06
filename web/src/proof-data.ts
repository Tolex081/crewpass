// Transactions recorded in deploy/live-run.md and deploy/attack-run.md (NEAR testnet, 2026-11-06).
export interface ProofRow {
  who: string;
  action: string;
  outcome: "ok" | "refused";
  detail?: string;
  tx: string;
}

export const liveRun: ProofRow[] = [
  { who: "alice", action: "Mint pass #1, no referrer", outcome: "ok", tx: "BM7AabmRj5ERjDLiUevRzcu8d6fUGNq3y1ZCee1ebXdh" },
  { who: "bob", action: "Mint pass #2 through pass #1: Ⓝ 0.01 into pass #1's vault", outcome: "ok", tx: "6ia9F4rS1hPNiYzK4AhbLmN6PgCFg3EKS95SxYF16v2d" },
  { who: "alice", action: "Refer herself with her own pass #1", outcome: "refused", detail: "a pass cannot refer its own holder", tx: "8ckMzXvwjWynxeqbKnPWxbmWozcJuKcwE37q2Q9BDy78" },
  { who: "alice", action: "List pass #1 for Ⓝ 1", outcome: "ok", tx: "BpmrrGPefgAgAwUfdJZRZA44Sums4Av6wCZy9MeJC8yi" },
  { who: "alice", action: "Withdraw while listed", outcome: "refused", detail: "pass is listed; delist it first", tx: "CE8fqG1HiGyNrZ2GxbG9sTntgJvN66hUTYxHxHZbjpf9" },
  { who: "carol", action: "Buy, expecting more than the vault holds", outcome: "refused", detail: "vault is below the amount you expected", tx: "3m6gvVfT4C9uKQE1mc9Xd92rrdgjGxfnLf7chKoGmiRg" },
  { who: "carol", action: "Buy pass #1 for Ⓝ 1; the Ⓝ 0.01 vault comes with it", outcome: "ok", tx: "4eBgF6Co7g5ALip2sPZdRGay3zDkAjkaFLKQcPg9aB2z" },
  { who: "alice", action: "Old owner withdraws after the sale", outcome: "refused", detail: "only the current holder can withdraw", tx: "Fmt9vyN4pyb5jt8ms2DaDYeNwqVRGxjzRBCdZkdT7rTy" },
  { who: "alice", action: "Old owner moves the pass after the sale", outcome: "refused", detail: "Approval extension is disabled", tx: "FU4Sffnwqvo31Pu2AT7t5TinAWvT1q1LAt45GqgQoVMR" },
  { who: "alice", action: "Old owner relists after the sale", outcome: "refused", detail: "only the current holder can list", tx: "Az3dH5CksFj5xVyZtjfHThmRFs1vJB51oTq5uYn3w55J" },
  { who: "carol", action: "New owner withdraws the Ⓝ 0.01 vault", outcome: "ok", tx: "9DQuZRXxNz1UBtRk8HFBcfhrUd6zQDdAXkaxidhNqVGC" },
  { who: "creator", action: "Creator claims mint income", outcome: "ok", tx: "9k4hMotMj2bLvdSEGD68oweVVLMspKd6KmsQ1VprJw69" },
];

export const attackRun: ProofRow[] = [
  { who: "evil contract", action: "Owns pass #1 for a moment, tries to withdraw the vault, then hands it back", outcome: "refused", detail: "pass is in the middle of nft_transfer_call", tx: "Ai6dFHWzrQubgtBBnQxewjtARcy81gUx9gnPaQKsnqXJ" },
  { who: "evil contract", action: "Tries to move pass #1 to an accomplice, then hands it back", outcome: "refused", detail: "pass is in the middle of nft_transfer_call", tx: "J2pC4Jg1hFnGSNoSZDjTnF1mrgHKUgCfYjtPgUyf4iF1" },
  { who: "evil contract", action: "Tries to list pass #1 for sale, then hands it back", outcome: "refused", detail: "pass is in the middle of nft_transfer_call", tx: "72ERs2FonEbTqG7UnKCivCvnoKbWKN3M9qX965EoyN2X" },
];
