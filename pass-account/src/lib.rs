//! CrewPass V2 pass account.
//!
//! Every pass N owns the account `N.<registry>`. That account has **no access keys** and runs this
//! code, attached by code hash (a global contract), so the code can never change. The account obeys
//! exactly one caller: its parent, the CrewPass registry, which only forwards requests from the
//! pass's current NFT owner. There is no stored controller and no state: control follows the NFT
//! inside the registry. See docs/ADR-001-pass-accounts.md.
//!
//! Arguments are Borsh-encoded because only the registry calls these methods. That keeps this
//! immutable code small (it is published once as a global contract, which is paid per byte).

use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

/// Highest gas the account will forward to a target. Leaves room for the registry's callback.
pub const MAX_FORWARD_GAS: Gas = Gas::from_tgas(200);

#[near(contract_state)]
#[derive(Default)]
pub struct PassAccount {}

/// The parent of `7.crewpass-v2.testnet` is `crewpass-v2.testnet`. Only a parent can create a
/// sub-account, so the parent is the registry that created this one.
pub fn parent_of(account: &AccountId) -> &str {
    match account.as_str().split_once('.') {
        Some((_, parent)) => parent,
        None => env::panic_str("a pass account is always a sub-account"),
    }
}

fn assert_registry() {
    require!(
        env::predecessor_account_id().as_str() == parent_of(&env::current_account_id()),
        "only the CrewPass registry can operate this account"
    );
}

#[near]
impl PassAccount {
    /// Send NEAR from this account. Registry only.
    pub fn execute_transfer(
        &self,
        #[serializer(borsh)] receiver_id: AccountId,
        #[serializer(borsh)] amount: u128,
    ) -> Promise {
        assert_registry();
        require!(amount > 0, "amount must be positive");
        Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount))
    }

    /// Call another contract as this account. Registry only. The returned promise lets the
    /// registry's callback wait for the result of the call.
    pub fn execute_call(
        &self,
        #[serializer(borsh)] receiver_id: AccountId,
        #[serializer(borsh)] method_name: String,
        #[serializer(borsh)] args: Vec<u8>,
        #[serializer(borsh)] deposit: u128,
        #[serializer(borsh)] gas: u64,
    ) -> Promise {
        assert_registry();
        require!(receiver_id != env::current_account_id(), "an account cannot call itself");
        let gas = Gas::from_gas(gas);
        require!(gas <= MAX_FORWARD_GAS, "gas above the forwarding limit");
        Promise::new(receiver_id).function_call(method_name, args, NearToken::from_yoctonear(deposit), gas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(caller: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("7.crewpass-v2.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .build());
    }

    #[test]
    fn parent_is_the_registry() {
        assert_eq!(parent_of(&"7.crewpass-v2.testnet".parse().unwrap()), "crewpass-v2.testnet");
    }

    #[test]
    fn registry_can_transfer() {
        ctx("crewpass-v2.testnet");
        let _ = PassAccount::default().execute_transfer("carol.testnet".parse().unwrap(), 5);
    }

    #[test]
    fn registry_can_call() {
        ctx("crewpass-v2.testnet");
        let _ = PassAccount::default().execute_call("x.testnet".parse().unwrap(), "m".into(), vec![], 0, 1);
    }

    #[test]
    #[should_panic(expected = "only the CrewPass registry can operate this account")]
    fn owner_cannot_call_account_directly() {
        ctx("alice.testnet");
        let _ = PassAccount::default().execute_transfer("alice.testnet".parse().unwrap(), 5);
    }

    #[test]
    #[should_panic(expected = "only the CrewPass registry can operate this account")]
    fn sibling_pass_account_cannot_operate() {
        ctx("8.crewpass-v2.testnet");
        let _ = PassAccount::default().execute_transfer("x.testnet".parse().unwrap(), 5);
    }

    #[test]
    #[should_panic(expected = "only the CrewPass registry can operate this account")]
    fn grandparent_cannot_operate() {
        ctx("testnet");
        let _ = PassAccount::default().execute_call("x.testnet".parse().unwrap(), "m".into(), vec![], 0, 1);
    }

    #[test]
    #[should_panic(expected = "an account cannot call itself")]
    fn cannot_call_itself() {
        ctx("crewpass-v2.testnet");
        let _ = PassAccount::default().execute_call(
            "7.crewpass-v2.testnet".parse().unwrap(), "execute_transfer".into(), vec![], 0, 1);
    }

    #[test]
    #[should_panic(expected = "gas above the forwarding limit")]
    fn forward_gas_is_capped() {
        ctx("crewpass-v2.testnet");
        let _ = PassAccount::default().execute_call(
            "x.testnet".parse().unwrap(), "m".into(), vec![], 0, Gas::from_tgas(250).as_gas());
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn zero_transfer_refused() {
        ctx("crewpass-v2.testnet");
        let _ = PassAccount::default().execute_transfer("x.testnet".parse().unwrap(), 0);
    }
}
