# CrewPass

Creator Ambassador Passes on NEAR. Each pass is an NEP-171 NFT with its own vault. Fans who mint
with your pass as their referrer add a 10% commission to that vault. Whoever holds the pass can
withdraw the vault and open the members-only page. When the pass is sold, the vault, the right to
withdraw and the page access go to the buyer in the same transaction, and the seller is locked out.

- **Track:** `nfts` · **Network:** NEAR testnet · **License:** MIT
- **Status:** Day 2. Contract built and tested locally (36 unit tests, 6 NEAR sandbox tests). Not deployed yet.
- **Security design:** [THREAT_MODEL.md](THREAT_MODEL.md)

## Testnet accounts

| Account | Role |
|---|---|
| `crewpass.testnet` | Where the CrewPass contract will be deployed; the creator |
| `crewpass-alice.testnet` | Demo: first ambassador (referrer) |
| `crewpass-bob.testnet` | Demo: fan who mints using Alice's pass |
| `crewpass-carol.testnet` | Demo: buyer of Alice's pass |

All were created through the free testnet faucet. Their keys are not in this repository.

## Try it (to be filled in as each piece is built)

Steps for a judge, in "do X, see Y" form, will go here once the contract is deployed.

## Layout

```
THREAT_MODEL.md   every attack, how it is blocked, and the test that proves it
contract/         the CrewPass contract (Rust, near-sdk 5.30.1) and its tests
test-receiver/    test-only attacker contract used by the sandbox tests
scripts/          test.sh (unit + sandbox), verify-hos.sh (House of Stake check)
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
