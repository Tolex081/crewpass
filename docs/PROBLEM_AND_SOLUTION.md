# CrewPass: the problem, the solution, and everything built so far

CrewPass is a membership pass on NEAR that **does something**. Each pass is a NEP-171 NFT with its
own money vault, its own members-only access and its own private AI companion. All of it belongs to
whoever holds the pass right now. When the pass is sold, the money, the rights and the access move to
the buyer in the same transaction, and the seller is locked out.

| | |
|---|---|
| **Track** | NEAR hackathon, Track 10: *NFTs That Do Something* (`nfts`) |
| **Network** | NEAR testnet, contract `crewpass.testnet` |
| **Live site** | https://crewpass-steel.vercel.app |
| **Licence** | MIT |
| **Built** | 2026-11-06 to 2026-11-08 (10 commits) |
| **Tests** | 36 contract unit tests, 6 NEAR sandbox tests (real compiled contract plus a real attacker contract), 26 web server tests |
| **Proof on chain** | 12-step live run ([deploy/live-run.md](../deploy/live-run.md)) and a live attack run ([deploy/attack-run.md](../deploy/attack-run.md)), each step linked to a testnet transaction |

---

## 1. The problem

Creators run membership and ambassador programmes: a community, a course, a fan club. Today the
"membership NFT" in those programmes is usually just a picture with a key attached somewhere else.
That causes five concrete problems.

### Problem 1: the NFT does nothing on its own

A typical membership NFT is a JPEG plus metadata. The perks (access to a page, rewards earned,
referral income) live in someone's database, a Discord bot or a wallet address. The token proves
you bought something once. It does not *hold* anything and does not *do* anything.

### Problem 2: rewards belong to a person, not to the pass

When a member brings in new members, the referral reward is paid to their wallet. The earning
position (being the person whose link brings in fans) cannot be sold with the pass, and a buyer gets
a pass with no history and no value inside it. The NFT and the value it created are separate.

### Problem 3: selling a pass does not cleanly end the seller's rights

After a sale, the old holder often keeps:

- an unexpired login or a cached "is a member" flag, so they still see members-only content;
- a role in a chat server that nobody removes;
- the ability to collect rewards that were "earned by the pass" but paid to them.

Access is checked once at login, not at the moment it matters.

### Problem 4: an NFT that holds money is a target

The moment a token carries value, every hand-over becomes an attack surface:

- **The seller drains the vault** right before the buyer's purchase lands, so the buyer pays for
  money that is no longer there.
- **The seller withdraws after the sale**, if the contract checks the wrong owner or checks in a
  separate step.
- **A receiver contract drains it during `nft_transfer_call`.** In standard NEP-171, the receiver
  briefly *owns* the token while `nft_on_transfer` runs. A hostile receiver can use that moment to
  withdraw the vault, move or list the pass, and then hand it back "untouched".
- **A failed payment refunds into the vault**, quietly gifting the seller's withdrawal to the buyer.
- **Self-referral**, fake referrers, double withdrawals, burning a pass that still holds money,
  and storage costs draining the contract.

### Problem 5: private member data leaks to the next owner

If a membership comes with a personal assistant or saved notes, a naive design ties that data to
the token. When the token is sold, the buyer inherits the seller's private conversations.

---

## 2. The solution in one sentence

**Make the pass the account of record**: put the money, the access rights and the companion behind
the token itself, check the *current* holder at the moment of every action, and move everything with
the token in one atomic step, with each attack blocked by contract rules and proven by tests and live
testnet transactions.

---

## 3. How CrewPass solves each problem

| Problem | CrewPass answer | Where |
|---|---|---|
| 1. NFT does nothing | Each pass has a vault, a members area and an AI companion. Holding the pass is what opens them | contract `vaults`, web `/api/members`, `/api/companion/:id` |
| 2. Rewards belong to a person | The vault is keyed by `token_id`, never by an account. Referral commission goes into the **referrer pass's vault**, so it is sold with the pass | `mint`, `credit_vault` in [contract/src/lib.rs](../contract/src/lib.rs) |
| 3. Seller keeps rights | `withdraw`, `list`, `burn` and transfers check the owner **in the same receipt**. The server re-reads `nft_token` on **every** gated request, never a cached flag | `owner_of`, `withdraw`; `web/server/app.ts` |
| 4. Value is a target | A guarded sale (`list` / `buy` with `expected_min_vault`), a lock during `nft_transfer_call`, reduce-before-send payments, an `owed` ledger for failed payments, burn only when empty, a solvency view | contract; [THREAT_MODEL.md](../THREAT_MODEL.md) T1–T20 |
| 5. Private data leaks | Companion memory is keyed by **token + holder account** and encrypted. A buyer starts with empty memory; the seller can still delete their own | `web/server/memory.ts`, threats C1–C10 |

---

## 4. Step by step: how CrewPass delivers the solution

This is the lifecycle of one pass, in the order a real user meets it. Every step names the code
that does it and the rule it keeps.

### Step 1. The creator deploys a programme

The contract is initialised with `new(creator, mint_price, commission_bps, name, symbol)`.

- Live settings on `crewpass.testnet`: mint price **0.1 NEAR**, referral commission **10%**
  (1000 bps, capped at 50% by the contract), listing deposit **0.01 NEAR**.
- **NEP-178 approvals are switched off** (`NonFungibleToken::new(..., None)`). Nobody but the owner
  can ever move a pass, so no third party can sell it outside CrewPass's checks (T13).
- The contract has no upgrade or admin method that can touch a vault (T18).
- The programme itself (name, benefits, member posts, the companion's approved knowledge) lives in
  [web/server/programme.ts](../web/server/programme.ts). The pilot is a demo learning community,
  "CrewPass Study Crew".

### Step 2. A fan mints a pass, optionally through a referral link

`mint(referrer_token_id)` with exactly 0.1 NEAR attached.

1. The deposit must be **exact** (`attach exactly the mint price`).
2. If there is a referrer: the referrer pass must exist (T12) and must not belong to the minter
   (T11, `a pass cannot refer its own holder`).
3. A new token is minted with NEP-177 metadata (`CrewPass #N`), an empty vault and fresh counters.
4. **In the same receipt**, 10% of the price (0.01 NEAR) is credited to the **referrer pass's
   vault**, and that pass's `referrals` and `earned` counters go up. Nothing is ever "in transit" to a
   person, so a commission cannot land with the wrong holder after a sale (T6).
5. The contract **measures the storage** the new pass used and charges it from the creator's share,
   so mints cannot drain the contract (T17). The rest is recorded as owed to the creator.
6. NEP-297 events are emitted: the standard `nft_mint` plus CrewPass's `pass_minted` and
   `commission_credited`. These are the pass's public history.

On the site, the Passes page reads a `?ref=` link and passes it as the referrer.

### Step 3. The pass earns: its vault fills

Every later mint that names this pass as referrer adds 0.01 NEAR to **this pass's vault**.
`pass_info(token_id)` shows the live state: owner, vault, listing, lock flag, and the counters
`minted_at_ns`, `referrals`, `earned`, `withdrawn`, `transfers`. The pass now carries value and a
track record of its own.

### Step 4. The holder signs in, and the pass opens the members area

The web server decides who sees members-only content; the browser never does.

1. The page asks `/api/challenge` for a 32-byte nonce that carries its own issue time and an HMAC.
2. The wallet signs a **NEP-413** message (`message`, `nonce`, `recipient`) with a full-access key.
3. `/api/session` rebuilds the NEP-413 bytes (tag `2147484061`, Borsh payload), checks the Ed25519
   signature, checks the nonce is genuine, under 5 minutes old and unused (T4), and checks **on chain**
   that the key is a full-access key of that account. It then issues a 15-minute session token.
4. `/api/members` re-reads ownership **on chain on every request**. No cache. If the chain cannot be
   reached, access is refused (fails closed).

The members area shows the programme's benefits, posts and lesson path.

### Step 5. The holder talks to their private AI companion

`POST /api/companion/:tokenId`.

- **Access:** a valid session, a full-access key still on the account, and
  `nft_token(tokenId).owner_id == session account`, read fresh on that request (C1, C2).
- **What it knows:** the programme's approved knowledge, the **live state of the pass** read from
  the contract on that request, and the holder's own recent conversation.
- **Memory:** stored under `mem:v1:<contract>:<tokenId>:<accountId>`, encrypted with AES-256-GCM, with
  the key itself as associated data, so a stored value cannot be copied to another holder's key (C3,
  C6). The last 20 messages are kept, with a 90-day expiry refreshed on use, and `DELETE` clears it at once.
- **Safe by design:** the companion has **no tools and no keys**. It cannot move money or sign
  anything; when a wallet action helps, it tells the member which button to press. Creator knowledge
  and member messages go into the prompt as quoted data under fixed rules (C9). Answers are rendered
  as plain text.
- **Provider:** any OpenAI-compatible API (Gemini, NEAR AI Cloud, others) set by environment
  variables. With no key set, an offline mode answers from the programme knowledge and pass state, and
  says so. Members see a privacy notice before their first message (C10).
- **Limits:** 20 messages per 10 minutes per account, 1000 characters per message (C7). A failed
  model call saves nothing and never shows the provider's error or key (C8).

### Step 6. The holder withdraws the vault

`withdraw(token_id, amount)` with 1 yoctoNEAR attached (proves a full-access key).

1. The caller must be the **current** owner, checked in this receipt (I1, T1).
2. The pass must not be listed or locked (I5).
3. The amount must be positive and no more than the vault (T8).
4. The vault is **reduced before** the payment is sent (T8).
5. The payment runs with an `on_payout` callback. If it fails, the amount is recorded as **owed to
   the person who withdrew**, claimable with `claim`. It never goes back into the vault, so a
   failed withdrawal can never become a gift to a later buyer (T7).

### Step 7. The holder lists the pass for sale

`list(token_id, price)` with exactly 0.01 NEAR (covers the listing's storage; returned on sale or
delist).

While listed, the pass **cannot be withdrawn from, transferred or burned** (I5). The seller cannot
empty the vault under a buyer (T5). Only the seller can `delist` (T15).

### Step 8. A buyer buys the pass, and everything moves at once

`buy(token_id, expected_min_vault)` with exactly the listing price.

1. The buyer states the **minimum vault they expect**. If the vault is lower, the purchase fails and
   the deposit is returned (T5).
2. The price must be exact (T14). The seller cannot buy their own pass. A stale listing is refused.
3. **In this one receipt:** the listing is removed, the token moves to the buyer, the `transfers`
   counter goes up, and a `pass_sold` event records the price and the vault that came with it.
4. The seller is paid **price + listing deposit**, once. If that payment fails, it is owed to the
   seller and claimable (T16).

Because the vault is keyed by the token and every vault action checks the current owner, **the
vault, the right to withdraw and the right to list all belong to the buyer from this receipt on**
(I4).

### Step 9. The seller is locked out everywhere

- **On chain:** the seller's `withdraw`, `nft_transfer` and `list` are refused (T1, T2).
- **Members area:** on the seller's next request the server re-reads `nft_token` and returns
  **403**, even with an unexpired session (T3).
- **Companion:** the seller is refused for that pass (C4). The buyer, after signing in, gets the
  pass's public state and a **fresh, empty** companion memory. The seller's chats are never handed
  over, and the seller can still delete them with their own session (C5).

### Step 10. Transfers to contracts are safe: the `nft_transfer_call` lock

This is the hardest attack, and CrewPass's main security contribution.

1. On `nft_transfer_call`, the contract **locks the pass** (`in_transfer_call`) and emits
   `transfer_call_locked`.
2. While locked, `withdraw`, `list`, `nft_transfer`, `nft_transfer_call`, `burn` and `buy` are
   **all refused** with `pass is in the middle of nft_transfer_call` (T9).
3. `nft_resolve_transfer` runs the standard NEP-171 logic and then **always clears the lock**,
   whether the receiver kept the pass, returned it or panicked (T10). If the receiver kept it, the
   vault rights are now the receiver's, as with any transfer.

This was proven against a real hostile contract (`crewpass-evil.testnet`, source in
[test-receiver/src/lib.rs](../test-receiver/src/lib.rs)) in the sandbox and **live on testnet**: it
tried to withdraw, move the pass to an accomplice and list it, every attempt was refused, the pass
went back to its holder and the vault was unchanged.

### Step 11. The creator collects income; the contract stays solvent

- The creator calls `claim` to collect mint income (and anyone with a failed payout claims it the
  same way).
- `burn` is only allowed when the vault is empty, so no money is ever left without an owner (T19).
- `accounting()` shows the contract's balance against everything it owes (vaults + owed + listing
  deposits + storage). `solvent` must always be true (I3). The sandbox tests check it after every test.

### Step 12. Anyone can verify it

- The **Passes** page lists every pass with its holder and vault, read live from the chain.
- The **Pass #N** page shows the pass's history, built from its on-chain events (`pass_minted`,
  `commission_credited`, `pass_sold`, `vault_withdrawn`, `nft_transfer`). If the NearBlocks indexer is
  down, it falls back to the on-chain counters and says so.
- The **Proof** page lists every recorded transaction with explorer links.
- Anyone with `near-cli-rs` can call `pass_info` and `accounting` on `crewpass.testnet` without an account.

---

## 5. The rules the contract must keep (invariants)

| # | Rule |
|---|---|
| I1 | Only the current owner of a pass can withdraw from its vault. |
| I2 | A pass's vault only goes down through `withdraw` by its current owner. |
| I3 | The books always balance: vaults + creator balance + owed amounts never exceed what the contract holds. |
| I4 | Moving a pass and moving the vault rights happen in the same receipt, never across two. |
| I5 | While a pass is listed or in `nft_transfer_call`, nothing can withdraw from it or move it except the sale or transfer under way. |

The full list of attacks, how each is blocked and the test that proves it is in
[THREAT_MODEL.md](../THREAT_MODEL.md): contract threats **T1–T20**, companion threats **C1–C10**,
open risks **R1–R5**.

---

## 6. What has been built

### 6.1 Smart contract ([contract/src/lib.rs](../contract/src/lib.rs))

Rust, `near-sdk` 5.30.1, `near-contract-standards` 5.30.1.

| Method | Kind | What it does |
|---|---|---|
| `new` | init | Creator, price, commission, name, symbol; approvals disabled |
| `mint(referrer_token_id?)` | payable | Mint for the exact price; commission into the referrer pass's vault; storage measured |
| `withdraw(token_id, amount?)` | 1 yocto | Current holder withdraws; reduce first, owe on failure |
| `claim()` | call | Collect anything owed (creator income, failed payouts) |
| `list(token_id, price)` | 0.01 NEAR | List for sale; freezes the pass |
| `delist(token_id)` | 1 yocto | Seller cancels; deposit returned |
| `buy(token_id, expected_min_vault)` | payable | Atomic sale with vault guard |
| `burn(token_id)` | 1 yocto | Only with an empty vault |
| `nft_transfer`, `nft_transfer_call`, `nft_resolve_transfer` | NEP-171 | Standard core with the busy-check and transfer-call lock |
| `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_total_supply`, `nft_supply_for_owner` | view | NEP-171 / NEP-181 |
| `nft_metadata` | view | NEP-177 |
| `pass_info`, `vault_of`, `owed_to`, `config`, `accounting` | view | Pass state, balances, settings, solvency |
| `on_payout` | private | Callback for every outgoing payment |

**Standards used:** NEP-171 (core), NEP-177 (metadata), NEP-181 (enumeration), NEP-297 (events),
NEP-413 (sign-in, web side). NEP-178 (approvals) is deliberately **not** supported.

### 6.2 Tests

| Suite | Count | What it covers |
|---|---|---|
| Unit tests ([contract/src/tests.rs](../contract/src/tests.rs)) | 36 | Every T-threat that a unit test can reach |
| Sandbox tests ([contract/tests/sandbox.rs](../contract/tests/sandbox.rs)) | 6 | Compiled wasm on a local NEAR network: full sale, a real attacker contract during `nft_transfer_call`, failed payout to a deleted account, private callbacks, burn, solvency after every test |
| Web server tests (`web/server/*.test.ts`) | 26 | NEP-413 sign-in, replay, sessions, 403 after sale, companion C1–C9 |

Run with `scripts/test.sh` (Linux or WSL2) and `cd web && npm test`.

### 6.3 Live on testnet

| Account | Role |
|---|---|
| `crewpass.testnet` | The contract (built from commit `5d034f3`, wasm sha256 in [deploy/testnet.json](../deploy/testnet.json)) |
| `crewpass-creator.testnet` | Creator, claims mint income |
| `crewpass-alice.testnet` | First ambassador (referrer) |
| `crewpass-bob.testnet` | Fan who mints with Alice's pass |
| `crewpass-carol.testnet` | Buyer of Alice's pass |
| `crewpass-evil.testnet` | Test-only attacker contract |
| `crewpass-accomplice.testnet` | Where the attacker tries to send stolen passes |

**Live run** (2026-11-06, [deploy/live-run.md](../deploy/live-run.md)), 12 real transactions:

1. Alice mints pass #1.
2. Bob mints pass #2 with pass #1 as referrer: 0.01 NEAR goes into pass #1's vault.
3. Alice tries to refer herself: **refused**.
4. Alice lists pass #1 for 1 NEAR.
5. Alice tries to withdraw while listed: **refused**.
6. Carol tries to buy expecting a bigger vault: **refused**.
7. Carol buys pass #1 for 1 NEAR, and the 0.01 NEAR vault comes with it.
8. Alice (old owner) tries to withdraw: **refused**.
9. Alice tries to move the pass: **refused**.
10. Alice tries to relist: **refused**.
11. Carol withdraws the 0.01 NEAR vault.
12. The creator claims mint income.

Final state: pass #1 owned by Carol, `referrals: 1`, `earned` and `withdrawn` both 0.01 NEAR,
`transfers: 1`; `accounting().solvent == true`.

**Live attack run** ([deploy/attack-run.md](../deploy/attack-run.md)): the hostile receiver gets pass #1
through `nft_transfer_call` and tries to withdraw, move and list it. All refused, the pass returns, the
vault is unchanged.

### 6.4 Web app ([web/](../web/))

**Server** (Hono on Node, Vercel functions), where all access decisions are made:

| Route | Purpose |
|---|---|
| `GET /config` | Contract settings |
| `GET /challenge`, `POST /session` | NEP-413 sign-in |
| `GET /members` | Members area, owner re-checked on chain every request |
| `GET /companion/info`, `GET /companion/:id`, `POST /companion/:id`, `DELETE /companion/:id/memory` | AI companion and its memory |
| `GET /passes`, `GET /passes/:id`, `GET /passes/:id/history` | Pass list, detail and event history |

Supporting modules: `near.ts` (RPC with fallback, NearBlocks history), `nep413.ts` (signature
checks), `tokens.ts` (HMAC nonces and sessions), `memory.ts` (encrypted store, Upstash Redis in
production), `companion.ts` (prompt and provider), `programme.ts` (programme content).

**Pages** (Vite + React, wallet through NEAR Connect):

| Page | For | Actions |
|---|---|---|
| Passes | Everyone | Browse; `mint` (with `?ref=` referral) |
| Pass #N | Everyone | History; holder: `withdraw`, `list`, `delist`; others: `buy` |
| Members | Current holders | Benefits, posts, AI companion |
| Proof | Judges | Every recorded transaction with explorer links |

Colourful "lanyard" pass cards and a light / dark / system theme switch.

### 6.5 Build timeline

| Date | Work |
|---|---|
| 2026-11-06 | Threat model written **before** any code; contract with vaults, transfer-call lock and tests; testnet deploy; live run; live attack run; web server (sign-in, owner check, history); web pages; Vercel deploy; theme |
| 2026-11-08 | Holder-only AI companion with encrypted per-holder memory; product document |

---

## 7. How it fits Track 10, "NFTs That Do Something"

| Track asks for | CrewPass |
|---|---|
| Assets that **own money** | Each pass has its own vault, withdrawable only by its holder |
| **Earn** | 10% referral commission into the referrer pass's vault (a commission, not a NEP-199 resale royalty) |
| **Carry credentials, memberships or access rights** | The pass opens the members area and the AI companion, checked live on chain |
| **Ownership with behaviour** | Value, rights and access move with the token in one receipt; the seller is locked out |
| **NEP-171** | Full NEP-171 core with NEP-177, NEP-181, NEP-297 |
| **Dynamic NFTs** | Partly: per-pass state changes (`referrals`, `earned`, `withdrawn`, `transfers`) and is shown live, but the token metadata itself does not change yet |
| **Sub-accounts** | Not used. Vaults are accounting inside one contract, chosen so every rule is enforced in one receipt |

---

## 8. Honest limits

- **Not audited.** Built and tested by the team in a few days.
- **R1:** if `nft_resolve_transfer` ever ran out of its fixed 5 TGas, a pass would stay locked. It fits
  comfortably today; there is no admin escape hatch by design.
- **R2:** the transfer-call lock and `owed` entries use a few bytes nobody pre-pays; the contract keeps
  a small reserve.
- **R3 / T13:** a buyer who pays a seller directly instead of using `buy` is not protected.
- **R4:** one person with two accounts can still refer themselves; that needs identity checks.
- **No supply cap and no transfer switch yet;** every pass is transferable and minting is unlimited.
- **Metadata is static;** no `nft_metadata_update` events yet.
- **Sign-in nonces are single-use per server instance**, so a captured signature could be replayed on
  another Vercel instance within 5 minutes. Moving nonces to Upstash fixes it.
- **The companion on Gemini's free tier is not private** (Google may use content to improve its
  products). Members are warned; a private provider (NEAR AI Cloud TEE models) is planned.
- **The contract account still has its full-access key**, needed for redeploys during the hackathon;
  removal is planned before submission.
- **House of Stake TLAs are not used.** The investigation is incomplete (see THREAT_MODEL.md).

---

## 9. What comes next (planned, not built)

Contract v2, deployed to a new account so v1 and its recorded proof stay valid:

1. **Fixed, disclosed supply cap** and an optional **non-transferable** mode enforced in the contract.
2. **Evolution Engine:** Bronze → Silver → Gold tiers from verifiable engagement, with
   **dynamic metadata** and `nft_metadata_update` events.
3. **Creator-funded reward campaigns** with a fixed budget, conditions and expiry, paid into pass vaults.
4. **NEP-199 royalties** so the creator earns on resales.
5. **Creator dashboard** and knowledge editor, replacing the file-based programme.

---

## 10. Where to look

| File | What it is |
|---|---|
| [README.md](../README.md) | Quick start and how to try it |
| [docs/PRODUCT.md](PRODUCT.md) | Product and architecture master document |
| [THREAT_MODEL.md](../THREAT_MODEL.md) | Every attack, how it is blocked, and the test that proves it |
| [contract/src/lib.rs](../contract/src/lib.rs) | The contract |
| [deploy/live-run.md](../deploy/live-run.md) | 12-step live run on testnet |
| [deploy/attack-run.md](../deploy/attack-run.md) | Live attack during `nft_transfer_call` |
| [web/README.md](../web/README.md) | Web server and pages |
