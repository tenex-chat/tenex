use secp256k1::XOnlyPublicKey;
use std::str::FromStr;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BunkerUriError {
    #[error("bunker uri must use scheme bunker://")]
    WrongScheme,
    #[error("bunker uri is missing remote pubkey")]
    MissingRemotePubkey,
    #[error("bunker uri remote pubkey is not a valid x-only key: {0}")]
    InvalidRemotePubkey(String),
    #[error("bunker uri must include at least one relay")]
    MissingRelay,
    #[error("bunker uri relay is not a valid websocket url: {0}")]
    InvalidRelay(String),
    #[error("bunker uri failed to parse: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BunkerUri {
    pub remote_pubkey: String,
    pub relays: Vec<String>,
    pub secret: Option<String>,
}

const BUNKER_SCHEME_PREFIX: &str = "bunker://";

pub fn parse_bunker_uri(raw: &str) -> Result<BunkerUri, BunkerUriError> {
    let rest = raw
        .strip_prefix(BUNKER_SCHEME_PREFIX)
        .ok_or(BunkerUriError::WrongScheme)?;

    if rest.is_empty() || rest.starts_with(['?', '/', '#']) {
        return Err(BunkerUriError::MissingRemotePubkey);
    }

    let parsed = Url::parse(&format!("http://{rest}"))
        .map_err(|err| BunkerUriError::Parse(err.to_string()))?;

    let remote_pubkey = parsed
        .host_str()
        .ok_or(BunkerUriError::MissingRemotePubkey)?;

    XOnlyPublicKey::from_str(remote_pubkey)
        .map_err(|err| BunkerUriError::InvalidRemotePubkey(err.to_string()))?;

    let mut relays: Vec<String> = Vec::new();
    let mut secret: Option<String> = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "relay" => {
                let relay = value.into_owned();
                let relay_url = Url::parse(&relay)
                    .map_err(|err| BunkerUriError::InvalidRelay(err.to_string()))?;
                match relay_url.scheme() {
                    "ws" | "wss" => relays.push(relay),
                    other => {
                        return Err(BunkerUriError::InvalidRelay(format!(
                            "unsupported scheme: {other}"
                        )));
                    }
                }
            }
            "secret" => secret = Some(value.into_owned()),
            _ => {}
        }
    }

    if relays.is_empty() {
        return Err(BunkerUriError::MissingRelay);
    }

    Ok(BunkerUri {
        remote_pubkey: remote_pubkey.to_string(),
        relays,
        secret,
    })
}

pub fn derive_default_bunker_uri(owner_pubkey: &str, first_relay: &str) -> String {
    format!("bunker://{owner_pubkey}?relay={first_relay}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};

    fn test_pubkey(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    #[test]
    fn parses_bunker_uri_with_two_relays_and_secret() {
        let pk = test_pubkey(0x01);
        let raw = format!("bunker://{pk}?relay=wss://a/&relay=wss://b/&secret=xyz");

        let parsed = parse_bunker_uri(&raw).expect("parse must succeed");

        assert_eq!(parsed.remote_pubkey, pk);
        assert_eq!(
            parsed.relays,
            vec!["wss://a/".to_string(), "wss://b/".to_string()]
        );
        assert_eq!(parsed.secret, Some("xyz".to_string()));
    }

    #[test]
    fn parses_bunker_uri_with_single_relay_and_no_secret() {
        let pk = test_pubkey(0x02);
        let raw = format!("bunker://{pk}?relay=wss://a/");

        let parsed = parse_bunker_uri(&raw).expect("parse must succeed");

        assert_eq!(parsed.remote_pubkey, pk);
        assert_eq!(parsed.relays, vec!["wss://a/".to_string()]);
        assert_eq!(parsed.secret, None);
    }

    #[test]
    fn rejects_https_scheme_as_wrong_scheme() {
        let pk = test_pubkey(0x01);
        let raw = format!("https://{pk}?relay=wss://a/");

        assert_eq!(parse_bunker_uri(&raw), Err(BunkerUriError::WrongScheme));
    }

    #[test]
    fn rejects_nostr_scheme_as_wrong_scheme() {
        let pk = test_pubkey(0x01);
        let raw = format!("nostr://{pk}?relay=wss://a/");

        assert_eq!(parse_bunker_uri(&raw), Err(BunkerUriError::WrongScheme));
    }

    #[test]
    fn rejects_missing_remote_pubkey() {
        let raw = "bunker://?relay=wss://a/";

        assert_eq!(
            parse_bunker_uri(raw),
            Err(BunkerUriError::MissingRemotePubkey)
        );
    }

    #[test]
    fn rejects_non_hex_remote_pubkey() {
        let raw = "bunker://not-hex?relay=wss://a/";

        match parse_bunker_uri(raw) {
            Err(BunkerUriError::InvalidRemotePubkey(_)) => {}
            other => panic!("expected InvalidRemotePubkey, got {other:?}"),
        }
    }

    #[test]
    fn rejects_remote_pubkey_with_wrong_length() {
        let short_pk = "abcdef0123456789";
        let raw = format!("bunker://{short_pk}?relay=wss://a/");

        match parse_bunker_uri(&raw) {
            Err(BunkerUriError::InvalidRemotePubkey(_)) => {}
            other => panic!("expected InvalidRemotePubkey, got {other:?}"),
        }
    }

    #[test]
    fn rejects_bunker_uri_without_any_relay() {
        let pk = test_pubkey(0x03);
        let raw = format!("bunker://{pk}");

        assert_eq!(parse_bunker_uri(&raw), Err(BunkerUriError::MissingRelay));
    }

    #[test]
    fn accepts_relay_with_ws_scheme() {
        let pk = test_pubkey(0x04);
        let raw = format!("bunker://{pk}?relay=ws://insecure/");

        let parsed = parse_bunker_uri(&raw).expect("ws:// must be accepted");

        assert_eq!(parsed.remote_pubkey, pk);
        assert_eq!(parsed.relays, vec!["ws://insecure/".to_string()]);
        assert_eq!(parsed.secret, None);
    }

    #[test]
    fn rejects_relay_with_http_scheme() {
        let pk = test_pubkey(0x05);
        let raw = format!("bunker://{pk}?relay=http://bad/");

        match parse_bunker_uri(&raw) {
            Err(BunkerUriError::InvalidRelay(_)) => {}
            other => panic!("expected InvalidRelay, got {other:?}"),
        }
    }

    #[test]
    fn derive_default_bunker_uri_round_trips_through_parser() {
        let owner = test_pubkey(0x06);
        let raw = derive_default_bunker_uri(&owner, "wss://relay/");

        let parsed = parse_bunker_uri(&raw).expect("derived uri must parse");

        assert_eq!(parsed.remote_pubkey, owner);
        assert_eq!(parsed.relays, vec!["wss://relay/".to_string()]);
        assert_eq!(parsed.secret, None);
    }
}
