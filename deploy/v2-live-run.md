# CrewPass V2 live run on NEAR testnet

Registry `crewpass-v2.testnet`, run 2026-11-13T08:37:58Z by `deploy/v2-live-run.sh`. Every row is a real testnet
transaction. Refused rows show the contract's own error. Pass #1 controls the keyless account `1.crewpass-v2.testnet`.

| # | Who | Action | Expected | Result | Transaction |
|---|---|---|---|---|---|
| 1 | crewpass-creator | Creator launches programme 1 (0.1 NEAR mint, 10% referral, 50% of tickets to members) | ok | ok | [HQWRFUk8PA…](https://testnet.nearblocks.io/txns/HQWRFUk8PAUgrqMNwLkR9pYngcodeGNwNNsGyEax8pQj) |
| 2 | crewpass-alice | Alice mints pass #1; the registry creates `1.crewpass-v2.testnet` (no keys, pass-account code by hash) | ok | ok | [Ag3hQbHNLh…](https://testnet.nearblocks.io/txns/Ag3hQbHNLhLNw1rY2Z1FTE1AZbVfvRvP1eMjAkBaZ3n3) |
| 3 | crewpass-bob | Bob mints pass #2 through pass #1: 0.01 NEAR commission paid into `1.crewpass-v2.testnet` | ok | ok | [8qyvBt2qbX…](https://testnet.nearblocks.io/txns/8qyvBt2qbXY9hvqiDhJPWM54DR5QedEMZqesdqbg28xs) |
| 4 | crewpass-alice | Alice tries to refer herself | refused | refused: a pass cannot refer its own holder | [DnLDNDSGAv…](https://testnet.nearblocks.io/txns/DnLDNDSGAvY54zir45L6T3wTYM6H6SXweADN9xZCzKCy) |
| 5 | crewpass-creator | Creator creates event 1 (0.05 NEAR ticket, 30 points) | ok | ok | [GTfLiHeevF…](https://testnet.nearblocks.io/txns/GTfLiHeevFvNK6P7BQxdjM62qtTjXzD7yaZ21vtT9ybL) |
| 6 | crewpass-alice | Alice buys a ticket with pass #1 attached | ok | ok | [FQ4xGY65Ty…](https://testnet.nearblocks.io/txns/FQ4xGY65Ty7cZyEavAdrZLNDJCtzKQABU7YbD1opv76p) |
| 7 | crewpass-accomplice | A visitor without a pass buys a ticket | ok | ok | [2yvm2L5sMr…](https://testnet.nearblocks.io/txns/2yvm2L5sMrYUoJJeaprnCYgi1YWUv89rJY9TpLy87Loz) |
| 8 | crewpass-accomplice | The visitor tries to buy a second ticket | refused | refused: you already hold a ticket for this event | [8W2Si1gnvg…](https://testnet.nearblocks.io/txns/8W2Si1gnvg8LzScrT7Tn5XAehVs9YD6PrkPZoJR8kPzh) |
| 9 | crewpass-bob | Anyone pushes pass #1's ticket revenue (2 × 0.0125 NEAR) into `1.crewpass-v2.testnet` | ok | ok | [3gL91VQUyA…](https://testnet.nearblocks.io/txns/3gL91VQUyAh9j6YMDT4oK2epsNssQ3CG9axs9dVv7oCH) |
| 10 | crewpass-bob | Claiming the same rewards again | refused | refused: no rewards to claim | [ASMa3fYey7…](https://testnet.nearblocks.io/txns/ASMa3fYey77bTmsBbhDfvwnUoLdg6RzcZBPEqPmYAXcm) |
| 11 | crewpass-alice | Alice tries to check herself in | refused | refused: only the programme creator can check in | [5sGskjwzKq…](https://testnet.nearblocks.io/txns/5sGskjwzKqFk1cvwmSgz1Szt5N4SCguZk7qmyE59SDXu) |
| 12 | crewpass-creator | Creator checks pass #1 in: +30 points → Silver (nft_metadata_update) | ok | ok | [FKX77GYVkc…](https://testnet.nearblocks.io/txns/FKX77GYVkcqmdixPXyW9zZRdEHjzFCkkmzeDWKDng1in) |
| 13 | crewpass-creator | Creator awards "first-project" (+45) → Gold (nft_metadata_update) | ok | ok | [4k2JYuEc2U…](https://testnet.nearblocks.io/txns/4k2JYuEc2UCEb5kZxxs4Age6abtmaB7zVLzFAUABWkMx) |
| 14 | crewpass-creator | Same achievement twice | refused | refused: achievement already awarded to this pass | [68Thw48BHJ…](https://testnet.nearblocks.io/txns/68Thw48BHJJVFmJt9pEgg5ELVjrLnE7yRC9KijGnggAu) |
| 15 | crewpass-alice | Alice, the holder, withdraws 0.005 NEAR from `1.crewpass-v2.testnet` | ok | ok | [8Bx3p9hkVU…](https://testnet.nearblocks.io/txns/8Bx3p9hkVUKVoxyza7echJZr7XYfS7Ng156VTAh9aZ89) |
| 16 | crewpass-alice | Alice lists pass #1 for 0.5 NEAR (listing 1) | ok | ok | [AThNpNvvSp…](https://testnet.nearblocks.io/txns/AThNpNvvSpgRnAQGzP7TpZXsx24EXpGd13zfAQxUkBq2) |
| 17 | crewpass-alice | Alice tries to empty the account while listed | refused | refused: pass is listed; delist it first | [9sxnQCDvFa…](https://testnet.nearblocks.io/txns/9sxnQCDvFaYPG6tqitfJhExa6fwx3bWgMqe7njrbfPN3) |
| 18 | crewpass-carol | Carol buys with a listing id she did not see | refused | refused: listing changed; check it again | [3TZzeS6VWx…](https://testnet.nearblocks.io/txns/3TZzeS6VWxmSznoqnt7h2BH9vhik4i5iW7ktnLEKjkGE) |
| 19 | crewpass-carol | Carol buys pass #1: ownership and control of `1.crewpass-v2.testnet` move in this receipt | ok | ok | [ErBQSxY895…](https://testnet.nearblocks.io/txns/ErBQSxY8956asLJEn1cvJBRdHFCSJgJuj9nwnXFMnAzF) |
| 20 | crewpass-alice | Alice (old owner) tries to withdraw from the account | refused | refused: only the current holder can operate the pass account | [HxPPokFnoB…](https://testnet.nearblocks.io/txns/HxPPokFnoBwUm8EkZGC5R89tjrJYbWZV9tNSyLsyuHLA) |
| 21 | crewpass-alice | Alice tries to make the account call another contract | refused | refused: only the current holder can operate the pass account | [Fc7hHFajMR…](https://testnet.nearblocks.io/txns/Fc7hHFajMRKbA6GBTNghCMmq8aL5UZp6TzRXV43ennjd) |
| 22 | crewpass-alice | Alice calls `1.crewpass-v2.testnet` directly (no registry) | refused | refused: only the CrewPass registry can operate this account | [4MHvFqN4xi…](https://testnet.nearblocks.io/txns/4MHvFqN4xiuxRefdVv3QPkdXjM7XyiJtnpsqmk76Je9U) |
| 23 | crewpass-alice | Alice tries to relist the pass | refused | refused: only the current holder can list | [HqRbaTsesb…](https://testnet.nearblocks.io/txns/HqRbaTsesbdeeefYkxhtDcQZSw4j1ppU8vjaZn2GHLXg) |
| 24 | crewpass-alice | Alice tries to move the pass | refused | refused: Approval extension is disabled | [Gx7UjU9Jho…](https://testnet.nearblocks.io/txns/Gx7UjU9Jhoi8YoncookKjdwg5KT1abBZn6KhBTMJ2zbV) |
| 25 | crewpass-carol | Carol withdraws 0.01 NEAR from `1.crewpass-v2.testnet` | ok | ok | [9NKckPSzaw…](https://testnet.nearblocks.io/txns/9NKckPSzawdzps5DLWB5ApYc5fvEYzAAkSDFHTanVdzM) |
| 26 | crewpass-carol | Carol makes `1.crewpass-v2.testnet` call another contract as itself | ok | ok | [H7cfMTY8cJ…](https://testnet.nearblocks.io/txns/H7cfMTY8cJdwa52gRJKozGYqSr7msXgqh3WqE6mAG6E9) |
| 27 | crewpass-carol | Carol tries to send the pass to a pass account (would freeze it) | refused | refused: a pass account cannot hold a pass | [95Ab2w9k4N…](https://testnet.nearblocks.io/txns/95Ab2w9k4Nz16WEwYA5qBUYvyqcN3EdbwmT8yFqTNCui) |
| 28 | crewpass-carol | Hostile receiver gets the pass via nft_transfer_call and tries to drain the account (pass returned) | ok | ok | [2B4mzgU86V…](https://testnet.nearblocks.io/txns/2B4mzgU86V52Mx6nMM1JQiMAhewDkpTPxtRKGTqK9emM) |
| 29 | crewpass-carol | Hostile receiver tries to list the pass mid-transfer (pass returned) | ok | ok | [HCR9oqG14v…](https://testnet.nearblocks.io/txns/HCR9oqG14vZ3Y4BojdTeEptD756zahMpHaUi1YntFzEk) |

Unexpected results in this run: **0**.

## Pass account right after mint

```
balance 0.0100 NEAR, global_contract_hash CuX7PYtWMa9ZG18jkHGTYKutgQVQoKNWiQSFvmmzEzRL
access keys: 0
```

## Pass #1 before the sale (Alice)

```json
{
  "account_id": "1.crewpass-v2.testnet",
  "achievements": 1,
  "check_ins": 1,
  "listing": null,
  "lock": null,
  "minted_at_ms": "1794559088191",
  "next_tier": "Platinum",
  "owner_epoch": 1,
  "owner_id": "crewpass-alice.testnet",
  "points": 85,
  "points_to_next_tier": 65,
  "programme_id": 1,
  "referral_earned": "10000000000000000000000",
  "referrals": 1,
  "rewards_available": "0",
  "rewards_claimed": "25000000000000000000000",
  "tickets": 1,
  "tier": "Gold",
  "token_id": "1",
  "transfers": 0
}
```

## State after the run

```json
// pass_info("1")
{
  "account_id": "1.crewpass-v2.testnet",
  "achievements": 1,
  "check_ins": 1,
  "listing": null,
  "lock": null,
  "minted_at_ms": "1794559088191",
  "next_tier": "Platinum",
  "owner_epoch": 2,
  "owner_id": "crewpass-carol.testnet",
  "points": 85,
  "points_to_next_tier": 65,
  "programme_id": 1,
  "referral_earned": "10000000000000000000000",
  "referrals": 1,
  "rewards_available": "0",
  "rewards_claimed": "25000000000000000000000",
  "tickets": 1,
  "tier": "Gold",
  "token_id": "1",
  "transfers": 1
}
// nft_token("1").metadata.title / extra
    "extra": "{\"programme_id\":1,\"tier\":\"Gold\",\"points\":85,\"account_id\":\"1.crewpass-v2.testnet\",\"check_ins\":1,\"achievements\":1,\"referrals\":1}",
    "title": "Study Crew #1 · Gold",
  "owner_id": "crewpass-carol.testnet",
// accounting()
{
  "balance": "17882459055170363500000005",
  "carry": "0",
  "liabilities": "212630000000000000000000",
  "listing_deposits": "0",
  "owed": "0",
  "pending_mints": "0",
  "reserved": "25000000000000000000000",
  "solvent": true,
  "storage_cost": "3584640000000000000000000",
  "treasury": "187630000000000000000000"
}
// crewpass-v2-target.testnet attempts() (hostile receiver)
[
  {
    "action": "account_transfer",
    "succeeded": false,
    "token_id": "1"
  },
  {
    "action": "list",
    "succeeded": false,
    "token_id": "1"
  }
]
// crewpass-v2-target.testnet calls() (made by the pass account)
[
  {
    "caller": "1.crewpass-v2.testnet",
    "deposit": "1000",
    "note": "hello from pass 1"
  }
]
```

```
1.crewpass-v2.testnet now:
balance 0.0300 NEAR, global_contract_hash CuX7PYtWMa9ZG18jkHGTYKutgQVQoKNWiQSFvmmzEzRL
access keys: 0
```
