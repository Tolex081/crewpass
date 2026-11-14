# CrewPass threat model

Written before any contract code, as the NFT track asks, and updated on Day 2 with the tests that
now prove each row. Unit tests are in `contract/src/tests.rs`; sandbox tests (compiled contract on a
local NEAR network) are in `contract/tests/sandbox.rs`. Run both with `scripts/test.sh`.

Status key: **proven** = unit and/or sandbox test passes · **design** = not testable yet (web page,
testnet deploy) · **open** = known residual risk.

## What CrewPass is

A creator sells Ambassador Passes: NEP-171 NFTs. Each pass

- opens a members-only page for whoever holds it now, and
- has its own **vault**: a balance kept inside the CrewPass contract, stored against the pass's
  `token_id`, never against a person.

When someone mints a pass using another pass as referrer, a commission goes into the referrer
pass's vault. Whoever holds a pass can withdraw its vault. When a pass changes hands, the vault, the
right to withdraw and the page access all go to the new holder in the same transaction.

Network: NEAR testnet. Our own contract, no House of Stake names (they only exist on mainnet).

## Settings (v1)

| Setting | Value |
|---|---|
| Mint price | 0.1 NEAR, exact amount |
| Referral commission | 10% of the mint price, into the referrer pass's vault |
| Rest of the mint price | Minus the storage the new pass uses (measured, about 0.008 NEAR), owed to the creator, who claims it with `claim` |
| Listing deposit | 0.01 NEAR, held while listed, returned to the seller with the sale price or on delist |
| History | Fixed-size counters per pass on chain (`pass_info`), full history in NEP-297 events |
| Burn | Only allowed when the vault is empty, so no vault is ever left without an owner |
| NEP-178 approvals | **Not supported.** Approved third parties would let a pass be sold outside CrewPass's checks (see T13) |
| Contract upgrades | None in v1. Once deployed, the contract account's full-access key is removed |

## Who attacks

- **The seller (old holder):** wants to keep the vault, keep page access, or get paid twice.
- **The buyer:** wants the pass for less, or the price back as well as the pass.
- **A receiver contract** used with `nft_transfer_call`.
- **A stranger:** wants to take vault money, fake referrals or copy someone's page sign-in.
- **The creator/admin:** is trusted only for what the contract allows, which is withdrawing the creator's own balance.

## Rules the contract must keep

- **I1.** Only the current owner of a pass can withdraw from its vault.
- **I2.** A pass's vault only goes down through `withdraw` by its current owner.
- **I3.** The contract's books always balance: the sum of all vaults, the creator balance and amounts owed to people is never more than what the contract holds.
- **I4.** Moving a pass and moving the vault rights happen in the same receipt (one step), never across two.
- **I5.** While a pass is listed for sale, or is in the middle of `nft_transfer_call`, nothing can withdraw from it or move it except the sale or transfer that's under way.

## Threats

Tests marked *(s)* are sandbox tests; the rest are unit tests.

| # | Threat | How it's blocked | Tests | Status |
|---|---|---|---|---|
| T1 | The seller withdraws from the vault after selling | `withdraw` checks the **current** owner in the same receipt it pays from | `old_owner_cannot_withdraw_after_sale`, `sale_moves_vault_and_locks_out_seller` *(s)* | proven |
| T2 | The seller transfers or relists the pass after the sale | Standard NEP-171 owner check; `list` checks the current owner | `old_owner_cannot_transfer_after_sale`, `old_owner_cannot_relist_after_sale`, `sale_moves_vault_and_locks_out_seller` *(s)* | proven |
| T3 | The seller keeps opening the members-only page | The server checks `nft_token` owner **on every request**, never a stored login | `old_owner_gets_403_after_sale` (web, Day 7) | design |
| T4 | Someone replays the seller's old sign-in | NEP-413 message with nonce + 5-minute expiry; each nonce is accepted once | `replayed_signin_is_refused` (web, Day 7) | design |
| T5 | The seller empties the vault right before a buyer's purchase lands | `buy(token_id, expected_min_vault)` fails if the vault is lower; withdrawing while listed is refused (I5) | `buy_reverts_when_vault_below_expected`, `withdraw_refused_while_listed`, `transfer_refused_while_listed`, `sale_moves_vault_and_locks_out_seller` *(s)* | proven |
| T6 | A commission is on its way when the pass is sold, and lands with the wrong holder | Not possible: the commission is added in the same receipt as the mint; nothing is ever in transit to a holder | `commission_is_credited_in_mint_receipt` | proven |
| T7 | A withdrawal is sent, the pass is sold, the withdrawal fails, and the refund goes to the vault (a gift to the buyer) | The vault is reduced **before** sending; a failed payment is owed to the person it was for, never put back in the vault | `failed_withdraw_is_owed_to_withdrawer_not_vault` | proven |
| T8 | Withdrawing twice, or more than the vault | Reduce first, then send; one promise per call; overflow-checked maths | `double_withdraw_cannot_exceed_vault`, `withdraw_more_than_vault_is_refused`, `withdraw_requires_one_yocto` | proven |
| T9 | **A receiver contract withdraws, moves or lists the pass during `nft_transfer_call`, then hands it back** | The pass is locked from `nft_transfer_call` until `nft_resolve_transfer`; withdraw, list, transfer and burn are refused while locked | `receiver_cannot_{withdraw,transfer,list,burn}_during_transfer_call`, `malicious_receiver_cannot_touch_vault_during_transfer_call` *(s, real attacker contract)*; live on testnet: [deploy/attack-run.md](deploy/attack-run.md) | proven |
| T10 | The lock never clears, or the pass returns to the wrong place | Resolve uses the standard NEP-171 logic, then always clears the lock: returned, kept, or receiver panicked | `transfer_call_return_restores_owner_and_vault`, `transfer_call_lock_clears_when_receiver_panics`, `transfer_call_kept_moves_vault_rights_to_receiver`, `sender_cannot_withdraw_after_receiver_keeps_pass`, `receiver_that_keeps_pass_gets_the_vault` *(s)* | proven |
| T11 | Self-referral: minting with your own pass as referrer | `mint` refuses when the referrer pass's owner is the caller | `self_referral_is_refused`, `sale_moves_vault_and_locks_out_seller` *(s)* | proven |
| T12 | Referral through a pass that doesn't exist | `mint` refuses an unknown referrer | `unknown_referrer_is_refused` | proven |
| T13 | A private sale outside CrewPass, where the seller empties the vault first | No approvals, so nobody but the owner can move a pass. A buyer who pays outside CrewPass is trusting the seller; the README must say to buy only through `buy` | `no_approval_lets_a_stranger_move_a_pass`, `no_approval_methods_exposed` | open (documented) |
| T14 | The buyer pays the wrong amount, or the price changes while their purchase is in flight | `buy` requires exactly the listing price, or fails and returns the deposit | `buy_with_wrong_amount_reverts`, `sale_moves_vault_and_locks_out_seller` *(s)* | proven |
| T15 | The seller delists while a buyer's purchase is in flight; strangers delist | `buy` fails and returns the deposit; only the seller can delist | `buy_after_delist_reverts`, `stranger_cannot_delist`, `seller_cannot_buy_own_listing` | proven |
| T16 | The seller isn't paid, or is paid twice | Seller is paid price + listing deposit once; if that payment fails it is owed and claimable | `sale_moves_vault_and_locks_out_seller` *(s, exact balance check)*, `failed_sale_payout_is_owed_to_seller` + *(s, seller account deleted)* | proven |
| T17 | Storage costs drain the contract | Each mint's storage is measured and charged from the creator's share; listing storage is covered by the listing deposit; per-pass counters are fixed size | `commission_is_credited_in_mint_receipt`, `accounting().solvent` checked after every sandbox test | proven (small gaps: see open risks) |
| T18 | The admin changes the rules or takes vault money | No method lets anyone but the current holder touch a vault; no upgrade method; private callbacks are contract-only | `strangers_cannot_call_private_callbacks` *(s)*; key removal checked on testnet (Day 5) | proven / design |
| T19 | Burning a pass that still holds money | `burn` refuses unless the vault is zero | `burn_refused_with_nonzero_vault`, `burn_allowed_when_vault_empty`, `burn_only_with_empty_vault` *(s)* | proven |
| T20 | Fake or tampered history | Only the contract writes counters and events, in the same receipt as the action | Events visible in every sandbox test log; web check Day 7 | design |

## AI companion threats (added 2026-11-08)

The companion is server-side and read-only (no tools, no keys). Tests: `web/server/companion.test.ts`.

| # | Threat | How it's blocked | Tests | Status |
|---|---|---|---|---|
| C1 | A signed-in member uses another pass's companion | Every request re-reads `nft_token` (never cached) and requires `owner_id == session account` | `C1: a signed-in member cannot use the companion of a pass they do not hold` | proven |
| C2 | No or forged session | Same NEP-413 session and full-access key check as the members area | `C2: no session, no companion`, `members area refuses a missing, tampered or expired session` | proven |
| C3 | One holder reads another holder's memory | Memory key includes token and account; server only loads the caller's key | `C3: two holders never see each other's memory` | proven |
| C4 | Seller keeps using the companion, or buyer sees the seller's chats | Ownership re-checked per request; buyer's key is different, so their memory starts empty | `C4: after a transfer the seller is locked out and the buyer starts with empty memory` | proven |
| C5 | A seller cannot erase what they shared | Delete needs only the seller's own session, not current ownership | `C5: a seller can still delete what they told the companion` | proven |
| C6 | Memory readable or movable at rest | AES-256-GCM with the record key as associated data; tampered or moved values do not decrypt | `C6: memory is encrypted at rest and bound to its holder's key` | proven |
| C7 | Abuse or cost blow-up | 20 messages per 10 minutes per account (Upstash counter shared across instances); 1000-character messages | `C7: rate limit per account`, `messages are validated` | proven |
| C8 | Model failure corrupts memory, or leaks the API key | Nothing saved on failure; provider error text never shown; key redacted from logs | `C8: a failed model call saves nothing`, `OpenAI-compatible provider: …` | proven |
| C9 | Prompt injection through creator knowledge or member messages | Fixed system rules; knowledge and pass state quoted as data with closing tags neutralised; no tools, so the worst case is a wrong answer, never an action | `untrusted knowledge cannot close its data block` | partial: a model can still be talked into a wrong answer |
| C10 | Private chats used by the AI provider | Members see a notice before the first message; Gemini's free tier states it may use content to improve Google's products. A verified TEE provider is implemented, but live credentials/runtime are not configured | UI notice; provider fail-closed tests | open until live TEE provider is configured; default provider remains disclosed |

## Open risks (Day 2)

- **R1. Lock stuck if `nft_resolve_transfer` runs out of gas.** The standard library gives it a fixed 5 TGas. If it ever ran out, the pass would stay locked (no withdraw, no transfer) with no way to clear it. It fits comfortably today, but there is no admin escape hatch by design.
- **R2. Small storage the contract pays itself.** The lock entry during `nft_transfer_call` and an `owed` entry after a failed payment use a few bytes that nobody pre-pays. The contract needs a small reserve of its own (about 0.1 NEAR) on top of the deploy storage.
- **R3. Private sales (T13).** Nothing on chain can protect a buyer who pays a seller directly instead of using `buy`.
- **R4. Fake-account referrals.** One person with two accounts can still refer themselves. Not solvable without identity checks.
- **R5. Not audited.** Built and tested by us in two days; uses `near-contract-standards` 5.30.1 for the NEP-171 core.

## House of Stake (TLA) investigation: INCOMPLETE

CrewPass does not use House of Stake Top Level Accounts and does not depend on them. We looked at
them because the NFT track points to them. What we know, and how we know it:

| Claim | Evidence | Verified by running code? |
|---|---|---|
| A TLA name is a NEP-171 token that is also a keyless NEAR account, live on mainnet at `registry.hos` | `houseofstake/tla-contracts` source; mainnet RPC calls (`get_stats`, `nft_tokens`, code hashes) | Read-only mainnet calls only |
| On a sale, the name's NEAR balance is swept to the **seller**, and transfers are refused while the name holds allowlisted tokens | Source: `hos-wallet` `apply_rotation`, `tla-registry` `nft_transfer`; their test `a_sale_pays_the_sellers_balance_out_with_the_name` | **No** |
| The seller's control (extensions, spend grants) is removed on transfer | Source: `apply_rotation` | **No** |
| There is no House of Stake deployment on testnet | Testnet RPC: `hos` does not exist | Yes (read-only) |

`scripts/verify-hos.sh` builds their contracts at the mainnet commit (`bf0b65d`) and runs their own
transfer tests, first from source, then on the exact mainnet bytecode. **It has not completed.** On
2026-11-06 it built 6 of their contracts, then compiling their integration tests crashed WSL twice
(on a machine with about 8 GB for WSL). Until it runs to the end, everything in the "No" rows above is
from reading their code, not from executing it.

## Not claimed

- Stopping someone making fake accounts to refer themselves. T11 only stops a pass referring itself; anything more needs identity checks, which v1 doesn't have.
- Making a seller forget what was on the members-only page.
- That the members-only content can't be copied by someone who could see it while they held the pass.
- Any connection to House of Stake. It runs on mainnet only. CrewPass follows its idea (control, access and value move with the token) in its own contract. See "House of Stake (TLA) investigation: INCOMPLETE" above.

---

# V2 threat model: pass accounts, revenue, tickets, tiers

Written on 2026-11-12, **before** the V2 contracts, then updated with test results as each row was
proven. The design is in [docs/ADR-001-pass-accounts.md](docs/ADR-001-pass-accounts.md). The V1 rows
above still describe `crewpass.testnet`, which is unchanged.

Unit tests: `contract-v2/src/tests.rs` (59) and `pass-account/src/lib.rs` (9). Sandbox tests (compiled
wasm, real accounts, real global contract, nearcore 2.14): `contract-v2/tests/sandbox.rs` (11). Web tests:
`web/server/*.test.ts` (43). Run with `scripts/test-v2.sh` and `npm test` in `web/`.

**Live evidence on testnet:** [deploy/v2-live-run.md](deploy/v2-live-run.md) exercises A1, A2, A6 (listing),
A8, A9, F1, F5, F8, R1v2 and R2v2 with real transactions (29 steps, 0 unexpected).
[deploy/v2-web-check.md](deploy/v2-web-check.md) exercises P1–P4 with real NEP-413 sign-ins (12 checks,
0 unexpected).

**Found by the live check, fixed:** a ticket attached to a pass also kept opening the event for the buyer
after they sold the pass (one seat, two people). The access route now honours an attached ticket only for
the pass's current holder (P4).

## What V2 adds

- Every pass *N* has its own keyless NEAR account `N.<registry>` running shared, immutable code
  (a global contract attached by hash). Only the registry can instruct it; the registry only obeys the
  current NFT owner.
- Programmes (any creator), paid events and tickets, a per-programme reward pool that accrues to every
  pass and is paid into the pass accounts, a creator treasury.
- On-chain engagement (check-ins, achievements, referrals) → points → Bronze, Silver, Gold, Platinum,
  with NEP-171 `nft_metadata_update` events.
- An ownership epoch per pass, used to scope private companion memory.

## Rules V2 must keep

- **V1.** The pass account acts only on instructions from the registry; the registry only issues them
  for the current owner, checked in the receipt that accepts the request.
- **V2.** No access key ever exists on a pass account.
- **V3.** While an account operation, a sale listing or an `nft_transfer_call` is in progress, the pass
  cannot change owner or start another account operation.
- **V4.** Treasuries + reserved rewards + owed + listing deposits + pending mints, plus storage, never
  exceed the registry's balance (`accounting().solvent`).
- **V5.** Each unit of reward is credited once and paid once, only to the pass's own account.
- **V6.** Tiers and metadata change only through contract logic.

## Threats

*(s)* = sandbox test; *(web)* = web server test; others are unit tests.

| # | Threat | How it's blocked | Tests | Status |
|---|---|---|---|---|
| A1 | **Stolen or retained seller keys** operate the pass account after a sale | The account has no keys (V2). The seller's own wallet key only reaches the registry, which checks current ownership | `mint_creates_keyless_pass_account` *(s)*, `sale_moves_account_control_to_buyer` *(s)*, `old_owner_account_op_refused_after_sale` | proven |
| A2 | **Account takeover**: someone calls the pass account directly | Pass-account code accepts only its parent (the registry) as caller | `pass_account_rejects_everyone_but_registry` *(s)* | proven |
| A3 | **Unauthorised withdrawal** from a pass account | `account_transfer` / `account_call` require the current owner and 1 yoctoNEAR (full-access key) | `account_op_only_by_owner`, `account_op_requires_one_yocto` | proven |
| A4 | **Failed account association** leaves an NFT without an account, or keeps the minter's money | The NFT is minted only in the success callback; on failure the minter is refunded and the seed is owed | `mint_success_mints_nft_and_links_account`, `mint_failure_refunds_and_owes_seed`, `failed_account_creation_refunds_minter` *(s)* | proven |
| A5 | **Failed control transition** | No rotation step exists: control is the owner in the same receipt. Account operations in flight block transfers (V3) | `buy_moves_control_and_bumps_epoch`, `sale_moves_account_control_to_buyer` *(s)* | proven |
| A6 | **Async race: sale during a pending account operation** (seller starts a withdrawal, then sells before it lands) | Operation lock from the request receipt until `on_account_op`; transfer, list, buy and transfer_call refused while locked | `transfer_refused_during_account_op`, `list_refused_during_account_op`, `second_account_op_refused`, `sale_refused_while_account_op_pending` *(s)* | proven |
| A7 | **Lock never clears** (callback failure) | The callback runs on success and on failure; owner-only `clear_stale_lock` after `LOCK_TIMEOUT_BLOCKS` | `callback_clears_lock_on_failure`, `stale_lock_cleared_only_after_timeout_by_owner`, `failed_account_op_clears_lock` *(s)* | proven |
| A8 | **Malicious `nft_transfer_call` receiver** uses the pass account while it briefly owns the pass | The transfer-call lock (V1 T9) now also blocks account operations | `transfer_call_lock_blocks_account_ops`, `malicious_receiver_cannot_use_pass_account` *(s, real attacker contract)* | proven |
| A9 | **Pass frozen forever** by sending it to its own (or another) pass account | Mint, transfer, transfer_call and buy refuse any sub-account of the registry | `transfer_to_pass_account_refused`, `cannot_send_pass_to_a_pass_account` *(s)* | proven |
| A10 | **Re-entrancy through the pass account** (the account calls back into the registry mid-operation) | The account is an ordinary caller to the registry, owns no pass (A9), and the lock is on the token | `pass_account_cannot_operate_its_own_token` | proven |
| F1 | **Double claim of rewards** | Claim moves the pass's snapshot to the current index and lowers the reserved total before paying | `claim_rewards_pays_pass_account_once` | proven |
| F2 | **Over-allocation**: the pool pays out more than it received | Integer share per pass = amount ÷ active passes; the remainder is carried, never created | `ticket_split_and_reward_index`, `reward_remainder_is_carried_not_lost` | proven |
| F3 | **New members take past revenue** | A new pass starts at the current index | `new_pass_gets_no_past_revenue` | proven |
| F4 | **Unauthorised treasury distribution or withdrawal** | Only the programme creator may fund the pool or withdraw the treasury, never more than it holds; reduce first, owe on failure | `fund_rewards_creator_only`, `withdraw_treasury_creator_only_and_bounded` | proven |
| F5 | **Duplicate ticket purchase or check-in** | One ticket per (event, buyer) and per (event, pass); one check-in per ticket; capacity enforced | `duplicate_ticket_refused`, `capacity_enforced`, `double_check_in_refused` | proven |
| F6 | **Rewards land with the wrong holder after a sale** | Rewards accrue to the token and are only ever paid to the pass's own account; unclaimed rewards move with the token | `rewards_follow_token_on_sale`, `ticket_revenue_reaches_pass_account` *(s)* | proven |
| F7 | **Wrong amounts** (mint, ticket, sale) | Exact deposits required | `mint_requires_exact_price`, `ticket_requires_exact_price`, `buy_with_wrong_amount_refused` | proven |
| F8 | **Stale listing swap**: seller delists, empties the account, relists at the same price before the buyer's transaction lands | `buy` names the `listing_id`; every listing gets a new id. While listed, nothing can leave the account | `buy_with_stale_listing_id_refused`, `account_op_refused_while_listed` | proven |
| R1v2 | **Reward or tier manipulation** | Points come only from: creator check-in of a real ticket, a creator achievement (unique code, capped points), a successful referral mint. Self-referral refused | `check_in_requires_ticket_and_creator`, `achievement_unique_and_capped`, `self_referral_refused` | proven (Sybil referrals stay open) |
| R2v2 | **Tier decided by the front end** | Tier is computed only in the contract from points; the site reads `pass_info` | `tier_thresholds_and_metadata_update`, `tier_upgrade_updates_metadata` *(s)* | proven |
| S1 | **Storage exhaustion** | Whoever adds storage pays for it: programme and event creation, check-ins and achievements are measured and charged to the caller (excess refunded); passes and tickets are charged from the creator share; minimum prices enforced | `storage_is_charged_to_the_caller`, `accounting_solvent_after_flows`; solvency checked after every sandbox test | proven |
| C11 | **Creator compromise** | A creator can only create events, check in, award capped achievements, fund the pool and withdraw their own treasury. No creator method touches pass accounts or other programmes | `creator_cannot_touch_other_programme`, `creator_cannot_operate_pass_account` | proven |
| U1 | **Registry upgrade / admin key** | No upgrade or admin method in the code; pass-account code attached by immutable hash. **The registry's full-access key is intentionally retained on testnet until an independent security review** and could redeploy the registry, which would compromise every pass account if stolen | — | **open** (remove after review, before any production use) |
| P1 | **Private memory leaks to the buyer, or back to a seller who buys the pass again** | Memory key = contract + token + **owner epoch** + account; the epoch increases on every ownership change | `companion memory is scoped to the ownership epoch` *(web)* | proven |
| P2 | **Sign-in replay across server instances** | Nonces recorded in the shared store (Upstash) when configured | `a nonce used on one instance is refused on another` *(web)* | proven |
| P3 | **A cached session outlives a sale** | Every gated request re-reads ownership on chain and fails closed | `old_owner_gets_403_after_sale`, `V2 access ends on the next request after a sale, even with a live session`, `V2 fails closed when the chain cannot be read` *(web)* | proven |
| P4 | **A seller keeps event access through a ticket they attached to the pass** | An attached ticket opens the event only for the pass's current holder; a visitor ticket only for its buyer | `a ticket the seller bought for their pass opens the event only for the pass's current holder` *(web)*; live: [v2-web-check](deploy/v2-web-check.md) | proven |
| P5 | **Higher-tier content leaks to lower tiers** | Server sends locked posts without their body; tier read from the chain | `members content is gated by the on-chain tier` *(web)* | proven |
| P6 | **Non-creator opens a creator dashboard** | Session account must equal the programme's creator on chain | `creator dashboard is for the programme's creator only` *(web)* | proven |
| F9 | **Campaign budget is overclaimed or stranded** | Each pass has a permanent one-time marker; tier and active dates are checked on chain; budget and claim storage are reserved up front; unused funds can be reclaimed after expiry or the claim cap; failed pass payouts remain claimable | `campaign_is_tier_gated_one_time_and_accounted`, `campaign_failed_payout_can_be_retried_without_pool_accounting_damage`, `expired_campaign_releases_unused_budget` | proven; deployed on testnet |
| F10 | **Resale royalty is omitted or transfer leaves seller as controller** | `nft_payout` returns the fixed 5% creator payout; `nft_transfer_payout` transfers and changes the owner epoch in the same receipt; CrewPass `buy` pays creator and seller itself; payout fails if `max_len_payout` cannot hold the full map | `nep199_payout_splits_creator_and_seller_and_transfer_changes_owner` | proven; deployed on testnet; external marketplaces must send the returned payouts |
| S2 | **Creator stores oversized or malformed content** | Only the programme creator can update it; field counts and byte lengths are bounded; measured storage is charged to that creator; the server gates post bodies using the on-chain tier | `creator_content_is_persisted_and_creator_only`, `members content is gated by the on-chain tier` *(web)* | proven; deployed on testnet |
| C12 | **Unverified or insecure AI endpoint receives a TEE request** | TEE mode requires an HTTPS endpoint, E2EE request, verified model and `provider_tee` response signature; replies fail closed before being saved or shown | `provider configuration selects verified TEE and stays offline without required settings`, `C8: a failed model call saves nothing` *(web)* | implementation proven by tests; live provider verification pending |

## V2 open risks

- **U1**: the registry's full-access key (see the table).
- **Lock timeout** (A7): if a callback failed and the owner cleared the lock early while a receipt was
  still pending, that receipt could still run. NEAR receipts settle within a few blocks; the timeout is
  far longer.
- **Sybil referrals** (R4) as in V1.
- **Creator trust**: check-ins and achievements are attested by the creator (achievement points capped).
- **Not audited.**
- Royalty, creator-content, and campaign controls are deployed on testnet. Existing programme/NFT reads and accounting were checked after the upgrade; deployment evidence is in [v2-upgrade-2026-11-14.json](deploy/v2-upgrade-2026-11-14.json). The live TEE provider remains unverified because credentials/runtime are not configured.
