//! File-backed TENEX trust-set reader.
//!
//! This crate has no process, socket, or background watcher. Callers pass the
//! TENEX base directory, load the current trust set from disk, and reload it
//! when their owning process observes relevant filesystem changes.

mod cache;
mod paths;

pub use cache::{Counts, TrustSet};
