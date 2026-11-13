//! NEAR sandbox tests for CrewPass V2: compiled wasm on a local NEAR node (nearcore 2.14), with the
//! pass-account code published as a real global contract and real keyless pass accounts.
//! Run with scripts/test-v2.sh, which builds the wasm and sets REGISTRY_WASM / PASS_ACCOUNT_WASM /
//! TARGET_WASM. Test names match rows in THREAT_MODEL.md (V2).
use near_api::types::account::ContractState;
use near_api::{AccountId, CryptoHash, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

type R<T = ()> = testresult::TestResult<T>;

const PRICE: NearToken = NearToken::from_millinear(100);
const SEED: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const REFERRAL: u128 = 10_000_000_000_000_000_000_000; // 10% of 0.1 NEAR
const TICKET: NearToken = NearToken::from_millinear(50);
const LIST_DEPOSIT: NearToken = NearToken::from_millinear(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);
const GAS: NearGas = NearGas::from_tgas(300);

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}
fn pass_account(token: &str) -> AccountId {
    format!("{token}.registry.sandbox").parse().unwrap()
}
fn tgas(n: u64) -> String {
    (n * 1_000_000_000_000).to_string()
}

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    registry: AccountId,
    code_hash: CryptoHash,
}

impl Env {
    /// Local network with the pass-account code published by hash and the registry deployed.
    /// `bad_hash` deploys the registry pointing at code that does not exist (account creation fails).
    async fn start_with(bad_hash: bool) -> R<Self> {
        let registry_wasm = std::fs::read(std::env::var("REGISTRY_WASM")?)?;
        let pass_wasm = std::fs::read(std::env::var("PASS_ACCOUNT_WASM")?)?;
        let target_wasm = std::fs::read(std::env::var("TARGET_WASM")?)?;
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        for (name, near) in [
            ("creator", 20), ("alice", 20), ("bob", 20), ("carol", 20), ("dave", 20),
            ("accomplice", 5), ("publisher", 50), ("registry", 30), ("target", 20),
        ] {
            sandbox.create_account(id(name).as_str().parse()?).initial_balance(NearToken::from_near(near)).send().await?;
        }
        let code_hash = CryptoHash::hash(&pass_wasm);
        near_api::Contract::deploy_global_contract_code(pass_wasm)
            .as_hash()
            .with_signer(id("publisher"), signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let init_hash = if bad_hash { CryptoHash::hash(b"no such code") } else { code_hash };
        near_api::Contract::deploy(id("registry"))
            .use_code(registry_wasm)
            .with_init_call("new", json!({ "pass_code_hash": init_hash.to_string() }))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        near_api::Contract::deploy(id("target"))
            .use_code(target_wasm)
            .without_init_call()
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let env = Self { _sandbox: sandbox, net, signer, registry: id("registry"), code_hash };
        env.ok_on(&id("target"), "creator", "set_accomplice", json!({ "accomplice": id("accomplice") }), ZERO).await?;
        // Programme 1: 0.1 NEAR mint, 10% referral, 50% of ticket revenue to members.
        env.ok("creator", "create_programme", json!({ "name": "Study Crew", "description": "sandbox",
            "mint_price": PRICE.as_yoctonear().to_string(), "referral_bps": 1000, "member_share_bps": 5000 }),
            NearToken::from_millinear(100)).await?;
        Ok(env)
    }

    async fn start() -> R<Self> {
        Self::start_with(false).await
    }

    async fn call_on(&self, contract: &AccountId, who: &str, method: &str, args: Value, deposit: NearToken) -> R<(bool, String)> {
        let res = near_api::Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(GAS)
            .with_signer(id(who), self.signer.clone())
            .send_to(&self.net)
            .await?;
        Ok((res.is_success(), format!("{res:?}")))
    }

    async fn call(&self, who: &str, method: &str, args: Value, deposit: NearToken) -> R<(bool, String)> {
        let r = self.registry.clone();
        self.call_on(&r, who, method, args, deposit).await
    }

    async fn ok_on(&self, contract: &AccountId, who: &str, method: &str, args: Value, deposit: NearToken) -> R<String> {
        let (ok, dbg) = self.call_on(contract, who, method, args, deposit).await?;
        assert!(ok, "{who}.{method} should succeed: {dbg}");
        Ok(dbg)
    }

    async fn ok(&self, who: &str, method: &str, args: Value, deposit: NearToken) -> R<String> {
        let r = self.registry.clone();
        self.ok_on(&r, who, method, args, deposit).await
    }

    async fn fails(&self, who: &str, method: &str, args: Value, deposit: NearToken, reason: &str) -> R {
        let (ok, dbg) = self.call(who, method, args, deposit).await?;
        assert!(!ok, "{who}.{method} should fail with '{reason}' but succeeded");
        assert!(dbg.contains(reason), "{who}.{method} failed, but not with '{reason}': {dbg}");
        Ok(())
    }

    async fn view_on(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        Ok(near_api::Contract(contract.clone()).call_function(method, args).read_only::<Value>().fetch_from(&self.net).await?.data)
    }

    async fn view(&self, method: &str, args: Value) -> R<Value> {
        let r = self.registry.clone();
        self.view_on(&r, method, args).await
    }

    async fn pass(&self, token: &str) -> R<Value> {
        self.view("pass_info", json!({ "token_id": token })).await
    }

    async fn owner(&self, token: &str) -> R<String> {
        Ok(self.view("nft_token", json!({ "token_id": token })).await?["owner_id"].as_str().unwrap_or("").to_string())
    }

    async fn balance_of(&self, account: &AccountId) -> R<u128> {
        Ok(near_api::Account(account.clone()).tokens().near_balance().fetch_from(&self.net).await?.total.as_yoctonear())
    }

    /// Balance after any refund receipts have landed (waits until it stops changing).
    async fn settled_balance(&self, account: &AccountId) -> R<u128> {
        let mut last = self.balance_of(account).await?;
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(600)).await;
            let now = self.balance_of(account).await?;
            if now == last {
                return Ok(now);
            }
            last = now;
        }
        Ok(last)
    }

    async fn assert_solvent(&self) -> R {
        let a = self.view("accounting", json!({})).await?;
        assert_eq!(a["solvent"], json!(true), "registry books do not balance: {a}");
        Ok(())
    }

    async fn mint(&self, who: &str, referrer: Option<&str>) -> R<String> {
        let dbg = self.ok(who, "mint", json!({ "programme_id": 1, "referrer_token_id": referrer }), PRICE).await?;
        assert!(dbg.contains("pass_account_created"), "mint did not create the pass account: {dbg}");
        Ok(dbg)
    }

    /// Call a pass account directly (Borsh arguments), as an attacker would.
    async fn call_pass_account_directly(&self, who: &str, token: &str, to: &str, amount: u128) -> R<(bool, String)> {
        let res = near_api::Contract(pass_account(token))
            .call_function_borsh("execute_transfer", (id(to), amount))
            .transaction()
            .gas(GAS)
            .with_signer(id(who), self.signer.clone())
            .send_to(&self.net)
            .await?;
        Ok((res.is_success(), format!("{res:?}")))
    }
}

// ------------------------------------------------------------------------------------- A1, A2, A4

#[tokio::test]
async fn mint_creates_keyless_pass_account() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    assert_eq!(env.owner("1").await?, id("alice").to_string());
    let p = env.pass("1").await?;
    assert_eq!(p["account_id"], json!(pass_account("1")));
    assert_eq!(p["tier"], json!("Bronze"));

    let account = near_api::Account(pass_account("1")).view().fetch_from(&env.net).await?.data;
    assert_eq!(account.contract_state, ContractState::GlobalHash(env.code_hash), "runs the published pass-account code");
    let keys = near_api::Account(pass_account("1")).list_keys().fetch_from(&env.net).await?.data;
    assert!(keys.is_empty(), "pass account must have no access keys, found {}", keys.len());
    assert_eq!(env.balance_of(&pass_account("1")).await?, SEED, "seed NEAR is held by the account itself");
    env.assert_solvent().await
}

#[tokio::test]
async fn pass_account_rejects_everyone_but_registry() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    // Even the current owner cannot call the account directly; nor can anyone else.
    for who in ["alice", "carol", "registry"] {
        let (ok, dbg) = env.call_pass_account_directly(who, "1", who, 1_000).await?;
        if who == "registry" {
            // The registry account itself signing a transaction *is* the parent: this is exactly
            // why the registry's key is the trust root (THREAT_MODEL U1).
            assert!(ok, "registry signer should be accepted: {dbg}");
        } else {
            assert!(!ok && dbg.contains("only the CrewPass registry can operate this account"), "{who}: {dbg}");
        }
    }
    env.assert_solvent().await
}

#[tokio::test]
async fn failed_account_creation_refunds_minter() -> R {
    let env = Env::start_with(true).await?;
    let before = env.balance_of(&id("alice")).await?;
    // near-api 0.8.7 cannot parse the `GlobalContractDoesNotExist` action error inside the RPC
    // answer, so it reports a transport error even though the transaction executed. We read the
    // outcome from the raw payload it returns, then check the chain state directly.
    let sent = near_api::Contract(env.registry.clone())
        .call_function("mint", json!({ "programme_id": 1 }))
        .transaction()
        .deposit(PRICE)
        .gas(GAS)
        .with_signer(id("alice"), env.signer.clone())
        .send_to(&env.net)
        .await;
    let dbg = match sent {
        Ok(res) => format!("{res:?}"),
        Err(e) => format!("{e:?}"),
    };
    assert!(dbg.contains("GlobalContractDoesNotExist"), "account creation should fail: {dbg}");
    assert!(dbg.contains("pass_mint_failed"), "{dbg}");
    assert_eq!(env.view("nft_token", json!({ "token_id": "1" })).await?, Value::Null, "no NFT without its account");
    assert_eq!(env.view("owed_to", json!({ "account_id": id("alice") })).await?, json!(SEED.to_string()));
    let after = env.settled_balance(&id("alice")).await?;
    let lost = before - after;
    assert!(lost < SEED + 5 * 10u128.pow(21), "alice lost more than the owed seed plus gas: {lost}");
    env.settled_balance(&env.registry).await?;
    env.ok("alice", "claim_owed", json!({}), ZERO).await?;
    assert_eq!(env.view("owed_to", json!({ "account_id": id("alice") })).await?, json!("0"));
    env.assert_solvent().await
}

// ------------------------------------------------------------------------------------- referral, tickets, rewards (F6)

#[tokio::test]
async fn referral_commission_lands_in_referrer_pass_account() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.mint("bob", Some("1")).await?;
    assert_eq!(env.settled_balance(&pass_account("1")).await?, SEED + REFERRAL);
    let p = env.pass("1").await?;
    assert_eq!((p["referrals"].clone(), p["points"].clone()), (json!(1), json!(10)));
    env.assert_solvent().await
}

#[tokio::test]
async fn ticket_revenue_reaches_pass_account() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.mint("bob", None).await?;
    env.ok("creator", "create_event", json!({ "programme_id": 1, "title": "Live session",
        "price": TICKET.as_yoctonear().to_string(), "capacity": 10, "points": 20, "starts_at_ms": "0" }),
        NearToken::from_millinear(100)).await?;
    env.ok("carol", "buy_ticket", json!({ "event_id": 1 }), TICKET).await?;
    let share = TICKET.as_yoctonear() / 2 / 2; // 50% to members, 2 passes
    assert_eq!(env.pass("1").await?["rewards_available"], json!(share.to_string()));
    let before = env.balance_of(&pass_account("1")).await?;
    env.ok("dave", "claim_rewards", json!({ "token_id": "1" }), ZERO).await?; // anyone can push it
    assert_eq!(env.settled_balance(&pass_account("1")).await? - before, share, "revenue is real NEAR in the pass account");
    env.fails("dave", "claim_rewards", json!({ "token_id": "1" }), ZERO, "no rewards to claim").await?;
    env.assert_solvent().await
}

// ------------------------------------------------------------------------------------- A1, A5, F8: sale

#[tokio::test]
async fn sale_moves_account_control_to_buyer() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.mint("bob", Some("1")).await?;
    let acct = pass_account("1");
    assert_eq!(env.settled_balance(&acct).await?, SEED + REFERRAL);

    let listing = env.call("alice", "list", json!({ "token_id": "1", "price": NearToken::from_near(1).as_yoctonear().to_string() }), LIST_DEPOSIT).await?;
    assert!(listing.0, "{}", listing.1);
    let listing_id = env.pass("1").await?["listing"]["id"].clone();
    env.fails("alice", "account_transfer", json!({ "token_id": "1", "receiver_id": id("alice"), "amount": "1000" }),
        ONE_YOCTO, "pass is listed; delist it first").await?;
    env.ok("carol", "buy", json!({ "token_id": "1", "listing_id": listing_id }), NearToken::from_near(1)).await?;
    assert_eq!(env.owner("1").await?, id("carol").to_string());
    assert_eq!(env.pass("1").await?["owner_epoch"], json!(2));

    // Alice: every route to the account is closed.
    env.fails("alice", "account_transfer", json!({ "token_id": "1", "receiver_id": id("alice"), "amount": "1000" }),
        ONE_YOCTO, "only the current holder can operate the pass account").await?;
    env.fails("alice", "account_call", json!({ "token_id": "1", "receiver_id": id("target"), "method_name": "record",
        "args": "", "deposit": "0", "gas": tgas(20) }), ONE_YOCTO, "only the current holder can operate the pass account").await?;
    let (ok, dbg) = env.call_pass_account_directly("alice", "1", "alice", 1_000).await?;
    assert!(!ok && dbg.contains("only the CrewPass registry can operate this account"), "{dbg}");
    env.fails("alice", "list", json!({ "token_id": "1", "price": "1" }), LIST_DEPOSIT, "only the current holder can list").await?;

    // Carol: controls the account and its NEAR.
    let amount = 15_000_000_000_000_000_000_000u128; // 0.015 NEAR
    let before = env.balance_of(&acct).await?;
    env.ok("carol", "account_transfer", json!({ "token_id": "1", "receiver_id": id("carol"), "amount": amount.to_string() }), ONE_YOCTO).await?;
    assert_eq!(before - env.settled_balance(&acct).await?, amount);
    // And can use it to act on another contract as the pass account itself.
    let args = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, json!({ "note": "hello from pass 1" }).to_string());
    env.ok("carol", "account_call", json!({ "token_id": "1", "receiver_id": id("target"), "method_name": "record",
        "args": args, "deposit": "1000", "gas": tgas(20) }), ONE_YOCTO).await?;
    let calls = env.view_on(&id("target"), "calls", json!({})).await?;
    assert_eq!(calls[0]["caller"], json!(acct), "target sees the pass account as the caller");
    assert_eq!(calls[0]["deposit"], json!("1000"));
    assert!(env.pass("1").await?["lock"].is_null());
    env.assert_solvent().await
}

// ------------------------------------------------------------------------------------- A6, A7: async races and failures

#[tokio::test]
async fn sale_refused_while_account_op_pending() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    // Start a slow account operation (a 12-receipt chain) without waiting for it.
    let (net, signer, registry) = (env.net.clone(), env.signer.clone(), env.registry.clone());
    let args = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, json!({ "steps": 30 }).to_string());
    let slow = tokio::spawn(async move {
        near_api::Contract(registry)
            .call_function("account_call", json!({ "token_id": "1", "receiver_id": id("target"),
                "method_name": "slow", "args": args, "deposit": "0", "gas": tgas(140) }))
            .transaction()
            .deposit(ONE_YOCTO)
            .gas(GAS)
            .with_signer(id("alice"), signer)
            .send_to(&net)
            .await
    });
    let mut locked = false;
    for _ in 0..100 {
        if !env.pass("1").await?["lock"].is_null() {
            locked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(locked, "never observed the account-operation lock");
    env.fails("alice", "list", json!({ "token_id": "1", "price": "1" }), LIST_DEPOSIT, "account operation in progress").await?;
    env.fails("alice", "nft_transfer", json!({ "token_id": "1", "receiver_id": id("carol") }), ONE_YOCTO, "account operation in progress").await?;
    env.fails("alice", "account_transfer", json!({ "token_id": "1", "receiver_id": id("alice"), "amount": "1" }), ONE_YOCTO, "account operation in progress").await?;
    let res = slow.await??;
    assert!(res.is_success(), "{res:?}");
    assert!(env.pass("1").await?["lock"].is_null(), "lock cleared when the operation settled");
    env.ok("alice", "list", json!({ "token_id": "1", "price": "1" }), LIST_DEPOSIT).await?;
    env.assert_solvent().await
}

#[tokio::test]
async fn failed_account_op_clears_lock() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    let acct = pass_account("1");
    let before = env.balance_of(&acct).await?;
    let dbg = env.ok("alice", "account_call", json!({ "token_id": "1", "receiver_id": id("target"), "method_name": "fail",
        "args": "", "deposit": "5000", "gas": tgas(20) }), ONE_YOCTO).await?;
    assert!(dbg.contains("\\\"succeeded\\\":false") || dbg.contains("\"succeeded\":false"), "{dbg}");
    assert!(env.pass("1").await?["lock"].is_null(), "lock cleared after a failed call");
    assert_eq!(env.settled_balance(&acct).await?, before, "failed call's deposit returned to the pass account");
    env.ok("alice", "list", json!({ "token_id": "1", "price": "1" }), LIST_DEPOSIT).await?;
    env.assert_solvent().await
}

// ------------------------------------------------------------------------------------- A8, A9

#[tokio::test]
async fn malicious_receiver_cannot_use_pass_account() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.mint("bob", Some("1")).await?;
    let acct = pass_account("1");
    let held = env.settled_balance(&acct).await?;
    for msg in ["steal_account", "steal_transfer", "steal_list"] {
        env.ok("alice", "nft_transfer_call", json!({ "token_id": "1", "receiver_id": id("target"), "msg": msg }), ONE_YOCTO).await?;
        let attempts = env.view_on(&id("target"), "attempts", json!({})).await?;
        let last = attempts.as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["succeeded"], json!(false), "{msg} succeeded: {last}");
        assert_eq!(env.owner("1").await?, id("alice").to_string(), "{msg}: pass not returned");
        assert!(env.pass("1").await?["lock"].is_null());
    }
    assert_eq!(env.settled_balance(&acct).await?, held, "pass account untouched");
    assert_eq!(env.owner("1").await?, id("alice").to_string());
    assert_eq!(env.pass("1").await?["owner_epoch"], json!(1), "returned pass keeps its epoch");
    env.assert_solvent().await
}

#[tokio::test]
async fn cannot_send_pass_to_a_pass_account() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.mint("bob", None).await?;
    for target in [pass_account("1"), pass_account("2")] {
        env.fails("alice", "nft_transfer", json!({ "token_id": "1", "receiver_id": target }), ONE_YOCTO, "a pass account cannot hold a pass").await?;
        env.fails("alice", "nft_transfer_call", json!({ "token_id": "1", "receiver_id": target, "msg": "" }), ONE_YOCTO, "a pass account cannot hold a pass").await?;
    }
    assert_eq!(env.owner("1").await?, id("alice").to_string());
    env.assert_solvent().await
}

// ------------------------------------------------------------------------------------- R2v2: dynamic metadata

#[tokio::test]
async fn tier_upgrade_updates_metadata() -> R {
    let env = Env::start().await?;
    env.mint("alice", None).await?;
    env.ok("creator", "create_event", json!({ "programme_id": 1, "title": "Workshop",
        "price": TICKET.as_yoctonear().to_string(), "capacity": 10, "points": 50, "starts_at_ms": "0" }),
        NearToken::from_millinear(100)).await?;
    env.ok("alice", "buy_ticket", json!({ "event_id": 1, "token_id": "1" }), TICKET).await?;
    env.fails("alice", "check_in", json!({ "event_id": 1, "token_id": "1" }), NearToken::from_millinear(10), "only the programme creator can check in").await?;
    let dbg = env.ok("creator", "check_in", json!({ "event_id": 1, "token_id": "1" }), NearToken::from_millinear(10)).await?;
    assert!(dbg.contains("nft_metadata_update") && dbg.contains("tier_changed"), "{dbg}");
    env.ok("creator", "award_achievement", json!({ "token_id": "1", "code": "first-talk", "points": 40 }), NearToken::from_millinear(10)).await?;
    let token = env.view("nft_token", json!({ "token_id": "1" })).await?;
    let title = token["metadata"]["title"].as_str().unwrap();
    assert!(title.ends_with("· Gold"), "title: {title}");
    let extra: Value = near_sdk::serde_json::from_str(token["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!((extra["tier"].clone(), extra["points"].clone()), (json!("Gold"), json!(90)));
    env.assert_solvent().await
}
