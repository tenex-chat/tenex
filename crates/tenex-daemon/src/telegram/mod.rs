//! Rust-native Telegram adapter.
//!
//! This module hosts the Rust-owned Telegram foundation: runtime publish
//! classification types, the HTML renderer, a read-only view of the shared
//! `TransportBindingStore` file, and the durable outbox edge used by daemon
//! diagnostics and maintenance.
//!
//! The module intentionally re-exports the existing crate-root
//! `telegram_outbox` module as `telegram::outbox`. That module is the durable
//! outbox primitive; it stays at the crate root during the transition so the
//! ongoing worker-publishing branch does not need to rewrite paths.

pub mod bindings;
pub mod chat_context;
pub mod client;
pub mod delivery;
pub mod delivery_plan;
pub mod inbound;
pub mod ingress_runtime;
pub mod media;
pub mod renderer;
pub mod types;

pub use crate::telegram_outbox as outbox;
