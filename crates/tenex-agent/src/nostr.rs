use anyhow::{Context, Result};
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
use serde::Deserialize;

/// Minimal representation of the incoming Nostr event from stdin.
#[derive(Debug, Deserialize)]
pub struct InputEvent {
    pub id: String,
    pub pubkey: String,
    #[allow(dead_code)]
    pub created_at: u64,
    #[allow(dead_code)]
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    #[allow(dead_code)]
    pub sig: String,
}

impl InputEvent {
    pub fn from_json(s: &str) -> Result<Self> {
        serde_json::from_str(s).context("Failed to parse input Nostr event from stdin")
    }

    /// The root event ID for the thread:
    /// 1. First tag ["e", id, _, "root"]
    /// 2. First ["e", id, ...] tag
    /// 3. The event's own id (this event IS the root)
    pub fn root_event_id(&self) -> &str {
        for tag in &self.tags {
            if tag.len() >= 4 && tag[0] == "e" && tag[3] == "root" {
                return &tag[1];
            }
        }
        for tag in &self.tags {
            if tag.len() >= 2 && tag[0] == "e" {
                return &tag[1];
            }
        }
        &self.id
    }

    /// The direct parent to reply to, or `None` when this event is itself the root.
    /// When `Some`, callers should add both a "root" e-tag and a "reply" e-tag.
    pub fn reply_event_id(&self) -> Option<&str> {
        if self.root_event_id() == self.id.as_str() {
            None
        } else {
            Some(&self.id)
        }
    }
}

/// LLM metadata tags added to every event.
pub struct LlmTags {
    pub model: String,
    pub ral: u32,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}

impl LlmTags {
    fn apply(&self, mut builder: EventBuilder) -> Result<EventBuilder> {
        builder = builder
            .tag(Tag::parse(["llm-model", &self.model]).context("Failed to build llm-model tag")?)
            .tag(
                Tag::parse(["llm-ral", &self.ral.to_string()])
                    .context("Failed to build llm-ral tag")?,
            );

        if let Some(n) = self.input_tokens {
            builder = builder.tag(
                Tag::parse(["llm-prompt-tokens", &n.to_string()])
                    .context("Failed to build llm-prompt-tokens tag")?,
            );
        }
        if let Some(n) = self.output_tokens {
            builder = builder.tag(
                Tag::parse(["llm-completion-tokens", &n.to_string()])
                    .context("Failed to build llm-completion-tokens tag")?,
            );
        }

        // Use reported total; fall back to sum of input + output.
        let effective_total = self.total_tokens.filter(|&t| t > 0).or_else(|| {
            match (self.input_tokens, self.output_tokens) {
                (Some(i), Some(o)) => Some(i + o),
                _ => None,
            }
        });
        if let Some(n) = effective_total {
            builder = builder.tag(
                Tag::parse(["llm-total-tokens", &n.to_string()])
                    .context("Failed to build llm-total-tokens tag")?,
            );
        }

        if let Some(n) = self.cached_input_tokens.filter(|&n| n > 0) {
            builder = builder.tag(
                Tag::parse(["llm-cached-input-tokens", &n.to_string()])
                    .context("Failed to build llm-cached-input-tokens tag")?,
            );
        }

        Ok(builder)
    }
}

fn add_thread_tags(
    mut builder: EventBuilder,
    root_id: &str,
    reply_id: Option<&str>,
) -> Result<EventBuilder> {
    builder = builder
        .tag(Tag::parse(["e", root_id, "", "root"]).context("Failed to build root e-tag")?);
    if let Some(id) = reply_id {
        builder = builder
            .tag(Tag::parse(["e", id, "", "reply"]).context("Failed to build reply e-tag")?);
    }
    Ok(builder)
}

pub struct AgentSigner {
    keys: Keys,
}

impl AgentSigner {
    pub fn new(nsec: &str) -> Result<Self> {
        let keys = Keys::parse(nsec).context("Failed to parse nsec key")?;
        Ok(Self { keys })
    }

    pub fn pubkey_hex(&self) -> String {
        self.keys.public_key().to_hex()
    }

    /// Emit a completion event (with p-tag and status=completed) to stdout.
    pub fn emit_completion(&self, content: &str, input: &InputEvent, llm: &LlmTags) -> Result<()> {
        let builder = EventBuilder::text_note(content);
        let builder = add_thread_tags(builder, input.root_event_id(), input.reply_event_id())?;
        let builder = builder
            .tag(Tag::parse(["p", &input.pubkey]).context("Failed to build p-tag")?)
            .tag(Tag::parse(["status", "completed"]).context("Failed to build status tag")?);
        let builder = llm.apply(builder)?;
        let event = builder
            .sign_with_keys(&self.keys)
            .context("Failed to sign completion event")?;
        println!("{}", event.as_json());
        Ok(())
    }

    /// Emit an intermediate text event (no p-tag, no status) to stdout.
    pub fn emit_intermediate(
        &self,
        content: &str,
        root_id: &str,
        reply_id: Option<&str>,
        llm: &LlmTags,
    ) -> Result<()> {
        let builder = EventBuilder::new(Kind::TextNote, content);
        let builder = add_thread_tags(builder, root_id, reply_id)?;
        let builder = llm.apply(builder)?;
        let event = builder
            .sign_with_keys(&self.keys)
            .context("Failed to sign intermediate event")?;
        println!("{}", event.as_json());
        Ok(())
    }

    /// Emit a tool-use event (no p-tag, no status) to stdout.
    pub fn emit_tool_use(
        &self,
        tool_name: &str,
        args: &str,
        root_id: &str,
        reply_id: Option<&str>,
        llm: &LlmTags,
        q_tags: &[String],
    ) -> Result<()> {
        let builder = EventBuilder::new(Kind::TextNote, "");
        let builder = add_thread_tags(builder, root_id, reply_id)?;
        let mut builder = builder
            .tag(Tag::parse(["tool", tool_name]).context("Failed to build tool tag")?)
            .tag(Tag::parse(["tool-args", args]).context("Failed to build tool-args tag")?);
        for q_id in q_tags {
            builder =
                builder.tag(Tag::parse(["q", q_id]).context("Failed to build q-tag")?);
        }
        let builder = llm.apply(builder)?;
        let event = builder
            .sign_with_keys(&self.keys)
            .context("Failed to sign tool-use event")?;
        println!("{}", event.as_json());
        Ok(())
    }

    /// Emit a delegation event (kind:1, p-tagged to recipient, no thread e-tags) to stdout.
    /// Returns the signed event ID so callers can q-tag it.
    pub fn emit_delegation(
        &self,
        target_pubkey: &str,
        content: &str,
        llm: &LlmTags,
    ) -> Result<String> {
        let builder = EventBuilder::new(Kind::TextNote, content);
        let builder = builder
            .tag(Tag::parse(["p", target_pubkey]).context("Failed to build p-tag")?);
        let builder = llm.apply(builder)?;
        let event = builder
            .sign_with_keys(&self.keys)
            .context("Failed to sign delegation event")?;
        let id = event.id.to_hex();
        println!("{}", event.as_json());
        Ok(id)
    }
}
