//! `tenex-embedder` — daemon + backfill that embeds conversation
//! transcripts into a single global RAG store.
//!
//! Source of truth: Nostr relay events (kind:1) `a`-tagged at any
//! project owned by the user (derived from `tenexPrivateKey`). Local
//! `conversation.db` is *not* read.
//!
//! See `docs/plans/2026-04-30-tenex-embedder.md` for the design (note:
//! the doc still references the older `conversation.db`-as-source
//! design and is being revised).

pub mod accounting;
pub mod accumulator;
pub mod backfill;
pub mod chunking;
pub mod config;
pub mod cursor;
pub mod identity;
pub mod lockfile;
pub mod pacing;
pub mod paths;
pub mod processor;
pub mod relay;
pub mod republish;
pub mod scheduler;
pub mod scope;
pub mod state;
pub mod target;
pub mod transcript;
pub mod tuning;
