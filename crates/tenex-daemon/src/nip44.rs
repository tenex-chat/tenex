use base64::Engine;
use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use secp256k1::{PublicKey, SecretKey};
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum Nip44Error {
    #[error("nip-44 hkdf expand failed")]
    HkdfExpand,
    #[error("nip-44 invalid payload: {0}")]
    InvalidPayload(&'static str),
    #[error("nip-44 base64 error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("nip-44 hmac mismatch")]
    HmacMismatch,
    #[error("nip-44 invalid padding")]
    InvalidPadding,
    #[error("nip-44 plaintext too long")]
    PlaintextTooLong,
    #[error("nip-44 plaintext empty")]
    PlaintextEmpty,
    #[error("nip-44 random generation failed: {0}")]
    Random(String),
}

pub fn conversation_key(secret: &SecretKey, peer: &PublicKey) -> Result<[u8; 32], Nip44Error> {
    use hkdf::Hkdf;
    use secp256k1::ecdh::shared_secret_point;
    use sha2::Sha256;

    let shared = shared_secret_point(peer, secret);
    let mut x_coord = [0u8; 32];
    x_coord.copy_from_slice(&shared[0..32]);
    let (prk, _) = Hkdf::<Sha256>::extract(Some(b"nip44-v2"), &x_coord);
    let mut out = [0u8; 32];
    out.copy_from_slice(prk.as_slice());
    Ok(out)
}

pub fn calc_padded_len(unpadded: usize) -> usize {
    if unpadded <= 32 {
        return 32;
    }
    let next_power = 1usize << ((unpadded - 1).ilog2() + 1);
    let chunk = if next_power <= 256 {
        32
    } else {
        next_power / 8
    };
    ((unpadded - 1) / chunk + 1) * chunk
}

const MIN_PLAINTEXT_LEN: usize = 1;
const MAX_PLAINTEXT_LEN: usize = 65535;
const VERSION_BYTE: u8 = 0x02;
const NONCE_LEN: usize = 32;
const MAC_LEN: usize = 32;
const MIN_PAYLOAD_LEN: usize = 1 + NONCE_LEN + 2 + 32 + MAC_LEN;
const MAX_PAYLOAD_LEN: usize = 1 + NONCE_LEN + 2 + 65536 + MAC_LEN;

pub fn encrypt(conversation_key: &[u8; 32], plaintext: &[u8]) -> Result<String, Nip44Error> {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).map_err(|error| Nip44Error::Random(error.to_string()))?;
    encrypt_with_nonce(conversation_key, &nonce, plaintext)
}

pub fn encrypt_with_nonce(
    conversation_key: &[u8; 32],
    nonce: &[u8; 32],
    plaintext: &[u8],
) -> Result<String, Nip44Error> {
    if plaintext.len() < MIN_PLAINTEXT_LEN {
        return Err(Nip44Error::PlaintextEmpty);
    }
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(Nip44Error::PlaintextTooLong);
    }

    let (chacha_key, chacha_nonce, hmac_key) = message_keys(conversation_key, nonce)?;

    let padded_len = calc_padded_len(plaintext.len());
    let mut padded = vec![0u8; 2 + padded_len];
    padded[0..2].copy_from_slice(&(plaintext.len() as u16).to_be_bytes());
    padded[2..2 + plaintext.len()].copy_from_slice(plaintext);

    let mut cipher = ChaCha20::new(&chacha_key.into(), &chacha_nonce.into());
    cipher.apply_keystream(&mut padded);

    let mac = compute_mac(&hmac_key, nonce, &padded)?;

    let mut payload = Vec::with_capacity(1 + NONCE_LEN + padded.len() + MAC_LEN);
    payload.push(VERSION_BYTE);
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&padded);
    payload.extend_from_slice(&mac);

    Ok(base64::engine::general_purpose::STANDARD.encode(&payload))
}

pub fn decrypt(conversation_key: &[u8; 32], payload: &str) -> Result<Vec<u8>, Nip44Error> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(payload)?;

    if decoded.len() < MIN_PAYLOAD_LEN || decoded.len() > MAX_PAYLOAD_LEN {
        return Err(Nip44Error::InvalidPayload("payload length out of range"));
    }
    if decoded[0] != VERSION_BYTE {
        return Err(Nip44Error::InvalidPayload("unknown version"));
    }

    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(&decoded[1..1 + NONCE_LEN]);
    let ciphertext_end = decoded.len() - MAC_LEN;
    let ciphertext = &decoded[1 + NONCE_LEN..ciphertext_end];
    let mac = &decoded[ciphertext_end..];

    let (chacha_key, chacha_nonce, hmac_key) = message_keys(conversation_key, &nonce)?;

    verify_mac(&hmac_key, &nonce, ciphertext, mac)?;

    let mut padded = ciphertext.to_vec();
    let mut cipher = ChaCha20::new(&chacha_key.into(), &chacha_nonce.into());
    cipher.apply_keystream(&mut padded);

    if padded.len() < 2 {
        return Err(Nip44Error::InvalidPadding);
    }
    let plaintext_len = u16::from_be_bytes([padded[0], padded[1]]) as usize;
    let padding_bytes = padded.len() - 2;
    if plaintext_len < MIN_PLAINTEXT_LEN
        || plaintext_len > padding_bytes
        || calc_padded_len(plaintext_len) != padding_bytes
    {
        return Err(Nip44Error::InvalidPadding);
    }

    let plaintext = padded[2..2 + plaintext_len].to_vec();
    if padded[2 + plaintext_len..].iter().any(|b| *b != 0) {
        return Err(Nip44Error::InvalidPadding);
    }

    Ok(plaintext)
}

fn compute_mac(
    hmac_key: &[u8; 32],
    nonce: &[u8; 32],
    ciphertext: &[u8],
) -> Result<[u8; 32], Nip44Error> {
    let mut mac = HmacSha256::new_from_slice(hmac_key).map_err(|_| Nip44Error::HkdfExpand)?;
    mac.update(nonce);
    mac.update(ciphertext);
    let tag = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&tag);
    Ok(out)
}

fn verify_mac(
    hmac_key: &[u8; 32],
    nonce: &[u8; 32],
    ciphertext: &[u8],
    expected: &[u8],
) -> Result<(), Nip44Error> {
    let mut mac = HmacSha256::new_from_slice(hmac_key).map_err(|_| Nip44Error::HkdfExpand)?;
    mac.update(nonce);
    mac.update(ciphertext);
    mac.verify_slice(expected)
        .map_err(|_| Nip44Error::HmacMismatch)
}

pub fn message_keys(
    conversation_key: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<([u8; 32], [u8; 12], [u8; 32]), Nip44Error> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let hk = Hkdf::<Sha256>::from_prk(conversation_key).map_err(|_| Nip44Error::HkdfExpand)?;
    let mut okm = [0u8; 76];
    hk.expand(nonce, &mut okm)
        .map_err(|_| Nip44Error::HkdfExpand)?;
    let mut chacha_key = [0u8; 32];
    chacha_key.copy_from_slice(&okm[0..32]);
    let mut chacha_nonce = [0u8; 12];
    chacha_nonce.copy_from_slice(&okm[32..44]);
    let mut hmac_key = [0u8; 32];
    hmac_key.copy_from_slice(&okm[44..76]);
    Ok((chacha_key, chacha_nonce, hmac_key))
}

#[cfg(test)]
mod conversation_key_tests {
    use super::*;
    use secp256k1::{PublicKey, SecretKey};
    use std::str::FromStr;

    #[test]
    fn conversation_key_matches_spec_vector_one() {
        let sec1 = "315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268";
        let pub2_xonly = "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133";
        let expected = "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1";

        let secret = SecretKey::from_str(sec1).unwrap();
        let peer = PublicKey::from_str(&format!("02{pub2_xonly}")).unwrap();
        let key = conversation_key(&secret, &peer).unwrap();

        assert_eq!(hex::encode(key), expected);
    }

    #[test]
    fn conversation_key_matches_all_spec_vectors() {
        #[derive(serde::Deserialize)]
        struct Case {
            sec1: String,
            pub2: String,
            conversation_key: String,
        }
        let raw = include_str!("../tests/fixtures/nip44-v2-vectors.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases: Vec<Case> =
            serde_json::from_value(parsed["v2"]["valid"]["get_conversation_key"].clone()).unwrap();
        assert!(!cases.is_empty(), "no conversation_key vectors loaded");
        for case in cases {
            let secret = SecretKey::from_str(&case.sec1).unwrap();
            let peer = PublicKey::from_str(&format!("02{}", case.pub2)).unwrap();
            let key = conversation_key(&secret, &peer).unwrap();
            assert_eq!(
                hex::encode(key),
                case.conversation_key,
                "vector: {}",
                case.sec1
            );
        }
    }
}

#[cfg(test)]
mod calc_padded_len_tests {
    use super::*;

    #[test]
    fn calc_padded_len_matches_all_spec_vectors() {
        #[derive(serde::Deserialize)]
        struct Case(usize, usize);
        let raw = include_str!("../tests/fixtures/nip44-v2-vectors.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases: Vec<Case> =
            serde_json::from_value(parsed["v2"]["valid"]["calc_padded_len"].clone()).unwrap();
        assert!(!cases.is_empty(), "no calc_padded_len vectors loaded");
        for Case(unpadded, expected) in cases {
            assert_eq!(calc_padded_len(unpadded), expected, "unpadded={unpadded}");
        }
    }
}

#[cfg(test)]
mod encrypt_decrypt_tests {
    use super::*;

    use sha2::Digest;

    fn decode_ck(hex_str: &str) -> [u8; 32] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    fn decode_nonce(hex_str: &str) -> [u8; 32] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    fn fixtures() -> serde_json::Value {
        let raw = include_str!("../tests/fixtures/nip44-v2-vectors.json");
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn encrypt_with_fixed_nonce_matches_spec_vector_one() {
        let ck = decode_ck("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
        let nonce =
            decode_nonce("0000000000000000000000000000000000000000000000000000000000000001");
        let plaintext = "a";
        let expected_payload = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";

        let payload = encrypt_with_nonce(&ck, &nonce, plaintext.as_bytes()).unwrap();
        assert_eq!(payload, expected_payload);

        let decrypted = decrypt(&ck, &payload).unwrap();
        assert_eq!(decrypted, plaintext.as_bytes());
    }

    #[test]
    fn encrypt_and_decrypt_match_all_spec_vectors() {
        #[derive(serde::Deserialize)]
        struct Case {
            conversation_key: String,
            nonce: String,
            plaintext: String,
            payload: String,
        }
        let parsed = fixtures();
        let cases: Vec<Case> =
            serde_json::from_value(parsed["v2"]["valid"]["encrypt_decrypt"].clone()).unwrap();
        assert!(!cases.is_empty(), "no encrypt_decrypt vectors loaded");
        for case in cases {
            let ck = decode_ck(&case.conversation_key);
            let nonce = decode_nonce(&case.nonce);
            let encrypted = encrypt_with_nonce(&ck, &nonce, case.plaintext.as_bytes()).unwrap();
            assert_eq!(encrypted, case.payload, "nonce {}", case.nonce);
            let decrypted = decrypt(&ck, &case.payload).unwrap();
            assert_eq!(decrypted, case.plaintext.as_bytes(), "nonce {}", case.nonce);
        }
    }

    #[test]
    fn encrypt_and_decrypt_match_all_long_msg_vectors() {
        #[derive(serde::Deserialize)]
        struct Case {
            conversation_key: String,
            nonce: String,
            pattern: String,
            repeat: usize,
            plaintext_sha256: String,
            payload_sha256: String,
        }
        let parsed = fixtures();
        let cases: Vec<Case> =
            serde_json::from_value(parsed["v2"]["valid"]["encrypt_decrypt_long_msg"].clone())
                .unwrap();
        assert!(
            !cases.is_empty(),
            "no encrypt_decrypt_long_msg vectors loaded"
        );
        for case in cases {
            let ck = decode_ck(&case.conversation_key);
            let nonce = decode_nonce(&case.nonce);
            let plaintext: Vec<u8> = case.pattern.repeat(case.repeat).into_bytes();
            let pt_hash = hex::encode(Sha256::digest(&plaintext));
            assert_eq!(pt_hash, case.plaintext_sha256, "plaintext hash mismatch");

            let payload = encrypt_with_nonce(&ck, &nonce, &plaintext).unwrap();
            let payload_hash = hex::encode(Sha256::digest(payload.as_bytes()));
            assert_eq!(payload_hash, case.payload_sha256, "payload hash mismatch");

            let decrypted = decrypt(&ck, &payload).unwrap();
            assert_eq!(decrypted, plaintext, "decrypted mismatch");
        }
    }

    #[test]
    fn decrypt_rejects_all_invalid_spec_vectors() {
        #[derive(serde::Deserialize)]
        struct Case {
            conversation_key: String,
            payload: String,
            note: String,
        }
        let parsed = fixtures();
        let cases: Vec<Case> =
            serde_json::from_value(parsed["v2"]["invalid"]["decrypt"].clone()).unwrap();
        assert!(!cases.is_empty(), "no invalid decrypt vectors loaded");
        for case in cases {
            let ck = decode_ck(&case.conversation_key);
            let result = decrypt(&ck, &case.payload);
            assert!(
                result.is_err(),
                "expected error for note={:?}, got Ok({:?})",
                case.note,
                result
            );
            let err = result.unwrap_err();
            let note = case.note.as_str();
            if note.starts_with("unknown encryption version") {
                // `#`-prefixed sentinel payloads are flagged as version errors
                // by the reference JS implementation, but since the prefix is
                // not valid base64 our decoder rejects them at the base64
                // stage. Both outcomes are acceptable rejections.
                assert!(
                    matches!(err, Nip44Error::InvalidPayload(_) | Nip44Error::Base64(_)),
                    "note={note:?} expected InvalidPayload or Base64, got {err:?}"
                );
            } else if note == "invalid base64" {
                assert!(
                    matches!(err, Nip44Error::Base64(_)),
                    "note={note:?} expected Base64, got {err:?}"
                );
            } else if note == "invalid MAC" {
                assert!(
                    matches!(err, Nip44Error::HmacMismatch),
                    "note={note:?} expected HmacMismatch, got {err:?}"
                );
            } else if note == "invalid padding" {
                assert!(
                    matches!(err, Nip44Error::InvalidPadding),
                    "note={note:?} expected InvalidPadding, got {err:?}"
                );
            } else if note.starts_with("invalid payload length") {
                assert!(
                    matches!(err, Nip44Error::InvalidPayload(_)),
                    "note={note:?} expected InvalidPayload, got {err:?}"
                );
            }
        }
    }

    #[test]
    fn encrypt_rejects_all_invalid_length_vectors() {
        let parsed = fixtures();
        let cases: Vec<usize> =
            serde_json::from_value(parsed["v2"]["invalid"]["encrypt_msg_lengths"].clone()).unwrap();
        assert!(
            !cases.is_empty(),
            "no invalid encrypt length vectors loaded"
        );
        let ck = [0u8; 32];
        let nonce = [0u8; 32];
        for len in cases {
            let plaintext = vec![b'x'; len];
            let result = encrypt_with_nonce(&ck, &nonce, &plaintext);
            assert!(
                result.is_err(),
                "expected error for plaintext len {len}, got Ok"
            );
            match (len, result.unwrap_err()) {
                (0, Nip44Error::PlaintextEmpty) => {}
                (n, Nip44Error::PlaintextTooLong) if n > MAX_PLAINTEXT_LEN => {}
                (n, err) => panic!("unexpected result for len {n}: {err:?}"),
            }
        }
    }

    #[test]
    fn encrypt_decrypt_round_trip_for_boundary_lengths() {
        let lengths: &[usize] = &[1, 31, 32, 33, 64, 100, 1000, 65535];
        // Deterministic conversation keys derived from a fixed seed pattern so
        // the test is reproducible without relying on runtime randomness.
        for (idx, &len) in lengths.iter().enumerate() {
            let seed_byte = (idx + 1) as u8;
            let ck = [seed_byte; 32];
            let mut nonce = [0u8; 32];
            for (i, slot) in nonce.iter_mut().enumerate() {
                *slot = seed_byte.wrapping_add(i as u8);
            }
            let plaintext: Vec<u8> = (0..len)
                .map(|i| ((i as u16).wrapping_mul(31) & 0xff) as u8)
                .collect();

            let payload = encrypt_with_nonce(&ck, &nonce, &plaintext).unwrap();
            let decrypted = decrypt(&ck, &payload).unwrap();
            assert_eq!(decrypted, plaintext, "len={len}");
        }
    }
}

#[cfg(test)]
mod message_keys_tests {
    use super::*;

    #[test]
    fn message_keys_matches_all_spec_vectors() {
        #[derive(serde::Deserialize)]
        struct Entry {
            nonce: String,
            chacha_key: String,
            chacha_nonce: String,
            hmac_key: String,
        }
        #[derive(serde::Deserialize)]
        struct Group {
            conversation_key: String,
            keys: Vec<Entry>,
        }
        let raw = include_str!("../tests/fixtures/nip44-v2-vectors.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        let group: Group =
            serde_json::from_value(parsed["v2"]["valid"]["get_message_keys"].clone()).unwrap();
        assert!(!group.keys.is_empty(), "no message_keys vectors loaded");

        let mut ck = [0u8; 32];
        ck.copy_from_slice(&hex::decode(&group.conversation_key).unwrap());

        for entry in group.keys {
            let mut nonce = [0u8; 32];
            nonce.copy_from_slice(&hex::decode(&entry.nonce).unwrap());
            let (chacha_key, chacha_nonce, hmac_key) = message_keys(&ck, &nonce).unwrap();
            assert_eq!(
                hex::encode(chacha_key),
                entry.chacha_key,
                "nonce: {}",
                entry.nonce
            );
            assert_eq!(
                hex::encode(chacha_nonce),
                entry.chacha_nonce,
                "nonce: {}",
                entry.nonce
            );
            assert_eq!(
                hex::encode(hmac_key),
                entry.hmac_key,
                "nonce: {}",
                entry.nonce
            );
        }
    }
}
