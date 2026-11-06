//! CrewPass: creator ambassador passes (NEP-171) with a vault per pass.
//!
//! The vault belongs to the pass (`token_id`), never to a person. Whoever owns the pass at the
//! moment of a call is the only one who can withdraw it, so the vault follows ownership in the
//! same receipt as every transfer. See THREAT_MODEL.md for each rule and the test that proves it.
#![allow(deprecated)] // near_sdk::collections: writes immediately, so storage can be measured mid-call

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    assert_one_yocto, env, is_promise_success, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use std::collections::HashMap;

/// Held while a pass is listed, returned to the seller on delist or sale. Covers the listing's storage.
pub const LIST_DEPOSIT: NearToken = NearToken::from_millinear(10);
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(5);
const MAX_COMMISSION_BPS: u16 = 5_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Vaults,
    Stats,
    Listings,
    InTransferCall,
    Owed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub seller: AccountId,
    pub price: U128,
}

/// Fixed-size counters per pass. Full history is in the NEP-297 events of each receipt.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PassStats {
    pub minted_at_ns: U64,
    pub referrals: u32,
    pub earned: U128,
    pub withdrawn: U128,
    pub transfers: u32,
}

#[near(serializers = [json])]
pub struct PassView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub vault: U128,
    pub listing: Option<Listing>,
    pub in_transfer_call: bool,
    pub stats: PassStats,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub creator: AccountId,
    pub mint_price: U128,
    pub commission_bps: u16,
    pub list_deposit: U128,
    pub next_token_id: U64,
}

/// Everything the contract owes, against what it holds. `free` must never go negative (I3).
#[near(serializers = [json])]
pub struct AccountingView {
    pub balance: U128,
    pub storage_cost: U128,
    pub total_vaults: U128,
    pub total_owed: U128,
    pub total_listing_deposits: U128,
    pub liabilities: U128,
    pub solvent: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CrewPass {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    creator: AccountId,
    mint_price: u128,
    commission_bps: u16,
    next_token_id: u64,
    vaults: LookupMap<TokenId, u128>,
    stats: LookupMap<TokenId, PassStats>,
    listings: LookupMap<TokenId, Listing>,
    in_transfer_call: LookupSet<TokenId>,
    owed: LookupMap<AccountId, u128>,
    total_vaults: u128,
    total_owed: u128,
    total_listing_deposits: u128,
}

#[near]
impl CrewPass {
    #[init]
    pub fn new(creator: AccountId, mint_price: U128, commission_bps: u16, name: String, symbol: String) -> Self {
        require!(mint_price.0 > 0, "mint price must be positive");
        require!(commission_bps <= MAX_COMMISSION_BPS, "commission above 50%");
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                creator.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                // No approvals: nobody but the owner may move a pass (T13).
                None::<StorageKey>,
            ),
            metadata,
            creator,
            mint_price: mint_price.0,
            commission_bps,
            next_token_id: 1,
            vaults: LookupMap::new(StorageKey::Vaults),
            stats: LookupMap::new(StorageKey::Stats),
            listings: LookupMap::new(StorageKey::Listings),
            in_transfer_call: LookupSet::new(StorageKey::InTransferCall),
            owed: LookupMap::new(StorageKey::Owed),
            total_vaults: 0,
            total_owed: 0,
            total_listing_deposits: 0,
        }
    }

    // ---------------------------------------------------------------- mint

    /// Mint a pass to the caller for exactly `mint_price`. With a referrer, the commission goes
    /// into the referrer pass's vault in this same receipt (T6). The rest, minus the storage the
    /// new pass uses, is owed to the creator.
    #[payable]
    pub fn mint(&mut self, referrer_token_id: Option<TokenId>) -> Token {
        let minter = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached == self.mint_price, "attach exactly the mint price");

        let commission = match &referrer_token_id {
            Some(referrer) => {
                let referrer_owner = self
                    .tokens
                    .owner_by_id
                    .get(referrer)
                    .unwrap_or_else(|| env::panic_str("unknown referrer pass"));
                require!(referrer_owner != minter, "a pass cannot refer its own holder");
                self.mint_price * self.commission_bps as u128 / 10_000
            }
            None => 0,
        };

        let storage_before = env::storage_usage();
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        let token_metadata = TokenMetadata {
            title: Some(format!("CrewPass #{token_id}")),
            description: Some("Creator Ambassador Pass. Its vault belongs to whoever holds it.".into()),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some((env::block_timestamp() / 1_000_000).to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        };
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            minter.clone(),
            Some(token_metadata),
            None,
        );
        self.vaults.insert(&token_id, &0);
        self.stats.insert(
            &token_id,
            &PassStats { minted_at_ns: U64(env::block_timestamp()), ..Default::default() },
        );

        if let Some(referrer) = &referrer_token_id {
            self.credit_vault(referrer, commission);
            let mut stats = self.stats.get(referrer).unwrap_or_default();
            stats.referrals += 1;
            stats.earned = U128(stats.earned.0 + commission);
            self.stats.insert(referrer, &stats);
        }
        if !self.owed.contains_key(&self.creator) {
            self.owed.insert(&self.creator, &0);
        }

        let storage_cost =
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - storage_before) as u128;
        let after_commission = attached - commission;
        require!(after_commission >= storage_cost, "mint price does not cover storage");
        let creator = self.creator.clone();
        self.credit_owed(&creator, after_commission - storage_cost);

        NftMint { owner_id: &minter, token_ids: &[&token_id], memo: None }.emit();
        emit(
            "pass_minted",
            json!({ "token_id": token_id, "owner_id": minter, "referrer_token_id": referrer_token_id,
                    "commission": U128(commission), "storage_cost": U128(storage_cost) }),
        );
        token
    }

    // ---------------------------------------------------------------- vault

    /// Withdraw from a pass's vault to its current holder (I1). The vault is reduced before the
    /// transfer is sent (T8); if the transfer fails, the amount is owed to this holder, not put
    /// back in the vault (T7).
    #[payable]
    pub fn withdraw(&mut self, token_id: TokenId, amount: Option<U128>) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let owner = self.owner_of(&token_id);
        require!(caller == owner, "only the current holder can withdraw");
        self.assert_not_busy(&token_id);

        let balance = self.vaults.get(&token_id).unwrap_or(0);
        let amount = amount.map_or(balance, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= balance, "amount exceeds the vault");

        self.vaults.insert(&token_id, &(balance - amount));
        self.total_vaults -= amount;
        let mut stats = self.stats.get(&token_id).unwrap_or_default();
        stats.withdrawn = U128(stats.withdrawn.0 + amount);
        self.stats.insert(&token_id, &stats);

        emit("vault_withdrawn", json!({ "token_id": token_id, "to": caller, "amount": U128(amount) }));
        self.pay(caller, amount, "withdraw")
    }

    /// Pull anything owed to the caller: the creator's share, or payouts that failed to send.
    pub fn claim(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.owed.get(&caller).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed.insert(&caller, &0);
        self.total_owed -= amount;
        emit("owed_claimed", json!({ "account_id": caller, "amount": U128(amount) }));
        self.pay(caller, amount, "claim")
    }

    /// Callback for every outgoing payment. A failed payment is owed to the same account,
    /// claimable later; it never goes back into a vault.
    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128, reason: String) -> bool {
        if is_promise_success() {
            return true;
        }
        self.credit_owed(&to, amount.0);
        emit("payout_failed", json!({ "to": to, "amount": amount, "reason": reason }));
        false
    }

    // ---------------------------------------------------------------- sale

    /// List a pass for sale. While listed it cannot be withdrawn from, transferred or burned (I5).
    #[payable]
    pub fn list(&mut self, token_id: TokenId, price: U128) {
        require!(env::attached_deposit() == LIST_DEPOSIT, "attach exactly the listing deposit (0.01 NEAR)");
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(&token_id), "only the current holder can list");
        self.assert_not_busy(&token_id);
        require!(price.0 > 0, "price must be positive");
        self.listings.insert(&token_id, &Listing { seller: caller.clone(), price });
        self.total_listing_deposits += LIST_DEPOSIT.as_yoctonear();
        emit("pass_listed", json!({ "token_id": token_id, "seller": caller, "price": price }));
    }

    #[payable]
    pub fn delist(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let listing = self.listings.get(&token_id).unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(caller == listing.seller, "only the seller can delist");
        self.listings.remove(&token_id);
        self.total_listing_deposits -= LIST_DEPOSIT.as_yoctonear();
        emit("pass_delisted", json!({ "token_id": token_id, "seller": caller }));
        self.pay(caller, LIST_DEPOSIT.as_yoctonear(), "listing deposit")
    }

    /// Buy a listed pass for exactly its price. Fails unless the vault still holds at least
    /// `expected_min_vault` (T5). The pass, its vault and all rights move to the buyer in this
    /// receipt; the seller is paid price + listing deposit.
    #[payable]
    pub fn buy(&mut self, token_id: TokenId, expected_min_vault: U128) -> Promise {
        let buyer = env::predecessor_account_id();
        let listing = self.listings.get(&token_id).unwrap_or_else(|| env::panic_str("pass is not listed"));
        require!(!self.in_transfer_call.contains(&token_id), "pass is in the middle of nft_transfer_call");
        require!(env::attached_deposit().as_yoctonear() == listing.price.0, "attach exactly the listing price");
        require!(buyer != listing.seller, "seller cannot buy their own pass");
        require!(self.owner_of(&token_id) == listing.seller, "listing is stale");
        let vault = self.vaults.get(&token_id).unwrap_or(0);
        require!(vault >= expected_min_vault.0, "vault is below the amount you expected");

        self.listings.remove(&token_id);
        self.total_listing_deposits -= LIST_DEPOSIT.as_yoctonear();
        self.tokens.internal_transfer(&listing.seller, &buyer, &token_id, None, Some("crewpass sale".into()));
        self.bump_transfers(&token_id);

        emit(
            "pass_sold",
            json!({ "token_id": token_id, "seller": listing.seller, "buyer": buyer,
                    "price": listing.price, "vault": U128(vault) }),
        );
        self.pay(listing.seller, listing.price.0 + LIST_DEPOSIT.as_yoctonear(), "sale")
    }

    // ---------------------------------------------------------------- burn

    /// Burn a pass. Only its holder, only when its vault is empty (T19), never while busy.
    #[payable]
    pub fn burn(&mut self, token_id: TokenId) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_of(&token_id), "only the current holder can burn");
        self.assert_not_busy(&token_id);
        require!(self.vaults.get(&token_id).unwrap_or(0) == 0, "withdraw the vault before burning");

        self.tokens.owner_by_id.remove(&token_id);
        if let Some(by_id) = &mut self.tokens.token_metadata_by_id {
            by_id.remove(&token_id);
        }
        if let Some(per_owner) = &mut self.tokens.tokens_per_owner {
            if let Some(mut set) = per_owner.get(&caller) {
                set.remove(&token_id);
                if set.is_empty() {
                    per_owner.remove(&caller);
                } else {
                    per_owner.insert(&caller, &set);
                }
            }
        }
        self.vaults.remove(&token_id);
        self.stats.remove(&token_id);
        NftBurn { owner_id: &caller, token_ids: &[&token_id], authorized_id: None, memo: None }.emit();
    }

    // ---------------------------------------------------------------- views

    pub fn vault_of(&self, token_id: TokenId) -> U128 {
        U128(self.vaults.get(&token_id).unwrap_or(0))
    }

    pub fn pass_info(&self, token_id: TokenId) -> Option<PassView> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(PassView {
            vault: U128(self.vaults.get(&token_id).unwrap_or(0)),
            listing: self.listings.get(&token_id),
            in_transfer_call: self.in_transfer_call.contains(&token_id),
            stats: self.stats.get(&token_id).unwrap_or_default(),
            owner_id,
            token_id,
        })
    }

    pub fn owed_to(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).unwrap_or(0))
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            creator: self.creator.clone(),
            mint_price: U128(self.mint_price),
            commission_bps: self.commission_bps,
            list_deposit: U128(LIST_DEPOSIT.as_yoctonear()),
            next_token_id: U64(self.next_token_id),
        }
    }

    pub fn accounting(&self) -> AccountingView {
        let balance = env::account_balance().as_yoctonear();
        let storage_cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let liabilities = self.total_vaults + self.total_owed + self.total_listing_deposits;
        AccountingView {
            balance: U128(balance),
            storage_cost: U128(storage_cost),
            total_vaults: U128(self.total_vaults),
            total_owed: U128(self.total_owed),
            total_listing_deposits: U128(self.total_listing_deposits),
            liabilities: U128(liabilities),
            solvent: balance >= storage_cost + liabilities,
        }
    }
}

// -------------------------------------------------------------------- internals

impl CrewPass {
    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("unknown pass"))
    }

    /// I5: nothing may withdraw from, move, list or burn a pass that is listed or in the middle of
    /// nft_transfer_call. Only the sale or the in-flight transfer may finish.
    fn assert_not_busy(&self, token_id: &TokenId) {
        require!(!self.in_transfer_call.contains(token_id), "pass is in the middle of nft_transfer_call");
        require!(!self.listings.contains_key(token_id), "pass is listed; delist it first");
    }

    fn credit_vault(&mut self, token_id: &TokenId, amount: u128) {
        let balance = self.vaults.get(token_id).unwrap_or(0);
        self.vaults.insert(token_id, &(balance + amount));
        self.total_vaults += amount;
        emit("commission_credited", json!({ "token_id": token_id, "amount": U128(amount) }));
    }

    fn credit_owed(&mut self, account_id: &AccountId, amount: u128) {
        let owed = self.owed.get(account_id).unwrap_or(0);
        self.owed.insert(account_id, &(owed + amount));
        self.total_owed += amount;
    }

    fn bump_transfers(&mut self, token_id: &TokenId) {
        let mut stats = self.stats.get(token_id).unwrap_or_default();
        stats.transfers += 1;
        self.stats.insert(token_id, &stats);
    }

    fn pay(&self, to: AccountId, amount: u128, reason: &str) -> Promise {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_payout(to, U128(amount), reason.to_string()),
        )
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "crewpass", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

// -------------------------------------------------------------------- NEP-171 with the guards

#[near]
impl NonFungibleTokenCore for CrewPass {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.assert_not_busy(&token_id);
        self.tokens.nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        self.bump_transfers(&token_id);
    }

    /// The receiver owns the pass while `nft_on_transfer` runs and could hand it back afterwards.
    /// The pass is locked from here until `nft_resolve_transfer`, so the receiver cannot withdraw,
    /// move, list or burn it in that window (T9).
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.assert_not_busy(&token_id);
        self.in_transfer_call.insert(&token_id);
        emit("transfer_call_locked", json!({ "token_id": token_id, "receiver_id": receiver_id }));
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for CrewPass {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let kept = self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id.clone(),
            approved_account_ids,
        );
        self.in_transfer_call.remove(&token_id);
        if kept {
            self.bump_transfers(&token_id);
        }
        emit("transfer_call_unlocked", json!({ "token_id": token_id, "kept_by_receiver": kept }));
        kept
    }
}

#[near]
impl NonFungibleTokenEnumeration for CrewPass {
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
impl NonFungibleTokenMetadataProvider for CrewPass {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
