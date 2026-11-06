# CrewPass live run on NEAR testnet

Contract `crewpass.testnet`, run 2026-11-06T11:49:24Z. Every step is a real testnet transaction; refused steps show the contract's own error.

| # | Who | Action | Expected | Result | Transaction |
|---|---|---|---|---|---|
| 1 | crewpass-alice | Mint pass #1 (no referrer) | ok | ok | [BM7AabmRj5…](https://testnet.nearblocks.io/txns/BM7AabmRj5ERjDLiUevRzcu8d6fUGNq3y1ZCee1ebXdh) |
| 2 | crewpass-bob | Mint pass #2 with pass #1 as referrer: 0.01 NEAR into pass #1 vault | ok | ok | [6ia9F4rS1h…](https://testnet.nearblocks.io/txns/6ia9F4rS1hPNiYzK4AhbLmN6PgCFg3EKS95SxYF16v2d) |
| 3 | crewpass-alice | Self-referral with own pass #1 | refused | refused: a pass cannot refer its own holder | [8ckMzXvwjW…](https://testnet.nearblocks.io/txns/8ckMzXvwjWynxeqbKnPWxbmWozcJuKcwE37q2Q9BDy78) |
| 4 | crewpass-alice | List pass #1 for 1 NEAR | ok | ok | [BpmrrGPefg…](https://testnet.nearblocks.io/txns/BpmrrGPefgAgAwUfdJZRZA44Sums4Av6wCZy9MeJC8yi) |
| 5 | crewpass-alice | Seller withdraws while listed | refused | refused: pass is listed; delist it first | [CE8fqG1HiG…](https://testnet.nearblocks.io/txns/CE8fqG1HiGyNrZ2GxbG9sTntgJvN66hUTYxHxHZbjpf9) |
| 6 | crewpass-carol | Buy expecting more than the vault holds | refused | refused: vault is below the amount you expected | [3m6gvVfT4C…](https://testnet.nearblocks.io/txns/3m6gvVfT4C9uKQE1mc9Xd92rrdgjGxfnLf7chKoGmiRg) |
| 7 | crewpass-carol | Buy pass #1 for 1 NEAR, vault 0.01 NEAR comes with it | ok | ok | [4eBgF6Co7g…](https://testnet.nearblocks.io/txns/4eBgF6Co7g5ALip2sPZdRGay3zDkAjkaFLKQcPg9aB2z) |
| 8 | crewpass-alice | Old owner withdraws after the sale | refused | refused: only the current holder can withdraw | [Fmt9vyN4py…](https://testnet.nearblocks.io/txns/Fmt9vyN4pyb5jt8ms2DaDYeNwqVRGxjzRBCdZkdT7rTy) |
| 9 | crewpass-alice | Old owner moves the pass after the sale | refused | refused: Approval extension is disabled | [FU4Sffnwqv…](https://testnet.nearblocks.io/txns/FU4Sffnwqvo31Pu2AT7t5TinAWvT1q1LAt45GqgQoVMR) |
| 10 | crewpass-alice | Old owner relists after the sale | refused | refused: only the current holder can list | [Az3dH5CksF…](https://testnet.nearblocks.io/txns/Az3dH5CksFj5xVyZtjfHThmRFs1vJB51oTq5uYn3w55J) |
| 11 | crewpass-carol | New owner withdraws the 0.01 NEAR vault | ok | ok | [9DQuZRXxNz…](https://testnet.nearblocks.io/txns/9DQuZRXxNz1UBtRk8HFBcfhrUd6zQDdAXkaxidhNqVGC) |
| 12 | crewpass-creator | Creator claims mint income | ok | ok | [9k4hMotMj2…](https://testnet.nearblocks.io/txns/9k4hMotMj2bLvdSEGD68oweVVLMspKd6KmsQ1VprJw69) |

## State after the run

```json
// pass_info("1")
{
  "in_transfer_call": false,
  "listing": null,
  "owner_id": "crewpass-carol.testnet",
  "stats": {
    "earned": "10000000000000000000000",
    "minted_at_ns": "1793965767496889873",
    "referrals": 1,
    "transfers": 1,
    "withdrawn": "10000000000000000000000"
  },
  "token_id": "1",
  "vault": "0"
}
// accounting()
{
  "balance": "10014883102909779900000001",
  "liabilities": "0",
  "solvent": true,
  "storage_cost": "2541020000000000000000000",
  "total_listing_deposits": "0",
  "total_owed": "0",
  "total_vaults": "0"
}
```
