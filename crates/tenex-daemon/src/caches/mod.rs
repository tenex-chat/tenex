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

#[cfg(test)]
mod compat_tests {
    use super::prefix_lookup::{
        PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION, PREFIX_LOOKUP_SCHEMA_VERSION,
        PrefixLookupDiagnostics, PrefixLookupSnapshot, inspect_prefix_lookup, write_prefix_lookup,
    };
    use super::profile_names::{
        PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION, PROFILE_NAMES_SCHEMA_VERSION,
        ProfileNamesDiagnostics, ProfileNamesSnapshot, inspect_profile_names,
        write_profile_names,
    };
    use super::trust_pubkeys::{
        TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION, TRUST_PUBKEYS_SCHEMA_VERSION,
        TrustPubkeysDiagnostics, TrustPubkeysSnapshot, inspect_trust_pubkeys,
        write_trust_pubkeys,
    };
    use super::{CACHES_DIR_NAME, CACHES_TMP_DIR_NAME, CACHES_WRITER, caches_dir, caches_tmp_dir};
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const CACHES_FIXTURE: &str =
        include_str!("../../../../src/test-utils/fixtures/daemon/caches.compat.json");
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-caches-compat-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    #[test]
    fn caches_fixture_matches_rust_contract() {
        let fixture: Value =
            serde_json::from_str(CACHES_FIXTURE).expect("fixture must parse");
        let daemon_dir = Path::new("/var/lib/tenex").join(
            fixture["daemonDirName"]
                .as_str()
                .expect("fixture must include daemonDirName"),
        );

        assert_eq!(
            fixture["relativePaths"]["cachesDir"].as_str(),
            Some(CACHES_DIR_NAME)
        );
        assert_eq!(
            fixture["relativePaths"]["cachesTmpDir"].as_str(),
            Some(format!("{CACHES_DIR_NAME}/{CACHES_TMP_DIR_NAME}").as_str())
        );
        assert_eq!(fixture["writer"].as_str(), Some(CACHES_WRITER));
        assert_eq!(caches_dir(&daemon_dir), daemon_dir.join(CACHES_DIR_NAME));
        assert_eq!(
            caches_tmp_dir(&daemon_dir),
            daemon_dir.join(CACHES_DIR_NAME).join(CACHES_TMP_DIR_NAME)
        );

        assert_eq!(
            fixture["schemaVersions"]["trustPubkeys"].as_u64(),
            Some(u64::from(TRUST_PUBKEYS_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture["schemaVersions"]["trustPubkeysDiagnostics"].as_u64(),
            Some(u64::from(TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture["schemaVersions"]["prefixLookup"].as_u64(),
            Some(u64::from(PREFIX_LOOKUP_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture["schemaVersions"]["prefixLookupDiagnostics"].as_u64(),
            Some(u64::from(PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture["schemaVersions"]["profileNames"].as_u64(),
            Some(u64::from(PROFILE_NAMES_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture["schemaVersions"]["profileNamesDiagnostics"].as_u64(),
            Some(u64::from(PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION))
        );

        let trust: TrustPubkeysSnapshot =
            serde_json::from_value(fixture["snapshots"]["trustPubkeys"].clone())
                .expect("trust pubkeys snapshot must deserialize");
        assert_eq!(trust.schema_version, TRUST_PUBKEYS_SCHEMA_VERSION);
        assert_eq!(trust.writer, CACHES_WRITER);
        assert_eq!(trust.pubkeys.len(), 3);

        let prefix: PrefixLookupSnapshot =
            serde_json::from_value(fixture["snapshots"]["prefixLookup"].clone())
                .expect("prefix lookup snapshot must deserialize");
        assert_eq!(prefix.schema_version, PREFIX_LOOKUP_SCHEMA_VERSION);
        assert_eq!(prefix.writer, CACHES_WRITER);
        assert_eq!(prefix.prefixes.len(), 2);

        let profiles: ProfileNamesSnapshot =
            serde_json::from_value(fixture["snapshots"]["profileNames"].clone())
                .expect("profile names snapshot must deserialize");
        assert_eq!(profiles.schema_version, PROFILE_NAMES_SCHEMA_VERSION);
        assert_eq!(profiles.writer, CACHES_WRITER);
        assert_eq!(profiles.entries.len(), 3);
        let nip05_only = profiles
            .entries
            .values()
            .find(|entry| entry.display_name.is_none() && entry.nip05.is_some());
        assert!(nip05_only.is_some(), "fixture must include a nip05-only profile entry");
        let display_only = profiles
            .entries
            .values()
            .find(|entry| entry.display_name.is_some() && entry.nip05.is_none());
        assert!(
            display_only.is_some(),
            "fixture must include a display-name-only profile entry"
        );

        let live_daemon_dir = unique_temp_daemon_dir();

        write_trust_pubkeys(&live_daemon_dir, &trust).expect("trust pubkeys write must succeed");
        let trust_diagnostics =
            inspect_trust_pubkeys(&live_daemon_dir, 1_710_001_000_500).expect("trust inspect");
        let expected_trust_diagnostics: TrustPubkeysDiagnostics = serde_json::from_value(
            fixture["diagnostics"]["trustPubkeysPopulated"].clone(),
        )
        .expect("trust populated diagnostics fixture must deserialize");
        assert_eq!(trust_diagnostics, expected_trust_diagnostics);

        write_prefix_lookup(&live_daemon_dir, &prefix).expect("prefix lookup write must succeed");
        let prefix_diagnostics =
            inspect_prefix_lookup(&live_daemon_dir, 1_710_001_000_500).expect("prefix inspect");
        let expected_prefix_diagnostics: PrefixLookupDiagnostics = serde_json::from_value(
            fixture["diagnostics"]["prefixLookupPopulated"].clone(),
        )
        .expect("prefix populated diagnostics fixture must deserialize");
        assert_eq!(prefix_diagnostics, expected_prefix_diagnostics);

        write_profile_names(&live_daemon_dir, &profiles).expect("profile names write must succeed");
        let profile_diagnostics =
            inspect_profile_names(&live_daemon_dir, 1_710_001_000_500).expect("profile inspect");
        let expected_profile_diagnostics: ProfileNamesDiagnostics = serde_json::from_value(
            fixture["diagnostics"]["profileNamesPopulated"].clone(),
        )
        .expect("profile populated diagnostics fixture must deserialize");
        assert_eq!(profile_diagnostics, expected_profile_diagnostics);

        let empty_daemon_dir = unique_temp_daemon_dir();
        let expected_trust_empty: TrustPubkeysDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["trustPubkeysEmpty"].clone())
                .expect("trust empty diagnostics fixture must deserialize");
        assert_eq!(
            inspect_trust_pubkeys(&empty_daemon_dir, 1_710_001_000_000).unwrap(),
            expected_trust_empty
        );
        let expected_prefix_empty: PrefixLookupDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["prefixLookupEmpty"].clone())
                .expect("prefix empty diagnostics fixture must deserialize");
        assert_eq!(
            inspect_prefix_lookup(&empty_daemon_dir, 1_710_001_000_000).unwrap(),
            expected_prefix_empty
        );
        let expected_profile_empty: ProfileNamesDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["profileNamesEmpty"].clone())
                .expect("profile empty diagnostics fixture must deserialize");
        assert_eq!(
            inspect_profile_names(&empty_daemon_dir, 1_710_001_000_000).unwrap(),
            expected_profile_empty
        );

        fs::remove_dir_all(live_daemon_dir).expect("populated daemon dir cleanup must succeed");
        fs::remove_dir_all(empty_daemon_dir).expect("empty daemon dir cleanup must succeed");
    }
}
