# Live attack on CrewPass during nft_transfer_call (testnet)

Threat **T9** in [THREAT_MODEL.md](../THREAT_MODEL.md). With standard NEP-171, `nft_transfer_call` makes the
receiver the owner *before* calling it. A hostile receiver could use that moment to empty the vault,
then hand the pass back. CrewPass locks the pass until `nft_resolve_transfer`.

Run 2026-11-06T12:05:28Z on `crewpass.testnet`. Attacker contract: `crewpass-evil.testnet` ([source](../test-receiver/src/lib.rs)).

Setup:

- Attacker deployed: [AuMji3LqbH…](https://testnet.nearblocks.io/txns/AuMji3LqbHhcow7p2nbkco5Ceb5q9N91a4Kt6JEdH4ih)
- Accomplice set to `crewpass-accomplice.testnet`: [A6dkmuUV7c…](https://testnet.nearblocks.io/txns/A6dkmuUV7cDfVjuYfVyPrz6ah4CBdoavBynepiTvWsGb)
- `crewpass-bob` mints with pass #1 as referrer, so pass #1's vault holds 0.01 NEAR: [2Eg1tg3y5x…](https://testnet.nearblocks.io/txns/2Eg1tg3y5xvpeCaVWmAmN2DAcW1zVQDok5Dp9HaDKWQ4)
- Pass #1 owner before the attacks: `crewpass-carol.testnet`, vault: "10000000000000000000000" yoctoNEAR

| # | Attack while the receiver owns the pass | Pass #1 owner after | Vault after | Lock after | Transaction |
|---|---|---|---|---|---|
| 1 | Withdraw the vault, then hand the pass back | `crewpass-carol.testnet` | "10000000000000000000000" | false | [Ai6dFHWzrQ…](https://testnet.nearblocks.io/txns/Ai6dFHWzrQubgtBBnQxewjtARcy81gUx9gnPaQKsnqXJ) |
| 2 | Move the pass to the accomplice, then hand it back | `crewpass-carol.testnet` | "10000000000000000000000" | false | [J2pC4Jg1hF…](https://testnet.nearblocks.io/txns/J2pC4Jg1hFnGSNoSZDjTnF1mrgHKUgCfYjtPgUyf4iF1) |
| 3 | List the pass for sale, then hand it back | `crewpass-carol.testnet` | "10000000000000000000000" | false | [72ERs2FonE…](https://testnet.nearblocks.io/txns/72ERs2FonEbTqG7UnKCivCvnoKbWKN3M9qX965EoyN2X) |

Vault amounts are in yoctoNEAR: 10000000000000000000000 = 0.01 NEAR, the same before and after.

## What the chain recorded, receipt by receipt

Read from testnet RPC (`EXPERIMENTAL_tx_status`) for each of the three transactions. All three have the
same shape (shown once):

| Order | Runs on | Result | CrewPass events |
|---|---|---|---|
| 1 | `crewpass.testnet` | ok | `transfer_call_locked`, `nft_transfer` (Carol → attacker) |
| 2 | `crewpass-evil.testnet` (`nft_on_transfer`) | ok, starts the attack | |
| 3 | `crewpass.testnet` (the attack call) | **FAILED: pass is in the middle of nft_transfer_call** | |
| 4–8 | `crewpass-evil.testnet`, `crewpass-carol.testnet` | ok: the attacker records the failure and asks to give the pass back; gas and deposit refunds | |
| 9 | `crewpass.testnet` (`nft_resolve_transfer`) | ok | `nft_transfer` (attacker → Carol), `transfer_call_unlocked` |

Final value of each transaction: `false` (the receiver did not keep the pass).

## What the attacker recorded

The attacker contract stores whether each of its calls into CrewPass succeeded (`attempts` view).
`succeeded: false` means CrewPass refused it with "pass is in the middle of nft_transfer_call".

```json
[
  {
    "action": "withdraw",
    "succeeded": false,
    "token_id": "1"
  },
  {
    "action": "nft_transfer",
    "succeeded": false,
    "token_id": "1"
  },
  {
    "action": "list",
    "succeeded": false,
    "token_id": "1"
  }
]
```

## Pass #1 after all three attacks

```json
{
  "in_transfer_call": false,
  "listing": null,
  "owner_id": "crewpass-carol.testnet",
  "stats": {
    "earned": "20000000000000000000000",
    "minted_at_ns": "1793965767496889873",
    "referrals": 2,
    "transfers": 1,
    "withdrawn": "10000000000000000000000"
  },
  "token_id": "1",
  "vault": "10000000000000000000000"
}
```
