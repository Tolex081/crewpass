//! Test-only contract for the CrewPass V2 sandbox tests. Never deployed to testnet as part of the
//! product. It plays three roles:
//!
//! - **Target of pass-account calls**: `record` (proves the caller is the pass account), `fail`
//!   (a call that fails), `slow` (a chain of receipts that keeps an account operation pending for
//!   several blocks).
//! - **Hostile `nft_transfer_call` receiver**: while it briefly owns a pass it tries, depending on
//!   `msg`, `steal_account` (move NEAR out of the pass account), `steal_transfer` (move the pass to an
//!   accomplice) or `steal_list` (list it), then hands the pass back. `keep` keeps it.
//!
//! Every attempt is recorded and readable with `attempts`; every `record` call with `calls`.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, is_promise_success, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

const ATTACK_GAS: Gas = Gas::from_tgas(60);
const RECORD_GAS: Gas = Gas::from_tgas(10);
const SLOW_STEP_GAS: Gas = Gas::from_tgas(4);

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Attempt {
    pub action: String,
    pub token_id: String,
    pub succeeded: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Call {
    pub caller: AccountId,
    pub deposit: U128,
    pub note: String,
}

#[near(contract_state)]
#[derive(Default)]
pub struct Target {
    accomplice: Option<AccountId>,
    attempts: Vec<Attempt>,
    calls: Vec<Call>,
}

#[near]
impl Target {
    pub fn set_accomplice(&mut self, accomplice: AccountId) {
        self.accomplice = Some(accomplice);
    }

    /// Record who called and what they attached.
    #[payable]
    pub fn record(&mut self, note: String) -> String {
        self.calls.push(Call {
            caller: env::predecessor_account_id(),
            deposit: U128(env::attached_deposit().as_yoctonear()),
            note: note.clone(),
        });
        note
    }

    /// Always fails. Any attached deposit is refunded to the caller by the protocol.
    #[payable]
    pub fn fail(&mut self) {
        env::panic_str("test-target: this call always fails");
    }

    /// Calls itself `steps` more times, one receipt each, so the caller waits several blocks.
    pub fn slow(&mut self, steps: u32) -> PromiseOrValue<u32> {
        if steps == 0 {
            return PromiseOrValue::Value(0);
        }
        Self::ext(env::current_account_id())
            .with_static_gas(Gas::from_tgas(5) .saturating_add(SLOW_STEP_GAS.saturating_mul(steps as u64)))
            .slow(steps - 1)
            .into()
    }

    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id);
        let registry = env::predecessor_account_id();
        let me = env::current_account_id();
        let attack = match msg.as_str() {
            "steal_account" => Some((
                "account_transfer",
                json!({ "token_id": token_id, "receiver_id": me, "amount": U128(1_000) }),
                NearToken::from_yoctonear(1),
            )),
            "steal_transfer" => Some((
                "nft_transfer",
                json!({ "token_id": token_id,
                        "receiver_id": self.accomplice.clone().unwrap_or_else(|| me.clone()) }),
                NearToken::from_yoctonear(1),
            )),
            "steal_list" => Some((
                "list",
                json!({ "token_id": token_id, "price": U128(1) }),
                NearToken::from_millinear(10),
            )),
            "keep" => return PromiseOrValue::Value(false),
            _ => None,
        };
        let Some((method, args, deposit)) = attack else {
            return PromiseOrValue::Value(true);
        };
        Promise::new(registry)
            .function_call(method.to_string(), args.to_string().into_bytes(), deposit, ATTACK_GAS)
            .then(
                Self::ext(me)
                    .with_static_gas(RECORD_GAS)
                    .record_attempt(method.to_string(), token_id),
            )
            .into()
    }

    /// Records whether the attack succeeded, then answers the registry: `true` = give the pass back.
    #[private]
    pub fn record_attempt(&mut self, action: String, token_id: String) -> bool {
        self.attempts.push(Attempt { action, token_id, succeeded: is_promise_success() });
        true
    }

    pub fn attempts(&self) -> Vec<Attempt> {
        self.attempts.clone()
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.clone()
    }
}
