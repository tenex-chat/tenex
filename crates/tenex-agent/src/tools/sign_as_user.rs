use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tenex_protocol::{RuntimeControlRequest, RuntimeControlResponse, SignAsUserRequest};

use crate::runtime_control;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SignAsUserError(String);

#[derive(Debug, Deserialize, Serialize)]
pub struct SignAsUserArgs {
    pub description: String,
    pub explanation: String,
    pub event: UnsignedEventInput,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum UnsignedEventInput {
    JsonString(String),
    Object(Value),
}

#[derive(Debug, Deserialize)]
struct RawUnsignedEvent {
    kind: u64,
    content: String,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

#[derive(Clone)]
pub struct SignAsUserTool {
    owner_pubkey: String,
    agent_nsec: String,
}

impl SignAsUserTool {
    pub fn new(owner_pubkey: String, agent_nsec: String) -> Self {
        Self {
            owner_pubkey,
            agent_nsec,
        }
    }
}

impl Tool for SignAsUserTool {
    const NAME: &'static str = "sign_as_user";
    type Error = SignAsUserError;
    type Args = SignAsUserArgs;
    type Output = tenex_protocol::SignAsUserResponse;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Request the project owner/user to sign an unsigned Nostr event through \
                their configured NIP-46 bunker. Provide the unsigned event, a concise description, \
                and a human-readable explanation for why the signature is needed. The tool returns \
                the signed event JSON; it does not publish the event."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "A short one-line description of the event being signed."
                    },
                    "explanation": {
                        "type": "string",
                        "description": "Human-readable reason the user should approve this signature."
                    },
                    "event": {
                        "description": "Unsigned Nostr event JSON as an object or JSON string. Must include numeric kind, string content, and optional tags as arrays of strings.",
                        "oneOf": [
                            {"type": "string"},
                            {
                                "type": "object",
                                "properties": {
                                    "kind": {"type": "number"},
                                    "created_at": {"type": "number"},
                                    "content": {"type": "string"},
                                    "tags": {
                                        "type": "array",
                                        "items": {
                                            "type": "array",
                                            "items": {"type": "string"}
                                        }
                                    }
                                },
                                "required": ["kind", "content"]
                            }
                        ]
                    }
                },
                "required": ["description", "explanation", "event"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let raw = parse_unsigned_event(&args.event)?;
        let kind = u16::try_from(raw.kind)
            .map_err(|_| SignAsUserError(format!("event kind {} exceeds u16 range", raw.kind)))?;
        nostr::Tags::parse(raw.tags.clone())
            .map_err(|e| SignAsUserError(format!("invalid tags: {e}")))?;

        let socket = runtime_control::socket_path().ok_or_else(|| {
            SignAsUserError(
                "sign_as_user requires the Rust project runtime control socket".to_string(),
            )
        })?;
        let response = runtime_control::request(
            socket,
            RuntimeControlRequest::SignAsUser(SignAsUserRequest {
                owner_pubkey: self.owner_pubkey.clone(),
                agent_nsec: self.agent_nsec.clone(),
                description: args.description,
                explanation: args.explanation,
                kind,
                created_at: raw.created_at,
                content: raw.content,
                tags: raw.tags,
            }),
        )
        .await
        .map_err(|e| SignAsUserError(format!("runtime control request failed: {e}")))?;

        match response {
            RuntimeControlResponse::SignAsUser(response) => Ok(response),
            RuntimeControlResponse::Error(error) => Err(SignAsUserError(error.message)),
            other => Err(SignAsUserError(format!(
                "unexpected runtime control response for sign_as_user: {other:?}"
            ))),
        }
    }
}

fn parse_unsigned_event(input: &UnsignedEventInput) -> Result<RawUnsignedEvent, SignAsUserError> {
    let value = match input {
        UnsignedEventInput::JsonString(raw) => serde_json::from_str(raw)
            .map_err(|e| SignAsUserError(format!("event is not valid JSON: {e}")))?,
        UnsignedEventInput::Object(value) => value.clone(),
    };
    serde_json::from_value(value).map_err(|e| SignAsUserError(format!("invalid event: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_event_from_json_string() {
        let input = UnsignedEventInput::JsonString(
            r#"{"kind":1,"created_at":123,"content":"hello","tags":[["t","tenex"]]}"#.to_string(),
        );
        let event = parse_unsigned_event(&input).unwrap();
        assert_eq!(event.kind, 1);
        assert_eq!(event.created_at, Some(123));
        assert_eq!(event.content, "hello");
        assert_eq!(event.tags, vec![vec!["t".to_string(), "tenex".to_string()]]);
    }

    #[tokio::test]
    async fn missing_runtime_control_socket_returns_tool_error() {
        std::env::remove_var("TENEX_RUNTIME_CONTROL_SOCKET");
        let tool = SignAsUserTool::new(
            "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957".to_string(),
            "nsec125v964gu6u6ncqdkczwjq7pdtu0adj03sjfcm3lsj67ljk7v2hrsr2juay".to_string(),
        );
        let err = tool
            .call(SignAsUserArgs {
                description: "desc".to_string(),
                explanation: "why".to_string(),
                event: UnsignedEventInput::Object(json!({
                    "kind": 1,
                    "content": "hello",
                    "tags": []
                })),
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("runtime control socket"));
    }
}
