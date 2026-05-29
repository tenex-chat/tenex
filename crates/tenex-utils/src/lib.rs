//! Shared, dependency-light utilities for the TENEX Rust workspace.
//!
//! This crate is the home for small cross-cutting helpers that would
//! otherwise be hand-rolled (and drift) across crates. Each concern lives
//! in its own module:
//!
//! - [`ids`] — event-ID validators, factories, and the single canonical
//!   long-to-short shortener.
//! - [`pubkey`] — pubkey shortening for display vs on-disk path contexts.

pub mod ids;
pub mod pubkey;
