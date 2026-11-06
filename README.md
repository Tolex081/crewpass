# CrewPass

Creator Ambassador Passes on NEAR. Each pass is an NEP-171 NFT with its own vault. Fans who mint
with your pass as their referrer add a 10% commission to that vault. Whoever holds the pass can
withdraw the vault and open the members-only page. When the pass is sold, the vault, the right to
withdraw and the page access go to the buyer in the same transaction, and the seller is locked out.

- **Live site:** https://crewpass-steel.vercel.app (passes, pass history, members area, proof)
- **Track:** `nfts` · **Network:** NEAR testnet · **License:** MIT
- **Status:** Contract live on testnet at `crewpass.testnet`, tested locally (36 unit tests, 6 NEAR sandbox tests) and in a recorded live run. Front end not built yet.
- **Security design:** [THREAT_MODEL.md](THREAT_MODEL.md)
- **House of Stake (TLA):** not used. Our investigation is **incomplete**: their transfer behaviour
  is known from reading their code, not from running their tests. Details in
  [THREAT_MODEL.md](THREAT_MODEL.md#house-of-stake-tla-investigation-incomplete).

## Testnet accounts

| Account | Role |
|---|---|
| `crewpass.testnet` | The CrewPass contract |
| `crewpass-creator.testnet` | The creator, who receives mint income through `claim` |
| `crewpass-alice.testnet` | Demo: first ambassador (referrer) |
| `crewpass-bob.testnet` | Demo: fan who mints using Alice's pass |
| `crewpass-carol.testnet` | Demo: buyer of Alice's pass |
| `crewpass-evil.testnet` | Test-only attacker contract ([source](test-receiver/src/lib.rs)) |
| `crewpass-accomplice.testnet` | Where the attacker tries to send stolen passes |

All were created through the free testnet faucet. Their keys are not in this repository.

## Try it

**In the browser.** Open https://crewpass-steel.vercel.app. You see every pass with its holder and
vault, read live from `crewpass.testnet`. Open pass #1: its history shows the mint, both referrals,
the sale to Carol with the vault moving with it, and three blocked attacks. The Proof tab lists every
recorded transaction with explorer links.

**Without installing anything.** Open [deploy/live-run.md](deploy/live-run.md). Each row is a real
testnet transaction with an explorer link: two mints with a referral, a sale, and the old owner's
three attempts after the sale, each refused with the contract's own error.

**See the hardest attack fail, live.** Open [deploy/attack-run.md](deploy/attack-run.md). A hostile
contract (`crewpass-evil.testnet`) receives pass #1 through `nft_transfer_call`, which makes it the
owner for a moment, and tries to withdraw the vault, move the pass to an accomplice, and list it.
Each transaction shows CrewPass refusing the attack ("pass is in the middle of nft_transfer_call"),
the pass returning to its holder, and the 0.01 NEAR vault unchanged.

**Read the live contract yourself** (needs [near-cli-rs](https://github.com/near/near-cli-rs), no account):

1. Run `near contract call-function as-read-only crewpass.testnet pass_info json-args '{"token_id":"1"}' network-config testnet now`.
   You see pass #1 owned by `crewpass-carol.testnet` (it was Alice's), with `referrals: 1`,
   `earned` and `withdrawn` both 0.01 NEAR, and `transfers: 1`.
2. Run `near contract call-function as-read-only crewpass.testnet accounting json-args '{}' network-config testnet now`.
   You see `"solvent": true`: the contract holds at least everything it owes plus its storage.

**Run the attacks yourself, free** (Linux or WSL2):

1. Run `scripts/test.sh`. You see 36 unit tests and 6 sandbox tests pass.
2. In the output, `malicious_receiver_cannot_touch_vault_during_transfer_call` is a real attacker
   contract ([test-receiver](test-receiver/src/lib.rs)) that receives a pass through
   `nft_transfer_call` and tries to withdraw, move and list it before handing it back. All three are
   refused and the vault is untouched.

The contract on testnet was built from commit `5d034f3`; wasm sha256 is in
[deploy/testnet.json](deploy/testnet.json).

## Layout

```
THREAT_MODEL.md   every attack, how it is blocked, and the test that proves it
contract/         the CrewPass contract (Rust, near-sdk 5.30.1) and its tests
test-receiver/    test-only attacker contract used by the sandbox tests
scripts/          test.sh (unit + sandbox), verify-hos.sh (House of Stake check, not yet completed)
web/              members-only page and pass history           [Day 7]
deploy/           testnet account list and deploy scripts
```

## Run the tests

```bash
scripts/test.sh          # unit tests, build wasm, NEAR sandbox tests (~5 min)
scripts/test.sh unit     # unit tests only (seconds)
```

## Requirements to build

Linux or WSL2 (the NEAR sandbox runs only on Linux x86 or macOS ARM), Rust stable with the
`wasm32-unknown-unknown` target, `cargo-near` and `near-cli-rs`.
