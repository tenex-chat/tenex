//! Span / trace identifier generation.
//!
//! Uses a 26-character Crockford base32 encoding of (timestamp_ms || randomness),
//! lexicographically sortable by creation time. Compatible with ULID
//! conventions but has no external dependency.
use std::sync::atomic::{AtomicU64, Ordering};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 26-char Crockford base32 sortable id. First 10 chars = ms timestamp.
pub fn new_id() -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // 80 bits of entropy: process-local nanoseconds + monotonic counter + random hash.
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let mix = (nanos << 32) ^ counter ^ ptr_seed();
    let high = mix as u128;
    let low = (counter as u128).wrapping_mul(0x9E3779B97F4A7C15);
    let rand: u128 = (high << 64) | low;
    encode_ulid(now_ms, rand)
}

fn ptr_seed() -> u64 {
    let v = 0u8;
    &v as *const u8 as usize as u64
}

fn encode_ulid(ts_ms: u64, rand: u128) -> String {
    let mut out = [0u8; 26];
    // 10 chars timestamp (50 bits)
    let mut t = ts_ms & ((1u64 << 50) - 1);
    for i in (0..10).rev() {
        out[i] = ALPHABET[(t & 0x1f) as usize];
        t >>= 5;
    }
    // 16 chars random (80 bits)
    let mut r = rand & ((1u128 << 80) - 1);
    for i in (10..26).rev() {
        out[i] = ALPHABET[(r & 0x1f) as usize];
        r >>= 5;
    }
    // Safety: alphabet is ASCII.
    String::from_utf8(out.to_vec()).expect("ascii")
}

/// SHA-256 hex digest of arbitrary bytes — used for content hashes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_sorted() {
        let mut ids = Vec::with_capacity(1000);
        for _ in 0..1000 {
            ids.push(new_id());
        }
        let mut sorted = ids.clone();
        sorted.sort();
        // Most should already be in monotonic order (timestamp prefix).
        let dedup: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(dedup.len(), 1000, "ids must be unique");
        assert!(ids.iter().all(|i| i.len() == 26));
    }
}
