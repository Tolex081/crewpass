# CrewPass V2 web check (members access, companion, events)

Run 2026-11-13T08:48:35.149Z by `web/scripts/v2-web-check.ts` against the local API reading the live
registry `crewpass-v2.testnet`, right after `deploy/v2-live-run.sh`. Sign-ins are real NEP-413 signatures
made with the demo accounts' own testnet keys.

| Who | Action | Expected HTTP | Got | Result | Detail |
|---|---|---|---|---|---|
| crewpass-alice | NEP-413 sign-in with own testnet key | 200 | 200 | as expected | session issued |
| crewpass-alice | Replay the same signed sign-in | 401 | 401 | as expected | This sign-in request was already used. Start again. |
| crewpass-carol | NEP-413 sign-in with own testnet key | 200 | 200 | as expected | session issued |
| crewpass-carol | Replay the same signed sign-in | 401 | 401 | as expected | This sign-in request was already used. Start again. |
| alice | Open pass #1's members area after selling it | 403 | 403 | as expected | Only the current holder of this pass can open this. |
| alice | Use pass #1's companion after selling it | 403 | 403 | as expected | Only the current holder of this pass can open this. |
| alice | Event 1 access (her ticket was attached to pass #1) | 403 | 403 | as expected | No ticket for this event on your account or on a pass you hold. |
| carol | Open pass #1's members area (inherited, Gold) | 200 | 200 | as expected | tier Gold; Gold post unlocked; Platinum post locked (body not sent) |
| carol | Companion history for her ownership period | 200 | 200 | as expected | owner epoch 2; 0 earlier messages |
| carol | Ask the companion about tier and account | 200 | 200 | as expected | Pass #1 controls the account 1.crewpass-v2.testnet, which holds Ⓝ 0.0299. Rewards waiting to be claimed: Ⓝ 0. Referral earnings so far: Ⓝ 0.01. Use Claim reward |
| carol | Event 1 access via the ticket attached to pass #1 | 200 | 200 | as expected | via pass #1 |
| carol | Open the creator dashboard of programme 1 | 403 | 403 | as expected | Only this programme's creator can open its dashboard. |

Unexpected results: **0**.
