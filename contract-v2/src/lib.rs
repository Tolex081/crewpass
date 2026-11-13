//! CrewPass V2 registry.
//!
//! Membership NFTs (NEP-171, NEP-177, NEP-181, NEP-297) where every pass controls its own keyless
//! NEAR account `N.<registry>`. The account runs the immutable `pass-account` code and obeys only
//! this registry; this registry only obeys the pass's current owner. Programmes, paid events and a
//! reward pool pay real NEAR into those accounts. Engagement moves passes through Bronze, Silver, Gold
//! and Platinum with NEP-171 `nft_metadata_update` events.
//!
//! Design: docs/ADR-001-pass-accounts.md. Threats and the tests that prove them: THREAT_MODEL.md (V2).
#![allow(deprecated)] // near_sdk::collections write immediately, so storage can be measured mid-call

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId, BorshStorageKey,
    CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use std::collections::HashMap;

// ------------------------------------------------------------------------------------- settings

/// NEAR sent into each new pass account in the same receipt that creates it.
pub const ACCOUNT_SEED: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
/// Held while a pass is listed; returned to the seller on sale or delist.
pub const LIST_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
/// Part of every mint price that must remain for the pass's storage and the treasury.
pub const MIN_MINT_HEADROOM: u128 = 30_000_000_000_000_000_000_000; // 0.03 NEAR
pub const MIN_TICKET_PRICE: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR
pub const MAX_REFERRAL_BPS: u16 = 2_000;
pub const MAX_MEMBER_SHARE_BPS: u16 = 8_000;
pub const MAX_EVENT_POINTS: u32 = 50;
pub const MAX_ACHIEVEMENT_POINTS: u32 = 50;
pub const REFERRAL_POINTS: u32 = 10;
pub const MAX_EVENT_CAPACITY: u32 = 10_000;
/// Owner may clear an account-operation lock this many blocks after it was taken (backstop only).
pub const LOCK_TIMEOUT_BLOCKS: u64 = 1_200;
/// Highest gas an owner may ask the pass account to forward to a target contract.
pub const MAX_ACCOUNT_CALL_GAS: Gas = Gas::from_tgas(150);

const CREATE_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const OP_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const EXECUTE_OVERHEAD_GAS: Gas = Gas::from_tgas(15);
const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Points needed for each tier, lowest first.
pub const TIERS: [(&str, u32); 4] = [("Bronze", 0), ("Silver", 30), ("Gold", 80), ("Platinum", 150)];

pub fn tier_for(points: u32) -> usize {
    TIERS.iter().rposition(|(_, min)| points >= *min).unwrap_or(0)
}

// ------------------------------------------------------------------------------------- state

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Programmes,
    Events,
    Tickets,
    PassTickets,
    Passes,
    PendingMints,
    Locks,
    Listings,
    Owed,
    Achievements,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Programme {
    pub id: u32,
    pub creator: AccountId,
    pub name: String,
    pub description: String,
    pub mint_price: U128,
    pub referral_bps: u16,
    /// Share of each ticket price paid into the reward pool for all passes of the programme.
    pub member_share_bps: u16,
    pub max_supply: Option<u32>,
    /// Passes minted or being minted (failed mints are subtracted).
    pub minted: u32,
    pub active_passes: u32,
    /// Cumulative reward per pass, in yoctoNEAR. A pass is owed `reward_index - its snapshot`.
    pub reward_index: U128,
    /// Remainder of the last distribution that did not divide evenly; added to the next one.
    pub carry: U128,
    pub treasury: U128,
    /// Rewards credited to passes and not yet paid into their accounts.
    pub reserved: U128,
    pub distributed_total: U128,
    pub claimed_total: U128,
    pub ticket_revenue_total: U128,
    pub funded_total: U128,
    pub events: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub id: u64,
    pub programme_id: u32,
    pub title: String,
    pub price: U128,
    pub capacity: u32,
    pub sold: u32,
    pub points: u32,
    pub starts_at_ms: U64,
    pub checked_in: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    pub event_id: u64,
    pub buyer: AccountId,
    pub token_id: Option<TokenId>,
    pub checked_in: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pass {
    pub programme_id: u32,
    pub owner_epoch: u32,
    pub points: u32,
    pub reward_snapshot: u128,
    /// Rewards whose payment into the pass account failed; claimable again.
    pub unpaid: u128,
    pub referrals: u32,
    pub referral_earned: u128,
    pub rewards_claimed: u128,
    pub transfers: u32,
    pub tickets: u32,
    pub check_ins: u32,
    pub achievements: u32,
    pub minted_at_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingMint {
    pub minter: AccountId,
    pub programme_id: u32,
    pub referrer: Option<TokenId>,
    pub price: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum LockKind {
    AccountOp,
    TransferCall,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Lock {
    pub kind: LockKind,
    pub since_block: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub id: U64,
    pub seller: AccountId,
    pub price: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Totals {
    pub treasury: u128,
    pub reserved: u128,
    pub carry: u128,
    pub owed: u128,
    pub listing_deposits: u128,
    pub pending_mints: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    pass_code_hash: CryptoHash,
    next_token_id: u64,
    next_programme_id: u32,
    next_event_id: u64,
    next_listing_id: u64,
    programmes: LookupMap<u32, Programme>,
    events: LookupMap<u64, Event>,
    /// "<event_id>:<buyer>" → ticket
    tickets: LookupMap<String, Ticket>,
    /// "<event_id>:<token_id>" → buyer
    pass_tickets: LookupMap<String, AccountId>,
    passes: LookupMap<TokenId, Pass>,
    /// "<token_id>:<code>"
    achievements: LookupSet<String>,
    pending_mints: LookupMap<TokenId, PendingMint>,
    locks: LookupMap<TokenId, Lock>,
    listings: LookupMap<TokenId, Listing>,
    owed: LookupMap<AccountId, u128>,
    totals: Totals,
}

#[ext_contract(ext_pass_account)]
pub trait PassAccountExt {
    fn execute_transfer(&self, #[serializer(borsh)] receiver_id: AccountId, #[serializer(borsh)] amount: u128) -> Promise;
    fn execute_call(
        &self,
        #[serializer(borsh)] receiver_id: AccountId,
        #[serializer(borsh)] method_name: String,
        #[serializer(borsh)] args: Vec<u8>,
        #[serializer(borsh)] deposit: u128,
        #[serializer(borsh)] gas: u64,
    ) -> Promise;
}

// ------------------------------------------------------------------------------------- views

#[near(serializers = [json])]
pub struct PassView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub account_id: AccountId,
    pub programme_id: u32,
    pub tier: String,
    pub points: u32,
    pub next_tier: Option<String>,
    pub points_to_next_tier: Option<u32>,
    pub owner_epoch: u32,
    pub lock: Option<Lock>,
    pub listing: Option<Listing>,
    pub rewards_available: U128,
    pub referrals: u32,
    pub referral_earned: U128,
    pub rewards_claimed: U128,
    pub transfers: u32,
    pub tickets: u32,
    pub check_ins: u32,
    pub achievements: u32,
    pub minted_at_ms: U64,
}

#[near(serializers = [json])]
pub struct AccountingView {
    pub balance: U128,
    pub storage_cost: U128,
    pub treasury: U128,
    pub reserved: U128,
    pub carry: U128,
    pub owed: U128,
    pub listing_deposits: U128,
    pub pending_mints: U128,
    pub liabilities: U128,
    pub solvent: bool,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub pass_code_hash: Base58CryptoHash,
    pub account_seed: U128,
    pub list_deposit: U128,
    pub lock_timeout_blocks: U64,
    pub max_account_call_gas: U64,
    pub tiers: Vec<(String, u32)>,
    pub next_token_id: U64,
    pub next_programme_id: u32,
    pub next_event_id: U64,
}

// ------------------------------------------------------------------------------------- contract

#[near]
impl Registry {
    #[init]
    pub fn new(pass_code_hash: Base58CryptoHash) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "CrewPass V2".into(),
            symbol: "CREWPASS".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                env::current_account_id(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                // No NEP-178 approvals: only the owner can move a pass (V1 T13).
                None::<StorageKey>,
            ),
            metadata,
            pass_code_hash: pass_code_hash.into(),
            next_token_id: 1,
            next_programme_id: 1,
            next_event_id: 1,
            next_listing_id: 1,
            programmes: LookupMap::new(StorageKey::Programmes),
            events: LookupMap::new(StorageKey::Events),
            tickets: LookupMap::new(StorageKey::Tickets),
            pass_tickets: LookupMap::new(StorageKey::PassTickets),
            passes: LookupMap::new(StorageKey::Passes),
            achievements: LookupSet::new(StorageKey::Achievements),
            pending_mints: LookupMap::new(StorageKey::PendingMints),
            locks: LookupMap::new(StorageKey::Locks),
            listings: LookupMap::new(StorageKey::Listings),
            owed: LookupMap::new(StorageKey::Owed),
            totals: Totals::default(),
        }
    }

    // --------------------------------------------------------------------------- programmes

    /// Anyone can launch a programme and becomes its creator. Attach enough NEAR for its storage;
    /// the excess is refunded.
    #[payable]
    pub fn create_programme(
        &mut self,
        name: String,
        description: String,
        mint_price: U128,
        referral_bps: u16,
        member_share_bps: u16,
        max_supply: Option<u32>,
    ) -> u32 {
        let creator = env::predecessor_account_id();
        require!(!self.is_pass_account(&creator), "a pass account cannot create a programme");
        require!(!name.is_empty() && name.len() <= 64, "name must be 1 to 64 bytes");
        require!(description.len() <= 280, "description is at most 280 bytes");
        require!(referral_bps <= MAX_REFERRAL_BPS, "referral share above 20%");
        require!(member_share_bps <= MAX_MEMBER_SHARE_BPS, "member share above 80%");
        require!(max_supply.map_or(true, |m| m > 0), "max supply must be positive");
        let referral = mint_price.0 * referral_bps as u128 / 10_000;
        require!(
            mint_price.0 >= ACCOUNT_SEED + referral + MIN_MINT_HEADROOM,
            "mint price too low for the pass account, referral and storage"
        );
        let before = env::storage_usage();
        let id = self.next_programme_id;
        self.next_programme_id += 1;
        let p = Programme {
            id,
            creator: creator.clone(),
            name,
            description,
            mint_price,
            referral_bps,
            member_share_bps,
            max_supply,
            minted: 0,
            active_passes: 0,
            reward_index: U128(0),
            carry: U128(0),
            treasury: U128(0),
            reserved: U128(0),
            distributed_total: U128(0),
            claimed_total: U128(0),
            ticket_revenue_total: U128(0),
            funded_total: U128(0),
            events: 0,
        };
        self.programmes.insert(&id, &p);
        self.charge_storage(before, &creator);
        emit("programme_created", json!({ "programme_id": id, "creator": creator, "name": p.name,
            "mint_price": mint_price, "referral_bps": referral_bps, "member_share_bps": member_share_bps,
            "max_supply": max_supply }));
        id
    }

    // --------------------------------------------------------------------------- mint

    /// Mint a pass for exactly the programme's price. The pass's account is created first; the NFT
    /// exists only once the account does (`on_pass_account_created`).
    #[payable]
    pub fn mint(&mut self, programme_id: u32, referrer_token_id: Option<TokenId>) -> Promise {
        let minter = env::predecessor_account_id();
        require!(!self.is_pass_account(&minter), "a pass account cannot hold a pass");
        let mut p = self.programme_or_panic(programme_id);
        require!(env::attached_deposit().as_yoctonear() == p.mint_price.0, "attach exactly the mint price");
        if let Some(max) = p.max_supply {
            require!(p.minted < max, "programme is sold out");
        }
        if let Some(referrer) = &referrer_token_id {
            let rp = self.passes.get(referrer).unwrap_or_else(|| env::panic_str("unknown referrer pass"));
            require!(rp.programme_id == programme_id, "referrer pass is from another programme");
            require!(self.owner_of(referrer) != minter, "a pass cannot refer its own holder");
        }
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        p.minted += 1;
        self.programmes.insert(&programme_id, &p);
        let price = p.mint_price.0;
        self.pending_mints.insert(
            &token_id,
            &PendingMint { minter: minter.clone(), programme_id, referrer: referrer_token_id.clone(), price },
        );
        // The seed leaves with the account batch; the rest is held until the callback.
        self.totals.pending_mints += price - ACCOUNT_SEED;
        let account = self.pass_account_id(&token_id);
        emit("pass_mint_started", json!({ "token_id": token_id, "account_id": account, "minter": minter,
            "programme_id": programme_id, "referrer_token_id": referrer_token_id }));
        Promise::new(account)
            .create_account()
            .use_global_contract(self.pass_code_hash)
            .transfer(NearToken::from_yoctonear(ACCOUNT_SEED))
            .then(Self::ext(env::current_account_id()).with_static_gas(CREATE_CALLBACK_GAS).on_pass_account_created(token_id))
    }

    /// Finishes a mint. On success the NFT is minted and linked to its account; on failure no NFT
    /// exists, the minter is refunded and the seed (refunded to us by the protocol) is owed to them.
    #[private]
    pub fn on_pass_account_created(&mut self, token_id: TokenId) -> bool {
        let pm = self.pending_mints.get(&token_id).unwrap_or_else(|| env::panic_str("no pending mint"));
        self.pending_mints.remove(&token_id);
        self.totals.pending_mints -= pm.price - ACCOUNT_SEED;
        let mut p = self.programme_or_panic(pm.programme_id);

        if !is_promise_success() {
            p.minted -= 1;
            self.programmes.insert(&p.id, &p);
            self.credit_owed(&pm.minter, ACCOUNT_SEED);
            emit("pass_mint_failed", json!({ "token_id": token_id, "minter": pm.minter,
                "refunded": U128(pm.price - ACCOUNT_SEED), "owed": U128(ACCOUNT_SEED) }));
            self.pay(pm.minter, pm.price - ACCOUNT_SEED, "mint refund").detach();
            return false;
        }

        let before = env::storage_usage();
        let now_ms = env::block_timestamp_ms();
        let pass = Pass {
            programme_id: p.id,
            owner_epoch: 1,
            points: 0,
            reward_snapshot: p.reward_index.0,
            unpaid: 0,
            referrals: 0,
            referral_earned: 0,
            rewards_claimed: 0,
            transfers: 0,
            tickets: 0,
            check_ins: 0,
            achievements: 0,
            minted_at_ms: now_ms,
        };
        let metadata = self.build_metadata(&token_id, &pass, &p, now_ms);
        self.tokens.internal_mint_with_refund(token_id.clone(), pm.minter.clone(), Some(metadata), None);
        self.passes.insert(&token_id, &pass);
        p.active_passes += 1;

        let mut commission = 0;
        if let Some(referrer) = &pm.referrer {
            if let Some(mut rp) = self.passes.get(referrer) {
                commission = pm.price * p.referral_bps as u128 / 10_000;
                rp.referrals += 1;
                rp.referral_earned += commission;
                self.passes.insert(referrer, &rp);
                self.add_points(referrer, REFERRAL_POINTS, "referral");
            }
        }
        let storage = self.storage_cost_since(before);
        let creator_share = (pm.price - ACCOUNT_SEED - commission).saturating_sub(storage);
        p.treasury = U128(p.treasury.0 + creator_share);
        self.totals.treasury += creator_share;
        self.programmes.insert(&p.id, &p);

        let account = self.pass_account_id(&token_id);
        NftMint { owner_id: &pm.minter, token_ids: &[&token_id], memo: None }.emit();
        emit("pass_account_created", json!({ "token_id": token_id, "account_id": account,
            "controller": pm.minter, "owner_epoch": 1, "seed": U128(ACCOUNT_SEED),
            "programme_id": p.id, "storage_cost": U128(storage), "treasury_share": U128(creator_share) }));
        if let Some(referrer) = pm.referrer {
            if commission > 0 {
                emit("referral_paid", json!({ "token_id": referrer, "account_id": self.pass_account_id(&referrer),
                    "from_token_id": token_id, "amount": U128(commission) }));
                self.pay_pass_account(&referrer, commission, "referral").detach();
            }
        }
        true
    }

    // --------------------------------------------------------------------------- pass account control

    /// Send NEAR from the pass's own account. Current owner only. Locks the pass until it settles.
    #[payable]
    pub fn account_transfer(&mut self, token_id: TokenId, receiver_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        self.begin_account_op(&token_id, "transfer", &receiver_id, amount.0);
        ext_pass_account::ext(self.pass_account_id(&token_id))
            .with_static_gas(EXECUTE_OVERHEAD_GAS)
            .execute_transfer(receiver_id, amount.0)
            .then(Self::ext(env::current_account_id()).with_static_gas(OP_CALLBACK_GAS).on_account_op(token_id, "transfer".into()))
    }

    /// Call any contract as the pass's own account. Current owner only. Locks the pass until the
    /// call (and the chain it returns) settles.
    #[payable]
    pub fn account_call(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        deposit: U128,
        gas: U64,
    ) -> Promise {
        assert_one_yocto();
        let forward = Gas::from_gas(gas.0);
        require!(forward <= MAX_ACCOUNT_CALL_GAS, "gas above the account-call limit");
        require!(!method_name.is_empty() && method_name.len() <= 64, "invalid method name");
        self.begin_account_op(&token_id, &format!("call:{method_name}"), &receiver_id, deposit.0);
        ext_pass_account::ext(self.pass_account_id(&token_id))
            .with_static_gas(forward.saturating_add(EXECUTE_OVERHEAD_GAS))
            .execute_call(receiver_id, method_name.clone(), args.0, deposit.0, gas.0)
            .then(Self::ext(env::current_account_id()).with_static_gas(OP_CALLBACK_GAS).on_account_op(token_id, method_name))
    }

    /// Clears the account-operation lock whether the operation succeeded or failed.
    #[private]
    pub fn on_account_op(&mut self, token_id: TokenId, op: String) -> bool {
        let ok = is_promise_success();
        self.locks.remove(&token_id);
        emit("account_op_finished", json!({ "token_id": token_id, "op": op, "succeeded": ok }));
        ok
    }

    /// Backstop for a lock whose callback never ran. Current owner only, only for account
    /// operations, only after `LOCK_TIMEOUT_BLOCKS`.
    pub fn clear_stale_lock(&mut self, token_id: TokenId) {
        require!(env::predecessor_account_id() == self.owner_of(&token_id), "only the current holder can clear a lock");
        let lock = self.locks.get(&token_id).unwrap_or_else(|| env::panic_str("pass is not locked"));
        require!(lock.kind == LockKind::AccountOp, "only account-operation locks can be cleared");
        require!(env::block_height() >= lock.since_block.0 + LOCK_TIMEOUT_BLOCKS, "lock is not stale yet");
        self.locks.remove(&token_id);
        emit("lock_cleared", json!({ "token_id": token_id, "since_block": lock.since_block }));
    }

    // --------------------------------------------------------------------------- events and tickets

    /// Creator only. Attach NEAR for storage; the excess is refunded.
    #[payable]
    pub fn create_event(
        &mut self,
        programme_id: u32,
        title: String,
        price: U128,
        capacity: u32,
        points: u32,
        starts_at_ms: U64,
    ) -> u64 {
        let caller = env::predecessor_account_id();
        let mut p = self.programme_or_panic(programme_id);
        require!(caller == p.creator, "only the programme creator can create events");
        require!(!title.is_empty() && title.len() <= 80, "title must be 1 to 80 bytes");
        require!(price.0 >= MIN_TICKET_PRICE, "ticket price below 0.02 NEAR");
        require!(capacity > 0 && capacity <= MAX_EVENT_CAPACITY, "capacity must be 1 to 10000");
        require!(points <= MAX_EVENT_POINTS, "event points above 50");
        let before = env::storage_usage();
        let id = self.next_event_id;
        self.next_event_id += 1;
        let event = Event { id, programme_id, title, price, capacity, sold: 0, points, starts_at_ms, checked_in: 0 };
        self.events.insert(&id, &event);
        p.events += 1;
        self.programmes.insert(&programme_id, &p);
        self.charge_storage(before, &caller);
        emit("event_created", json!({ "event_id": id, "programme_id": programme_id, "title": event.title,
            "price": price, "capacity": capacity, "points": points, "starts_at_ms": starts_at_ms }));
        id
    }

    /// Buy one ticket for exactly its price. With `token_id`, the ticket is attached to a pass the
    /// caller holds, so attendance counts towards that pass. The member share goes into the
    /// programme's reward pool; the rest (minus storage) to the creator treasury.
    #[payable]
    pub fn buy_ticket(&mut self, event_id: u64, token_id: Option<TokenId>) {
        let buyer = env::predecessor_account_id();
        let mut event = self.events.get(&event_id).unwrap_or_else(|| env::panic_str("unknown event"));
        let price = event.price.0;
        require!(env::attached_deposit().as_yoctonear() == price, "attach exactly the ticket price");
        require!(event.sold < event.capacity, "event is sold out");
        let key = format!("{event_id}:{buyer}");
        require!(self.tickets.get(&key).is_none(), "you already hold a ticket for this event");
        let before = env::storage_usage();
        if let Some(t) = &token_id {
            require!(self.owner_of(t) == buyer, "only the pass holder can attach a ticket to it");
            let mut pass = self.pass_or_panic(t);
            require!(pass.programme_id == event.programme_id, "pass is from another programme");
            let pkey = format!("{event_id}:{t}");
            require!(self.pass_tickets.get(&pkey).is_none(), "this pass already has a ticket for this event");
            self.pass_tickets.insert(&pkey, &buyer);
            pass.tickets += 1;
            self.passes.insert(t, &pass);
        }
        self.tickets.insert(&key, &Ticket { event_id, buyer: buyer.clone(), token_id: token_id.clone(), checked_in: false });
        event.sold += 1;
        self.events.insert(&event_id, &event);

        let mut p = self.programme_or_panic(event.programme_id);
        let storage = self.storage_cost_since(before);
        let member_share = price * p.member_share_bps as u128 / 10_000;
        let creator_part = price - member_share;
        require!(creator_part >= storage, "ticket price does not cover storage");
        p.ticket_revenue_total = U128(p.ticket_revenue_total.0 + price);
        p.treasury = U128(p.treasury.0 + creator_part - storage);
        self.totals.treasury += creator_part - storage;
        emit("ticket_purchased", json!({ "event_id": event_id, "programme_id": p.id, "buyer": buyer,
            "token_id": token_id, "price": U128(price), "member_share": U128(member_share),
            "treasury_share": U128(creator_part - storage) }));
        self.distribute(&mut p, member_share, "ticket");
        self.programmes.insert(&p.id, &p);
    }

    /// Creator confirms that a pass with a ticket attended. Adds the event's points. Attach NEAR
    /// for any storage the metadata update needs; the excess is refunded.
    #[payable]
    pub fn check_in(&mut self, event_id: u64, token_id: TokenId) {
        let caller = env::predecessor_account_id();
        let mut event = self.events.get(&event_id).unwrap_or_else(|| env::panic_str("unknown event"));
        let p = self.programme_or_panic(event.programme_id);
        require!(caller == p.creator, "only the programme creator can check in");
        let buyer = self
            .pass_tickets
            .get(&format!("{event_id}:{token_id}"))
            .unwrap_or_else(|| env::panic_str("this pass has no ticket for this event"));
        let key = format!("{event_id}:{buyer}");
        let mut ticket = self.tickets.get(&key).unwrap_or_else(|| env::panic_str("ticket missing"));
        require!(!ticket.checked_in, "already checked in");
        let before = env::storage_usage();
        ticket.checked_in = true;
        self.tickets.insert(&key, &ticket);
        event.checked_in += 1;
        self.events.insert(&event_id, &event);
        let mut pass = self.pass_or_panic(&token_id);
        pass.check_ins += 1;
        self.passes.insert(&token_id, &pass);
        emit("checked_in", json!({ "event_id": event_id, "token_id": token_id, "points": event.points }));
        self.add_points(&token_id, event.points, "check_in");
        self.charge_storage(before, &caller);
    }

    /// Creator awards a one-off achievement (unique `code` per pass, at most 50 points).
    #[payable]
    pub fn award_achievement(&mut self, token_id: TokenId, code: String, points: u32) {
        let caller = env::predecessor_account_id();
        let mut pass = self.pass_or_panic(&token_id);
        let p = self.programme_or_panic(pass.programme_id);
        require!(caller == p.creator, "only the programme creator can award achievements");
        require!(!code.is_empty() && code.len() <= 32, "code must be 1 to 32 bytes");
        require!(points > 0 && points <= MAX_ACHIEVEMENT_POINTS, "achievement points must be 1 to 50");
        let key = format!("{token_id}:{code}");
        require!(!self.achievements.contains(&key), "achievement already awarded to this pass");
        let before = env::storage_usage();
        self.achievements.insert(&key);
        pass.achievements += 1;
        self.passes.insert(&token_id, &pass);
        emit("achievement_awarded", json!({ "token_id": token_id, "code": code, "points": points }));
        self.add_points(&token_id, points, "achievement");
        self.charge_storage(before, &caller);
    }

    // --------------------------------------------------------------------------- rewards and treasury

    /// Creator funds the reward pool; it is shared equally by every pass of the programme.
    #[payable]
    pub fn fund_rewards(&mut self, programme_id: u32) {
        let mut p = self.programme_or_panic(programme_id);
        require!(env::predecessor_account_id() == p.creator, "only the programme creator can fund rewards");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the amount to distribute");
        require!(p.active_passes > 0, "no passes to reward yet");
        p.funded_total = U128(p.funded_total.0 + amount);
        self.distribute(&mut p, amount, "creator_funded");
        self.programmes.insert(&programme_id, &p);
    }

    /// Pay a pass's accrued rewards into the pass's own account. Anyone may call it: the money can
    /// only go to that account.
    pub fn claim_rewards(&mut self, token_id: TokenId) -> Promise {
        let mut pass = self.pass_or_panic(&token_id);
        let mut p = self.programme_or_panic(pass.programme_id);
        let amount = p.reward_index.0 - pass.reward_snapshot + pass.unpaid;
        require!(amount > 0, "no rewards to claim");
        pass.reward_snapshot = p.reward_index.0;
        pass.unpaid = 0;
        pass.rewards_claimed += amount;
        self.passes.insert(&token_id, &pass);
        p.reserved = U128(p.reserved.0 - amount);
        p.claimed_total = U128(p.claimed_total.0 + amount);
        self.programmes.insert(&p.id, &p);
        self.totals.reserved -= amount;
        emit("rewards_claimed", json!({ "token_id": token_id, "account_id": self.pass_account_id(&token_id),
            "amount": U128(amount) }));
        self.pay_pass_account(&token_id, amount, "rewards")
    }

    /// Creator withdraws from their programme treasury (never more than it holds).
    pub fn withdraw_treasury(&mut self, programme_id: u32, amount: Option<U128>) -> Promise {
        let caller = env::predecessor_account_id();
        let mut p = self.programme_or_panic(programme_id);
        require!(caller == p.creator, "only the programme creator can withdraw the treasury");
        let amount = amount.map_or(p.treasury.0, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= p.treasury.0, "amount exceeds the treasury");
        p.treasury = U128(p.treasury.0 - amount);
        self.programmes.insert(&programme_id, &p);
        self.totals.treasury -= amount;
        emit("treasury_withdrawn", json!({ "programme_id": programme_id, "to": caller, "amount": U128(amount) }));
        self.pay(caller, amount, "treasury")
    }

    /// Pull anything owed to the caller (failed payouts, failed-mint seeds).
    pub fn claim_owed(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.owed.get(&caller).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed.insert(&caller, &0);
        self.totals.owed -= amount;
        emit("owed_claimed", json!({ "account_id": caller, "amount": U128(amount) }));
        self.pay(caller, amount, "owed")
    }

    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128, reason: String) -> bool {
        if is_promise_success() {
            return true;
        }
        self.credit_owed(&to, amount.0);
        emit("payout_failed", json!({ "to": to, "amount": amount, "reason": reason }));
        false
    }

    /// A failed payment into a pass account stays with the pass and can be claimed again.
    #[private]
    pub fn on_pass_payout(&mut self, token_id: TokenId, amount: U128, reason: String) -> bool {
        if is_promise_success() {
            return true;
        }
        let mut pass = self.pass_or_panic(&token_id);
        let mut p = self.programme_or_panic(pass.programme_id);
        pass.unpaid += amount.0;
        self.passes.insert(&token_id, &pass);
        p.reserved = U128(p.reserved.0 + amount.0);
        self.programmes.insert(&p.id, &p);
        self.totals.reserved += amount.0;
        emit("pass_payout_failed", json!({ "token_id": token_id, "amount": amount, "reason": reason }));
        false
    }

    // --------------------------------------------------------------------------- sale

    /// List a pass. While listed, nothing can leave its account and it cannot move except by `buy`.
    #[payable]
    pub fn list(&mut self, token_id: TokenId, price: U128) -> U64 {
        require!(env::attached_deposit().as_yoctonear() == LIST_DEPOSIT, "attach exactly the listing deposit (0.01 NEAR)");
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(&token_id), "only the current holder can list");
        self.assert_idle(&token_id);
        require!(price.0 > 0, "price must be positive");
        let id = U64(self.next_listing_id);
        self.next_listing_id += 1;
        self.listings.insert(&token_id, &Listing { id, seller: caller.clone(), price });
        self.totals.listing_deposits += LIST_DEPOSIT;
        emit("pass_listed", json!({ "token_id": token_id, "listing_id": id, "seller": caller, "price": price }));
        id
    }

    #[payable]
    pub fn delist(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let listing = self.listings.get(&token_id).unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(caller == listing.seller, "only the seller can delist");
        self.listings.remove(&token_id);
        self.totals.listing_deposits -= LIST_DEPOSIT;
        emit("pass_delisted", json!({ "token_id": token_id, "listing_id": listing.id, "seller": caller }));
        self.pay(caller, LIST_DEPOSIT, "listing deposit")
    }

    /// Buy a listed pass for exactly its price. `listing_id` must match the listing the buyer saw.
    /// Ownership, and so control of the pass account, moves to the buyer in this receipt.
    #[payable]
    pub fn buy(&mut self, token_id: TokenId, listing_id: U64) -> Promise {
        let buyer = env::predecessor_account_id();
        require!(!self.is_pass_account(&buyer), "a pass account cannot hold a pass");
        let listing = self.listings.get(&token_id).unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(listing.id == listing_id, "listing changed; check it again");
        require!(self.locks.get(&token_id).is_none(), "pass is locked");
        require!(env::attached_deposit().as_yoctonear() == listing.price.0, "attach exactly the listing price");
        require!(buyer != listing.seller, "seller cannot buy their own pass");
        require!(self.owner_of(&token_id) == listing.seller, "listing is stale");
        self.listings.remove(&token_id);
        self.totals.listing_deposits -= LIST_DEPOSIT;
        self.tokens.internal_transfer(&listing.seller, &buyer, &token_id, None, Some("crewpass sale".into()));
        self.owner_changed(&token_id, &listing.seller, &buyer);
        emit("pass_sold", json!({ "token_id": token_id, "listing_id": listing.id, "seller": listing.seller,
            "buyer": buyer, "price": listing.price, "account_id": self.pass_account_id(&token_id) }));
        self.pay(listing.seller, listing.price.0 + LIST_DEPOSIT, "sale")
    }

    // --------------------------------------------------------------------------- views

    pub fn pass_info(&self, token_id: TokenId) -> Option<PassView> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let pass = self.passes.get(&token_id)?;
        let p = self.programmes.get(&pass.programme_id)?;
        let tier = tier_for(pass.points);
        let next = TIERS.get(tier + 1);
        Some(PassView {
            account_id: self.pass_account_id(&token_id),
            programme_id: pass.programme_id,
            tier: TIERS[tier].0.to_string(),
            points: pass.points,
            next_tier: next.map(|t| t.0.to_string()),
            points_to_next_tier: next.map(|t| t.1 - pass.points),
            owner_epoch: pass.owner_epoch,
            lock: self.locks.get(&token_id),
            listing: self.listings.get(&token_id),
            rewards_available: U128(p.reward_index.0 - pass.reward_snapshot + pass.unpaid),
            referrals: pass.referrals,
            referral_earned: U128(pass.referral_earned),
            rewards_claimed: U128(pass.rewards_claimed),
            transfers: pass.transfers,
            tickets: pass.tickets,
            check_ins: pass.check_ins,
            achievements: pass.achievements,
            minted_at_ms: U64(pass.minted_at_ms),
            owner_id,
            token_id,
        })
    }

    pub fn pass_account_of(&self, token_id: TokenId) -> AccountId {
        self.pass_account_id(&token_id)
    }

    pub fn pending_mint(&self, token_id: TokenId) -> Option<Value> {
        self.pending_mints.get(&token_id).map(|m| {
            json!({ "minter": m.minter, "programme_id": m.programme_id, "referrer_token_id": m.referrer,
                    "price": U128(m.price) })
        })
    }

    pub fn programme(&self, programme_id: u32) -> Option<Programme> {
        self.programmes.get(&programme_id)
    }

    pub fn programmes(&self, from_id: Option<u32>, limit: Option<u32>) -> Vec<Programme> {
        let from = from_id.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_programme_id).filter_map(|id| self.programmes.get(&id)).take(limit as usize).collect()
    }

    pub fn event(&self, event_id: U64) -> Option<Event> {
        self.events.get(&event_id.0)
    }

    pub fn events(&self, programme_id: Option<u32>, from_id: Option<U64>, limit: Option<u32>) -> Vec<Event> {
        let from = from_id.map_or(1, |f| f.0).max(1);
        let limit = limit.unwrap_or(50).min(100) as usize;
        (from..self.next_event_id)
            .filter_map(|id| self.events.get(&id))
            .filter(|e| programme_id.map_or(true, |p| e.programme_id == p))
            .take(limit)
            .collect()
    }

    pub fn ticket_of(&self, event_id: U64, account_id: AccountId) -> Option<Ticket> {
        self.tickets.get(&format!("{}:{account_id}", event_id.0))
    }

    pub fn pass_ticket(&self, event_id: U64, token_id: TokenId) -> Option<Ticket> {
        let buyer = self.pass_tickets.get(&format!("{}:{token_id}", event_id.0))?;
        self.tickets.get(&format!("{}:{buyer}", event_id.0))
    }

    pub fn has_achievement(&self, token_id: TokenId, code: String) -> bool {
        self.achievements.contains(&format!("{token_id}:{code}"))
    }

    pub fn owed_to(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).unwrap_or(0))
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            pass_code_hash: self.pass_code_hash.into(),
            account_seed: U128(ACCOUNT_SEED),
            list_deposit: U128(LIST_DEPOSIT),
            lock_timeout_blocks: U64(LOCK_TIMEOUT_BLOCKS),
            max_account_call_gas: U64(MAX_ACCOUNT_CALL_GAS.as_gas()),
            tiers: TIERS.iter().map(|(n, p)| (n.to_string(), *p)).collect(),
            next_token_id: U64(self.next_token_id),
            next_programme_id: self.next_programme_id,
            next_event_id: U64(self.next_event_id),
        }
    }

    /// Everything the registry owes against what it holds (V4).
    pub fn accounting(&self) -> AccountingView {
        let t = &self.totals;
        let balance = env::account_balance().as_yoctonear();
        let storage_cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let liabilities = t.treasury + t.reserved + t.carry + t.owed + t.listing_deposits + t.pending_mints;
        AccountingView {
            balance: U128(balance),
            storage_cost: U128(storage_cost),
            treasury: U128(t.treasury),
            reserved: U128(t.reserved),
            carry: U128(t.carry),
            owed: U128(t.owed),
            listing_deposits: U128(t.listing_deposits),
            pending_mints: U128(t.pending_mints),
            liabilities: U128(liabilities),
            solvent: balance >= storage_cost + liabilities,
        }
    }
}

// ------------------------------------------------------------------------------------- internals

impl Registry {
    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("unknown pass"))
    }

    fn pass_or_panic(&self, token_id: &TokenId) -> Pass {
        self.passes.get(token_id).unwrap_or_else(|| env::panic_str("unknown pass"))
    }

    fn programme_or_panic(&self, id: u32) -> Programme {
        self.programmes.get(&id).unwrap_or_else(|| env::panic_str("unknown programme"))
    }

    pub fn pass_account_id(&self, token_id: &TokenId) -> AccountId {
        format!("{token_id}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid pass account id"))
    }

    /// Any sub-account of the registry. Only the registry can create them, and only for passes.
    fn is_pass_account(&self, account: &AccountId) -> bool {
        account.as_str().ends_with(&format!(".{}", env::current_account_id()))
    }

    /// V3: a pass with a lock or a listing cannot move or start an account operation.
    fn assert_idle(&self, token_id: &TokenId) {
        if let Some(lock) = self.locks.get(token_id) {
            match lock.kind {
                LockKind::AccountOp => env::panic_str("account operation in progress"),
                LockKind::TransferCall => env::panic_str("pass is in the middle of nft_transfer_call"),
            }
        }
        require!(!self.listings.contains_key(token_id), "pass is listed; delist it first");
    }

    fn begin_account_op(&mut self, token_id: &TokenId, op: &str, receiver: &AccountId, amount: u128) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(token_id), "only the current holder can operate the pass account");
        self.assert_idle(token_id);
        self.locks.insert(token_id, &Lock { kind: LockKind::AccountOp, since_block: U64(env::block_height()) });
        emit("account_op_started", json!({ "token_id": token_id, "account_id": self.pass_account_id(token_id),
            "controller": caller, "op": op, "receiver_id": receiver, "amount": U128(amount) }));
    }

    /// Every ownership change: new epoch, counter, and an explicit control event.
    fn owner_changed(&mut self, token_id: &TokenId, from: &AccountId, to: &AccountId) {
        let mut pass = self.pass_or_panic(token_id);
        pass.owner_epoch += 1;
        pass.transfers += 1;
        self.passes.insert(token_id, &pass);
        emit("control_changed", json!({ "token_id": token_id, "account_id": self.pass_account_id(token_id),
            "previous_controller": from, "controller": to, "owner_epoch": pass.owner_epoch }));
    }

    fn distribute(&mut self, p: &mut Programme, amount: u128, source: &str) {
        let total = amount + p.carry.0;
        self.totals.carry -= p.carry.0;
        if p.active_passes == 0 {
            p.treasury = U128(p.treasury.0 + total);
            self.totals.treasury += total;
            p.carry = U128(0);
            emit("revenue_distributed", json!({ "programme_id": p.id, "source": source, "amount": U128(amount),
                "per_pass": U128(0), "passes": 0, "to_treasury": U128(total) }));
            return;
        }
        let per_pass = total / p.active_passes as u128;
        let credited = per_pass * p.active_passes as u128;
        let carry = total - credited;
        p.reward_index = U128(p.reward_index.0 + per_pass);
        p.reserved = U128(p.reserved.0 + credited);
        p.distributed_total = U128(p.distributed_total.0 + credited);
        p.carry = U128(carry);
        self.totals.reserved += credited;
        self.totals.carry += carry;
        emit("revenue_distributed", json!({ "programme_id": p.id, "source": source, "amount": U128(amount),
            "per_pass": U128(per_pass), "passes": p.active_passes, "carry": U128(carry),
            "reward_index": p.reward_index }));
    }

    fn add_points(&mut self, token_id: &TokenId, points: u32, reason: &str) {
        let mut pass = self.pass_or_panic(token_id);
        let old_tier = tier_for(pass.points);
        pass.points += points;
        let new_tier = tier_for(pass.points);
        self.passes.insert(token_id, &pass);
        if new_tier != old_tier {
            emit("tier_changed", json!({ "token_id": token_id, "from": TIERS[old_tier].0, "to": TIERS[new_tier].0,
                "points": pass.points, "reason": reason }));
        }
        let p = self.programme_or_panic(pass.programme_id);
        let metadata = self.build_metadata(token_id, &pass, &p, env::block_timestamp_ms());
        if let Some(by_id) = &mut self.tokens.token_metadata_by_id {
            by_id.insert(token_id, &metadata);
        }
        // NEP-171 v1.2.0 metadata update event.
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "nep171", "version": "1.2.0", "event": "nft_metadata_update",
                    "data": [{ "token_ids": [token_id] }] })
        ));
    }

    fn build_metadata(&self, token_id: &TokenId, pass: &Pass, p: &Programme, now_ms: u64) -> TokenMetadata {
        let tier = TIERS[tier_for(pass.points)].0;
        TokenMetadata {
            title: Some(format!("{} #{token_id} · {tier}", p.name)),
            description: Some(format!(
                "CrewPass membership. This pass controls the NEAR account {}.",
                self.pass_account_id(token_id)
            )),
            media: Some(tier_art(token_id, tier, pass.points)),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(pass.minted_at_ms.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: Some(now_ms.to_string()),
            extra: Some(
                json!({ "programme_id": p.id, "tier": tier, "points": pass.points,
                        "account_id": self.pass_account_id(token_id), "check_ins": pass.check_ins,
                        "achievements": pass.achievements, "referrals": pass.referrals })
                .to_string(),
            ),
            reference: None,
            reference_hash: None,
        }
    }

    /// Charge the caller for storage added since `before`; refund the rest of the attached deposit.
    fn charge_storage(&mut self, before: u64, payer: &AccountId) {
        let cost = self.storage_cost_since(before);
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, format!("attach at least {cost} yoctoNEAR for storage"));
        if attached > cost {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(attached - cost)).detach();
        }
    }

    fn storage_cost_since(&self, before: u64) -> u128 {
        let used = env::storage_usage().saturating_sub(before);
        env::storage_byte_cost().as_yoctonear() * used as u128
    }

    fn credit_owed(&mut self, account: &AccountId, amount: u128) {
        let owed = self.owed.get(account).unwrap_or(0);
        self.owed.insert(account, &(owed + amount));
        self.totals.owed += amount;
    }

    fn pay(&self, to: AccountId, amount: u128, reason: &str) -> Promise {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_payout(to, U128(amount), reason.to_string()),
        )
    }

    fn pay_pass_account(&self, token_id: &TokenId, amount: u128, reason: &str) -> Promise {
        Promise::new(self.pass_account_id(token_id)).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_pass_payout(token_id.clone(), U128(amount), reason.to_string()),
        )
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "crewpass", "version": "2.0.0", "event": event, "data": [data] })
    ));
}

/// Small on-chain SVG card for wallets, as a data URI. Changes with the tier.
fn tier_art(token_id: &str, tier: &str, points: u32) -> String {
    let (bg, fg) = match tier {
        "Silver" => ("#C9D1DC", "#14181F"),
        "Gold" => ("#F2C14E", "#2A1E05"),
        "Platinum" => ("#9FE3F0", "#062A33"),
        _ => ("#C98A5A", "#1F1208"),
    };
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'><rect width='300' height='400' rx='28' fill='{bg}'/>\
<text x='26' y='58' font-family='sans-serif' font-size='22' fill='{fg}'>CrewPass</text>\
<text x='26' y='330' font-family='sans-serif' font-size='44' font-weight='700' fill='{fg}'>{tier}</text>\
<text x='26' y='368' font-family='sans-serif' font-size='18' fill='{fg}'>#{token_id} · {points} pts</text></svg>"
    );
    let mut out = String::from("data:image/svg+xml;utf8,");
    for c in svg.chars() {
        match c {
            '#' => out.push_str("%23"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '%' => out.push_str("%25"),
            '"' => out.push_str("%22"),
            _ => out.push(c),
        }
    }
    out
}

// ------------------------------------------------------------------------------------- NEP-171 with guards

#[near]
impl NonFungibleTokenCore for Registry {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.assert_idle(&token_id);
        require!(!self.is_pass_account(&receiver_id), "a pass account cannot hold a pass");
        let from = self.owner_of(&token_id);
        self.tokens.nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
        self.owner_changed(&token_id, &from, &receiver_id);
    }

    /// The receiver owns the pass while `nft_on_transfer` runs. The pass is locked until
    /// `nft_resolve_transfer`, so the receiver cannot use the pass account, move or list it.
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.assert_idle(&token_id);
        require!(!self.is_pass_account(&receiver_id), "a pass account cannot hold a pass");
        self.locks.insert(&token_id, &Lock { kind: LockKind::TransferCall, since_block: U64(env::block_height()) });
        emit("transfer_call_locked", json!({ "token_id": token_id, "receiver_id": receiver_id }));
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Registry {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let kept = self.tokens.nft_resolve_transfer(
            previous_owner_id.clone(),
            receiver_id.clone(),
            token_id.clone(),
            approved_account_ids,
        );
        self.locks.remove(&token_id);
        if kept {
            self.owner_changed(&token_id, &previous_owner_id, &receiver_id);
        }
        emit("transfer_call_unlocked", json!({ "token_id": token_id, "kept_by_receiver": kept }));
        kept
    }
}

#[near]
impl NonFungibleTokenEnumeration for Registry {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Registry {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
