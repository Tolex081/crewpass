//! Test-only attacker. When CrewPass hands it a pass through `nft_transfer_call`, it owns the
//! pass for a moment. `msg` picks what it tries to do in that moment before answering:
//!
//! - `steal_withdraw`: call `withdraw` on the pass, then hand the pass back
//! - `steal_transfer`: call `nft_transfer` to move the pass to `accomplice`, then hand it back
//! - `steal_list`: call `list` on the pass, then hand it back
//! - `keep`: keep the pass (a normal deposit)
//! - anything else: hand the pass back
//!
//! Each attempt's outcome is recorded and readable with `attempts`.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, is_promise_success, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

const ATTACK_GAS: Gas = Gas::from_tgas(30);
const RECORD_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Attempt {
    pub action: String,
    pub token_id: String,
    pub succeeded: bool,
}

#[near(contract_state)]
#[derive(Default)]
pub struct Receiver {
    accomplice: Option<AccountId>,
    attempts: Vec<Attempt>,
}

#[near]
impl Receiver {
    pub fn set_accomplice(&mut self, accomplice: AccountId) {
        self.accomplice = Some(accomplice);
    }

    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id);
        let nft = env::predecessor_account_id();
        let attack = match msg.as_str() {
            "steal_withdraw" => Some((
                "withdraw",
                json!({ "token_id": token_id }),
                NearToken::from_yoctonear(1),
            )),
            "steal_transfer" => Some((
                "nft_transfer",
                json!({ "token_id": token_id,
                        "receiver_id": self.accomplice.clone().unwrap_or_else(|| env::current_account_id()) }),
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
        Promise::new(nft)
            .function_call(method.to_string(), args.to_string().into_bytes(), deposit, ATTACK_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RECORD_GAS)
                    .record_attempt(method.to_string(), token_id, true),
            )
            .into()
    }

    /// Records whether the attack call succeeded, then answers CrewPass: `true` = give it back.
    #[private]
    pub fn record_attempt(&mut self, action: String, token_id: String, give_back: bool) -> bool {
        self.attempts.push(Attempt { action, token_id, succeeded: is_promise_success() });
        give_back
    }

    /// After keeping a pass, withdraw its vault like any ordinary holder.
    pub fn withdraw_from(&mut self, nft: AccountId, token_id: String) -> Promise {
        Promise::new(nft)
            .function_call(
                "withdraw".to_string(),
                json!({ "token_id": token_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                ATTACK_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RECORD_GAS)
                    .record_attempt("withdraw_after_keep".to_string(), token_id, false),
            )
    }

    pub fn attempts(&self) -> Vec<Attempt> {
        self.attempts.clone()
    }
}
