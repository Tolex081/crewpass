//! NEAR sandbox tests: the compiled contracts on a local NEAR network.
//! Run with scripts/test.sh, which builds the wasm and sets CREWPASS_WASM / RECEIVER_WASM.
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;

type R<T = ()> = testresult::TestResult<T>;

const PRICE: NearToken = NearToken::from_millinear(100);
const COMMISSION: NearToken = NearToken::from_millinear(10);
const LIST_DEPOSIT: NearToken = NearToken::from_millinear(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS: NearGas = NearGas::from_tgas(300);

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    crewpass: AccountId,
    receiver: AccountId,
}

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}

impl Env {
    async fn start() -> R<Self> {
        let crewpass_wasm = std::fs::read(std::env::var("CREWPASS_WASM")?)?;
        let receiver_wasm = std::fs::read(std::env::var("RECEIVER_WASM")?)?;
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        for name in ["creator", "alice", "bob", "carol", "dave", "accomplice", "crewpass", "evil"] {
            sandbox
                .create_account(id(name).as_str().parse()?)
                .initial_balance(NearToken::from_near(20))
                .send()
                .await?;
        }
        near_api::Contract::deploy(id("crewpass"))
            .use_code(crewpass_wasm)
            .with_init_call(
                "new",
                json!({ "creator": id("creator"), "mint_price": PRICE.as_yoctonear().to_string(),
                        "commission_bps": 1000, "name": "CrewPass", "symbol": "CREW" }),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        near_api::Contract::deploy(id("evil"))
            .use_code(receiver_wasm)
            .without_init_call()
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        Ok(Self { _sandbox: sandbox, net, signer, crewpass: id("crewpass"), receiver: id("evil") })
    }

    /// Sign a call from `who` to `contract`. Returns (succeeded, debug text of the outcome).
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
        let c = self.crewpass.clone();
        self.call_on(&c, who, method, args, deposit).await
    }

    async fn ok(&self, who: &str, method: &str, args: Value, deposit: NearToken) -> R {
        let (ok, dbg) = self.call(who, method, args, deposit).await?;
        assert!(ok, "{who}.{method} should succeed: {dbg}");
        Ok(())
    }

    async fn fails(&self, who: &str, method: &str, args: Value, deposit: NearToken, reason: &str) -> R {
        let (ok, dbg) = self.call(who, method, args, deposit).await?;
        assert!(!ok, "{who}.{method} should fail with '{reason}' but succeeded");
        assert!(dbg.contains(reason), "{who}.{method} failed, but not with '{reason}': {dbg}");
        Ok(())
    }

    async fn view_on(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        Ok(near_api::Contract(contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn view(&self, method: &str, args: Value) -> R<Value> {
        let c = self.crewpass.clone();
        self.view_on(&c, method, args).await
    }

    async fn owner(&self, token: &str) -> R<String> {
        Ok(self.view("nft_token", json!({ "token_id": token })).await?["owner_id"].as_str().unwrap().to_string())
    }

    async fn vault(&self, token: &str) -> R<u128> {
        Ok(self.view("vault_of", json!({ "token_id": token })).await?.as_str().unwrap().parse()?)
    }

    async fn balance(&self, who: &str) -> R<u128> {
        Ok(near_api::Account(id(who)).tokens().near_balance().fetch_from(&self.net).await?.total.as_yoctonear())
    }

    async fn assert_solvent(&self) -> R {
        let a = self.view("accounting", json!({})).await?;
        assert_eq!(a["solvent"], json!(true), "contract books do not balance: {a}");
        Ok(())
    }

    /// Alice mints pass 1; Bob mints pass 2 with pass 1 as referrer.
    async fn alice_pass_with_commission(&self) -> R {
        self.ok("alice", "mint", json!({}), PRICE).await?;
        self.ok("bob", "mint", json!({ "referrer_token_id": "1" }), PRICE).await?;
        assert_eq!(self.vault("1").await?, COMMISSION.as_yoctonear());
        Ok(())
    }

    async fn attempts(&self) -> R<Vec<Value>> {
        let r = self.receiver.clone();
        Ok(self.view_on(&r, "attempts", json!({})).await?.as_array().unwrap().clone())
    }
}

/// T1, T2, T5, T6, T11, T14, T16: the pass, its vault and the right to withdraw move to the buyer
/// together; the seller is paid exactly once and is locked out afterwards.
#[tokio::test]
async fn sale_moves_vault_and_locks_out_seller() -> R {
    let env = Env::start().await?;
    env.alice_pass_with_commission().await?;
    env.fails("alice", "mint", json!({ "referrer_token_id": "1" }), PRICE, "a pass cannot refer its own holder").await?;

    env.ok("alice", "list", json!({ "token_id": "1", "price": NearToken::from_near(1).as_yoctonear().to_string() }), LIST_DEPOSIT).await?;
    env.fails("alice", "withdraw", json!({ "token_id": "1" }), ONE_YOCTO, "pass is listed").await?;
    env.fails("carol", "buy", json!({ "token_id": "1", "expected_min_vault": "0" }), PRICE, "attach exactly the listing price").await?;
    let too_much = (COMMISSION.as_yoctonear() + 1).to_string();
    env.fails("carol", "buy", json!({ "token_id": "1", "expected_min_vault": too_much }), NearToken::from_near(1), "vault is below").await?;

    let alice_before = env.balance("alice").await?;
    let expected = COMMISSION.as_yoctonear().to_string();
    env.ok("carol", "buy", json!({ "token_id": "1", "expected_min_vault": expected }), NearToken::from_near(1)).await?;
    assert_eq!(env.owner("1").await?, id("carol").to_string());
    assert_eq!(env.vault("1").await?, COMMISSION.as_yoctonear(), "vault stays with the pass");
    assert_eq!(
        env.balance("alice").await? - alice_before,
        NearToken::from_near(1).as_yoctonear() + LIST_DEPOSIT.as_yoctonear(),
        "seller receives price + listing deposit exactly once"
    );

    env.fails("alice", "withdraw", json!({ "token_id": "1" }), ONE_YOCTO, "only the current holder can withdraw").await?;
    env.fails("alice", "nft_transfer", json!({ "token_id": "1", "receiver_id": id("alice") }), ONE_YOCTO, "Approval extension is disabled").await?;
    env.fails("alice", "list", json!({ "token_id": "1", "price": "1" }), LIST_DEPOSIT, "only the current holder can list").await?;

    let carol_before = env.balance("carol").await?;
    env.ok("carol", "withdraw", json!({ "token_id": "1" }), ONE_YOCTO).await?;
    let gained = env.balance("carol").await? - carol_before;
    assert!(gained > COMMISSION.as_yoctonear() - NearToken::from_millinear(2).as_yoctonear(), "carol got {gained}");
    assert_eq!(env.vault("1").await?, 0);
    env.assert_solvent().await
}

/// T9: a receiver contract owns the pass during nft_on_transfer. It tries to withdraw, move or
/// list the pass, then hands it back. Every attempt must fail and the vault must be untouched.
#[tokio::test]
async fn malicious_receiver_cannot_touch_vault_during_transfer_call() -> R {
    let env = Env::start().await?;
    env.alice_pass_with_commission().await?;
    let evil = env.receiver.clone();
    env.call_on(&evil, "alice", "set_accomplice", json!({ "accomplice": id("accomplice") }), NearToken::from_yoctonear(0)).await?;

    for msg in ["steal_withdraw", "steal_transfer", "steal_list"] {
        let (ok, dbg) = env
            .call("alice", "nft_transfer_call", json!({ "receiver_id": evil, "token_id": "1", "msg": msg }), ONE_YOCTO)
            .await?;
        assert!(ok, "transfer call ({msg}) itself should complete: {dbg}");
        assert!(dbg.contains("pass is in the middle of nft_transfer_call"), "{msg}: lock did not fire: {dbg}");
        assert_eq!(env.owner("1").await?, id("alice").to_string(), "{msg}: pass returned to alice");
        assert_eq!(env.vault("1").await?, COMMISSION.as_yoctonear(), "{msg}: vault untouched");
        let info = env.view("pass_info", json!({ "token_id": "1" })).await?;
        assert_eq!(info["in_transfer_call"], json!(false), "{msg}: lock released after resolve");
        assert_eq!(info["listing"], Value::Null, "{msg}: no listing left behind");
    }
    let attempts = env.attempts().await?;
    assert_eq!(attempts.len(), 3);
    for a in &attempts {
        assert_eq!(a["succeeded"], json!(false), "attack succeeded: {a}");
    }
    // Alice still controls her pass and can withdraw normally.
    env.ok("alice", "withdraw", json!({ "token_id": "1" }), ONE_YOCTO).await?;
    env.assert_solvent().await
}

/// T10: a receiver that keeps the pass becomes its holder, with the vault; the sender is out.
#[tokio::test]
async fn receiver_that_keeps_pass_gets_the_vault() -> R {
    let env = Env::start().await?;
    env.alice_pass_with_commission().await?;
    let evil = env.receiver.clone();
    env.ok("alice", "nft_transfer_call", json!({ "receiver_id": evil, "token_id": "1", "msg": "keep" }), ONE_YOCTO).await?;
    assert_eq!(env.owner("1").await?, evil.to_string());
    env.fails("alice", "withdraw", json!({ "token_id": "1" }), ONE_YOCTO, "only the current holder can withdraw").await?;

    let (ok, dbg) = env
        .call_on(&evil, "alice", "withdraw_from", json!({ "nft": env.crewpass, "token_id": "1" }), NearToken::from_yoctonear(0))
        .await?;
    assert!(ok, "{dbg}");
    assert_eq!(env.attempts().await?.last().unwrap()["succeeded"], json!(true));
    assert_eq!(env.vault("1").await?, 0);
    env.assert_solvent().await
}

/// Private callbacks are only callable by the contract itself (checked on chain, not in unit tests).
#[tokio::test]
async fn strangers_cannot_call_private_callbacks() -> R {
    let env = Env::start().await?;
    env.alice_pass_with_commission().await?;
    env.fails("bob", "on_payout", json!({ "to": id("bob"), "amount": "1000000000000000000000000", "reason": "x" }),
        NearToken::from_yoctonear(0), "is private").await?;
    env.fails("bob", "nft_resolve_transfer", json!({ "previous_owner_id": id("bob"), "receiver_id": id("alice"), "token_id": "1" }),
        NearToken::from_yoctonear(0), "is private").await?;
    assert_eq!(env.view("owed_to", json!({ "account_id": id("bob") })).await?, json!("0"));
    assert_eq!(env.owner("1").await?, id("alice").to_string());
    Ok(())
}

/// T7/T16: if paying the seller fails (their account is gone), the money is owed to them and
/// claimable, never lost or moved into the vault.
#[tokio::test]
async fn failed_sale_payout_is_owed_to_seller() -> R {
    let env = Env::start().await?;
    env.ok("dave", "mint", json!({}), PRICE).await?;
    env.ok("dave", "list", json!({ "token_id": "1", "price": PRICE.as_yoctonear().to_string() }), LIST_DEPOSIT).await?;
    near_api::Account(id("dave"))
        .delete_account_with_beneficiary(id("creator"))
        .with_signer(env.signer.clone())
        .send_to(&env.net)
        .await?
        .assert_success();

    let (ok, dbg) = env.call("carol", "buy", json!({ "token_id": "1", "expected_min_vault": "0" }), PRICE).await?;
    assert!(ok, "buy completes even though the payout fails: {dbg}");
    assert!(dbg.contains("payout_failed"), "payout failure must be recorded: {dbg}");
    assert_eq!(env.owner("1").await?, id("carol").to_string());
    let owed: u128 = env.view("owed_to", json!({ "account_id": id("dave") })).await?.as_str().unwrap().parse()?;
    assert_eq!(owed, PRICE.as_yoctonear() + LIST_DEPOSIT.as_yoctonear());
    env.assert_solvent().await
}

/// T19: a pass with money in its vault cannot be burned; an empty one can.
#[tokio::test]
async fn burn_only_with_empty_vault() -> R {
    let env = Env::start().await?;
    env.alice_pass_with_commission().await?;
    env.fails("alice", "burn", json!({ "token_id": "1" }), ONE_YOCTO, "withdraw the vault before burning").await?;
    env.ok("bob", "burn", json!({ "token_id": "2" }), ONE_YOCTO).await?;
    assert_eq!(env.view("nft_token", json!({ "token_id": "2" })).await?, Value::Null);
    env.ok("creator", "claim", json!({}), NearToken::from_yoctonear(0)).await?;
    env.assert_solvent().await
}
