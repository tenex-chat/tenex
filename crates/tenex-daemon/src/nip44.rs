use secp256k1::{PublicKey, SecretKey};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Nip44Error {
    #[error("nip-44 invalid secret key: {0}")]
    InvalidSecretKey(secp256k1::Error),
    #[error("nip-44 invalid public key: {0}")]
    InvalidPublicKey(secp256k1::Error),
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

pub fn message_keys(
    conversation_key: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<([u8; 32], [u8; 12], [u8; 32]), Nip44Error> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let hk = Hkdf::<Sha256>::from_prk(conversation_key).map_err(|_| Nip44Error::HkdfExpand)?;
    let mut okm = [0u8; 76];
    hk.expand(nonce, &mut okm).map_err(|_| Nip44Error::HkdfExpand)?;
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
            assert_eq!(hex::encode(key), case.conversation_key, "vector: {}", case.sec1);
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
            assert_eq!(hex::encode(chacha_key), entry.chacha_key, "nonce: {}", entry.nonce);
            assert_eq!(hex::encode(chacha_nonce), entry.chacha_nonce, "nonce: {}", entry.nonce);
            assert_eq!(hex::encode(hmac_key), entry.hmac_key, "nonce: {}", entry.nonce);
        }
    }
}
