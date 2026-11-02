//! NEP-297 events: `EVENT_JSON:{"standard":"hana-id","version":"1.2.0","event":...,"data":[{...}]}`. Version 1.1.0
//! (governance batch, D86) is additive over 1.0.0: new events, and `issuer_key_set` / `issuer_key_removed` gain fields
//! and are emitted when a key enters or leaves the active set. Version 1.2.0 (email login) is additive over 1.1.0:
//! `issuer_self_issued`, `signer_policy_set`, the `identity_link_*` / `identity_linked` / `identity_unlinked` events,
//! and `issuer_key_proposed` gains `signer` for a self-issued issuer's key.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "hana-id";
pub const VERSION: &str = "1.2.0";

pub fn emit(event: &str, data: Value) {
    let line = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", line));
}
