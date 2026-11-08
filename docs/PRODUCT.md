# CrewPass: Living AI Membership on NEAR

Master product and architecture document. It replaces nothing else: [README.md](../README.md) is the
quick start, [THREAT_MODEL.md](../THREAT_MODEL.md) is the security record, [web/README.md](../web/README.md)
covers the web server. Every feature below is marked **built**, **partial** or **planned**.

Last updated: 2026-11-08.

---

## 1. Product

**CrewPass is a membership platform on NEAR.** A creator or organisation runs a membership programme.
Each member holds a NEP-171 NFT, the **pass**, that proves current membership, opens real benefits
and gives access to a personal **AI companion**. The pass can evolve through meaningful engagement.
Where the programme allows transfer, the pass carries its token-bound state and rewards to the new
owner, and nothing private about the previous owner.

**Promise:** one pass, a membership that evolves, an AI companion that makes it useful.

**Pilot vertical:** a learning community (lessons, live sessions, a study group). The programme
model stays generic; the pilot only supplies demo content.

### The four parts

| Part | What it is | Status |
|---|---|---|
| Living Pass | NEP-171 NFT, ownership and membership credential | **built** (contract v1) |
| AI Companion | Holder-only assistant using creator knowledge, live pass state and the holder's private memory | **built in this slice** (see §6) |
| Evolution Engine | Verifiable engagement rules that move a pass through Bronze, Silver, Gold | **planned** (needs contract v2, §9) |
| Membership Vault | Per-pass reward ledger inside the contract | **built** for referral commissions; creator-funded campaigns **planned** |

The NFT does not run an AI model. The contract holds ownership and membership state; the AI runs in
the web server and checks the chain before every gated request.

---

## 2. Roles and journeys

**Creator / programme admin.** Today (v1): one programme per contract, configured at deploy time
(price, referral share); mint income is claimed with `claim`. Planned: programme profile, fixed supply,
transfer policy, tiers, engagement actions, knowledge base and funded campaigns, all from a creator page.

**Member / current holder.** Built: mint (optionally through a referral link), sign in with NEP-413,
open the members area, chat with the companion, withdraw the pass vault, list and sell the pass.

**Visitor.** Built: browse passes, pass history and the proof page. No holder content, no companion.

---

## 3. Audit of the repository against the brief (2026-11-08)

### What works (verified)

| Area | Files | Evidence |
|---|---|---|
| NEP-171 core, NEP-177 metadata, NEP-181 enumeration, NEP-297 events | `contract/src/lib.rs` (near-sdk 5.30.1, near-contract-standards 5.30.1) | 36 unit tests pass (run 2026-11-07) |
| Per-pass vault: credit, withdraw, owed-on-failure, solvency view | `contract/src/lib.rs` `withdraw`, `claim`, `on_payout`, `accounting` | unit + sandbox tests; live run on testnet |
| `nft_transfer_call` lock against receiver drain (T9) | `contract/src/lib.rs` `nft_transfer_call` / `nft_resolve_transfer` | sandbox attacker test; live attack on testnet ([deploy/attack-run.md](../deploy/attack-run.md)) |
| Sale with `expected_min_vault`, seller lock-out | `list`, `delist`, `buy` | live run ([deploy/live-run.md](../deploy/live-run.md)) |
| No approvals (only the owner moves a pass) | `NonFungibleToken::new(..., None)` | unit tests |
| NEP-413 sign-in, single-use nonces, 15-minute sessions | `web/server/nep413.ts`, `tokens.ts`, `app.ts` | 12 server tests, signatures cross-checked with near-api-js |
| Members area re-checks ownership on every request, never cached | `web/server/app.ts` `/members` | test `old_owner_gets_403_after_sale` |
| Pass history from chain events | `web/server/near.ts` `recentEvents` | live smoke test |
| Hosting | `web/api/index.ts`, `web/vercel.json` | live at crewpass-steel.vercel.app |

### What is incomplete or unsafe for the new direction

| Gap | Why it matters | Plan |
|---|---|---|
| **No supply cap.** `mint` is unlimited. | Brief §7 requires a fixed, disclosed maximum supply. | Contract v2 (§9) |
| **No transfer switch.** Every pass is transferable. | Brief §12: a non-transferable programme must be enforced in the contract. | Contract v2 |
| **No tiers or engagement state on chain.** | Evolution Engine and dynamic metadata need token-bound state. | Contract v2 |
| **Metadata never changes;** no `nft_metadata_update` event. | Brief §16. | Contract v2 |
| **Referral commission is the only reward.** | Brief §11: it may stay as an optional legacy mechanism, not the central promise. Copy on the site still leads with it. | Keep the mechanism; re-word the site; add creator-funded campaigns in v2 |
| **Members content is hard-coded** (`web/server/members-content.ts`). | Brief §8 wants creator-managed knowledge. | This slice moves it into a programme config file; a creator editor is planned |
| **Nonce single-use is per server instance.** | A captured sign-in could be replayed on another Vercel instance within 5 minutes. | Use the Upstash store for nonces too (small follow-up) |
| **NEP-413 recipient is `crewpass.app`, not the real domain.** | Signatures should name the site they are for. | Set `NEP413_RECIPIENT` in Vercel |
| **Contract account still has its full-access key.** | Anyone holding that key can redeploy the contract. | Remove before submission, after the last redeploy |
| **History depends on NearBlocks v3** (one day old when integrated). | Fails closed to on-chain counters, but the timeline disappears. | Accept for MVP |

### What can be reused unchanged

Contract v1 vault, sale and lock logic; the NEP-413 sign-in and session code; the fresh on-chain
ownership check; the RPC client with fallback; the site shell, theme and pass laminates.

---

## 4. On-chain and off-chain boundaries

| Fact | Authority | Where |
|---|---|---|
| Who owns a pass | Contract (`nft_token`) | NEAR testnet |
| Vault balance, withdrawals, owed amounts | Contract | NEAR testnet |
| Programme price and referral share | Contract (`config`) | NEAR testnet |
| Supply cap, transfer policy, tier, progress | Contract **v2** | planned |
| Creator knowledge and companion personality | Programme config | `web/server/programme.ts` (built) |
| Holder's private chat memory | Encrypted store keyed by holder | Upstash Redis in production, memory locally (built) |
| Sign-in sessions | HMAC tokens, 15 minutes | stateless (built) |

The server is never the authority for ownership or balances. Every gated request reads the chain
fresh and **fails closed** if the chain cannot be reached.

---

## 5. Exact transfer behaviour

**In the same contract receipt** as the ownership change (`nft_transfer`, the `buy` method, or the
resolve step of `nft_transfer_call`): the new owner becomes the only account that can withdraw the
vault, list, move or burn the pass. The vault balance stays with the token.

**Off chain, on the buyer's or seller's next request:** the server reads `nft_token` again. The seller
is refused (403) for that pass's members area and companion even with an unexpired session. The
buyer, after signing in, gets the pass's public state and a **fresh, empty** companion memory.

**Never transferred:** the seller's chats, preferences and notes. They are stored under the seller's
account and the token, encrypted, and are only ever served to the seller while the seller holds that
pass. Nothing about them is in NFT metadata or any public storage.

This is not one atomic step across chain and server: chain state changes atomically; server access
follows on the next request because it re-reads the chain every time.

---

## 6. AI companion (built in this slice)

**What it does:** answers the holder's questions using (1) the programme's approved knowledge,
(2) the live state of the pass they hold, read from the contract on that request, and (3) the holder's
own recent conversation. It is **read-only**: it has no tools, no keys and cannot move anything. Where a
wallet action helps (withdraw, list), it tells the member which button to use; the member signs.

**Access:** `POST /api/companion/:tokenId` requires a valid session, a full-access key still on the
account, and `nft_token(tokenId).owner_id == session account`, read fresh. Otherwise 401 or 403.

**Memory:** key `mem:v1:<contract>:<tokenId>:<accountId>`. Values are AES-256-GCM encrypted with
`MEMORY_ENCRYPTION_KEY`, with the key itself as associated data so a value cannot be moved to another
holder's key. Last 20 messages kept; 90-day expiry refreshed on use; `DELETE` clears it at once.

**Model provider:** any OpenAI-compatible chat API, chosen by environment variables, so Gemini, NEAR AI
Cloud or another provider is a settings change. With no key configured, an offline mode answers from
the programme knowledge and pass state by simple matching, and says so.

**Privacy notice, shown before the first message:** on the Gemini **free** tier, Google states that
submitted content is used to improve its products (Gemini API pricing page, checked 2026-11-08). Members
are told this and asked not to share personal information. NEAR AI Cloud's private (TEE) models avoid
this and are the planned upgrade once credit is available.

**Prompt injection:** creator knowledge and member messages are placed in the prompt as quoted data
under fixed system rules. Because the companion has no tools, an injected instruction can at most make
it say something wrong; it cannot act. Answers are rendered as plain text.

---

## 7. Rewards

**Built:** referral commission (10% of the 0.1 NEAR mint price) into the referrer pass's vault, in the
mint receipt. Withdrawn only by the current holder. Optional, legacy; not the product promise.

**Planned (v2):** creator-funded campaigns with a fixed budget, explicit conditions and expiry; funded,
claimable and claimed amounts tracked separately; budget cannot be exceeded. Pending rewards stay with
the campaign until validated; only available balances follow the pass.

**Not offered:** dividends, revenue share, yield, staking, a fungible token or any promise of appreciation.

---

## 8. Security assumptions and known limitations

See [THREAT_MODEL.md](../THREAT_MODEL.md) (T1 to T20, R1 to R5). Added by this slice: companion access
(C1 to C6 in the threat model). Main limits: contract not audited; Gemini free tier is not private;
in-memory rate limits and nonces are per server instance unless Upstash is configured.

---

## 9. Decision needed: contract v2 migration

Supply cap, transfer switch, tiers, engagement and funded campaigns all add contract state. The v1
contract has no `migrate` method, so its stored state cannot be extended in place safely.

| Option | Effect | Recommendation |
|---|---|---|
| **A. Deploy v2 to a new account** (`crewpass-v2.testnet`) | Clean state; v1 and its recorded proof stay live and valid | **Recommended** |
| B. Add a migration to v1 and redeploy in place | Keeps one address; a migration bug could corrupt live vaults | Not for a hackathon timeline |
| C. Keep v1, store tiers and supply off chain | No contract work, but supply cap and transfer policy would not be enforceable | Rejected (brief §7, §12) |

**Nothing in this slice changes the contract.**

---

## 10. Environment variables

| Name | Where | Secret | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | Vercel | yes | Signs sign-in nonces and sessions (32+ chars) |
| `MEMORY_ENCRYPTION_KEY` | Vercel | yes | 32 random bytes, hex or base64; encrypts companion memory |
| `AI_BASE_URL` | Vercel | no | OpenAI-compatible endpoint, e.g. `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `AI_API_KEY` | Vercel | yes | Provider key (Google AI Studio for Gemini) |
| `AI_MODEL` | Vercel | no | e.g. `gemini-3.8-flash` |
| `AI_DATA_NOTICE` | Vercel | no | Privacy notice shown to members for this provider |
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | Vercel | no | Upstash REST endpoint (either name) |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | Vercel | yes | Upstash token (either name) |
| `NEP413_RECIPIENT` | Vercel | no | Site name bound into sign-in signatures |
| `CREWPASS_CONTRACT` | optional | no | Defaults to `crewpass.testnet` |
| `NEAR_RPC_URL`, `NEARBLOCKS_URL` | optional | no | Override RPC and indexer |

Without `AI_API_KEY` the companion runs in offline mode. Without Upstash, memory lives in server memory
(local development only: it resets on restart and is not shared between Vercel instances).

---

## 11. Implemented, partial, planned

| Item | Status |
|---|---|
| NEP-171 pass, vault, sale, transfer-call lock | built |
| NEP-413 sign-in, per-request ownership check | built |
| AI companion with encrypted per-holder memory | built (this slice) |
| Programme config (name, benefits, knowledge) | partial: file-based, single programme |
| Supply cap, transfer switch | planned (v2) |
| Bronze/Silver/Gold tiers, engagement attestations, metadata updates | planned (v2) |
| Creator-funded reward campaigns | planned (v2) |
| Creator dashboard and knowledge editor | planned |
