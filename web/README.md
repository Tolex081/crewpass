# CrewPass web

The site for CrewPass passes on NEAR testnet. Two layers:

- **Server** (`server/`, Hono on Node; runs on Vercel as functions). Everything that decides who may
  see members-only content runs here, never in the browser.
- **Pages** (`src/`, Vite + React). Wallet connection through NEAR Connect.

## What each page does

| Page | For | Reads | Writes (wallet transaction) |
|---|---|---|---|
| Passes | Everyone | `nft_tokens`, `pass_info` | `mint` (with a referrer from a `?ref=` link) |
| Pass #N | Everyone | `pass_info`, history | Holder: `withdraw`, `list`, `delist`. Others: `buy` |
| Members | Current holders only | `/api/members` | none |
| Proof | Judges | `deploy/live-run.md`, `deploy/attack-run.md` data | none |

## Members-only access (threats T3 and T4)

1. The page asks the server for a challenge: a 32-byte nonce that carries its own issue time and an
   HMAC, so any server instance can check it without shared storage.
2. The wallet signs a NEP-413 message (`message`, `nonce`, `recipient`) with a full-access key.
3. The server rebuilds the NEP-413 bytes (tag `2147484061`, Borsh payload), checks the Ed25519
   signature, checks the nonce is genuine, under 5 minutes old and not used before, and checks on chain
   that the public key is a **full-access key of that account**. It then issues a 15-minute session token.
4. **Every** request to `/api/members` re-checks on chain that the account still holds a pass. A
   seller is refused on their next request after the sale, even with an unexpired session.

Limit: "not used before" is remembered per server instance. On Vercel, a replay of a captured
signature could still succeed on a different instance within its 5-minute life. The signature is
bound to this site's `recipient`, so it cannot be reused elsewhere.

## Pass history

The server lists the contract's transactions from the NearBlocks v3 API and reads each one's CrewPass
events (`pass_minted`, `commission_credited`, `pass_sold`, `vault_withdrawn`, NEP-171 `nft_transfer`)
from a NEAR RPC node. If NearBlocks is unavailable, the page shows the on-chain counters from
`pass_info` and says the full history is temporarily unavailable.

## AI companion

`/api/companion/:tokenId` (GET history, POST a message) and `/api/companion/:tokenId/memory` (DELETE).
Only the current holder of that pass, checked on chain on every request. Memory is encrypted
(AES-256-GCM) per pass and holder; the model is any OpenAI-compatible API set by environment
variables, or an offline mode without one. Full design: [docs/PRODUCT.md](../docs/PRODUCT.md) §6;
environment variables: §10; threats C1 to C10: [THREAT_MODEL.md](../THREAT_MODEL.md).

## Run locally

```bash
cd web
npm install
npm run dev        # server on :8787, pages on :5173
npm test           # server security tests
```

The API server runs Node with `--use-system-ca`, so it trusts the operating system's certificate
store. Without it, antivirus HTTPS scanning (Avast on the development machine) makes every RPC call
fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Certificate checks stay on.

The API port is `API_PORT` (default 8787), not `PORT`, because dev launchers set `PORT` for Vite.

`SESSION_SECRET` (any long random string) must be set in production. Locally a random one is
generated at start, which signs everyone out on restart.
