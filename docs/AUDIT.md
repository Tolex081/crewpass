# CrewPass V2: audit against the brief and Track 10

Checked on 2026-11-13 against the "CrewPass V2: complete architectural redesign" brief and the Track 10 page
(*NFTs That Do Something*: "Build NFTs as accounts — assets that own money, earn royalties, hold inventory,
carry credentials, memberships or access rights. Ownership with behavior." Tags: dynamic NFTs, NEP-171,
sub-accounts).

Status key: **met** = implemented, deployed on testnet and tested · **partial** = works with a stated limit ·
**not met** = not done, with the reason.

## Evidence used

| Evidence | Result |
|---|---|
| `scripts/test-v2.sh` (unit) | 59 registry + 9 pass-account tests, all pass |
| `scripts/test-v2.sh` (sandbox, nearcore 2.14, real global contract) | 11 tests, all pass |
| `npm test` in `web/` | 43 tests, all pass |
| `scripts/test.sh` (V1) | 36 unit pass this session; 6 sandbox passed in this session's baseline run; V1 code unchanged |
| [deploy/v2-live-run.md](../deploy/v2-live-run.md) | 29 testnet transactions, 0 unexpected |
| [deploy/v2-web-check.md](../deploy/v2-web-check.md) | 12 checks with real NEP-413 sign-ins, 0 unexpected (after fixing the bug it found, see THREAT_MODEL P4) |
| Deployed code | `crewpass-v2.testnet` code hash `GadRMbaD…3nYA` = sha256 `e77ca695…0e5853` of the local build; pass accounts use global hash `CuX7PYtW…EzRL` = sha256 `b0e4cdcd…a921f` |
| Browser check | Every V2 page loaded against testnet with no console errors; no horizontal scroll at 375 px |

## Track 10

| Track asks for | CrewPass V2 | Status |
|---|---|---|
| NFTs as accounts | Every pass is a NEP-171 token **and** the keyless account `N.crewpass-v2.testnet` | met |
| Own money | The account holds real NEAR (pass #1: 0.03 NEAR after the run), visible in any explorer | met |
| Earn | Ticket revenue share, creator-funded rewards and referral commissions are paid into the pass account | met (no NEP-199 resale royalty yet) |
| Hold inventory | The account can call any contract as itself (live: `record` saw `caller: 1.crewpass-v2.testnet`), so it can register with and hold FTs/NFTs | met (FT/NFT holding not demonstrated live) |
| Carry credentials / memberships / access | Tier, points, achievements, check-ins on chain; members area, event access and companion gated by current ownership | met |
| Ownership with behaviour | Control of the account, rewards, tier and access move with the token in the same receipt; seller locked out | met |
| Tag: dynamic NFTs | NEP-177 metadata (title, on-chain SVG, `extra`) rewritten on every points change; NEP-171 v1.2.0 `nft_metadata_update` | met |
| Tag: NEP-171 | Core + NEP-177 metadata + NEP-181 enumeration + NEP-297 events; approvals deliberately off | met |
| Tag: sub-accounts | Pass accounts are sub-accounts of the registry, created at mint | met |

## The brief, section by section

### §3 Account architecture
| Requirement | Status | Where |
|---|---|---|
| Research TLAs, HoS contracts, NEP-641, NEP-171, access keys, async receipts | met | [ADR-001](ADR-001-pass-accounts.md) "What we checked" |
| Do not assume mainnet contracts on testnet | met | ADR: `hos` does not exist on testnet (RPC) |
| Evaluate A (keyless + rotation), B (factory + control contract), C (account abstraction) | met | ADR options A, A′, A″, B (chosen), C, V1 |
| Unique, permanent association | met | sub-account named by token id; ids never reused; no burn in V2 |
| Real NEAR independent of internal accounting | met | live: account balance in explorer |
| Current owner is controller; previous holders have no route | met | A1, A2, A3; live rows 20–24 |
| Can hold and interact with assets and apps | met | `account_call`; live row 26 |
| Secure update on sale or transfer | met | same-receipt control; `control_changed` event; A5 |
| Recovery and failure scenarios | partial | failed creation refunds (A4); stale-lock backstop (A7); lost owner key = lost pass by design; registry key is the trust root (U1) |
| No ordinary key for the owner | met | 0 access keys (sandbox and live) |
| No false atomicity claims | met | ADR states the lock spans several receipts; control change itself is one receipt |
| Async transfer state machine with locks and failure handling | met | ADR state diagram; A6, A7, A8 |

### §4 Financial and revenue engine
| Requirement | Status | Where |
|---|---|---|
| Real balances, deposit, withdrawal, controller check, history | met | account balance (anyone can send NEAR in); `account_transfer`; events |
| Programme treasury and allocation rules | met | `member_share_bps`, `referral_bps`, treasury per programme |
| Creator-funded reward budgets | partial | `fund_rewards` funds the whole pool; campaigns with conditions and expiry are planned |
| Reserved / distributed / claimed accounting | met | `reserved`, `distributed_total`, `claimed_total`, `carry`; `accounting()` |
| Paid events, tickets, distribution by rules, verifiable allocation | met | `create_event`, `buy_ticket`, `revenue_distributed` events |
| No double claims, over-allocation, unauthorised distributions | met | F1, F2, F4 |
| Referrals optional, into the NFT account, no self-referral, Sybil documented | met | `referral_bps` may be 0; F-rows; R4 open |
| All backed by contract operations | met | no front-end simulation |

### §5 Dynamic NFT and evolution
| Requirement | Status |
|---|---|
| Bronze → Silver → Gold → Platinum from verifiable inputs | met (check-ins, achievements, referrals) |
| Engagement stored on chain, tiers enforced by contract | met |
| Metadata updates + NEP-171 `nft_metadata_update` | met (live rows 12–13) |
| History kept with the NFT; progression moves on sale | met (`progression_moves_with_the_pass`; live: Carol's pass is Gold) |
| Front end never decides tiers | met (R2v2) |

### §6 Transfer and security engine
| Requirement | Status |
|---|---|
| Explicit transfer state machine | met (ADR diagram, `assert_idle`) |
| Prevent withdrawals, control conflicts, concurrent listings/transfers before completion | met (A6, F8) |
| Pending financial operations settle | met (claims always pay the pass account; account ops lock; failed payouts owed) |
| Failed transfer leaves ownership consistent | met (transfer_call resolve; callbacks on failure) |
| After transfer: buyer controls, seller cannot operate or access, buyer inherits, private chats stay private | met (live + web check) |
| Keep hostile receiver protection | met (A8, live rows 28–29) |
| Threat model expanded before implementation, each threat with mitigation and test | met (THREAT_MODEL V2 section written 2026-11-12 before the code; all rows now proven or marked open) |

### §7 Membership access
| Requirement | Status |
|---|---|
| Current-owner verification, members-only content, multiple passes, programme-specific benefits | met |
| Event access verification | met (`/v2/events/:id/access`, P4) |
| Immediate loss after sale; fail closed; sessions never override chain | met (P3) |

### §8 AI companion
| Requirement | Status |
|---|---|
| Knows programme, tier, achievements, account balance, earnings, rewards, events, benefits | met |
| Memory private per holder **and ownership epoch** | met (P1) |
| Encryption, rate limit, provider disclosure, ownership checks, no transactions | met (C-rows) |

### §9 Transparent history
| Requirement | Status |
|---|---|
| Mint, ownership, account association and control changes, deposits, distributions, ticket earnings, withdrawals, claims, achievements, metadata updates | met (all emitted as NEP-297 events and shown on the pass and rewards pages) |
| All records, not just the first page | met: NearBlocks v3 `next_page` cursor, up to 20 × 100 transactions |
| Incomplete history is labelled | met ("Incomplete" chip and note) |
| Proof links real transactions, nothing fabricated | met (proof data generated from the live-run file) |

Incoming NEAR sent to a pass account by others (not through the registry) is visible as the account balance, but it is not listed in the history.

### §10 Web application
| Section | Status |
|---|---|
| Landing, Discover, Programme, My passes, Pass, Events, Rewards, Members, Creator, Proof | met |
| Real vs simulated distinguishable; no dead buttons | met: every button is a contract call or a gated API call; demo programme content is labelled; V1 is labelled as an archive |
| Live deployment of the V2 site | **not yet**: the code is committed locally; Vercel deploys on push to GitHub |

### §11 Implementation rules
| Rule | Status |
|---|---|
| Inspect, run existing tests, baseline | met (V1 36 + 6, web 26 at start) |
| ADR and V2 plan | met (ADR-001; plan = this audit's structure plus PRODUCT §11) |
| Rust + near-sdk, keep React/TS, NEAR wallet, decisions on chain | met |
| Reproducible builds and recorded hashes | partial: hashes recorded and matched against the chain; Docker reproducible build not run |
| No new unvetted dependencies | met: no new runtime dependencies (near-sdk's own base64 re-export used in tests) |
| V1 untouched; V2 on new accounts; no secrets committed | met |

### §12 Testing
| Required | Status |
|---|---|
| Unit: minting, association, revenue, withdrawal, tickets, claims, tiers, metadata, transfer restrictions | met (59 + 9) |
| Sandbox: compiled execution, real control rotation, sale with real assets, old owner refused, buyer controls, sale during pending op, failed transition, malicious receiver, solvency after each | met (11, solvency asserted in each). The "failed transition" is a failed account creation; ownership change itself has no separate step that could fail |
| Web: auth, ownership, cross-instance replay, revocation, memory isolation, creator permissions | met (43) |
| End-to-end, steps 1–12 | met on testnet by `deploy/v2-live-run.sh` + `web/scripts/v2-web-check.ts`. Not a browser-automated wallet test (a real wallet UI cannot be driven headlessly here) |

## Open items (honest list)

1. **Registry full-access key** still on `crewpass-v2.testnet` (U1). Remove it before any real use.
2. **Site not redeployed** with V2 until the commit is pushed.
3. **Cross-instance replay protection** depends on Upstash being configured on Vercel. It is used for companion memory there, but this audit did not inspect the Vercel settings.
4. **Builds are not Docker-reproducible** (hashes recorded and matched).
5. **Not yet built:**
   - campaigns with conditions and expiry;
   - NEP-199 royalties;
   - creator-editable content;
   - a private AI provider.
6. **House of Stake:** the verification script is still incomplete. HoS is not used.
