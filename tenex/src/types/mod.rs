//! Validation primitives shared across screens (pubkeys, relays, telegram
//! identities). Each function reproduces the *exact* TS validator semantics
//! — including its strictness — so prompts wired to these match the source
//! byte-for-byte (error messages verbatim per spec docs 07, 08).

pub mod relay;
pub mod telegram;

#[cfg(test)]
pub mod pubkey;
