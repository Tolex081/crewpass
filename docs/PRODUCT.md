# CrewPass: product and architecture (V2)

Master product document. [README.md](../README.md) is the quick start, [ADR-001](ADR-001-pass-accounts.md) the
account design, [THREAT_MODEL.md](../THREAT_MODEL.md) the security record, [AUDIT.md](AUDIT.md) the check against
the brief. Every feature below is marked **built** (deployed on testnet and tested), **partial** or **planned**.

Last updated: 2026-11-14. The V2 additions described below are deployed to testnet. Contract unit and sandbox checks pass; TEE credentials/runtime, a clean Docker reproducible build, and an external security audit remain outstanding.

---

## 1. Product

**CrewPass is a membership protocol on NEAR where each membership NFT owns its financial position.**
A creator launches a programme. Members mint passes. Every pass is a NEP-171 token **and** its own keyless
NEAR account. The pass earns from the programme's activity, carries verifiable achievements, evolves
from Bronze to Platinum, opens members-only benefits and a private AI companion, and transfers all of it
(account control included) to its next owner.

It is not a marketplace, a dashboard or a chatbot with an NFT attached. The NFT is the authoritative credential;
the server never decides ownership, money or tiers.

### The parts

| Part | What it is | Status |
|---|---|---|
| Pass account | `N.<registry>`: keyless, immutable shared code (global contract by hash), obeys only the registry | **built** |
| Registry | NEP-171/177/181/297 contract: passes, account control, programmes, events, rewards, tiers, sales | **built** |
| Revenue engine | Ticket split → reward pool (O(1) index) → claims into pass accounts; creator-funded rewards; creator treasury; referrals into pass accounts | **built** |
| Evolution engine | On-chain points from check-ins, achievements and referrals → Bronze/Silver/Gold/Platinum, NEP-177 metadata + `nft_metadata_update` | **built** |
| Transfer engine | Locks for account operations, listings and `nft_transfer_call`; listing ids; owner epoch | **built** |
| Members area | Server checks current owner and tier on chain on every request; content above the tier is not sent | **built** |
| AI companion | Read-only, knows tier, account, rewards and events; memory encrypted per holder **and ownership epoch** | **built** |
| Web app | Landing, Discover, Programme, My passes, Pass, Events, Rewards, Members, Creator, Proof, V1 archive | **built** |

## 2. Roles and journeys

**Creator.** Launches a programme (`create_programme`: price, referral %, member share of tickets, optional
supply cap), creates events, checks in ticket holders, awards achievements (≤ 50 points, unique code),
funds the reward pool, withdraws the treasury. Everything from the Creator page; the page opens only for the
programme's creator, verified on chain.

**Member.** Mints (optionally with a referral link), sees the pass's own account on its page, buys tickets with
the pass attached, claims rewards into the pass account, withdraws from the account or makes it call other
contracts, signs in to the members area and companion, lists and sells.

**Buyer.** Buys a listed pass naming the listing id; gets the pass, control of its account and balance, its
unclaimed rewards, tier, achievements and history. Starts a fresh, empty companion memory.

**Visitor.** Browses everything public and can buy a visitor ticket.

## 3. Account architecture

See [ADR-001](ADR-001-pass-accounts.md) for the options evaluated (House of Stake TLAs, controller rotation,
keys for holders, deterministic accounts) and why they were rejected.

- Mint: the registry sends one batch receipt to `N.<registry>`: `CreateAccount` + `UseGlobalContract(hash)` +
  `Transfer(0.01 NEAR seed)`. The NFT is minted only in the success callback. On failure, the minter gets back
  `price − seed` at once, and the seed is recorded as owed until NEAR's refund lands.
- The pass-account code has two methods, `execute_transfer` and `execute_call`. Both use Borsh arguments,
  and only the account's parent may call them. It holds no state. It is 43.6 KB, published once (about 4.4 testnet NEAR burned).
- The registry methods `account_transfer` and `account_call` require the current owner and 1 yoctoNEAR. They lock the
  pass, forward the request, and unlock in `on_account_op` (success or failure). Forwarded gas is capped at 150 TGas.
- Pass accounts can never hold passes: that would freeze them.

## 4. Money

| Flow | Rule | Where it ends |
|---|---|---|
| Mint price | exact; seed → pass account; referral % → referrer pass account; rest − measured storage → treasury | real NEAR / treasury |
| Ticket | exact price; member share → pool; rest − measured storage → treasury | pool / treasury |
| Resale | CrewPass `buy` pays a fixed 5% creator royalty and the balance to seller; NEP-199 returns the same split to integrating marketplaces | creator / seller |
| Pool | `per_pass = (amount + carry) / active_passes`, remainder carried; new passes start at the current index | accrued per pass |
| Claim | anyone may call; pays the pass's accrued amount into the pass account; failure keeps it on the pass | real NEAR |
| Treasury | creator only, never more than held, reduce first, owed on failure | creator wallet |
| Accounting | `accounting()` = balance vs treasury + reserved + carry + owed + listing deposits + pending mints + storage | `solvent` must be true |

No dividends, yield or promise of appreciation are offered. Referral and ticket shares are programme rules.

## 5. Tiers

| Tier | Points |
|---|---|
| Bronze | 0 |
| Silver | 30 |
| Gold | 80 |
| Platinum | 150 |

Points: 10 per successful referral, the event's points (≤ 50) on creator check-in of a ticket attached to the
pass, creator achievements (1–50, unique code per pass). On every change, the registry rewrites the token's NEP-177
metadata (title `… · Gold`, on-chain SVG `media`, `extra` JSON with tier and points) and logs NEP-171 v1.2.0
`nft_metadata_update`. Progress belongs to the token and moves with it.

## 6. On-chain and off-chain boundaries

| Fact | Authority |
|---|---|
| Owner, account control, balances, rewards, tiers, tickets, check-ins | Registry contract (testnet) |
| Account balance and keys | NEAR protocol (`view_account`, `view_access_key_list`) |
| Programme posts, benefit wording, companion knowledge | Creator-managed content stored by the registry; curated catalogue remains as a fallback |
| Companion memory | Encrypted store keyed by contract + token + owner epoch + account |
| Sessions | HMAC tokens, 15 minutes; never override on-chain ownership |
| Sign-in nonces | Single use; shared across instances through Upstash when configured |

Every gated request reads the chain fresh and **fails closed** (502) if it cannot.

## 7. Exact transfer behaviour

**Same receipt as the ownership change** (`nft_transfer`, `buy`, or the kept branch of `nft_resolve_transfer`):
the new owner becomes the only account that can operate the pass account, list or move the pass. `owner_epoch`
increases, and a `control_changed` event names the old and new controller. Unclaimed rewards, tier, achievements and
tickets attached to the pass stay with the token.

**Before it can happen:** no account operation, listing or transfer call may be in flight (V3). An in-flight
reward claim pays the pass account whoever owns it, so it needs no lock.

**Next request off chain:** the seller gets 403 from members, companion and event access, even with a live session. The buyer
gets the members content for the pass's tier and an empty companion memory (new epoch). The seller can still
delete their own memory for every epoch they had.

## 8. AI companion

Read-only, no tools and no keys. It knows the programme content, the pass's tier, points, next tier, account
balance, rewards waiting, referral earnings, open events, and the member's own conversation during the current ownership
epoch. It never moves funds; it names the button to press. The default provider is any OpenAI-compatible API set by
environment variables. An optional provider interface supports verified providers; the first integration is NEAR AI
Cloud's E2EE SDK with TEE response verification and fails closed when its proof is missing or invalid. Without a model,
an offline mode answers from the same facts and says so. Rate limited to 20 messages per 10 minutes. AES-256-GCM at
rest. The provider is disclosed before the first message. TEE mode still relies on the site to protect API credentials
and encrypted chat history.

## 9. Security

[THREAT_MODEL.md](../THREAT_MODEL.md) lists every V2 threat with its mitigation and test. Main open risks:
- the registry's full-access key (U1);
- the lock timeout backstop;
- Sybil referrals;
- creator-attested check-ins and achievements;
- no audit.

## 10. Environment variables (web)

| Name | Purpose |
|---|---|
| `CREWPASS_V2_CONTRACT` | V2 registry, default `crewpass-v2.testnet` |
| `CREWPASS_CONTRACT` | V1 contract for the archive, default `crewpass.testnet` |
| `SESSION_SECRET` | Signs nonces and sessions (32+ characters) |
| `MEMORY_ENCRYPTION_KEY` | 32 bytes hex/base64 for companion memory |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` (or `KV_REST_API_*`) | Memory, rate limits and **cross-instance nonce replay protection** |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_DATA_NOTICE` | Companion model (optional) |
| `AI_PROVIDER=nearai-tee`, `NEARAI_API_KEY`, `NEARAI_BASE_URL`, `AI_MODEL` | Optional verified NEAR AI TEE provider; server runtime must be Node 24.22.1 or newer |
| `NEP413_RECIPIENT` | Site name bound into sign-in signatures |
| `NEAR_RPC_URL`, `NEARBLOCKS_URL` | Overrides |

## 11. Built, partial, planned

| Item | Status |
|---|---|
| Keyless pass accounts via global contract, registry control, lock state machine | built |
| Programmes, events, tickets, reward pool, claims, treasury, referrals into accounts | built |
| Tiers, achievements, check-ins, dynamic metadata + `nft_metadata_update` | built |
| Members area with tier gating, event access verification, creator dashboard | built |
| Companion with ownership-epoch memory | built |
| Paged, complete-or-flagged history from NearBlocks v3 | built |
| Reproducible (Docker) builds | partial: non-reproducible builds with recorded sha256 |
| Removing the registry's full-access key | retained on testnet until independent security review; remove after review before any production use |
| NEP-199 resale royalties | deployed on testnet: fixed 5% creator payout; contract unit tests pass |
| Creator-editable member content | deployed on testnet: on-chain content editor with tier-gated member posts; contract and web tests pass |
| Creator-funded campaigns with conditions and expiry | deployed on testnet: per-pass claim, minimum tier, dates, bounded claims, reserved budget, and reclaim; contract tests pass |
| Private (TEE) AI provider | code deployed with the registry/web integration; provider-agnostic interface and verified NEAR AI integration implemented; live provider credentials/runtime verification pending |

The creator royalty is fixed at 5% in this implementation. NEP-199-compatible marketplaces receive a payout map but must execute those payments themselves; only CrewPass's own sale method guarantees payment. The testnet upgrade preserved the existing programme/pass state and pass-account code hash. The registry's full-access key remains a separate final security action after review.

Dependency review: the pinned Hono packages were updated to patched same-major releases. `npm audit` still reports three low-severity paths through `elliptic` in NEAR AI's DCAP verifier, with no upstream fixed version. CrewPass uses the SDK's Node entrypoint, whose verifier selects Node's built-in crypto implementation; keep the SDK on the server and recheck this advisory when the upstream dependency changes ([GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)).
