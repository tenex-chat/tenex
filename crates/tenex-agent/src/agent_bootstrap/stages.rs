//! Structured bootstrap stages — each function turns a slice of the agent's
//! input state into a self-contained chunk of the [`AgentBootstrap`] result.
//!
//! Stages here are larger than the simple utilities in
//! [`super::helpers`]; they have explicit input/output structs to keep
//! call-sites readable.

use std::sync::Arc;

use tenex_context::DisplayNameResolver;
use tenex_conversations::ConversationStore;
use tenex_protocol::ProjectRef;
use tenex_rag::RagStore;

use crate::config::{AgentConfig, ResolvedModel};
use crate::context_discovery;

/// Outputs of [`open_project`].
pub(super) struct OpenedProject {
    pub project_meta: tenex_project::ProjectMetadata,
    pub project_agents: Arc<Vec<tenex_project::Agent>>,
    pub is_pm_agent: bool,
    pub project_ref: ProjectRef,
    pub owner_pubkey_hex: String,
}

/// Open the project metadata, agent list, and PM membership. Resolves
/// `project_ref` from the owner pubkey for use in emitted events.
pub(super) fn open_project(project_id: &str, agent_pubkey: &str) -> anyhow::Result<OpenedProject> {
    use anyhow::Context as _;
    let project = tenex_project::Project::open_default(project_id)
        .with_context(|| format!("Failed to open project for '{project_id}'"))?;
    let project_meta = project
        .metadata()
        .context("Failed to read project metadata")?
        .context("Project metadata is missing — has the project been ingested?")?;
    // Use the comprehensive list — every member named in the project's
    // 31933 event — so the running agent is aware of peers that live on
    // other backends. Locality is encoded on `Agent::is_local`.
    let project_agents = Arc::new(
        project
            .all_project_agents()
            .context("Failed to read project agents")?,
    );
    let is_pm_agent = project
        .project_agents()
        .context("Failed to read project membership")?
        .iter()
        .any(|pa| pa.agent_pubkey == agent_pubkey && pa.is_pm);
    let owner_pubkey_hex = project_meta
        .owner_pubkey
        .as_ref()
        .context("Project metadata has no owner_pubkey — cannot construct project ref")?
        .clone();
    let project_ref = ProjectRef {
        author: nostr::PublicKey::from_hex(&owner_pubkey_hex)
            .context("Failed to parse project owner pubkey")?,
        d_tag: project_meta.d_tag.clone(),
    };
    Ok(OpenedProject {
        project_meta,
        project_agents,
        is_pm_agent,
        project_ref,
        owner_pubkey_hex,
    })
}

/// Outputs of [`resolve_workspace`].
pub(super) struct WorkspacePaths {
    pub project_root: std::path::PathBuf,
    pub working_dir: String,
    pub project_base_path: String,
    pub current_branch: Option<String>,
    pub root_agents_md: Option<String>,
}

/// Resolve `project_root`, branch-specific `working_dir`, and root
/// `AGENTS.md` overlay from the agent config + triggering envelope.
///
/// Honours the envelope's `branch` first; falls back to the current branch
/// of the configured working directory. When `envelope_commit` is set, the
/// worktree is fetched and synced to that commit so cross-host delegations
/// see exactly the state the sender pushed.
pub(super) fn resolve_workspace(
    agent_config: &AgentConfig,
    envelope_branch: Option<&str>,
    envelope_commit: Option<&str>,
) -> WorkspacePaths {
    let configured_working_dir = agent_config
        .working_directory
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let project_root = crate::project_instructions::infer_project_root(&configured_working_dir);
    let (resolved_working_dir, current_branch) =
        if envelope_branch.is_some() || envelope_commit.is_some() {
            tenex_project::resolve_working_dir(&project_root, envelope_branch, envelope_commit)
        } else {
            let current = tenex_project::current_branch(&configured_working_dir)
                .ok()
                .flatten()
                .or_else(|| tenex_project::current_branch(&project_root).ok().flatten());
            (configured_working_dir, current)
        };
    let working_dir = resolved_working_dir.display().to_string();
    let project_base_path = project_root.display().to_string();
    let root_agents_md = crate::project_instructions::read_root_agents_md(&project_root);
    WorkspacePaths {
        project_root,
        working_dir,
        project_base_path,
        current_branch,
        root_agents_md,
    }
}

/// Inputs for [`build_skill_context`].
pub(super) struct SkillContextInputs<'a> {
    pub agent_pubkey: &'a str,
    pub working_dir: &'a str,
    pub base_dir: &'a std::path::Path,
    pub agent_home: &'a std::path::Path,
    pub agent_config_path: &'a str,
    pub conv_store: Option<&'a ConversationStore>,
    pub conversation_id: &'a str,
    pub agent_default_skills: Option<Vec<String>>,
    pub envelope_skills: Vec<String>,
    /// Static category from agent config — used to auto-enable category-scoped
    /// skills (e.g. `workflows` for orchestrators/principals) without waiting
    /// for the async fallback resolver.
    pub agent_category: Option<tenex_supervision::types::AgentCategory>,
}

/// Outputs of [`build_skill_context`].
pub(super) struct SkillContextOutputs {
    pub skill_ctx: Arc<crate::skills::SkillLookupCtx>,
    pub initial_self_applied: Vec<String>,
    pub granted_tools: std::collections::HashSet<String>,
    pub preloaded_skills_block: Option<String>,
}

/// Resolve the agent's skill context: load self-applied skills from prior
/// turns, merge with always-on config skills, render the preloaded-skills
/// block for the system prompt, and compute the set of tools granted by
/// skill frontmatter.
pub(super) fn build_skill_context(inputs: SkillContextInputs<'_>) -> SkillContextOutputs {
    let skill_ctx = Arc::new(crate::skills::SkillLookupCtx {
        agent_pubkey: inputs.agent_pubkey.to_string(),
        project_path: inputs.working_dir.to_string(),
        base_dir: inputs.base_dir.to_path_buf(),
        agent_config_path: inputs.agent_config_path.to_string(),
    });

    let initial_self_applied: Vec<String> = inputs
        .conv_store
        .and_then(|s| {
            s.get_agent_context_state(inputs.conversation_id, inputs.agent_pubkey)
                .ok()
                .flatten()
        })
        .and_then(|state| state.self_applied_skills)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let mut all_skill_ids: Vec<String> = inputs.agent_default_skills.unwrap_or_default();
    for id in &inputs.envelope_skills {
        if !all_skill_ids.contains(id) {
            all_skill_ids.push(id.clone());
        }
    }
    for id in &initial_self_applied {
        if !all_skill_ids.contains(id) {
            all_skill_ids.push(id.clone());
        }
    }

    // Category-scoped auto-enable: orchestrators and principals always get the
    // `workflows` skill so they can write down and dispatch the multi-step
    // procedures their base prompts describe, without re-deriving them each turn.
    if matches!(
        inputs.agent_category,
        Some(tenex_supervision::types::AgentCategory::Orchestrator)
            | Some(tenex_supervision::types::AgentCategory::Principal)
    ) && !all_skill_ids.iter().any(|id| id == "workflows")
    {
        all_skill_ids.push("workflows".to_string());
    }

    let preloaded_skills = crate::skills::fetch_skills(&all_skill_ids, &skill_ctx);

    let granted_tools: std::collections::HashSet<String> = preloaded_skills
        .iter()
        .filter_map(|s| s.frontmatter.as_ref())
        .flat_map(|fm| fm.tools.iter().cloned())
        .collect();

    let preloaded_skills_block = if preloaded_skills.is_empty() {
        None
    } else {
        let user_home = std::env::var("HOME").unwrap_or_default();
        let agent_home_str = inputs.agent_home.display().to_string();
        let tenex_base_str = inputs.base_dir.display().to_string();
        let path_vars: Vec<(&str, &str)> = vec![
            ("$USER_HOME", &user_home),
            ("$AGENT_HOME", &agent_home_str),
            ("$TENEX_BASE_DIR", &tenex_base_str),
            ("$PROJECT_BASE", inputs.working_dir),
        ];
        Some(crate::skills::render_loaded_skills_block(
            &preloaded_skills,
            &path_vars,
        ))
    };

    SkillContextOutputs {
        skill_ctx,
        initial_self_applied,
        granted_tools,
        preloaded_skills_block,
    }
}

/// Prefetch envelope-borne images and return them as raw fetched bytes.
/// Returns an empty `Vec` for non-vision providers and on empty/failed
/// fetches. The agent runner uses these both to persist attachment rows
/// in the conversation store *and* to build rig `UserContent` parts.
pub(super) async fn fetch_envelope_attachments(
    provider: &str,
    base_dir: &std::path::Path,
    envelope_content: &str,
) -> Vec<crate::multimodal::FetchedAttachment> {
    let supports_vision = matches!(provider, "anthropic" | "openai" | "openrouter");
    if !supports_vision {
        return Vec::new();
    }
    // `file://` image URLs are only honoured when they live under one of these
    // trusted cache prefixes — otherwise an inbound event could read arbitrary
    // local files. The Telegram bridge writes inbound photos here; add new
    // trusted producers to this list.
    //
    // We pre-create the dir and canonicalize the physical path so the prefix
    // is absolute and matches whatever canonical form the poller emits, even
    // when the daemon and the agent run with different working directories
    // (the runtime spawns agents with cwd set to the project workspace, while
    // the poller runs with the daemon's cwd).
    let media_root = base_dir.join("data").join("telegram-media");
    let _ = std::fs::create_dir_all(&media_root);
    let allowed_file_prefixes = vec![media_root.canonicalize().unwrap_or(media_root)];
    crate::multimodal::fetch_envelope_attachments(envelope_content, &allowed_file_prefixes).await
}

/// Open the conversation store for `(project_id)` if available, ensuring
/// the conversation row exists for FK-dependent writes.
pub(super) fn open_conversation_store(
    project_id: &str,
    conversation_id: &str,
) -> Option<ConversationStore> {
    let base_dir = tenex_conversations::paths::default_base_dir();
    let d_tag = tenex_conversations::normalize_project_id(project_id).ok()?;
    let db_path = tenex_conversations::paths::conversation_db_path(&base_dir, &d_tag);
    let store = match ConversationStore::open(&db_path) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("[tenex-agent] Conversation store unavailable: {e}");
            return None;
        }
    };
    if let Err(e) = store.ensure_conversation(conversation_id) {
        eprintln!("[tenex-agent] Failed to ensure conversation row: {e}");
    }
    Some(store)
}

/// Open the project RAG store, falling back to `None` (with a log line) on
/// open failure.
pub(super) fn open_rag_store(base_dir: &std::path::Path) -> Option<Arc<RagStore>> {
    let cfg = tenex_rag::EmbedConfig::load_from_base_dir(base_dir)?;
    let db_path = base_dir.join("embeddings.db");
    match RagStore::open(&db_path, &cfg) {
        Ok(store) => Some(Arc::new(store)),
        Err(e) => {
            eprintln!("[tenex-agent] RAG store unavailable: {e}");
            None
        }
    }
}

/// Build the AGENT shell environment: parses `<agent_home>/.env` and
/// injects computed runtime variables. `HOME` is filtered out so we never
/// override the real user home.
pub(super) fn build_shell_env(
    agent_home: &std::path::Path,
    pubkey_hex: &str,
    base_dir: &std::path::Path,
    working_dir: &str,
    project_id: &str,
) -> Vec<(String, String)> {
    let mut shell_env: Vec<(String, String)> =
        crate::stdio_home::parse_dotenv(&agent_home.join(".env"))
            .into_iter()
            .filter(|(k, _)| k != "HOME")
            .collect();
    shell_env.push(("AGENT_HOME".to_string(), agent_home.display().to_string()));
    shell_env.push(("PUBKEY".to_string(), pubkey_hex.to_string()));
    shell_env.push(("TENEX_BASE_DIR".to_string(), base_dir.display().to_string()));
    if let Ok(user_home) = std::env::var("HOME") {
        shell_env.push(("USER_HOME".to_string(), user_home));
    }
    shell_env.push(("PROJECT_BASE".to_string(), working_dir.to_string()));
    shell_env.push(("PROJECT_ID".to_string(), project_id.to_string()));
    shell_env
}

/// Run RAG-backed proactive context discovery for the inbound message and
/// render it as a `<proactive-context>` block. Returns `None` when the store
/// is absent or no relevant rows pass the score threshold.
///
/// Conversation hits are rendered by their real title/summary/participants
/// (looked up via `conv_store`, with pubkeys resolved to kind:0 names by
/// `resolver`) rather than transcript snippets, and deduplicated by
/// conversation so multiple matching chunks collapse to one entry. Other
/// collections (project/agent notes) render their title and a content
/// snippet.
///
/// Always emits a `rag.context_discovery` span so an absent store is
/// distinguishable from an empty result set in telemetry. Phase counts and
/// LLM child spans are populated by [`context_discovery::discover_context`].
pub(super) async fn proactive_context_block(
    rag_store: Option<&Arc<RagStore>>,
    conv_store: Option<&ConversationStore>,
    resolver: &dyn DisplayNameResolver,
    envelope_content: &str,
    project_id: &str,
    agent_pubkey: &str,
    conversation_id: &str,
    resolved: &ResolvedModel,
) -> Option<String> {
    use tracing::{Instrument, info_span};

    const SCORE_THRESHOLD: f64 = 0.65;
    const MAX_RESULTS: i64 = 5;
    let collections = [
        "conversations".to_string(),
        format!("project_{project_id}"),
        format!("agent_{agent_pubkey}"),
    ];
    let collection_count = collections.len() as i64;

    let span = info_span!(
        "rag.context_discovery",
        outcome = tracing::field::Empty,
        score.threshold = SCORE_THRESHOLD,
        max_results = MAX_RESULTS,
        collection.count = collection_count,
        query.word_count = tracing::field::Empty,
        planner.used = tracing::field::Empty,
        queries.count = tracing::field::Empty,
        queries.list = tracing::field::Empty,
        raw_count = tracing::field::Empty,
        deduped_count = tracing::field::Empty,
        filtered_count = tracing::field::Empty,
        returned_count = tracing::field::Empty,
        results = tracing::field::Empty,
        top_score = tracing::field::Empty,
        reranker.used = tracing::field::Empty,
    );

    async move {
        let Some(store) = rag_store else {
            tracing::Span::current().record("outcome", "no_store");
            return None;
        };

        let refs: Vec<&str> = collections.iter().map(|s| s.as_str()).collect();
        let accounting = context_discovery::DiscoveryAccountingCtx {
            agent_pubkey: agent_pubkey.to_string(),
            project_id: project_id.to_string(),
            conversation_id: Some(conversation_id.to_string()),
        };
        let relevant = context_discovery::discover_context(
            envelope_content,
            store,
            &refs,
            resolved,
            &accounting,
        )
        .await;

        if relevant.is_empty() {
            tracing::Span::current().record("outcome", "empty_results");
            return None;
        }
        tracing::Span::current().record("outcome", "returned");

        let mut block = String::from(
            "\n\n<proactive-context>\nPotentially relevant past conversations and notes, retrieved based on your task:\n",
        );
        let mut seen_convs: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut rendered_any = false;
        for r in &relevant {
            let conv_id = r
                .meta_json
                .as_ref()
                .and_then(|m| m.get("conversation_id"))
                .and_then(|v| v.as_str());

            match conv_id {
                Some(cid) => {
                    // Skip the conversation the agent is already in — listing
                    // it back is self-referential noise.
                    if cid == conversation_id {
                        continue;
                    }
                    if !seen_convs.insert(cid.to_string()) {
                        continue;
                    }
                    let row = conv_store.and_then(|s| s.get_conversation(cid).ok().flatten());
                    let title = row
                        .as_ref()
                        .and_then(|row| row.title.clone())
                        .or_else(|| row.as_ref().and_then(|row| first_line(row.last_user_message.as_deref())))
                        .unwrap_or_else(|| "(untitled conversation)".to_string());
                    let short_id: String = cid.chars().take(8).collect();
                    block.push_str(&format!("\n{title} [ id: {short_id} ]\n"));
                    if let Some(summary) = row.as_ref().and_then(|row| row.summary.as_deref()) {
                        block.push_str(summary);
                        block.push('\n');
                    }
                    let names = participant_names(conv_store, resolver, cid);
                    if !names.is_empty() {
                        block.push_str(&format!("Participants: {}\n", names.join(", ")));
                    }
                    rendered_any = true;
                }
                None => {
                    let title = r.title.clone().unwrap_or_else(|| "(note)".to_string());
                    let snippet: String = r.content.chars().take(300).collect();
                    let ellipsis = if r.content.chars().count() > 300 { "…" } else { "" };
                    block.push_str(&format!("\n{title} [ id: {} ]\n{snippet}{ellipsis}\n", r.id));
                    rendered_any = true;
                }
            }
        }
        if !rendered_any {
            return None;
        }
        block.push_str("</proactive-context>");
        Some(block)
    }
    .instrument(span)
    .await
}

/// Resolve a conversation's distinct participants to kind:0 display names,
/// ordered by first appearance. Unresolved pubkeys fall back to their first
/// 8 hex chars. Returns empty when the conversation store is absent.
fn participant_names(
    conv_store: Option<&ConversationStore>,
    resolver: &dyn DisplayNameResolver,
    conversation_id: &str,
) -> Vec<String> {
    let Some(store) = conv_store else {
        return Vec::new();
    };
    store
        .participant_pubkeys(conversation_id)
        .unwrap_or_default()
        .iter()
        .map(|pk| {
            resolver
                .display_name(pk)
                .unwrap_or_else(|| pk.chars().take(8).collect())
        })
        .collect()
}

/// First non-empty line of `s`, trimmed and capped at 80 chars — a usable
/// title fallback for conversations the summarizer hasn't titled yet.
fn first_line(s: Option<&str>) -> Option<String> {
    let line = s?.lines().map(str::trim).find(|l| !l.is_empty())?;
    let truncated: String = line.chars().take(80).collect();
    Some(truncated)
}
