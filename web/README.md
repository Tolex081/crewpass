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

## Run locally

```bash
cd web
npm install
npm run dev        # server on :8787, pages on :5173
npm test           # server security tests
```

`SESSION_SECRET` (any long random string) must be set in production. Locally a random one is
generated at start, which signs everyone out on restart.
