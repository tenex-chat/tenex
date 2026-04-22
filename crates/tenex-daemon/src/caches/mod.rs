//! Filesystem-backed caches the Rust daemon keeps under
//! `$TENEX_BASE_DIR/daemon/caches/`. Each cache is a single JSON document that
//! is rewritten atomically on every update using a `tmp/` scratch sibling plus
//! `fs::rename` into place. Readers treat schema mismatches, malformed records,
//! and truncated JSON as fatal; callers must fix the on-disk state before the
//! cache resumes service.

pub mod prefix_lookup;
pub mod profile_names;
pub mod trust_pubkeys;

use std::path::{Path, PathBuf};

pub const CACHES_DIR_NAME: &str = "caches";
pub const CACHES_TMP_DIR_NAME: &str = "tmp";
pub const CACHES_WRITER: &str = "rust-daemon";

pub fn caches_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(CACHES_DIR_NAME)
}

pub fn caches_tmp_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    caches_dir(daemon_dir).join(CACHES_TMP_DIR_NAME)
}
