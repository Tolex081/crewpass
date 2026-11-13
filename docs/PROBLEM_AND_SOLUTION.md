# CrewPass: the problem, the solution, and how it works step by step

CrewPass is a membership protocol on NEAR where **every membership NFT owns a real NEAR account**. The
pass earns from its programme into that account, carries verifiable achievements and a tier that evolves
on chain, opens members-only benefits and a private AI companion, and transfers all of it, account control
included, to its next owner. The seller keeps nothing they could use.

| | |
|---|---|
| **Track** | NEAR Hackathon Track 10: *NFTs That Do Something* |
| **Network** | NEAR testnet: registry `crewpass-v2.testnet`, pass accounts `N.crewpass-v2.testnet` |
| **Live site** | https://crewpass-steel.vercel.app |
| **Tests** | 68 V2 contract unit, 11 V2 sandbox (real local NEAR node), 43 web server; V1 36 + 6 |
| **Live proof** | [deploy/v2-live-run.md](../deploy/v2-live-run.md) (29 testnet transactions, 0 unexpected), [deploy/v2-web-check.md](../deploy/v2-web-check.md) (12 checks, 0 unexpected) |
| **History** | V1 (2026-11-06/08): passes with an internal vault, on `crewpass.testnet`, unchanged. V2 (2026-11-12/13): real accounts, revenue, tiers |

---

## 1. The problem

Creators run membership programmes: a course, a community, a fan club. The "membership NFT" in those
programmes is usually a picture with a key kept somewhere else.

1. **The NFT does nothing.** Perks, earnings and access live in a database, a bot or someone's wallet. The
   token proves a purchase once; it does not hold or do anything.
2. **Value belongs to a person, not to the membership.** Rewards and referral income go to a wallet. A buyer
   gets a token with nothing inside it, and the earning position cannot be sold with it.
3. **Selling does not end the seller's rights.** Cached logins, chat roles and payout addresses survive the
   sale. Access is checked once, not when it matters.
4. **If you do give an NFT a wallet, the key is the problem.** Hand the holder a key to an account and the
   seller can copy it before selling. Rotate keys after the sale and there is a window, and a failure mode,
   where the old owner still controls the account.
5. **NEAR is asynchronous.** A withdrawal started before a sale can land after it. A contract receiving the
   NFT through `nft_transfer_call` owns it for a moment and can act in that moment. Anything checked in one
   receipt can change before the next.
6. **Money in an NFT is a target.** Double claims, over-allocation, unauthorised distributions, duplicate
   tickets, fake points, storage exhaustion, a compromised creator.
7. **Private data leaks to the next owner.** A personal assistant tied to the token hands the seller's
   conversations to the buyer, or back to the seller if they buy the token again.

## 2. The solution in one sentence

**Make the NFT the only key:** give each pass a keyless account that obeys only the registry, make the
registry obey only the pass's current owner in the same receipt, lock the pass while anything asynchronous is
in flight, and keep money, tiers and access decisions on chain where every rule is enforced and tested.

## 3. Problem → answer

| Problem | CrewPass V2 answer | Where |
|---|---|---|
| 1. NFT does nothing | Each pass has a real account, earns into it, has a tier, opens members content, event access and a companion | `contract-v2`, `pass-account`, `web/server/v2.ts` |
| 2. Value belongs to a person | Referrals and rewards are paid into the **pass account**; unclaimed rewards accrue to the token | `on_pass_account_created`, `claim_rewards` |
| 3. Seller keeps rights | Control, listing, members area, companion and attached event tickets all follow `owner_id`, read fresh | registry guards; `holderOf` in the web server |
| 4. Keys can be kept | **The pass account has no keys.** Its immutable code obeys only its parent registry. There is nothing to rotate | [ADR-001](ADR-001-pass-accounts.md) |
| 5. Async races | Lock state machine: account ops, listings and `nft_transfer_call` lock the pass until their callback | `begin_account_op`, `on_account_op`, `nft_transfer_call` |
| 6. Money is a target | Exact deposits, reduce-before-pay, owed ledger, O(1) reward index with carried remainder, unique tickets and achievements, caller-pays storage, solvency view | THREAT_MODEL F1–F8, S1, C11 |
| 7. Private data leaks | Memory key = token + **owner epoch** + account, AES-256-GCM | `memoryKeyV2` |

## 4. Step by step: the journey (as recorded live on testnet)

Each step names the code that performs it and, in brackets, the row of
[deploy/v2-live-run.md](../deploy/v2-live-run.md) that shows it happening on testnet.

### Step 1. A creator launches a programme (row 1)
`create_programme(name, description, mint_price, referral_bps, member_share_bps, max_supply)`. Anyone can be a
creator. The contract caps referral at 20% and the member share at 80%, and requires the price to cover the
account seed, the referral and storage. The caller pays for the programme's storage; the excess is refunded.

### Step 2. A member mints, and the pass gets its own account (row 2)
`mint(programme_id, referrer?)` with the exact price. The registry reserves token *N* and sends one batch
receipt to `N.crewpass-v2.testnet`: create the account, attach the pass-account code by hash, send it the 0.01 NEAR
seed. Only when that succeeds does `on_pass_account_created` mint the NFT. After the live mint, the account
had **0 access keys** and ran global contract `CuX7PYtW…`. If creation fails, no NFT exists and the minter is
refunded (sandbox test `failed_account_creation_refunds_minter`).

### Step 3. Referrals pay the referring pass's account (rows 3–4)
Bob mints through pass #1: 10% of his price is transferred into `1.crewpass-v2.testnet` and pass #1 gains 10
points. Alice referring herself is refused.

### Step 4. Events generate revenue for every pass (rows 5–10)
The creator creates an event. Members buy tickets with their pass attached; visitors buy plain tickets; one
ticket per buyer per event. Each ticket sends 50% to the programme's pool: `per_pass = amount ÷ passes`,
and any remainder is carried. `claim_rewards(1)`, which anyone may call, paid 0.025 NEAR into pass #1's account. A second
claim is refused.

### Step 5. Engagement upgrades the NFT (rows 11–14)
The creator checks pass #1 in (+30 points → Silver) and awards "first-project" (+45 → **Gold**). Each change
rewrites the token's metadata (title `Study Crew #1 · Gold`, an on-chain SVG, `extra` with tier and points)
and logs NEP-171 `nft_metadata_update`. Alice cannot check herself in, and the same achievement cannot be awarded twice.

### Step 6. The holder uses the account (row 15)
`account_transfer(1, alice, 0.005 NEAR)`: the registry checks Alice owns pass #1, locks it, asks the account
to pay, and unlocks in the callback.

### Step 7. Sale (rows 16–19)
Alice lists pass #1 (listing 1). While listed, nothing can leave the account (row 17). Carol's purchase naming
a listing she did not see is refused (row 18). Carol buys listing 1: in that receipt the owner becomes Carol,
`owner_epoch` becomes 2, and `control_changed` records the hand-over of `1.crewpass-v2.testnet`.

### Step 8. The seller is locked out everywhere (rows 20–24, web check)
- Withdrawing via the registry: refused.
- Making the account call another contract: refused.
- **Calling the pass account directly: refused** ("only the CrewPass registry can operate this account").
- Relisting: refused.
- Moving the pass: refused.
- Off chain, with her real key and a fresh session: the members area, the companion and event access all return 403.

### Step 9. The buyer uses the inherited membership (rows 25–29, web check)
Carol withdraws 0.01 NEAR from the account and makes it call another contract as itself (the target records
`caller: 1.crewpass-v2.testnet`). She opens the members area as Gold: the Gold post is unlocked, and the Platinum
post's body is not sent at all. Her companion starts empty (epoch 2) and knows the tier and account. Event 1
opens for her through the ticket attached to the pass. Sending the pass to a pass account is refused. A hostile
`nft_transfer_call` receiver tries to drain the account and list the pass; both attempts fail and the pass comes back.

### Step 10. Everything is public and checkable
- **Pass page:** the account, its balance, "✓ No keys", "✓ Runs the published pass-account code", tier track, money, and the full history (every NearBlocks page; marked incomplete if any page fails).
- **Rewards page:** every distribution and claim.
- **Proof page:** links every transaction.
- **Books:** `accounting()` shows the registry solvent after the run.

## 5. What was built

| Component | Files | Tests |
|---|---|---|
| Registry contract | `contract-v2/src/lib.rs` | 59 unit, 11 sandbox |
| Pass-account code (global contract) | `pass-account/src/lib.rs` | 9 unit, sandbox |
| Test-only target and hostile receiver | `test-target/src/lib.rs` | used by sandbox and live run |
| Web API (V2 routes, paged history, shared nonces, epoch memory, event access, creator gate) | `web/server/v2.ts`, `near.ts`, `tokens.ts`, `memory.ts`, `catalog.ts` | 43 web tests |
| Web app (10 sections + V1 archive) | `web/src/pages/*`, `web/src/components/PassCardV2.tsx` | checked in the browser against testnet |
| Deploy and evidence | `deploy/v2-deploy.sh`, `deploy/v2-live-run.sh`, `web/scripts/v2-web-check.ts`, `deploy/testnet-v2.json` | 29 + 12 live checks |
| Design and security docs | `docs/ADR-001-pass-accounts.md`, `THREAT_MODEL.md`, `docs/PRODUCT.md`, `docs/AUDIT.md` | — |

V1 (`contract/`, `crewpass.testnet`) is untouched and still live as evidence of the first design.

## 6. Honest limits

- **Registry key (U1).** The registry's full-access key still exists; whoever holds it controls every pass account.
  Removing it is the step before real use.
- **House of Stake not used.** Their TLA contracts exist only on mainnet. CrewPass implements the same pattern itself.
- **Lock timeout backstop.** If a callback ever failed, the owner may clear the lock after 1,200 blocks.
- **Trust assumptions.**
  - Sybil referrals are possible.
  - Check-ins and achievements are creator-attested (capped).
  - The Gemini free tier is not private (disclosed to members).
- **Builds.** Builds are not Docker-reproducible; the sha256 of each deployed wasm is recorded.
- **Not audited.**

## 7. Next

- Remove the registry key.
- Add NEP-199 resale royalties.
- Let creators edit member content and run campaigns with conditions and expiry.
- Move the companion to a private TEE model provider.
