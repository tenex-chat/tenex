use crate::config::ResolvedModel;
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::Prompt, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tenex_conversations::{ConversationStore, MessageQuery};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationGetArgs {
    pub conversation_id: String,
    pub limit: Option<i64>,
    pub until_id: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationGetError(String);

#[derive(Clone)]
pub struct ConversationGetTool {
    db_path: PathBuf,
    resolved: Arc<ResolvedModel>,
}

impl ConversationGetTool {
    pub fn new(db_path: PathBuf, resolved: Arc<ResolvedModel>) -> Self {
        Self { db_path, resolved }
    }

    async fn call_llm(&self, system: &str, user: String) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let result = match self.resolved.provider.as_str() {
            "openrouter" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
                let agent = openrouter::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "openai" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
                let agent = openai::CompletionsClient::builder()
                    .api_key(key)
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "ollama" => {
                let mut builder = ollama::Client::builder().api_key(Nothing);
                if let Some(url) = self.resolved.base_url.as_deref() {
                    builder = builder.base_url(url);
                }
                let agent = builder
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            _ => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
                let agent = anthropic::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
        };

        Ok(result)
    }
}

impl Tool for ConversationGetTool {
    const NAME: &'static str = "conversation_get";
    type Error = ConversationGetError;
    type Args = ConversationGetArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Retrieve the full message transcript for a conversation by its ID. Returns messages in chronological order with role and author prefix.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "The conversation ID (64-char hex event ID)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of messages to return (default: all)"
                    },
                    "until_id": {
                        "type": "string",
                        "description": "Stop before the message with this event ID or record ID (exclusive). Useful for reading a conversation slice."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "If provided, analyze the conversation transcript with this prompt using an LLM and return the analysis instead of the raw transcript."
                    }
                },
                "required": ["conversation_id"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ConversationGetError(format!("failed to open conversation store: {e}")))?;

        let messages = store
            .list_messages(
                &args.conversation_id,
                MessageQuery {
                    limit: args.limit,
                    ..Default::default()
                },
            )
            .map_err(|e| ConversationGetError(format!("failed to list messages: {e}")))?;

        let id_short = &args.conversation_id[..8.min(args.conversation_id.len())];

        if messages.is_empty() {
            return Ok(format!("No messages found for conversation {id_short}"));
        }

        let mut filtered = messages;
        if let Some(uid) = args.until_id.as_deref() {
            if let Some(idx) = filtered.iter().position(|m| {
                m.record_id == uid || m.nostr_event_id.as_deref() == Some(uid)
            }) {
                filtered.truncate(idx);
            }
        }

        if filtered.is_empty() {
            return Ok(format!("No messages found for conversation {id_short}"));
        }

        let mut lines = vec![format!(
            "Conversation {id_short} ({} messages):",
            filtered.len()
        )];
        for m in &filtered {
            let author_short = &m.author_pubkey[..8.min(m.author_pubkey.len())];
            lines.push(format!("[{}] {author_short}: {}", m.message_type, m.content));
        }
        let transcript = lines.join("\n");

        if let Some(p) = args.prompt {
            let system = "You are analyzing a conversation transcript. Answer concisely based only on the transcript provided.";
            let user = format!("<transcript>\n{transcript}\n</transcript>\n\n{p}");
            return self
                .call_llm(system, user)
                .await
                .map_err(|e| ConversationGetError(format!("LLM call failed: {e}")));
        }

        Ok(transcript)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tenex_conversations::model::ConversationRow;
    use tenex_conversations::NewMessage;

    fn resolved() -> Arc<ResolvedModel> {
        Arc::new(ResolvedModel {
            provider: "anthropic".to_string(),
            model: "claude-3-sonnet".to_string(),
            api_key: None,
            base_url: None,
        })
    }

    fn seed_db(path: &std::path::Path, conversation_id: &str, messages: &[(&str, &str, &str)]) {
        let store = ConversationStore::open(path).expect("open store");
        store
            .upsert_conversation(&ConversationRow {
                id: conversation_id.to_string(),
                title: None,
                summary: None,
                last_user_message: None,
                status_label: None,
                status_current_activity: None,
                owner_pubkey: None,
                created_at: Some(0),
                last_activity: None,
                metadata: serde_json::json!({}),
                runtime_state: serde_json::json!({}),
                updated_at: 0,
            })
            .expect("upsert conversation");
        for (i, (record_id, author, content)) in messages.iter().enumerate() {
            store
                .append_message(
                    conversation_id,
                    &NewMessage {
                        record_id: record_id.to_string(),
                        nostr_event_id: None,
                        author_pubkey: author.to_string(),
                        sender_pubkey: None,
                        ral: None,
                        message_type: "user".to_string(),
                        role: Some("user".to_string()),
                        content: content.to_string(),
                        timestamp: Some(i as i64),
                        targeted_pubkeys: None,
                        sender_principal: None,
                        targeted_principals: None,
                        tool_data: None,
                        delegation_marker: None,
                        human_readable: None,
                        transcript_tool_attributes: None,
                    },
                )
                .expect("append message");
        }
    }

    #[test]
    fn test_conversation_get_tool_creation() {
        let db_path = PathBuf::from("/home/user/.tenex/projects/myproject/conversation.db");
        let tool = ConversationGetTool::new(db_path.clone(), resolved());
        assert_eq!(tool.db_path, db_path);
    }

    #[tokio::test]
    async fn returns_transcript_for_existing_conversation() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("conversation.db");
        let cid = "a".repeat(64);
        seed_db(
            &db,
            &cid,
            &[
                ("rec1", "alice0000aaaa", "hello"),
                ("rec2", "bob0000bbbb", "world"),
            ],
        );

        let tool = ConversationGetTool::new(db, resolved());
        let out = tool
            .call(ConversationGetArgs {
                conversation_id: cid.clone(),
                limit: None,
                until_id: None,
                prompt: None,
            })
            .await
            .expect("tool call should succeed");

        assert!(out.contains("aaaaaaaa (2 messages)"), "got: {out}");
        assert!(out.contains("hello"));
        assert!(out.contains("world"));
        assert!(out.contains("alice000"));
        assert!(out.contains("bob0000b"));
    }

    #[tokio::test]
    async fn reports_missing_conversation() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("conversation.db");
        ConversationStore::open(&db).unwrap();

        let tool = ConversationGetTool::new(db, resolved());
        let out = tool
            .call(ConversationGetArgs {
                conversation_id: "f".repeat(64),
                limit: None,
                until_id: None,
                prompt: None,
            })
            .await
            .expect("tool call should succeed");

        assert!(out.starts_with("No messages found"), "got: {out}");
    }

    #[tokio::test]
    async fn until_id_truncates_by_record_id() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("conversation.db");
        let cid = "b".repeat(64);
        seed_db(
            &db,
            &cid,
            &[
                ("rec1", "alice0000", "first"),
                ("rec2", "alice0000", "second"),
                ("rec3", "alice0000", "third"),
            ],
        );

        let tool = ConversationGetTool::new(db, resolved());
        let out = tool
            .call(ConversationGetArgs {
                conversation_id: cid,
                limit: None,
                until_id: Some("rec2".to_string()),
                prompt: None,
            })
            .await
            .expect("tool call should succeed");

        assert!(out.contains("(1 messages)"), "got: {out}");
        assert!(out.contains("first"));
        assert!(!out.contains("second"));
        assert!(!out.contains("third"));
    }

    /// E2E probe against a copy of the live project DB.
    ///
    /// Run with:
    ///   TENEX_PROBE_DB=$HOME/.tenex/projects/TENEX-ff3ssq/conversation.db \
    ///   TENEX_PROBE_CID=410a9661ec26252aac23a81a4100052a0a80e659e71d18d2aa4277692f7f63cb \
    ///   cargo test -p tenex-agent --bins -- conversation_get::tests::probe_real_database --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn probe_real_database() {
        let src = std::env::var("TENEX_PROBE_DB").expect("set TENEX_PROBE_DB to a conversation.db path");
        let cid = std::env::var("TENEX_PROBE_CID").expect("set TENEX_PROBE_CID to a conversation id");
        let dir = TempDir::new().unwrap();
        let copy = dir.path().join("conversation.db");
        std::fs::copy(&src, &copy).expect("copy db");

        let tool = ConversationGetTool::new(copy, resolved());
        let out = tool
            .call(ConversationGetArgs {
                conversation_id: cid.clone(),
                limit: Some(5),
                until_id: None,
                prompt: None,
            })
            .await
            .expect("tool call should succeed");

        eprintln!("=== probe output ({} bytes) ===\n{}", out.len(), out);
        assert!(!out.starts_with("No messages found"), "expected real conversation");
    }

    #[tokio::test]
    async fn limit_caps_returned_messages() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("conversation.db");
        let cid = "c".repeat(64);
        seed_db(
            &db,
            &cid,
            &[
                ("rec1", "alice0000", "one"),
                ("rec2", "alice0000", "two"),
                ("rec3", "alice0000", "three"),
            ],
        );

        let tool = ConversationGetTool::new(db, resolved());
        let out = tool
            .call(ConversationGetArgs {
                conversation_id: cid,
                limit: Some(2),
                until_id: None,
                prompt: None,
            })
            .await
            .expect("tool call should succeed");

        assert!(out.contains("(2 messages)"), "got: {out}");
        assert!(out.contains("one"));
        assert!(out.contains("two"));
        assert!(!out.contains("three"));
    }
}
