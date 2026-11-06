# CrewPass threat model

Written before any contract code, as the NFT track asks. Every row names the test that must prove
it. A row is only "done" when that test passes in the local sandbox and the same step has been run
on testnet.

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
| Rest of the mint price | Creator's balance, which the creator withdraws themselves |
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

| # | Threat | How it's blocked | Test |
|---|---|---|---|
| T1 | The seller withdraws from the vault after selling | `withdraw` checks the **current** owner in the same receipt it pays from | `old_owner_cannot_withdraw_after_sale` |
| T2 | The seller transfers the pass again after the sale | Standard NEP-171 owner check | `old_owner_cannot_transfer_after_sale` |
| T3 | The seller keeps opening the members-only page | The server checks `nft_token` owner **on every request**, never a stored login | `old_owner_gets_403_after_sale` (web) |
| T4 | Someone replays the seller's old sign-in | NEP-413 message with nonce + 5-minute expiry; each nonce is accepted once | `replayed_signin_is_refused` (web) |
| T5 | The seller empties the vault right before a buyer's purchase lands | `buy(token_id, expected_min_vault)` fails if the vault is lower; withdrawing while listed is refused (I5) | `buy_reverts_when_vault_below_expected`, `withdraw_refused_while_listed` |
| T6 | A commission is on its way when the pass is sold, and lands with the wrong holder | Not possible: the commission is added in the same receipt as the mint, and nothing is ever in transit to a holder | `commission_is_credited_in_mint_receipt` |
| T7 | A withdrawal is sent, then the pass is sold, then the withdrawal fails and the refund goes back into the vault, a gift to the buyer | The vault is reduced **before** sending; if sending fails, the money is recorded as owed to the person who withdrew, never put back in the vault | `failed_withdraw_is_owed_to_withdrawer_not_vault` |
| T8 | Withdrawing twice or re-entering withdraw | Reduce first, then send (checks-effects-interactions); one promise per call; overflow-checked maths | `double_withdraw_cannot_exceed_vault` |
| T9 | **A receiver contract withdraws during `nft_transfer_call`, then hands the pass back** | The pass is marked "transfer in progress" from `nft_transfer_call` until `nft_resolve_transfer`; withdraw, list, transfer and burn are refused while it is set | `receiver_cannot_withdraw_during_transfer_call` |
| T10 | A receiver keeps the pass but makes `nft_resolve_transfer` look like it was returned | Standard NEP-171 resolve logic: only give the pass back if the receiver still owns it | `transfer_call_return_restores_owner_and_vault` |
| T11 | Self-referral: minting with your own pass as referrer | `mint` refuses when the referrer pass's owner is the caller | `self_referral_is_refused` |
| T12 | Referral through a pass that doesn't exist or is in the middle of a transfer | `mint` refuses an unknown referrer; a commission to a pass with a transfer in progress is still allowed, because it is stored against the pass, not a person | `unknown_referrer_is_refused` |
| T13 | A private sale outside CrewPass, where the seller empties the vault first | No approvals, so nobody but the owner can move a pass. A buyer who pays outside CrewPass is trusting the seller; the README says to buy only through `buy` | Documented risk, `no_approval_methods_exposed` |
| T14 | The buyer pays the wrong amount, or the price changes while their purchase is in flight | `buy` requires the attached amount to equal the current listing price exactly, or it fails and the deposit is returned | `buy_with_wrong_amount_reverts` |
| T15 | The seller delists while a buyer's purchase is in flight | `buy` fails, the deposit is returned | `buy_after_delist_reverts` |
| T16 | The seller isn't paid, or is paid twice | Sale proceeds are added to the seller's balance in the same receipt as the transfer; the seller withdraws them separately (pull payment) | `sale_credits_seller_exactly_once` |
| T17 | Storage costs drain the contract | Mint price covers storage; `buy` takes a small storage deposit; history per pass is capped | `mint_covers_storage`, `history_is_capped` |
| T18 | The admin changes the rules or takes vault money | No admin method touches vaults; no upgrade method; full-access key removed after deploy | `creator_cannot_touch_vaults`, check the deploy key on chain |
| T19 | Burning a pass that still holds money | `burn` refuses unless the vault is zero | `burn_refused_with_nonzero_vault` |
| T20 | Fake or tampered history | History is written only by the contract, in the same receipt as the event; the page reads it from the chain | `history_records_mint_commission_sale_withdraw` |

## Not claimed

- Stopping someone making fake accounts to refer themselves. T11 only stops a pass referring itself; anything more needs identity checks, which v1 doesn't have.
- Making a seller forget what was on the members-only page.
- That the members-only content can't be copied by someone who could see it while they held the pass.
- Any connection to House of Stake. It runs on mainnet only. CrewPass follows its idea (control, access and value move with the token) in its own contract.
