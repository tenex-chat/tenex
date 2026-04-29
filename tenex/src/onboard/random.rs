//! Username generator — `<adjective>-<noun>` from two fixed 30-element lists.
//!
//! Source: `src/commands/onboard.ts:1516-1532`. The TS uses
//! `Math.floor(Math.random() * arr.length)` over the JS `Math.random()`
//! engine; we use a small xorshift64 PRNG seeded from `SystemTime` for
//! uniform-enough output without pulling a runtime dependency. The lists
//! themselves are pinned byte-for-byte against the spec — a divergence
//! here would be visible in the welcome screen.

use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

/// Verbatim list from `src/commands/onboard.ts:1516-1520`.
pub const ADJECTIVES: &[&str] = &[
    "swift", "bright", "calm", "bold", "keen", "warm", "wild", "cool", "fair", "glad", "brave",
    "clever", "deft", "eager", "fierce", "gentle", "happy", "jolly", "kind", "lively", "mighty",
    "noble", "plucky", "quick", "sharp", "steady", "true", "vivid", "witty", "zesty",
];

/// Verbatim list from `src/commands/onboard.ts:1522-1526`.
pub const NOUNS: &[&str] = &[
    "fox", "owl", "bear", "wolf", "hawk", "deer", "lynx", "crow", "hare", "wren", "otter", "raven",
    "crane", "finch", "panda", "tiger", "eagle", "cobra", "bison", "whale", "badger", "falcon",
    "heron", "robin", "viper", "squid", "gecko", "moose", "stork", "manta",
];

thread_local! {
    static RNG: Cell<u64> = Cell::new(seed());
}

fn seed() -> u64 {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    let pid = std::process::id() as u64;
    t.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(pid).max(1)
}

fn next_u64() -> u64 {
    RNG.with(|r| {
        let mut x = r.get();
        if x == 0 {
            x = 1;
        }
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        r.set(x);
        x
    })
}

/// Produce a fresh `<adjective>-<noun>` username.
pub fn random_username() -> String {
    let adj = ADJECTIVES[(next_u64() as usize) % ADJECTIVES.len()];
    let noun = NOUNS[(next_u64() as usize) % NOUNS.len()];
    format!("{adj}-{noun}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_are_thirty_each() {
        // The spec calls out "30 adjectives" and "30 nouns" verbatim
        // (`src/commands/onboard.ts:1516, 1522`).
        assert_eq!(ADJECTIVES.len(), 30);
        assert_eq!(NOUNS.len(), 30);
    }

    #[test]
    fn first_and_last_entries_match_spec_verbatim() {
        // Pin the first and last in case anyone reorders the list.
        assert_eq!(ADJECTIVES[0], "swift");
        assert_eq!(ADJECTIVES[29], "zesty");
        assert_eq!(NOUNS[0], "fox");
        assert_eq!(NOUNS[29], "manta");
    }

    #[test]
    fn lists_have_no_duplicates() {
        // Both lists are unique sets per the TS source.
        let mut seen = std::collections::HashSet::new();
        for a in ADJECTIVES {
            assert!(seen.insert(a), "duplicate adjective: {a}");
        }
        seen.clear();
        for n in NOUNS {
            assert!(seen.insert(n), "duplicate noun: {n}");
        }
    }

    #[test]
    fn random_username_has_dash_and_two_known_parts() {
        for _ in 0..50 {
            let u = random_username();
            let (a, b) = u.split_once('-').expect("dash separator");
            assert!(ADJECTIVES.contains(&a), "unknown adjective {a}");
            assert!(NOUNS.contains(&b), "unknown noun {b}");
        }
    }

    #[test]
    fn xorshift_does_not_settle_to_a_single_value() {
        // Coverage check: with 30×30 outcomes we should see at least 5
        // distinct usernames in 50 draws. (Probability of fewer is ~0.)
        let mut s = std::collections::HashSet::new();
        for _ in 0..50 {
            s.insert(random_username());
        }
        assert!(s.len() >= 5, "got {} distinct in 50 draws: {s:?}", s.len());
    }
}
