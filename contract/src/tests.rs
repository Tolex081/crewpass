//! Unit tests. Each test name matches a row in THREAT_MODEL.md where one applies.
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const PRICE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const COMMISSION: u128 = PRICE / 10; // 10%
const ONE_YOCTO: u128 = 1;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}
fn contract_id() -> AccountId {
    acc("crewpass")
}
fn creator() -> AccountId {
    acc("creator")
}
fn alice() -> AccountId {
    acc("alice")
}
fn bob() -> AccountId {
    acc("bob")
}
fn carol() -> AccountId {
    acc("carol")
}
fn evil() -> AccountId {
    acc("evil-receiver")
}

fn ctx(predecessor: &AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50));
    b
}

fn call_as(who: &AccountId, deposit: u128) {
    testing_env!(ctx(who, deposit).build());
}

/// Run a callback on the contract with a given result for promise 0.
fn callback_with(result: PromiseResult) {
    testing_env!(
        ctx(&contract_id(), 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn setup() -> CrewPass {
    call_as(&creator(), 0);
    CrewPass::new(creator(), U128(PRICE), 1_000, "CrewPass".into(), "CREW".into())
}

fn mint(c: &mut CrewPass, who: &AccountId, referrer: Option<&str>) -> TokenId {
    call_as(who, PRICE);
    c.mint(referrer.map(str::to_string)).token_id
}

/// Alice holds pass "1" with 0.01 NEAR in its vault from Bob's referred mint (pass "2").
fn setup_with_commission() -> CrewPass {
    let mut c = setup();
    assert_eq!(mint(&mut c, &alice(), None), "1");
    assert_eq!(mint(&mut c, &bob(), Some("1")), "2");
    c
}

fn list(c: &mut CrewPass, who: &AccountId, token: &str, price: u128) {
    call_as(who, LIST_DEPOSIT.as_yoctonear());
    c.list(token.into(), U128(price));
}

fn owner(c: &CrewPass, token: &str) -> AccountId {
    c.nft_token(token.into()).unwrap().owner_id
}

// ------------------------------------------------------------------ mint and commission

#[test]
fn commission_is_credited_in_mint_receipt() {
    let c = setup_with_commission();
    assert_eq!(c.vault_of("1".into()).0, COMMISSION);
    assert_eq!(c.vault_of("2".into()).0, 0);
    let stats = c.pass_info("1".into()).unwrap().stats;
    assert_eq!(stats.referrals, 1);
    assert_eq!(stats.earned.0, COMMISSION);
    // Creator is owed both prices minus the commission minus the storage both mints used
    // (about 0.008 NEAR each, read from the pass_minted events).
    let owed = c.owed_to(creator()).0;
    let storage_budget = 2 * 10_000_000_000_000_000_000_000; // 0.01 NEAR per mint, generous
    assert!(owed < 2 * PRICE - COMMISSION, "storage must be charged");
    assert!(owed > 2 * PRICE - COMMISSION - storage_budget, "storage charge out of range: owed {owed}");
    let acct = c.accounting();
    assert_eq!(acct.total_vaults.0, COMMISSION);
    assert_eq!(acct.total_owed.0, owed);
}

#[test]
#[should_panic(expected = "attach exactly the mint price")]
fn mint_requires_exact_price() {
    let mut c = setup();
    call_as(&alice(), PRICE + 1);
    c.mint(None);
}

#[test]
#[should_panic(expected = "a pass cannot refer its own holder")]
fn self_referral_is_refused() {
    let mut c = setup();
    mint(&mut c, &alice(), None);
    mint(&mut c, &alice(), Some("1"));
}

#[test]
#[should_panic(expected = "unknown referrer pass")]
fn unknown_referrer_is_refused() {
    let mut c = setup();
    mint(&mut c, &alice(), Some("99"));
}

// ------------------------------------------------------------------ withdraw

#[test]
#[should_panic(expected = "only the current holder can withdraw")]
fn non_holder_cannot_withdraw() {
    let mut c = setup_with_commission();
    call_as(&bob(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut c = setup_with_commission();
    call_as(&alice(), 0);
    let _ = c.withdraw("1".into(), None);
}

#[test]
fn withdraw_reduces_vault_before_sending() {
    let mut c = setup_with_commission();
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
    assert_eq!(c.vault_of("1".into()).0, 0);
    assert_eq!(c.accounting().total_vaults.0, 0);
    assert_eq!(c.pass_info("1".into()).unwrap().stats.withdrawn.0, COMMISSION);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn double_withdraw_cannot_exceed_vault() {
    let mut c = setup_with_commission();
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

#[test]
#[should_panic(expected = "amount exceeds the vault")]
fn withdraw_more_than_vault_is_refused() {
    let mut c = setup_with_commission();
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), Some(U128(COMMISSION + 1)));
}

#[test]
fn failed_withdraw_is_owed_to_withdrawer_not_vault() {
    let mut c = setup_with_commission();
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
    // Meanwhile the pass is sold to Carol; then the payment to Alice fails.
    list(&mut c, &alice(), "1", PRICE);
    call_as(&carol(), PRICE);
    let _ = c.buy("1".into(), U128(0));
    callback_with(PromiseResult::Failed);
    assert!(!c.on_payout(alice(), U128(COMMISSION), "withdraw".into()));
    assert_eq!(c.owed_to(alice()).0, COMMISSION);
    assert_eq!(c.vault_of("1".into()).0, 0, "failed refund must not go to the new holder's vault");
}

#[test]
fn owed_can_be_claimed_once() {
    let mut c = setup_with_commission();
    let owed = c.owed_to(creator()).0;
    call_as(&creator(), 0);
    let _ = c.claim();
    assert_eq!(c.owed_to(creator()).0, 0);
    assert_eq!(c.accounting().total_owed.0, 0);
    assert!(owed > 0);
}

#[test]
#[should_panic(expected = "nothing owed")]
fn claim_twice_is_refused() {
    let mut c = setup_with_commission();
    call_as(&creator(), 0);
    let _ = c.claim();
    call_as(&creator(), 0);
    let _ = c.claim();
}

// ------------------------------------------------------------------ nft_transfer_call lock (T9, T10)

fn start_transfer_call(c: &mut CrewPass) {
    call_as(&alice(), ONE_YOCTO);
    let _ = c.nft_transfer_call(evil(), "1".into(), None, None, "steal".into());
    assert_eq!(owner(c, "1"), evil(), "standard NEP-171 hands the pass to the receiver first");
    assert!(c.pass_info("1".into()).unwrap().in_transfer_call);
}

#[test]
#[should_panic(expected = "pass is in the middle of nft_transfer_call")]
fn receiver_cannot_withdraw_during_transfer_call() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    call_as(&evil(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

#[test]
#[should_panic(expected = "pass is in the middle of nft_transfer_call")]
fn receiver_cannot_transfer_during_transfer_call() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    call_as(&evil(), ONE_YOCTO);
    c.nft_transfer(carol(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "pass is in the middle of nft_transfer_call")]
fn receiver_cannot_list_during_transfer_call() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    list(&mut c, &evil(), "1", PRICE);
}

#[test]
#[should_panic(expected = "pass is in the middle of nft_transfer_call")]
fn receiver_cannot_burn_during_transfer_call() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    call_as(&evil(), ONE_YOCTO);
    c.burn("1".into());
}

#[test]
fn transfer_call_return_restores_owner_and_vault() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    callback_with(PromiseResult::Successful(b"true".to_vec())); // receiver asks to return it
    let kept = c.nft_resolve_transfer(alice(), evil(), "1".into(), None);
    assert!(!kept);
    assert_eq!(owner(&c, "1"), alice());
    assert!(!c.pass_info("1".into()).unwrap().in_transfer_call);
    assert_eq!(c.vault_of("1".into()).0, COMMISSION);
}

#[test]
fn transfer_call_lock_clears_when_receiver_panics() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    callback_with(PromiseResult::Failed);
    assert!(!c.nft_resolve_transfer(alice(), evil(), "1".into(), None));
    assert_eq!(owner(&c, "1"), alice());
    assert!(!c.pass_info("1".into()).unwrap().in_transfer_call);
}

#[test]
fn transfer_call_kept_moves_vault_rights_to_receiver() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    callback_with(PromiseResult::Successful(b"false".to_vec())); // receiver keeps it
    assert!(c.nft_resolve_transfer(alice(), evil(), "1".into(), None));
    assert_eq!(owner(&c, "1"), evil());
    assert!(!c.pass_info("1".into()).unwrap().in_transfer_call);
    call_as(&evil(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
    assert_eq!(c.vault_of("1".into()).0, 0);
}

#[test]
#[should_panic(expected = "only the current holder can withdraw")]
fn sender_cannot_withdraw_after_receiver_keeps_pass() {
    let mut c = setup_with_commission();
    start_transfer_call(&mut c);
    callback_with(PromiseResult::Successful(b"false".to_vec()));
    c.nft_resolve_transfer(alice(), evil(), "1".into(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

// ------------------------------------------------------------------ sale (T1, T2, T5, T14, T15)

fn sell_alice_pass_to_carol(c: &mut CrewPass) {
    list(c, &alice(), "1", PRICE * 5);
    call_as(&carol(), PRICE * 5);
    let _ = c.buy("1".into(), U128(COMMISSION));
}

#[test]
fn sale_moves_pass_and_vault_rights_together() {
    let mut c = setup_with_commission();
    sell_alice_pass_to_carol(&mut c);
    assert_eq!(owner(&c, "1"), carol());
    assert_eq!(c.vault_of("1".into()).0, COMMISSION, "vault stays with the pass");
    assert!(c.pass_info("1".into()).unwrap().listing.is_none());
    assert_eq!(c.accounting().total_listing_deposits.0, 0);
    assert_eq!(c.pass_info("1".into()).unwrap().stats.transfers, 1);
    call_as(&carol(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
    assert_eq!(c.vault_of("1".into()).0, 0);
}

#[test]
#[should_panic(expected = "only the current holder can withdraw")]
fn old_owner_cannot_withdraw_after_sale() {
    let mut c = setup_with_commission();
    sell_alice_pass_to_carol(&mut c);
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

#[test]
#[should_panic(expected = "Approval extension is disabled")]
fn old_owner_cannot_transfer_after_sale() {
    let mut c = setup_with_commission();
    sell_alice_pass_to_carol(&mut c);
    call_as(&alice(), ONE_YOCTO);
    c.nft_transfer(alice(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "only the current holder can list")]
fn old_owner_cannot_relist_after_sale() {
    let mut c = setup_with_commission();
    sell_alice_pass_to_carol(&mut c);
    list(&mut c, &alice(), "1", PRICE);
}

#[test]
#[should_panic(expected = "pass is listed; delist it first")]
fn withdraw_refused_while_listed() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&alice(), ONE_YOCTO);
    let _ = c.withdraw("1".into(), None);
}

#[test]
#[should_panic(expected = "pass is listed; delist it first")]
fn transfer_refused_while_listed() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&alice(), ONE_YOCTO);
    c.nft_transfer(bob(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "vault is below the amount you expected")]
fn buy_reverts_when_vault_below_expected() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&carol(), PRICE);
    let _ = c.buy("1".into(), U128(COMMISSION + 1));
}

#[test]
#[should_panic(expected = "attach exactly the listing price")]
fn buy_with_wrong_amount_reverts() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&carol(), PRICE - 1);
    let _ = c.buy("1".into(), U128(0));
}

#[test]
#[should_panic(expected = "pass is not listed")]
fn buy_after_delist_reverts() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&alice(), ONE_YOCTO);
    let _ = c.delist("1".into());
    call_as(&carol(), PRICE);
    let _ = c.buy("1".into(), U128(0));
}

#[test]
#[should_panic(expected = "seller cannot buy their own pass")]
fn seller_cannot_buy_own_listing() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&alice(), PRICE);
    let _ = c.buy("1".into(), U128(0));
}

#[test]
#[should_panic(expected = "only the seller can delist")]
fn stranger_cannot_delist() {
    let mut c = setup_with_commission();
    list(&mut c, &alice(), "1", PRICE);
    call_as(&bob(), ONE_YOCTO);
    let _ = c.delist("1".into());
}

#[test]
fn failed_sale_payout_is_owed_to_seller() {
    let mut c = setup_with_commission();
    sell_alice_pass_to_carol(&mut c);
    let due = PRICE * 5 + LIST_DEPOSIT.as_yoctonear();
    callback_with(PromiseResult::Failed);
    c.on_payout(alice(), U128(due), "sale".into());
    assert_eq!(c.owed_to(alice()).0, due);
    assert_eq!(c.vault_of("1".into()).0, COMMISSION);
}

// ------------------------------------------------------------------ approvals, burn, admin (T13, T18, T19)

#[test]
#[should_panic(expected = "Approval extension is disabled")]
fn no_approval_lets_a_stranger_move_a_pass() {
    let mut c = setup_with_commission();
    call_as(&bob(), ONE_YOCTO);
    c.nft_transfer(bob(), "1".into(), Some(0), None);
}

#[test]
fn no_approval_methods_exposed() {
    let c = setup_with_commission();
    assert!(c.nft_token("1".into()).unwrap().approved_account_ids.is_none());
}

#[test]
#[should_panic(expected = "withdraw the vault before burning")]
fn burn_refused_with_nonzero_vault() {
    let mut c = setup_with_commission();
    call_as(&alice(), ONE_YOCTO);
    c.burn("1".into());
}

#[test]
fn burn_allowed_when_vault_empty() {
    let mut c = setup_with_commission();
    call_as(&bob(), ONE_YOCTO);
    c.burn("2".into());
    assert!(c.nft_token("2".into()).is_none());
    assert_eq!(c.nft_total_supply().0, 1);
    assert_eq!(c.nft_supply_for_owner(bob()).0, 0);
}

// `#[private]` is only enforced in the compiled contract, so strangers calling `on_payout` and
// `nft_resolve_transfer` are tested in tests/sandbox.rs, not here.
