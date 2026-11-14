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

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
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
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId,
    BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
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
pub const CREATOR_ROYALTY_BPS: u16 = 500;
pub const MAX_CAMPAIGN_CLAIMS: u32 = 1_000;
pub const MAX_CAMPAIGNS_PER_PROGRAMME: u64 = 100;
const CAMPAIGN_CLAIM_STORAGE_BYTES: u128 = 512;

const CREATE_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const OP_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const EXECUTE_OVERHEAD_GAS: Gas = Gas::from_tgas(15);
const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Points needed for each tier, lowest first.
pub const TIERS: [(&str, u32); 4] = [
    ("Bronze", 0),
    ("Silver", 30),
    ("Gold", 80),
    ("Platinum", 150),
];

pub fn tier_for(points: u32) -> usize {
    TIERS
        .iter()
        .rposition(|(_, min)| points >= *min)
        .unwrap_or(0)
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
    // Append new storage prefixes only. Existing enum discriminants are part of deployed state.
    ProgrammeContent,
    Campaigns,
    CampaignSequences,
    CampaignClaims,
    CampaignOwed,
}

/// Content entered by a programme's creator and stored with the registry.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ProgrammeContent {
    pub label: String,
    pub summary: String,
    pub companion_name: String,
    pub companion_tone: String,
    pub benefits: Vec<ContentBenefit>,
    pub posts: Vec<ContentPost>,
    pub knowledge: Vec<ContentKnowledge>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ContentBenefit {
    pub text: String,
    pub min_tier: u8,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ContentPost {
    pub title: String,
    pub body: String,
    pub min_tier: u8,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ContentKnowledge {
    pub title: String,
    pub body: String,
}

/// Bounded, creator-funded campaign. The budget is reserved at creation; each pass can claim once.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RewardCampaign {
    pub id: U64,
    pub programme_id: u32,
    pub title: String,
    pub reward_per_pass: U128,
    pub max_claims: u32,
    pub claimed: u32,
    pub min_tier: u8,
    pub starts_at_ms: U64,
    pub ends_at_ms: U64,
    pub remaining_budget: U128,
    pub storage_reserve: U128,
    pub closed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct NftPayout {
    pub payout: HashMap<AccountId, U128>,
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
    fn execute_transfer(
        &self,
        #[serializer(borsh)] receiver_id: AccountId,
        #[serializer(borsh)] amount: u128,
    ) -> Promise;
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
    pub creator_royalty_bps: u16,
    pub storage_byte_cost: U128,
    pub campaign_claim_storage_bytes: u32,
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
    fn payout_for(
        &self,
        token_id: &TokenId,
        balance: u128,
        max_len_payout: Option<u32>,
    ) -> NftPayout {
        let owner = self.owner_of(token_id);
        let pass = self.pass_or_panic(token_id);
        let programme = self.programme_or_panic(pass.programme_id);
        // Split before multiplying so even U128::MAX balances cannot overflow.
        let royalty = (balance / 10_000) * CREATOR_ROYALTY_BPS as u128
            + ((balance % 10_000) * CREATOR_ROYALTY_BPS as u128) / 10_000;
        let mut payout = HashMap::new();
        if programme.creator == owner {
            payout.insert(owner, U128(balance));
        } else {
            if royalty > 0 {
                payout.insert(programme.creator, U128(royalty));
            }
            payout.insert(owner, U128(balance - royalty));
        }
        let max_len = max_len_payout.unwrap_or(10);
        require!(
            payout.len() <= max_len as usize,
            "payout exceeds max_len_payout"
        );
        NftPayout { payout }
    }

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
        require!(
            !self.is_pass_account(&creator),
            "a pass account cannot create a programme"
        );
        require!(
            !name.is_empty() && name.len() <= 64,
            "name must be 1 to 64 bytes"
        );
        require!(description.len() <= 280, "description is at most 280 bytes");
        require!(referral_bps <= MAX_REFERRAL_BPS, "referral share above 20%");
        require!(
            member_share_bps <= MAX_MEMBER_SHARE_BPS,
            "member share above 80%"
        );
        require!(
            max_supply.map_or(true, |m| m > 0),
            "max supply must be positive"
        );
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
        emit(
            "programme_created",
            json!({ "programme_id": id, "creator": creator, "name": p.name,
            "mint_price": mint_price, "referral_bps": referral_bps, "member_share_bps": member_share_bps,
            "max_supply": max_supply }),
        );
        id
    }

    // --------------------------------------------------------------------------- mint

    /// Mint a pass for exactly the programme's price. The pass's account is created first; the NFT
    /// exists only once the account does (`on_pass_account_created`).
    #[payable]
    pub fn mint(&mut self, programme_id: u32, referrer_token_id: Option<TokenId>) -> Promise {
        let minter = env::predecessor_account_id();
        require!(
            !self.is_pass_account(&minter),
            "a pass account cannot hold a pass"
        );
        let mut p = self.programme_or_panic(programme_id);
        require!(
            env::attached_deposit().as_yoctonear() == p.mint_price.0,
            "attach exactly the mint price"
        );
        if let Some(max) = p.max_supply {
            require!(p.minted < max, "programme is sold out");
        }
        if let Some(referrer) = &referrer_token_id {
            let rp = self
                .passes
                .get(referrer)
                .unwrap_or_else(|| env::panic_str("unknown referrer pass"));
            require!(
                rp.programme_id == programme_id,
                "referrer pass is from another programme"
            );
            require!(
                self.owner_of(referrer) != minter,
                "a pass cannot refer its own holder"
            );
        }
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        p.minted += 1;
        self.programmes.insert(&programme_id, &p);
        let price = p.mint_price.0;
        self.pending_mints.insert(
            &token_id,
            &PendingMint {
                minter: minter.clone(),
                programme_id,
                referrer: referrer_token_id.clone(),
                price,
            },
        );
        // The seed leaves with the account batch; the rest is held until the callback.
        self.totals.pending_mints += price - ACCOUNT_SEED;
        let account = self.pass_account_id(&token_id);
        emit(
            "pass_mint_started",
            json!({ "token_id": token_id, "account_id": account, "minter": minter,
            "programme_id": programme_id, "referrer_token_id": referrer_token_id }),
        );
        Promise::new(account)
            .create_account()
            .use_global_contract(self.pass_code_hash)
            .transfer(NearToken::from_yoctonear(ACCOUNT_SEED))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CREATE_CALLBACK_GAS)
                    .on_pass_account_created(token_id),
            )
    }

    /// Finishes a mint. On success the NFT is minted and linked to its account; on failure no NFT
    /// exists, the minter is refunded and the seed (refunded to us by the protocol) is owed to them.
    #[private]
    pub fn on_pass_account_created(&mut self, token_id: TokenId) -> bool {
        let pm = self
            .pending_mints
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("no pending mint"));
        self.pending_mints.remove(&token_id);
        self.totals.pending_mints -= pm.price - ACCOUNT_SEED;
        let mut p = self.programme_or_panic(pm.programme_id);

        if !is_promise_success() {
            p.minted -= 1;
            self.programmes.insert(&p.id, &p);
            self.credit_owed(&pm.minter, ACCOUNT_SEED);
            emit(
                "pass_mint_failed",
                json!({ "token_id": token_id, "minter": pm.minter,
                "refunded": U128(pm.price - ACCOUNT_SEED), "owed": U128(ACCOUNT_SEED) }),
            );
            self.pay(pm.minter, pm.price - ACCOUNT_SEED, "mint refund")
                .detach();
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
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            pm.minter.clone(),
            Some(metadata),
            None,
        );
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
        NftMint {
            owner_id: &pm.minter,
            token_ids: &[&token_id],
            memo: None,
        }
        .emit();
        emit(
            "pass_account_created",
            json!({ "token_id": token_id, "account_id": account,
            "controller": pm.minter, "owner_epoch": 1, "seed": U128(ACCOUNT_SEED),
            "programme_id": p.id, "storage_cost": U128(storage), "treasury_share": U128(creator_share) }),
        );
        if let Some(referrer) = pm.referrer {
            if commission > 0 {
                emit(
                    "referral_paid",
                    json!({ "token_id": referrer, "account_id": self.pass_account_id(&referrer),
                    "from_token_id": token_id, "amount": U128(commission) }),
                );
                self.pay_pass_account(&referrer, commission, "referral")
                    .detach();
            }
        }
        true
    }

    // --------------------------------------------------------------------------- pass account control

    /// Send NEAR from the pass's own account. Current owner only. Locks the pass until it settles.
    #[payable]
    pub fn account_transfer(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        amount: U128,
    ) -> Promise {
        assert_one_yocto();
        self.begin_account_op(&token_id, "transfer", &receiver_id, amount.0);
        ext_pass_account::ext(self.pass_account_id(&token_id))
            .with_static_gas(EXECUTE_OVERHEAD_GAS)
            .execute_transfer(receiver_id, amount.0)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(OP_CALLBACK_GAS)
                    .on_account_op(token_id, "transfer".into()),
            )
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
        require!(
            forward <= MAX_ACCOUNT_CALL_GAS,
            "gas above the account-call limit"
        );
        require!(
            !method_name.is_empty() && method_name.len() <= 64,
            "invalid method name"
        );
        self.begin_account_op(
            &token_id,
            &format!("call:{method_name}"),
            &receiver_id,
            deposit.0,
        );
        ext_pass_account::ext(self.pass_account_id(&token_id))
            .with_static_gas(forward.saturating_add(EXECUTE_OVERHEAD_GAS))
            .execute_call(receiver_id, method_name.clone(), args.0, deposit.0, gas.0)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(OP_CALLBACK_GAS)
                    .on_account_op(token_id, method_name),
            )
    }

    /// Clears the account-operation lock whether the operation succeeded or failed.
    #[private]
    pub fn on_account_op(&mut self, token_id: TokenId, op: String) -> bool {
        let ok = is_promise_success();
        self.locks.remove(&token_id);
        emit(
            "account_op_finished",
            json!({ "token_id": token_id, "op": op, "succeeded": ok }),
        );
        ok
    }

    /// Backstop for a lock whose callback never ran. Current owner only, only for account
    /// operations, only after `LOCK_TIMEOUT_BLOCKS`.
    pub fn clear_stale_lock(&mut self, token_id: TokenId) {
        require!(
            env::predecessor_account_id() == self.owner_of(&token_id),
            "only the current holder can clear a lock"
        );
        let lock = self
            .locks
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("pass is not locked"));
        require!(
            lock.kind == LockKind::AccountOp,
            "only account-operation locks can be cleared"
        );
        require!(
            env::block_height() >= lock.since_block.0 + LOCK_TIMEOUT_BLOCKS,
            "lock is not stale yet"
        );
        self.locks.remove(&token_id);
        emit(
            "lock_cleared",
            json!({ "token_id": token_id, "since_block": lock.since_block }),
        );
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
        require!(
            caller == p.creator,
            "only the programme creator can create events"
        );
        require!(
            !title.is_empty() && title.len() <= 80,
            "title must be 1 to 80 bytes"
        );
        require!(price.0 >= MIN_TICKET_PRICE, "ticket price below 0.02 NEAR");
        require!(
            capacity > 0 && capacity <= MAX_EVENT_CAPACITY,
            "capacity must be 1 to 10000"
        );
        require!(points <= MAX_EVENT_POINTS, "event points above 50");
        let before = env::storage_usage();
        let id = self.next_event_id;
        self.next_event_id += 1;
        let event = Event {
            id,
            programme_id,
            title,
            price,
            capacity,
            sold: 0,
            points,
            starts_at_ms,
            checked_in: 0,
        };
        self.events.insert(&id, &event);
        p.events += 1;
        self.programmes.insert(&programme_id, &p);
        self.charge_storage(before, &caller);
        emit(
            "event_created",
            json!({ "event_id": id, "programme_id": programme_id, "title": event.title,
            "price": price, "capacity": capacity, "points": points, "starts_at_ms": starts_at_ms }),
        );
        id
    }

    /// Buy one ticket for exactly its price. With `token_id`, the ticket is attached to a pass the
    /// caller holds, so attendance counts towards that pass. The member share goes into the
    /// programme's reward pool; the rest (minus storage) to the creator treasury.
    #[payable]
    pub fn buy_ticket(&mut self, event_id: u64, token_id: Option<TokenId>) {
        let buyer = env::predecessor_account_id();
        let mut event = self
            .events
            .get(&event_id)
            .unwrap_or_else(|| env::panic_str("unknown event"));
        let price = event.price.0;
        require!(
            env::attached_deposit().as_yoctonear() == price,
            "attach exactly the ticket price"
        );
        require!(event.sold < event.capacity, "event is sold out");
        let key = format!("{event_id}:{buyer}");
        require!(
            self.tickets.get(&key).is_none(),
            "you already hold a ticket for this event"
        );
        let before = env::storage_usage();
        if let Some(t) = &token_id {
            require!(
                self.owner_of(t) == buyer,
                "only the pass holder can attach a ticket to it"
            );
            let mut pass = self.pass_or_panic(t);
            require!(
                pass.programme_id == event.programme_id,
                "pass is from another programme"
            );
            let pkey = format!("{event_id}:{t}");
            require!(
                self.pass_tickets.get(&pkey).is_none(),
                "this pass already has a ticket for this event"
            );
            self.pass_tickets.insert(&pkey, &buyer);
            pass.tickets += 1;
            self.passes.insert(t, &pass);
        }
        self.tickets.insert(
            &key,
            &Ticket {
                event_id,
                buyer: buyer.clone(),
                token_id: token_id.clone(),
                checked_in: false,
            },
        );
        event.sold += 1;
        self.events.insert(&event_id, &event);

        let mut p = self.programme_or_panic(event.programme_id);
        let storage = self.storage_cost_since(before);
        let member_share = price * p.member_share_bps as u128 / 10_000;
        let creator_part = price - member_share;
        require!(
            creator_part >= storage,
            "ticket price does not cover storage"
        );
        p.ticket_revenue_total = U128(p.ticket_revenue_total.0 + price);
        p.treasury = U128(p.treasury.0 + creator_part - storage);
        self.totals.treasury += creator_part - storage;
        emit(
            "ticket_purchased",
            json!({ "event_id": event_id, "programme_id": p.id, "buyer": buyer,
            "token_id": token_id, "price": U128(price), "member_share": U128(member_share),
            "treasury_share": U128(creator_part - storage) }),
        );
        self.distribute(&mut p, member_share, "ticket");
        self.programmes.insert(&p.id, &p);
    }

    /// Creator confirms that a pass with a ticket attended. Adds the event's points. Attach NEAR
    /// for any storage the metadata update needs; the excess is refunded.
    #[payable]
    pub fn check_in(&mut self, event_id: u64, token_id: TokenId) {
        let caller = env::predecessor_account_id();
        let mut event = self
            .events
            .get(&event_id)
            .unwrap_or_else(|| env::panic_str("unknown event"));
        let p = self.programme_or_panic(event.programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can check in"
        );
        let buyer = self
            .pass_tickets
            .get(&format!("{event_id}:{token_id}"))
            .unwrap_or_else(|| env::panic_str("this pass has no ticket for this event"));
        let key = format!("{event_id}:{buyer}");
        let mut ticket = self
            .tickets
            .get(&key)
            .unwrap_or_else(|| env::panic_str("ticket missing"));
        require!(!ticket.checked_in, "already checked in");
        let before = env::storage_usage();
        ticket.checked_in = true;
        self.tickets.insert(&key, &ticket);
        event.checked_in += 1;
        self.events.insert(&event_id, &event);
        let mut pass = self.pass_or_panic(&token_id);
        pass.check_ins += 1;
        self.passes.insert(&token_id, &pass);
        emit(
            "checked_in",
            json!({ "event_id": event_id, "token_id": token_id, "points": event.points }),
        );
        self.add_points(&token_id, event.points, "check_in");
        self.charge_storage(before, &caller);
    }

    /// Creator awards a one-off achievement (unique `code` per pass, at most 50 points).
    #[payable]
    pub fn award_achievement(&mut self, token_id: TokenId, code: String, points: u32) {
        let caller = env::predecessor_account_id();
        let mut pass = self.pass_or_panic(&token_id);
        let p = self.programme_or_panic(pass.programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can award achievements"
        );
        require!(
            !code.is_empty() && code.len() <= 32,
            "code must be 1 to 32 bytes"
        );
        require!(
            points > 0 && points <= MAX_ACHIEVEMENT_POINTS,
            "achievement points must be 1 to 50"
        );
        let key = format!("{token_id}:{code}");
        require!(
            !self.achievements.contains(&key),
            "achievement already awarded to this pass"
        );
        let before = env::storage_usage();
        self.achievements.insert(&key);
        pass.achievements += 1;
        self.passes.insert(&token_id, &pass);
        emit(
            "achievement_awarded",
            json!({ "token_id": token_id, "code": code, "points": points }),
        );
        self.add_points(&token_id, points, "achievement");
        self.charge_storage(before, &caller);
    }

    // ------------------------------------------------------------------------ creator content

    /// Store member content on chain. Each benefit/post tier is an index into TIERS.
    #[payable]
    pub fn set_programme_content(&mut self, programme_id: u32, content: ProgrammeContent) {
        let caller = env::predecessor_account_id();
        let p = self.programme_or_panic(programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can edit content"
        );
        require!(
            !content.label.is_empty() && content.label.len() <= 80,
            "label must be 1 to 80 bytes"
        );
        require!(
            content.summary.len() <= 1_000,
            "summary is at most 1000 bytes"
        );
        require!(
            !content.companion_name.is_empty() && content.companion_name.len() <= 64,
            "companion name must be 1 to 64 bytes"
        );
        require!(
            content.companion_tone.len() <= 280,
            "companion tone is at most 280 bytes"
        );
        require!(
            content.benefits.len() <= 20
                && content.posts.len() <= 50
                && content.knowledge.len() <= 50,
            "too many content entries"
        );
        require!(
            content.benefits.iter().all(|x| !x.text.is_empty()
                && x.text.len() <= 280
                && x.min_tier < TIERS.len() as u8),
            "invalid benefit"
        );
        require!(
            content.posts.iter().all(|x| !x.title.is_empty()
                && x.title.len() <= 120
                && x.body.len() <= 10_000
                && x.min_tier < TIERS.len() as u8),
            "invalid post"
        );
        require!(
            content
                .knowledge
                .iter()
                .all(|x| !x.title.is_empty() && x.title.len() <= 120 && x.body.len() <= 4_000),
            "invalid knowledge entry"
        );
        let before = env::storage_usage();
        LookupMap::<u32, ProgrammeContent>::new(StorageKey::ProgrammeContent)
            .insert(&programme_id, &content);
        self.charge_storage(before, &caller);
        emit(
            "programme_content_updated",
            json!({ "programme_id": programme_id }),
        );
    }

    pub fn programme_content(&self, programme_id: u32) -> Option<ProgrammeContent> {
        LookupMap::<u32, ProgrammeContent>::new(StorageKey::ProgrammeContent).get(&programme_id)
    }

    // ------------------------------------------------------------------------ reward campaigns

    /// Create a tier-gated campaign with an expiry. Attach reward_per_pass * max_claims plus
    /// storage for the campaign and its one-time claim markers. Unused funds are reclaimable after
    /// expiry or when the campaign reaches its claim limit.
    #[payable]
    pub fn create_reward_campaign(
        &mut self,
        programme_id: u32,
        title: String,
        reward_per_pass: U128,
        max_claims: u32,
        min_tier: u8,
        starts_at_ms: U64,
        ends_at_ms: U64,
    ) -> U64 {
        let caller = env::predecessor_account_id();
        let p = self.programme_or_panic(programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can create campaigns"
        );
        require!(
            !title.is_empty() && title.len() <= 80,
            "title must be 1 to 80 bytes"
        );
        require!(reward_per_pass.0 > 0, "reward per pass must be positive");
        require!(
            max_claims > 0 && max_claims <= MAX_CAMPAIGN_CLAIMS,
            "max claims must be 1 to 1000"
        );
        require!(min_tier < TIERS.len() as u8, "unknown minimum tier");
        require!(
            starts_at_ms.0 < ends_at_ms.0 && ends_at_ms.0 > env::block_timestamp_ms(),
            "campaign dates are invalid or already expired"
        );
        let budget = reward_per_pass
            .0
            .checked_mul(max_claims as u128)
            .unwrap_or_else(|| env::panic_str("campaign budget overflow"));
        let claim_reserve = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(CAMPAIGN_CLAIM_STORAGE_BYTES)
            .and_then(|x| x.checked_mul(max_claims as u128))
            .unwrap_or_else(|| env::panic_str("campaign storage reserve overflow"));
        let mut sequences = LookupMap::<u32, u64>::new(StorageKey::CampaignSequences);
        let id = sequences
            .get(&programme_id)
            .unwrap_or(0)
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("campaign id overflow"));
        require!(
            id <= MAX_CAMPAIGNS_PER_PROGRAMME,
            "programme campaign limit reached"
        );
        let key = campaign_key(programme_id, id);
        let before = env::storage_usage();
        let mut campaign = RewardCampaign {
            id: U64(id),
            programme_id,
            title,
            reward_per_pass,
            max_claims,
            claimed: 0,
            min_tier,
            starts_at_ms,
            ends_at_ms,
            remaining_budget: U128(budget),
            storage_reserve: U128(claim_reserve),
            closed: false,
        };
        LookupMap::<String, RewardCampaign>::new(StorageKey::Campaigns).insert(&key, &campaign);
        sequences.insert(&programme_id, &id);
        let storage = self.storage_cost_since(before);
        let required = budget
            .checked_add(claim_reserve)
            .and_then(|x| x.checked_add(storage))
            .unwrap_or_else(|| env::panic_str("campaign funding overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= required,
            format!("attach at least {required} yoctoNEAR for campaign funding and storage")
        );
        self.totals.reserved += budget + claim_reserve;
        campaign.storage_reserve = U128(claim_reserve);
        emit(
            "reward_campaign_created",
            json!({ "programme_id": programme_id, "campaign_id": id,
            "budget": U128(budget), "reward_per_pass": reward_per_pass, "max_claims": max_claims,
            "min_tier": TIERS[min_tier as usize].0, "starts_at_ms": starts_at_ms, "ends_at_ms": ends_at_ms }),
        );
        if attached > required {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached - required))
                .detach();
        }
        U64(id)
    }

    pub fn reward_campaign(&self, programme_id: u32, campaign_id: U64) -> Option<RewardCampaign> {
        LookupMap::<String, RewardCampaign>::new(StorageKey::Campaigns)
            .get(&campaign_key(programme_id, campaign_id.0))
    }

    pub fn reward_campaigns(&self, programme_id: u32) -> Vec<RewardCampaign> {
        let next = LookupMap::<u32, u64>::new(StorageKey::CampaignSequences)
            .get(&programme_id)
            .unwrap_or(0);
        let campaigns = LookupMap::<String, RewardCampaign>::new(StorageKey::Campaigns);
        (1..=next)
            .filter_map(|id| campaigns.get(&campaign_key(programme_id, id)))
            .collect()
    }

    pub fn has_claimed_campaign(
        &self,
        programme_id: u32,
        campaign_id: U64,
        token_id: TokenId,
    ) -> bool {
        LookupSet::<String>::new(StorageKey::CampaignClaims).contains(&campaign_claim_key(
            programme_id,
            campaign_id.0,
            &token_id,
        ))
    }

    /// Anyone can trigger a valid claim; value always goes to the pass account. Claim storage is
    /// funded from the campaign reserve, and the claim lock is token-scoped and one-time.
    pub fn claim_campaign(
        &mut self,
        programme_id: u32,
        campaign_id: U64,
        token_id: TokenId,
    ) -> Promise {
        let key = campaign_key(programme_id, campaign_id.0);
        let mut campaigns = LookupMap::<String, RewardCampaign>::new(StorageKey::Campaigns);
        let mut campaign = campaigns
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown campaign"));
        require!(!campaign.closed, "campaign is closed");
        let now = env::block_timestamp_ms();
        require!(
            now >= campaign.starts_at_ms.0 && now < campaign.ends_at_ms.0,
            "campaign is not active"
        );
        require!(
            campaign.claimed < campaign.max_claims,
            "campaign has no claims remaining"
        );
        let pass = self.pass_or_panic(&token_id);
        require!(
            pass.programme_id == programme_id,
            "pass is from another programme"
        );
        require!(
            tier_for(pass.points) >= campaign.min_tier as usize,
            "pass does not meet the campaign tier"
        );
        let marker = campaign_claim_key(programme_id, campaign_id.0, &token_id);
        let mut claimed = LookupSet::<String>::new(StorageKey::CampaignClaims);
        require!(
            !claimed.contains(&marker),
            "pass already claimed this campaign"
        );
        let before = env::storage_usage();
        claimed.insert(&marker);
        let marker_storage = self.storage_cost_since(before);
        let claim_allowance =
            env::storage_byte_cost().as_yoctonear() * CAMPAIGN_CLAIM_STORAGE_BYTES;
        require!(
            marker_storage <= claim_allowance && marker_storage <= campaign.storage_reserve.0,
            "campaign claim storage reserve exceeded"
        );
        campaign.claimed += 1;
        campaign.remaining_budget = U128(campaign.remaining_budget.0 - campaign.reward_per_pass.0);
        campaign.storage_reserve = U128(campaign.storage_reserve.0 - marker_storage);
        campaigns.insert(&key, &campaign);
        self.totals.reserved -= campaign.reward_per_pass.0 + marker_storage;
        // on_pass_payout records this as unpaid if transfer fails; it remains claimable then.
        emit(
            "campaign_claimed",
            json!({ "programme_id": programme_id, "campaign_id": campaign_id,
            "token_id": token_id, "account_id": self.pass_account_id(&token_id), "amount": campaign.reward_per_pass }),
        );
        self.pay_campaign_account(&token_id, campaign.reward_per_pass.0)
    }

    pub fn campaign_owed_to(&self, token_id: TokenId) -> U128 {
        U128(
            LookupMap::<TokenId, u128>::new(StorageKey::CampaignOwed)
                .get(&token_id)
                .unwrap_or(0),
        )
    }

    /// Retry a campaign payout that previously failed. Anyone may trigger it; funds still go only
    /// to the pass account.
    pub fn claim_campaign_owed(&mut self, token_id: TokenId) -> Promise {
        let mut owed = LookupMap::<TokenId, u128>::new(StorageKey::CampaignOwed);
        let amount = owed.get(&token_id).unwrap_or(0);
        require!(amount > 0, "no campaign rewards are owed");
        owed.insert(&token_id, &0);
        self.totals.reserved -= amount;
        self.pay_campaign_account(&token_id, amount)
    }

    /// Creator reclaims unclaimed funds only after expiry or after every claim slot is used.
    pub fn close_reward_campaign(&mut self, programme_id: u32, campaign_id: U64) -> bool {
        let caller = env::predecessor_account_id();
        let p = self.programme_or_panic(programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can close campaigns"
        );
        let key = campaign_key(programme_id, campaign_id.0);
        let mut campaigns = LookupMap::<String, RewardCampaign>::new(StorageKey::Campaigns);
        let mut campaign = campaigns
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown campaign"));
        require!(!campaign.closed, "campaign is already closed");
        require!(
            env::block_timestamp_ms() >= campaign.ends_at_ms.0
                || campaign.claimed == campaign.max_claims,
            "campaign is still active"
        );
        let refund = campaign.remaining_budget.0;
        self.totals.reserved -= refund + campaign.storage_reserve.0;
        campaign.remaining_budget = U128(0);
        campaign.storage_reserve = U128(0);
        campaign.closed = true;
        campaigns.insert(&key, &campaign);
        emit(
            "reward_campaign_closed",
            json!({ "programme_id": programme_id, "campaign_id": campaign_id, "refund": U128(refund) }),
        );
        if refund > 0 {
            self.pay(caller, refund, "campaign refund").detach();
        }
        true
    }

    // --------------------------------------------------------------------------- rewards and treasury

    /// Creator funds the reward pool; it is shared equally by every pass of the programme.
    #[payable]
    pub fn fund_rewards(&mut self, programme_id: u32) {
        let mut p = self.programme_or_panic(programme_id);
        require!(
            env::predecessor_account_id() == p.creator,
            "only the programme creator can fund rewards"
        );
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
        emit(
            "rewards_claimed",
            json!({ "token_id": token_id, "account_id": self.pass_account_id(&token_id),
            "amount": U128(amount) }),
        );
        self.pay_pass_account(&token_id, amount, "rewards")
    }

    /// Creator withdraws from their programme treasury (never more than it holds).
    pub fn withdraw_treasury(&mut self, programme_id: u32, amount: Option<U128>) -> Promise {
        let caller = env::predecessor_account_id();
        let mut p = self.programme_or_panic(programme_id);
        require!(
            caller == p.creator,
            "only the programme creator can withdraw the treasury"
        );
        let amount = amount.map_or(p.treasury.0, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= p.treasury.0, "amount exceeds the treasury");
        p.treasury = U128(p.treasury.0 - amount);
        self.programmes.insert(&programme_id, &p);
        self.totals.treasury -= amount;
        emit(
            "treasury_withdrawn",
            json!({ "programme_id": programme_id, "to": caller, "amount": U128(amount) }),
        );
        self.pay(caller, amount, "treasury")
    }

    /// Pull anything owed to the caller (failed payouts, failed-mint seeds).
    pub fn claim_owed(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.owed.get(&caller).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed.insert(&caller, &0);
        self.totals.owed -= amount;
        emit(
            "owed_claimed",
            json!({ "account_id": caller, "amount": U128(amount) }),
        );
        self.pay(caller, amount, "owed")
    }

    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128, reason: String) -> bool {
        if is_promise_success() {
            return true;
        }
        self.credit_owed(&to, amount.0);
        emit(
            "payout_failed",
            json!({ "to": to, "amount": amount, "reason": reason }),
        );
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
        emit(
            "pass_payout_failed",
            json!({ "token_id": token_id, "amount": amount, "reason": reason }),
        );
        false
    }

    #[private]
    pub fn on_campaign_payout(&mut self, token_id: TokenId, amount: U128) -> bool {
        if is_promise_success() {
            return true;
        }
        let mut owed = LookupMap::<TokenId, u128>::new(StorageKey::CampaignOwed);
        let previous = owed.get(&token_id).unwrap_or(0);
        owed.insert(&token_id, &(previous + amount.0));
        self.totals.reserved += amount.0;
        emit(
            "campaign_payout_failed",
            json!({ "token_id": token_id, "amount": amount }),
        );
        false
    }

    // --------------------------------------------------------------------------- sale

    /// List a pass. While listed, nothing can leave its account and it cannot move except by `buy`.
    #[payable]
    pub fn list(&mut self, token_id: TokenId, price: U128) -> U64 {
        require!(
            env::attached_deposit().as_yoctonear() == LIST_DEPOSIT,
            "attach exactly the listing deposit (0.01 NEAR)"
        );
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_of(&token_id),
            "only the current holder can list"
        );
        self.assert_idle(&token_id);
        require!(price.0 > 0, "price must be positive");
        let id = U64(self.next_listing_id);
        self.next_listing_id += 1;
        self.listings.insert(
            &token_id,
            &Listing {
                id,
                seller: caller.clone(),
                price,
            },
        );
        self.totals.listing_deposits += LIST_DEPOSIT;
        emit(
            "pass_listed",
            json!({ "token_id": token_id, "listing_id": id, "seller": caller, "price": price }),
        );
        id
    }

    #[payable]
    pub fn delist(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let listing = self
            .listings
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(caller == listing.seller, "only the seller can delist");
        self.listings.remove(&token_id);
        self.totals.listing_deposits -= LIST_DEPOSIT;
        emit(
            "pass_delisted",
            json!({ "token_id": token_id, "listing_id": listing.id, "seller": caller }),
        );
        self.pay(caller, LIST_DEPOSIT, "listing deposit")
    }

    /// Buy a listed pass for exactly its price. `listing_id` must match the listing the buyer saw.
    /// Ownership, and so control of the pass account, moves to the buyer in this receipt.
    #[payable]
    pub fn buy(&mut self, token_id: TokenId, listing_id: U64) -> Promise {
        let buyer = env::predecessor_account_id();
        require!(
            !self.is_pass_account(&buyer),
            "a pass account cannot hold a pass"
        );
        let listing = self
            .listings
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(listing.id == listing_id, "listing changed; check it again");
        require!(self.locks.get(&token_id).is_none(), "pass is locked");
        require!(
            env::attached_deposit().as_yoctonear() == listing.price.0,
            "attach exactly the listing price"
        );
        require!(buyer != listing.seller, "seller cannot buy their own pass");
        require!(
            self.owner_of(&token_id) == listing.seller,
            "listing is stale"
        );
        self.listings.remove(&token_id);
        self.totals.listing_deposits -= LIST_DEPOSIT;
        self.tokens.internal_transfer(
            &listing.seller,
            &buyer,
            &token_id,
            None,
            Some("crewpass sale".into()),
        );
        self.owner_changed(&token_id, &listing.seller, &buyer);
        emit(
            "pass_sold",
            json!({ "token_id": token_id, "listing_id": listing.id, "seller": listing.seller,
            "buyer": buyer, "price": listing.price, "account_id": self.pass_account_id(&token_id) }),
        );
        let programme = self.programme_or_panic(self.pass_or_panic(&token_id).programme_id);
        let royalty = (listing.price.0 / 10_000) * CREATOR_ROYALTY_BPS as u128
            + ((listing.price.0 % 10_000) * CREATOR_ROYALTY_BPS as u128) / 10_000;
        if royalty > 0 && programme.creator != listing.seller {
            self.pay(programme.creator, royalty, "creator royalty")
                .detach();
            self.pay(
                listing.seller,
                listing.price.0 - royalty + LIST_DEPOSIT,
                "sale",
            )
        } else {
            self.pay(listing.seller, listing.price.0 + LIST_DEPOSIT, "sale")
        }
    }

    // ------------------------------------------------------------------------ NEP-199 payouts

    pub fn nft_payout(
        &self,
        token_id: TokenId,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> NftPayout {
        self.payout_for(&token_id, balance.0, max_len_payout)
    }

    /// NEP-199 transfer-and-payout. Marketplace contracts remain responsible for making the
    /// returned payments; CrewPass's own `buy` method performs the same split itself.
    #[payable]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> NftPayout {
        assert_one_yocto();
        self.assert_idle(&token_id);
        require!(
            !self.is_pass_account(&receiver_id),
            "a pass account cannot hold a pass"
        );
        let from = self.owner_of(&token_id);
        let payout = self.payout_for(&token_id, balance.0, max_len_payout);
        self.tokens
            .nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
        self.owner_changed(&token_id, &from, &receiver_id);
        payout
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
        (from..self.next_programme_id)
            .filter_map(|id| self.programmes.get(&id))
            .take(limit as usize)
            .collect()
    }

    pub fn event(&self, event_id: U64) -> Option<Event> {
        self.events.get(&event_id.0)
    }

    pub fn events(
        &self,
        programme_id: Option<u32>,
        from_id: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<Event> {
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
        let buyer = self
            .pass_tickets
            .get(&format!("{}:{token_id}", event_id.0))?;
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
            creator_royalty_bps: CREATOR_ROYALTY_BPS,
            storage_byte_cost: U128(env::storage_byte_cost().as_yoctonear()),
            campaign_claim_storage_bytes: CAMPAIGN_CLAIM_STORAGE_BYTES as u32,
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
        let liabilities =
            t.treasury + t.reserved + t.carry + t.owed + t.listing_deposits + t.pending_mints;
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

fn campaign_key(programme_id: u32, campaign_id: u64) -> String {
    format!("{programme_id}:{campaign_id}")
}

fn campaign_claim_key(programme_id: u32, campaign_id: u64, token_id: &str) -> String {
    format!("{programme_id}:{campaign_id}:{token_id}")
}

// ------------------------------------------------------------------------------------- internals

impl Registry {
    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens
            .owner_by_id
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("unknown pass"))
    }

    fn pass_or_panic(&self, token_id: &TokenId) -> Pass {
        self.passes
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("unknown pass"))
    }

    fn programme_or_panic(&self, id: u32) -> Programme {
        self.programmes
            .get(&id)
            .unwrap_or_else(|| env::panic_str("unknown programme"))
    }

    pub fn pass_account_id(&self, token_id: &TokenId) -> AccountId {
        format!("{token_id}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid pass account id"))
    }

    /// Any sub-account of the registry. Only the registry can create them, and only for passes.
    fn is_pass_account(&self, account: &AccountId) -> bool {
        account
            .as_str()
            .ends_with(&format!(".{}", env::current_account_id()))
    }

    /// V3: a pass with a lock or a listing cannot move or start an account operation.
    fn assert_idle(&self, token_id: &TokenId) {
        if let Some(lock) = self.locks.get(token_id) {
            match lock.kind {
                LockKind::AccountOp => env::panic_str("account operation in progress"),
                LockKind::TransferCall => {
                    env::panic_str("pass is in the middle of nft_transfer_call")
                }
            }
        }
        require!(
            !self.listings.contains_key(token_id),
            "pass is listed; delist it first"
        );
    }

    fn begin_account_op(
        &mut self,
        token_id: &TokenId,
        op: &str,
        receiver: &AccountId,
        amount: u128,
    ) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_of(token_id),
            "only the current holder can operate the pass account"
        );
        self.assert_idle(token_id);
        self.locks.insert(
            token_id,
            &Lock {
                kind: LockKind::AccountOp,
                since_block: U64(env::block_height()),
            },
        );
        emit(
            "account_op_started",
            json!({ "token_id": token_id, "account_id": self.pass_account_id(token_id),
            "controller": caller, "op": op, "receiver_id": receiver, "amount": U128(amount) }),
        );
    }

    /// Every ownership change: new epoch, counter, and an explicit control event.
    fn owner_changed(&mut self, token_id: &TokenId, from: &AccountId, to: &AccountId) {
        let mut pass = self.pass_or_panic(token_id);
        pass.owner_epoch += 1;
        pass.transfers += 1;
        self.passes.insert(token_id, &pass);
        emit(
            "control_changed",
            json!({ "token_id": token_id, "account_id": self.pass_account_id(token_id),
            "previous_controller": from, "controller": to, "owner_epoch": pass.owner_epoch }),
        );
    }

    fn distribute(&mut self, p: &mut Programme, amount: u128, source: &str) {
        let total = amount + p.carry.0;
        self.totals.carry -= p.carry.0;
        if p.active_passes == 0 {
            p.treasury = U128(p.treasury.0 + total);
            self.totals.treasury += total;
            p.carry = U128(0);
            emit(
                "revenue_distributed",
                json!({ "programme_id": p.id, "source": source, "amount": U128(amount),
                "per_pass": U128(0), "passes": 0, "to_treasury": U128(total) }),
            );
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
        emit(
            "revenue_distributed",
            json!({ "programme_id": p.id, "source": source, "amount": U128(amount),
            "per_pass": U128(per_pass), "passes": p.active_passes, "carry": U128(carry),
            "reward_index": p.reward_index }),
        );
    }

    fn add_points(&mut self, token_id: &TokenId, points: u32, reason: &str) {
        let mut pass = self.pass_or_panic(token_id);
        let old_tier = tier_for(pass.points);
        pass.points += points;
        let new_tier = tier_for(pass.points);
        self.passes.insert(token_id, &pass);
        if new_tier != old_tier {
            emit(
                "tier_changed",
                json!({ "token_id": token_id, "from": TIERS[old_tier].0, "to": TIERS[new_tier].0,
                "points": pass.points, "reason": reason }),
            );
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

    fn build_metadata(
        &self,
        token_id: &TokenId,
        pass: &Pass,
        p: &Programme,
        now_ms: u64,
    ) -> TokenMetadata {
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
        require!(
            attached >= cost,
            format!("attach at least {cost} yoctoNEAR for storage")
        );
        if attached > cost {
            Promise::new(payer.clone())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
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
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .on_payout(to, U128(amount), reason.to_string()),
            )
    }

    fn pay_pass_account(&self, token_id: &TokenId, amount: u128, reason: &str) -> Promise {
        Promise::new(self.pass_account_id(token_id))
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .on_pass_payout(token_id.clone(), U128(amount), reason.to_string()),
            )
    }

    fn pay_campaign_account(&self, token_id: &TokenId, amount: u128) -> Promise {
        Promise::new(self.pass_account_id(token_id))
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .on_campaign_payout(token_id.clone(), U128(amount)),
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
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.assert_idle(&token_id);
        require!(
            !self.is_pass_account(&receiver_id),
            "a pass account cannot hold a pass"
        );
        let from = self.owner_of(&token_id);
        self.tokens
            .nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
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
        require!(
            !self.is_pass_account(&receiver_id),
            "a pass account cannot hold a pass"
        );
        self.locks.insert(
            &token_id,
            &Lock {
                kind: LockKind::TransferCall,
                since_block: U64(env::block_height()),
            },
        );
        emit(
            "transfer_call_locked",
            json!({ "token_id": token_id, "receiver_id": receiver_id }),
        );
        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
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
        emit(
            "transfer_call_unlocked",
            json!({ "token_id": token_id, "kept_by_receiver": kept }),
        );
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
    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
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
