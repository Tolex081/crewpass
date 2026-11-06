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
| T9 | **A receiver contract withdraws, moves or lists the pass during `nft_transfer_call`, then hands it back** | The pass is locked from `nft_transfer_call` until `nft_resolve_transfer`; withdraw, list, transfer and burn are refused while locked | `receiver_cannot_{withdraw,transfer,list,burn}_during_transfer_call`, `malicious_receiver_cannot_touch_vault_during_transfer_call` *(s, real attacker contract)* | proven |
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
