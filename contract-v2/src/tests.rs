//! Unit tests for the V2 registry. Names match rows in THREAT_MODEL.md (V2 section).
//! Cross-contract steps are simulated by calling the callback with a chosen promise result; the
//! sandbox tests (tests/sandbox.rs) run the same flows on a real local NEAR network.
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const PRICE: u128 = NEAR / 10; // 0.1 NEAR
const TICKET: u128 = NEAR / 20; // 0.05 NEAR
const ONE_YOCTO: u128 = 1;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}
fn registry() -> AccountId {
    acc("crewpass-v2")
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
fn pass_account(token: &str) -> AccountId {
    format!("{token}.crewpass-v2.testnet").parse().unwrap()
}

fn ctx(who: &AccountId, deposit: u128, block: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(registry())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_height(block);
    b
}

fn call_as(who: &AccountId, deposit: u128) {
    testing_env!(ctx(who, deposit, 100).build());
}

fn call_at(who: &AccountId, deposit: u128, block: u64) {
    testing_env!(ctx(who, deposit, block).build());
}

fn callback_with(result: PromiseResult) {
    testing_env!(
        ctx(&registry(), 0, 100).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

fn setup() -> Registry {
    call_as(&registry(), 0);
    let mut r = Registry::new(Base58CryptoHash::from([7u8; 32]));
    call_as(&creator(), NEAR);
    // 0.1 NEAR mint, 10% referral, 50% of tickets to members.
    assert_eq!(
        r.create_programme(
            "Study Crew".into(),
            "demo".into(),
            U128(PRICE),
            1_000,
            5_000,
            None
        ),
        1
    );
    r
}

/// Mint and complete the account callback with the given result.
fn mint_with(
    r: &mut Registry,
    who: &AccountId,
    referrer: Option<&str>,
    result: PromiseResult,
) -> TokenId {
    call_as(who, PRICE);
    let id = r.config().next_token_id.0.to_string();
    let _ = r.mint(1, referrer.map(str::to_string));
    callback_with(result);
    r.on_pass_account_created(id.clone());
    id
}

fn mint(r: &mut Registry, who: &AccountId, referrer: Option<&str>) -> TokenId {
    mint_with(r, who, referrer, ok())
}

fn owner(r: &Registry, token: &str) -> AccountId {
    r.nft_token(token.into()).unwrap().owner_id
}

fn info(r: &Registry, token: &str) -> PassView {
    r.pass_info(token.into()).unwrap()
}

fn start_withdraw(r: &mut Registry, who: &AccountId, token: &str, amount: u128) {
    call_as(who, ONE_YOCTO);
    let _ = r.account_transfer(token.into(), who.clone(), U128(amount));
}

fn finish_op(r: &mut Registry, token: &str, result: PromiseResult) -> bool {
    callback_with(result);
    r.on_account_op(token.into(), "transfer".into())
}

fn list(r: &mut Registry, who: &AccountId, token: &str, price: u128) -> U64 {
    call_as(who, LIST_DEPOSIT);
    r.list(token.into(), U128(price))
}

fn buy(r: &mut Registry, who: &AccountId, token: &str, listing: U64, price: u128) {
    call_as(who, price);
    let _ = r.buy(token.into(), listing);
}

fn event(r: &mut Registry, points: u32, capacity: u32) -> u64 {
    call_as(&creator(), NEAR / 10);
    r.create_event(
        1,
        "Live session".into(),
        U128(TICKET),
        capacity,
        points,
        U64(0),
    )
}

fn ticket(r: &mut Registry, who: &AccountId, event_id: u64, token: Option<&str>) {
    call_as(who, TICKET);
    r.buy_ticket(event_id, token.map(str::to_string));
}

fn assert_solvent(r: &Registry) {
    call_as(&registry(), 0);
    let a = r.accounting();
    assert!(a.solvent, "insolvent: liabilities {:?}", a.liabilities);
}

// ------------------------------------------------------------------------------------- mint (A4)

#[test]
fn mint_reserves_token_and_sends_account_batch() {
    let mut r = setup();
    call_as(&alice(), PRICE);
    let _ = r.mint(1, None);
    assert!(r.pending_mint("1".into()).is_some());
    assert!(
        r.nft_token("1".into()).is_none(),
        "no NFT before the account exists"
    );
    assert_eq!(r.accounting().pending_mints.0, PRICE - ACCOUNT_SEED);
}

#[test]
fn mint_success_mints_nft_and_links_account() {
    let mut r = setup();
    let t = mint(&mut r, &alice(), None);
    assert_eq!(owner(&r, &t), alice());
    let i = info(&r, &t);
    assert_eq!(i.account_id, pass_account("1"));
    assert_eq!(i.tier, "Bronze");
    assert_eq!(i.owner_epoch, 1);
    assert!(r.pending_mint(t.clone()).is_none());
    assert_eq!(r.programme(1).unwrap().active_passes, 1);
    let logs = get_logs().join("\n");
    assert!(logs.contains("nft_mint") && logs.contains("pass_account_created"));
    assert_solvent(&r);
}

#[test]
fn mint_failure_refunds_and_owes_seed() {
    let mut r = setup();
    let t = mint_with(&mut r, &alice(), None, PromiseResult::Failed);
    assert!(r.nft_token(t.clone()).is_none());
    assert!(r.pass_info(t).is_none());
    assert_eq!(r.owed_to(alice()).0, ACCOUNT_SEED);
    assert_eq!(r.programme(1).unwrap().minted, 0);
    assert_eq!(r.accounting().pending_mints.0, 0);
    assert!(get_logs().join("\n").contains("pass_mint_failed"));
}

#[test]
#[should_panic(expected = "attach exactly the mint price")]
fn mint_requires_exact_price() {
    let mut r = setup();
    call_as(&alice(), PRICE - 1);
    let _ = r.mint(1, None);
}

#[test]
#[should_panic(expected = "a pass cannot refer its own holder")]
fn self_referral_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    mint(&mut r, &alice(), Some("1"));
}

#[test]
#[should_panic(expected = "referrer pass is from another programme")]
fn referrer_from_other_programme_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&bob(), NEAR);
    r.create_programme("Other".into(), "".into(), U128(PRICE), 0, 0, None);
    call_as(&carol(), PRICE);
    let _ = r.mint(2, Some("1".into()));
}

#[test]
#[should_panic(expected = "programme is sold out")]
fn max_supply_enforced() {
    let mut r = setup();
    call_as(&bob(), NEAR);
    let id = r.create_programme("Tiny".into(), "".into(), U128(PRICE), 0, 0, Some(1));
    call_as(&alice(), PRICE);
    let _ = r.mint(id, None);
    call_as(&carol(), PRICE);
    let _ = r.mint(id, None);
}

#[test]
#[should_panic(expected = "a pass account cannot hold a pass")]
fn pass_account_cannot_mint() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&pass_account("1"), PRICE);
    let _ = r.mint(1, None);
}

#[test]
#[should_panic(expected = "mint price too low")]
fn programme_price_must_cover_account_and_storage() {
    let mut r = setup();
    call_as(&bob(), NEAR);
    r.create_programme("Cheap".into(), "".into(), U128(ACCOUNT_SEED), 0, 0, None);
}

#[test]
fn referral_credits_referrer_pass_and_points() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    mint(&mut r, &bob(), Some("1"));
    let i = info(&r, "1");
    assert_eq!(i.referrals, 1);
    assert_eq!(i.referral_earned.0, PRICE / 10);
    assert_eq!(i.points, REFERRAL_POINTS);
    assert!(get_logs().join("\n").contains("referral_paid"));
    assert_solvent(&r);
}

// ------------------------------------------------------------------------------------- account control (A1, A3, A5, A6, A7, A10)

#[test]
fn account_op_locks_pass() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    assert_eq!(info(&r, "1").lock.unwrap().kind, LockKind::AccountOp);
}

#[test]
#[should_panic(expected = "only the current holder can operate the pass account")]
fn account_op_only_by_owner() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &bob(), "1", 5);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn account_op_requires_one_yocto() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), 0);
    let _ = r.account_transfer("1".into(), alice(), U128(5));
}

#[test]
#[should_panic(expected = "gas above the account-call limit")]
fn account_call_gas_is_capped() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.account_call(
        "1".into(),
        bob(),
        "m".into(),
        Base64VecU8(vec![]),
        U128(0),
        U64(Gas::from_tgas(200).as_gas()),
    );
}

#[test]
#[should_panic(expected = "account operation in progress")]
fn transfer_refused_during_account_op() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    call_as(&alice(), ONE_YOCTO);
    r.nft_transfer(carol(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "account operation in progress")]
fn list_refused_during_account_op() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    list(&mut r, &alice(), "1", NEAR);
}

#[test]
#[should_panic(expected = "account operation in progress")]
fn transfer_call_refused_during_account_op() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(carol(), "1".into(), None, None, "".into());
}

#[test]
#[should_panic(expected = "account operation in progress")]
fn second_account_op_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    start_withdraw(&mut r, &alice(), "1", 5);
}

#[test]
fn callback_clears_lock_on_success_and_failure() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    assert!(finish_op(&mut r, "1", ok()));
    assert!(info(&r, "1").lock.is_none());
    start_withdraw(&mut r, &alice(), "1", 5);
    assert!(!finish_op(&mut r, "1", PromiseResult::Failed));
    assert!(info(&r, "1").lock.is_none());
    assert!(get_logs().join("\n").contains("\"succeeded\":false"));
}

#[test]
fn callback_clears_lock_on_failure() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5);
    finish_op(&mut r, "1", PromiseResult::Failed);
    // Pass is usable again.
    list(&mut r, &alice(), "1", NEAR);
}

#[test]
fn stale_lock_cleared_only_after_timeout_by_owner() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &alice(), "1", 5); // locked at block 100
    call_at(&alice(), 0, 100 + LOCK_TIMEOUT_BLOCKS - 1);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        r.clear_stale_lock("1".into())
    }));
    assert!(early.is_err(), "cleared before the timeout");
    call_at(&bob(), 0, 100 + LOCK_TIMEOUT_BLOCKS);
    let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        r.clear_stale_lock("1".into())
    }));
    assert!(stranger.is_err(), "stranger cleared the lock");
    call_at(&alice(), 0, 100 + LOCK_TIMEOUT_BLOCKS);
    r.clear_stale_lock("1".into());
    assert!(info(&r, "1").lock.is_none());
}

#[test]
#[should_panic(expected = "only account-operation locks can be cleared")]
fn transfer_call_lock_cannot_be_cleared_by_owner() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(carol(), "1".into(), None, None, "".into());
    call_at(&carol(), 0, 100 + LOCK_TIMEOUT_BLOCKS);
    r.clear_stale_lock("1".into());
}

#[test]
#[should_panic(expected = "only the current holder can operate the pass account")]
fn pass_account_cannot_operate_its_own_token() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &pass_account("1"), "1", 5);
}

#[test]
fn buy_moves_control_and_bumps_epoch() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    assert_eq!(owner(&r, "1"), carol());
    let i = info(&r, "1");
    assert_eq!(i.owner_epoch, 2);
    assert_eq!(i.transfers, 1);
    assert!(get_logs().join("\n").contains("control_changed"));
    // Carol now controls the account.
    start_withdraw(&mut r, &carol(), "1", 5);
    assert_solvent(&r);
}

#[test]
#[should_panic(expected = "only the current holder can operate the pass account")]
fn old_owner_account_op_refused_after_sale() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    start_withdraw(&mut r, &alice(), "1", 5);
}

#[test]
#[should_panic(expected = "only the current holder can operate the pass account")]
fn old_owner_account_call_refused_after_sale() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.account_call(
        "1".into(),
        bob(),
        "m".into(),
        Base64VecU8(vec![]),
        U128(0),
        U64(1),
    );
}

#[test]
fn nft_transfer_moves_control() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    r.nft_transfer(bob(), "1".into(), None, None);
    assert_eq!(info(&r, "1").owner_epoch, 2);
    start_withdraw(&mut r, &bob(), "1", 5);
}

// ------------------------------------------------------------------------------------- sale (F7, F8)

#[test]
#[should_panic(expected = "listing changed; check it again")]
fn buy_with_stale_listing_id_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let old = list(&mut r, &alice(), "1", NEAR);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.delist("1".into());
    let _new = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", old, NEAR);
}

#[test]
#[should_panic(expected = "pass is listed; delist it first")]
fn account_op_refused_while_listed() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    list(&mut r, &alice(), "1", NEAR);
    start_withdraw(&mut r, &alice(), "1", 5);
}

#[test]
#[should_panic(expected = "attach exactly the listing price")]
fn buy_with_wrong_amount_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR - 1);
}

#[test]
#[should_panic(expected = "only the current holder can list")]
fn old_owner_cannot_relist_after_sale() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    list(&mut r, &alice(), "1", NEAR);
}

// ------------------------------------------------------------------------------------- frozen passes (A8, A9)

#[test]
#[should_panic(expected = "a pass account cannot hold a pass")]
fn transfer_to_pass_account_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    r.nft_transfer(pass_account("1"), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "a pass account cannot hold a pass")]
fn transfer_call_to_pass_account_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(pass_account("1"), "1".into(), None, None, "".into());
}

#[test]
#[should_panic(expected = "pass is in the middle of nft_transfer_call")]
fn transfer_call_lock_blocks_account_ops() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(carol(), "1".into(), None, None, "".into());
    // Carol (the receiver) owns it for a moment and tries to use the account.
    start_withdraw(&mut r, &carol(), "1", 5);
}

#[test]
fn transfer_call_return_restores_owner_without_new_epoch() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(carol(), "1".into(), None, None, "".into());
    callback_with(PromiseResult::Successful(b"true".to_vec()));
    let kept = r.nft_resolve_transfer(alice(), carol(), "1".into(), None);
    assert!(!kept);
    assert_eq!(owner(&r, "1"), alice());
    assert_eq!(info(&r, "1").owner_epoch, 1);
    assert!(info(&r, "1").lock.is_none());
}

#[test]
fn transfer_call_kept_moves_control() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), ONE_YOCTO);
    let _ = r.nft_transfer_call(carol(), "1".into(), None, None, "".into());
    callback_with(PromiseResult::Successful(b"false".to_vec()));
    assert!(r.nft_resolve_transfer(alice(), carol(), "1".into(), None));
    assert_eq!(info(&r, "1").owner_epoch, 2);
    start_withdraw(&mut r, &carol(), "1", 5);
}

// ------------------------------------------------------------------------------------- tickets and rewards (F1–F6)

#[test]
fn ticket_split_and_reward_index() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    mint(&mut r, &bob(), None);
    let e = event(&mut r, 10, 100);
    let before = r.programme(1).unwrap().treasury.0;
    ticket(&mut r, &carol(), e, None);
    let p = r.programme(1).unwrap();
    let member_share = TICKET / 2;
    assert_eq!(p.reward_index.0, member_share / 2);
    assert_eq!(p.reserved.0, member_share);
    assert!(
        p.treasury.0 > before && p.treasury.0 < before + TICKET / 2,
        "treasury gets creator part minus storage"
    );
    assert_eq!(info(&r, "1").rewards_available.0, member_share / 2);
    assert_eq!(info(&r, "2").rewards_available.0, member_share / 2);
    assert_solvent(&r);
}

#[test]
fn reward_remainder_is_carried_not_lost() {
    let mut r = setup();
    for who in [alice(), bob(), carol()] {
        mint(&mut r, &who, None);
    }
    call_as(&creator(), 100); // 100 yocto across 3 passes
    r.fund_rewards(1);
    let p = r.programme(1).unwrap();
    assert_eq!(p.reward_index.0, 33);
    assert_eq!(p.carry.0, 1);
    assert_eq!(p.reserved.0, 99);
    call_as(&creator(), 2);
    r.fund_rewards(1);
    let p = r.programme(1).unwrap();
    assert_eq!(p.reward_index.0, 34);
    assert_eq!(p.carry.0, 0);
    assert_solvent(&r);
}

#[test]
fn new_pass_gets_no_past_revenue() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    r.fund_rewards(1);
    mint(&mut r, &bob(), None);
    assert_eq!(info(&r, "2").rewards_available.0, 0);
    assert_eq!(info(&r, "1").rewards_available.0, NEAR);
}

#[test]
fn claim_rewards_pays_pass_account_once() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    r.fund_rewards(1);
    call_as(&bob(), 0); // anyone may trigger it; money only goes to the pass account
    let _ = r.claim_rewards("1".into());
    assert_eq!(info(&r, "1").rewards_available.0, 0);
    assert_eq!(info(&r, "1").rewards_claimed.0, NEAR);
    assert_eq!(r.programme(1).unwrap().reserved.0, 0);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&bob(), 0);
        let _ = r.claim_rewards("1".into());
    }));
    assert!(again.is_err(), "second claim paid out");
    assert_solvent(&r);
}

#[test]
fn failed_reward_payment_stays_with_pass() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    r.fund_rewards(1);
    let _ = r.claim_rewards("1".into());
    callback_with(PromiseResult::Failed);
    r.on_pass_payout("1".into(), U128(NEAR), "rewards".into());
    assert_eq!(info(&r, "1").rewards_available.0, NEAR);
    assert_solvent(&r);
}

#[test]
fn rewards_follow_token_on_sale() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    r.fund_rewards(1);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    assert_eq!(
        info(&r, "1").rewards_available.0,
        NEAR,
        "unclaimed rewards moved with the pass"
    );
}

#[test]
#[should_panic(expected = "only the programme creator can fund rewards")]
fn fund_rewards_creator_only() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&alice(), NEAR);
    r.fund_rewards(1);
}

#[test]
fn withdraw_treasury_creator_only_and_bounded() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let treasury = r.programme(1).unwrap().treasury.0;
    assert!(treasury > 0);
    let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&alice(), 0);
        let _ = r.withdraw_treasury(1, None);
    }));
    assert!(stranger.is_err());
    let too_much = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&creator(), 0);
        let _ = r.withdraw_treasury(1, Some(U128(treasury + 1)));
    }));
    assert!(too_much.is_err());
    call_as(&creator(), 0);
    let _ = r.withdraw_treasury(1, None);
    assert_eq!(r.programme(1).unwrap().treasury.0, 0);
    callback_with(PromiseResult::Failed);
    r.on_payout(creator(), U128(treasury), "treasury".into());
    assert_eq!(
        r.owed_to(creator()).0,
        treasury,
        "failed payout is owed, not returned to the treasury"
    );
    assert_solvent(&r);
}

#[test]
#[should_panic(expected = "you already hold a ticket for this event")]
fn duplicate_ticket_refused() {
    let mut r = setup();
    let e = event(&mut r, 0, 10);
    ticket(&mut r, &carol(), e, None);
    ticket(&mut r, &carol(), e, None);
}

#[test]
#[should_panic(expected = "event is sold out")]
fn capacity_enforced() {
    let mut r = setup();
    let e = event(&mut r, 0, 1);
    ticket(&mut r, &carol(), e, None);
    ticket(&mut r, &bob(), e, None);
}

#[test]
#[should_panic(expected = "attach exactly the ticket price")]
fn ticket_requires_exact_price() {
    let mut r = setup();
    let e = event(&mut r, 0, 10);
    call_as(&carol(), TICKET + 1);
    r.buy_ticket(e, None);
}

#[test]
#[should_panic(expected = "only the pass holder can attach a ticket to it")]
fn ticket_attached_only_by_holder() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let e = event(&mut r, 0, 10);
    ticket(&mut r, &bob(), e, Some("1"));
}

#[test]
fn ticket_with_no_passes_goes_to_treasury() {
    let mut r = setup();
    let e = event(&mut r, 0, 10);
    ticket(&mut r, &carol(), e, None);
    assert_eq!(r.programme(1).unwrap().reserved.0, 0);
    assert_solvent(&r);
}

// ------------------------------------------------------------------------------------- engagement and tiers (R1v2, R2v2, F5)

#[test]
#[should_panic(expected = "this pass has no ticket for this event")]
fn check_in_requires_ticket_and_creator() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let e = event(&mut r, 10, 10);
    call_as(&creator(), NEAR / 100);
    r.check_in(e, "1".into());
}

#[test]
#[should_panic(expected = "only the programme creator can check in")]
fn check_in_by_stranger_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let e = event(&mut r, 10, 10);
    ticket(&mut r, &alice(), e, Some("1"));
    call_as(&alice(), NEAR / 100);
    r.check_in(e, "1".into());
}

#[test]
#[should_panic(expected = "already checked in")]
fn double_check_in_refused() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let e = event(&mut r, 10, 10);
    ticket(&mut r, &alice(), e, Some("1"));
    call_as(&creator(), NEAR / 100);
    r.check_in(e, "1".into());
    call_as(&creator(), NEAR / 100);
    r.check_in(e, "1".into());
}

#[test]
fn achievement_unique_and_capped() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR / 100);
    r.award_achievement("1".into(), "lesson-1".into(), 20);
    assert!(r.has_achievement("1".into(), "lesson-1".into()));
    let dup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&creator(), NEAR / 100);
        r.award_achievement("1".into(), "lesson-1".into(), 20);
    }));
    assert!(dup.is_err(), "same achievement twice");
    let big = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&creator(), NEAR / 100);
        r.award_achievement("1".into(), "huge".into(), MAX_ACHIEVEMENT_POINTS + 1);
    }));
    assert!(big.is_err(), "points above the cap");
    let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&alice(), NEAR / 100);
        r.award_achievement("1".into(), "self".into(), 10);
    }));
    assert!(stranger.is_err(), "holder awarded themselves");
    assert_eq!(info(&r, "1").points, 20);
}

#[test]
fn tier_thresholds_and_metadata_update() {
    assert_eq!(TIERS[tier_for(0)].0, "Bronze");
    assert_eq!(TIERS[tier_for(29)].0, "Bronze");
    assert_eq!(TIERS[tier_for(30)].0, "Silver");
    assert_eq!(TIERS[tier_for(80)].0, "Gold");
    assert_eq!(TIERS[tier_for(150)].0, "Platinum");
    assert_eq!(TIERS[tier_for(10_000)].0, "Platinum");

    let mut r = setup();
    mint(&mut r, &alice(), None);
    let e = event(&mut r, 50, 10);
    ticket(&mut r, &alice(), e, Some("1"));
    call_as(&creator(), NEAR / 100);
    r.check_in(e, "1".into());
    let logs = get_logs().join("\n");
    assert!(logs.contains(
        "\"standard\":\"nep171\",\"version\":\"1.2.0\",\"event\":\"nft_metadata_update\""
    ));
    assert!(logs.contains("tier_changed"));
    call_as(&creator(), NEAR / 100);
    r.award_achievement("1".into(), "speaker".into(), 40);
    let i = info(&r, "1");
    assert_eq!((i.tier.as_str(), i.points), ("Gold", 90));
    assert_eq!(i.next_tier.as_deref(), Some("Platinum"));
    assert_eq!(i.points_to_next_tier, Some(60));
    let meta = r.nft_token("1".into()).unwrap().metadata.unwrap();
    assert!(meta.title.unwrap().ends_with("· Gold"));
    assert!(meta.extra.unwrap().contains("\"tier\":\"Gold\""));
    assert!(meta.media.unwrap().starts_with("data:image/svg+xml;utf8,"));
}

#[test]
fn progression_moves_with_the_pass() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR / 100);
    r.award_achievement("1".into(), "speaker".into(), 40);
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    let i = info(&r, "1");
    assert_eq!(
        (i.owner_id, i.tier.as_str(), i.points),
        (carol(), "Silver", 40)
    );
}

// ------------------------------------------------------------------------------------- creator limits (C11), storage (S1)

#[test]
#[should_panic(expected = "only the programme creator can create events")]
fn creator_cannot_touch_other_programme() {
    let mut r = setup();
    call_as(&bob(), NEAR);
    r.create_programme("Bob's".into(), "".into(), U128(PRICE), 0, 0, None);
    call_as(&creator(), NEAR / 10);
    r.create_event(2, "x".into(), U128(TICKET), 10, 0, U64(0));
}

#[test]
#[should_panic(expected = "only the current holder can operate the pass account")]
fn creator_cannot_operate_pass_account() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    start_withdraw(&mut r, &creator(), "1", 5);
}

#[test]
#[should_panic(expected = "for storage")]
fn storage_is_charged_to_the_caller() {
    let mut r = setup();
    call_as(&creator(), 0);
    r.create_event(1, "Free storage?".into(), U128(TICKET), 10, 0, U64(0));
}

#[test]
fn accounting_solvent_after_flows() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    mint(&mut r, &bob(), Some("1"));
    let e = event(&mut r, 10, 10);
    ticket(&mut r, &alice(), e, Some("1"));
    ticket(&mut r, &carol(), e, None);
    call_as(&creator(), NEAR);
    r.fund_rewards(1);
    let _ = r.claim_rewards("2".into());
    let l = list(&mut r, &alice(), "1", NEAR);
    buy(&mut r, &carol(), "1", l, NEAR);
    let a = r.accounting();
    assert!(a.solvent);
    assert_eq!(a.listing_deposits.0, 0);
    assert_eq!(
        a.liabilities.0,
        a.treasury.0
            + a.reserved.0
            + a.carry.0
            + a.owed.0
            + a.listing_deposits.0
            + a.pending_mints.0
    );
}

#[test]
fn creator_content_is_persisted_and_creator_only() {
    let mut r = setup();
    let content = ProgrammeContent {
        label: "Member space".into(),
        summary: "Useful member content".into(),
        companion_name: "Guide".into(),
        companion_tone: "Plain and practical".into(),
        benefits: vec![ContentBenefit {
            text: "Lessons".into(),
            min_tier: 0,
        }],
        posts: vec![ContentPost {
            title: "Start here".into(),
            body: "Lesson one".into(),
            min_tier: 1,
        }],
        knowledge: vec![ContentKnowledge {
            title: "Course".into(),
            body: "Build a project".into(),
        }],
    };
    call_as(&creator(), NEAR / 10);
    r.set_programme_content(1, content.clone());
    assert_eq!(r.programme_content(1), Some(content));
    let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&alice(), NEAR / 10);
        r.set_programme_content(
            1,
            ProgrammeContent {
                label: "hack".into(),
                summary: "".into(),
                companion_name: "x".into(),
                companion_tone: "".into(),
                benefits: vec![],
                posts: vec![],
                knowledge: vec![],
            },
        );
    }));
    assert!(stranger.is_err());
}

#[test]
fn campaign_is_tier_gated_one_time_and_accounted() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    let campaign = r.create_reward_campaign(
        1,
        "Welcome grant".into(),
        U128(NEAR / 100),
        1,
        1,
        U64(0),
        U64(1_000_000),
    );
    assert_eq!(campaign.0, 1);
    assert!(r.accounting().solvent);
    let gated = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&bob(), 0);
        let _ = r.claim_campaign(1, campaign, "1".into());
    }));
    assert!(gated.is_err());
    call_as(&creator(), NEAR / 10);
    r.award_achievement("1".into(), "silver-member".into(), 30);
    call_as(&bob(), 0);
    let _ = r.claim_campaign(1, campaign, "1".into());
    assert!(r.has_claimed_campaign(1, campaign, "1".into()));
    assert_eq!(r.reward_campaign(1, campaign).unwrap().claimed, 1);
    let duplicate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&bob(), 0);
        let _ = r.claim_campaign(1, campaign, "1".into());
    }));
    assert!(duplicate.is_err());
    mint(&mut r, &bob(), None);
    let exhausted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&carol(), 0);
        let _ = r.claim_campaign(1, campaign, "2".into());
    }));
    assert!(exhausted.is_err());
}

#[test]
fn expired_campaign_releases_unused_budget() {
    let mut r = setup();
    call_as(&creator(), NEAR);
    let campaign = r.create_reward_campaign(
        1,
        "Short campaign".into(),
        U128(NEAR / 100),
        2,
        0,
        U64(0),
        U64(1),
    );
    let still_active = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        call_as(&creator(), 0);
        r.close_reward_campaign(1, campaign);
    }));
    assert!(still_active.is_err());

    let mut expired = ctx(&creator(), 0, 101);
    expired.block_timestamp(2_000_000);
    testing_env!(expired.build());
    assert!(r.close_reward_campaign(1, campaign));
    let closed = r.reward_campaign(1, campaign).unwrap();
    assert!(closed.closed);
    assert_eq!(closed.remaining_budget.0, 0);
    assert_eq!(closed.storage_reserve.0, 0);
    assert!(r.accounting().solvent);
}

#[test]
fn campaign_failed_payout_can_be_retried_without_pool_accounting_damage() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    call_as(&creator(), NEAR);
    let campaign = r.create_reward_campaign(
        1,
        "Welcome grant".into(),
        U128(NEAR / 100),
        1,
        0,
        U64(0),
        U64(1_000_000),
    );
    call_as(&bob(), 0);
    let _ = r.claim_campaign(1, campaign, "1".into());
    callback_with(PromiseResult::Failed);
    assert!(!r.on_campaign_payout("1".into(), U128(NEAR / 100)));
    assert_eq!(r.campaign_owed_to("1".into()).0, NEAR / 100);
    assert_eq!(
        r.programme(1).unwrap().reserved.0,
        0,
        "campaign reserve is not pool revenue"
    );
    call_as(&bob(), 0);
    let _ = r.claim_campaign_owed("1".into());
    assert_eq!(r.campaign_owed_to("1".into()).0, 0);
}

#[test]
fn nep199_payout_splits_creator_and_seller_and_transfer_changes_owner() {
    let mut r = setup();
    mint(&mut r, &alice(), None);
    let payout = r.nft_payout("1".into(), U128(NEAR), Some(10));
    assert_eq!(payout.payout.get(&creator()).unwrap().0, NEAR / 20);
    assert_eq!(payout.payout.get(&alice()).unwrap().0, NEAR - NEAR / 20);
    call_as(&alice(), ONE_YOCTO);
    let result = r.nft_transfer_payout(bob(), "1".into(), None, None, U128(NEAR), Some(10));
    assert_eq!(result.payout.get(&creator()).unwrap().0, NEAR / 20);
    assert_eq!(owner(&r, "1"), bob());
    assert_eq!(info(&r, "1").owner_epoch, 2);
}
