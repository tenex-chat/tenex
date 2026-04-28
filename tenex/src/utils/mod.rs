//! Cross-cutting utilities — display helpers, string normalisers, etc.
//!
//! Each submodule here ports a tiny TS file from `src/utils/`. Pure
//! functions only — no I/O, no Nostr, no LLM. Anything that does I/O
//! belongs in `crate::store` or its own substrate module.

pub mod identifiers;
pub mod telegram_identifiers;
