//! `tenex mcp agent <pubkey> --conversation <conv_id>` — standalone MCP
//! stdio server that exposes TENEX built-in tools scoped to a specific agent
//! identity and conversation context. Designed for ACP-compatible runtimes
//! (Claude Code, Codex) to participate as full TENEX agents.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use nostr::Keys;
use nostr_sdk::{Client, ClientOptions};
use serde_json::Value;
use tenex_agent::config::ResolvedModel;
use tenex_agent::emit::EmitState;
use tenex_agent::mcp_stdio::{serve_stdio, ServerInfo};
use tenex_agent::skills::SkillLookupCtx;
use tenex_agent::{
    build_mcp_agent_tools, save_context_state, EmitStateArgs, McpAgentContext, TodoItem,
};
use tenex_agent_registry::AgentDoc;
use tenex_conversations::ConversationStore;
use tenex_project::Project;
use tenex_protocol::nostr::NostrChannel;
use tenex_protocol::sink::RelaySink;
use tenex_protocol::{Channel, ConversationRef, PrincipalRef, ProjectRef};

use super::AgentArgs;

const SERVER_NAME: &str = "tenex";

pub(super) async fn run(args: AgentArgs) -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(None);

    let agent = load_agent(&base_dir, &args.pubkey)?;
    let project_id = resolve_project_id(&base_dir, &args.pubkey, args.project_id.as_deref())?;

    let conversation_root_id = nostr::EventId::from_hex(&args.conversation_id)
        .with_context(|| format!("invalid conversation id {:?}", args.conversation_id))?;
    let conversation_root = ConversationRef::Nostr {
        root_event_id: conversation_root_id,
    };
    let conversation_id_hex = conversation_root_id.to_hex();

    let project = Project::open(&project_id, &base_dir)
        .with_context(|| format!("opening project '{project_id}'"))?;
    let project_meta = project
        .metadata()
        .context("reading project metadata")?
        .ok_or_else(|| anyhow!("project metadata is missing for '{project_id}'"))?;
    let owner_pubkey_hex = project_meta
        .owner_pubkey
        .clone()
        .ok_or_else(|| anyhow!("project metadata has no owner_pubkey"))?;
    let project_ref = ProjectRef {
        author: nostr::PublicKey::from_hex(&owner_pubkey_hex)
            .context("parsing project owner pubkey")?,
        d_tag: project_meta.d_tag.clone(),
    };
    let project_agents = Arc::new(project.agents().context("reading project agents")?);
    let teams = Arc::new(tenex_project::load_teams(&base_dir, Some(&project_id)));

    let project_root = project_root_for(&base_dir, &project_meta.d_tag);
    let (working_dir_path, current_branch) =
        tenex_project::resolve_working_dir(&project_root, None, None);
    let working_dir = working_dir_path.display().to_string();

    let agent_pubkey = agent.keys.public_key().to_hex();
    let agent_slug = agent.slug.clone();
    let agent_category = agent.category;
    let allows_delegation = agent_category
        .map(|c| c.allows_delegation())
        .unwrap_or(true);

    let agent_home = tenex_agent::home::agent_home_dir(&base_dir, &agent_pubkey);
    tenex_agent::home::ensure_agent_home_dir(&agent_home);

    let conv_db_path = {
        let d_tag = tenex_conversations::normalize_project_id(&project_id)
            .map_err(|err| anyhow!("{err}"))?;
        tenex_conversations::paths::conversation_db_path(&base_dir, &d_tag)
    };
    let (todos, self_applied_skills) =
        load_conversation_state(&conv_db_path, &conversation_id_hex, &agent_pubkey)?;

    let relays = resolve_relays(&base_dir);
    if relays.is_empty() {
        bail!("no relays configured; set `relays` in <base_dir>/config.json");
    }
    let relay_client = build_relay_client(&agent.keys, &relays).await?;
    let sink = RelaySink::new(relay_client.clone());
    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(&agent.nsec, sink)
            .context("initializing standalone Nostr channel")?,
    );

    let emit_state = Arc::new(EmitState::new(EmitStateArgs {
        channel,
        project: project_ref,
        triggering_principal: PrincipalRef::nostr_agent(agent.keys.public_key()),
        triggering_message: None,
        conversation_root: Some(conversation_root),
        completion_recipient: None,
        model: "standalone:mcp".to_string(),
        team: None,
        current_branch,
        completion_project_a_tags: Vec::new(),
    }));

    let resolved_model = Arc::new(
        ResolvedModel::resolve(&base_dir, agent.raw_model.as_deref())
            .unwrap_or_else(|_| placeholder_model()),
    );
    let summarization_model = Arc::new(
        ResolvedModel::resolve_role(&base_dir, "summarization")
            .unwrap_or_else(|_| (*resolved_model).clone()),
    );

    let rag_store = open_rag_store(&base_dir);

    let blossom_url = read_blossom_server_url(&base_dir)
        .unwrap_or_else(|| "https://blossom.primal.net".to_string());

    let skill_ctx = Arc::new(SkillLookupCtx {
        agent_pubkey: agent_pubkey.clone(),
        project_path: working_dir.clone(),
        base_dir: base_dir.clone(),
        agent_config_path: tenex_agent_registry::agent_file_path(&base_dir, &agent_pubkey)
            .display()
            .to_string(),
    });
    let granted_tools =
        resolve_granted_tools(&agent, agent_category, &self_applied_skills, &skill_ctx);

    let escalation_pubkey = project_agents
        .iter()
        .find(|a| a.category.as_deref() == Some("principal") && a.pubkey != agent_pubkey)
        .map(|a| a.pubkey.clone());

    let todos = Arc::new(Mutex::new(todos));
    let self_applied_skills = Arc::new(Mutex::new(self_applied_skills));

    let ctx = McpAgentContext {
        emit_state,
        project_agents,
        teams,
        owner_pubkey: owner_pubkey_hex,
        escalation_pubkey,
        base_dir: base_dir.clone(),
        allows_delegation,
        agent_category,
        conv_db_path: conv_db_path.clone(),
        agent_pubkey: agent_pubkey.clone(),
        agent_home,
        resolved_model,
        summarization_model,
        project_d_tag: project_meta.d_tag.clone(),
        agent_slug,
        project_id,
        rag_store,
        working_dir,
        granted_tools,
        todos: todos.clone(),
        blossom_url,
        agent_keys: agent.keys.clone(),
        project_root,
        skill_ctx,
        self_applied_skills: self_applied_skills.clone(),
    };

    let tools = build_mcp_agent_tools(&ctx);

    let info = ServerInfo {
        name: SERVER_NAME,
        version: env!("CARGO_PKG_VERSION"),
    };
    let serve_result = serve_stdio(info, tools).await;
    let _ = relay_client.disconnect().await;

    // Persist any todo / self-applied skill mutations made during the MCP
    // session back into `agent_context_state` so they survive across
    // invocations — both for subsequent `tenex mcp agent` sessions and for
    // the normal turn-loop reading the same row.
    persist_session_state(
        &conv_db_path,
        &conversation_id_hex,
        &agent_pubkey,
        &todos,
        &self_applied_skills,
    );

    serve_result
}

fn persist_session_state(
    conv_db_path: &std::path::Path,
    conversation_id: &str,
    agent_pubkey: &str,
    todos: &Arc<Mutex<Vec<TodoItem>>>,
    self_applied_skills: &Arc<Mutex<Vec<String>>>,
) {
    let store = match ConversationStore::open(conv_db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[tenex mcp agent] Failed to open conversation store for save: {e}");
            return;
        }
    };
    let todos_snapshot = todos.lock().unwrap().clone();
    let skills_snapshot = self_applied_skills.lock().unwrap().clone();
    if let Err(e) = save_context_state(
        &store,
        conversation_id,
        agent_pubkey,
        &todos_snapshot,
        &skills_snapshot,
    ) {
        eprintln!("[tenex mcp agent] Failed to save agent context state: {e:#}");
    }
}

struct LoadedAgent {
    keys: Keys,
    nsec: String,
    slug: String,
    category: Option<tenex_supervision::types::AgentCategory>,
    raw_model: Option<String>,
    default_skills: Vec<String>,
}

fn load_agent(base_dir: &std::path::Path, pubkey: &str) -> Result<LoadedAgent> {
    let doc = AgentDoc::load(base_dir, pubkey)
        .with_context(|| format!("loading agent file for {pubkey}"))?
        .ok_or_else(|| {
            anyhow!(
                "agent {pubkey} not found at {}",
                tenex_agent_registry::agent_file_path(base_dir, pubkey).display()
            )
        })?;
    let nsec = doc
        .nsec()
        .ok_or_else(|| anyhow!("agent {pubkey} has no nsec"))?
        .to_string();
    let keys = Keys::parse(&nsec).with_context(|| format!("parsing nsec for {pubkey}"))?;
    let slug = doc.slug().unwrap_or_default().to_string();
    let category = doc
        .raw()
        .get("category")
        .and_then(Value::as_str)
        .and_then(|c| c.parse::<tenex_supervision::types::AgentCategory>().ok());
    let raw_model = doc
        .raw()
        .get("default")
        .and_then(Value::as_object)
        .and_then(|d| d.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let default_skills = doc
        .raw()
        .get("default")
        .and_then(Value::as_object)
        .and_then(|d| d.get("skills"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(LoadedAgent {
        keys,
        nsec,
        slug,
        category,
        raw_model,
        default_skills,
    })
}

/// Resolve the project identifier to a bare dTag, comparing against the
/// agent's index membership. Accepts either a bare dTag or a full NIP-33
/// coordinate `31933:<pubkey>:<dTag>` for the explicit `--project` argument
/// and normalizes the latter before checking membership.
fn resolve_project_id(
    base_dir: &std::path::Path,
    pubkey: &str,
    explicit: Option<&str>,
) -> Result<String> {
    let storage = tenex_agent_registry::AgentStorage::open(base_dir)?;
    let projects = storage.get_index_projects_for_agent(pubkey);
    let normalized = explicit.map(normalize_project_arg);
    match (normalized.as_deref(), projects.as_slice()) {
        (Some(p), all) if !all.is_empty() && !all.iter().any(|x| x == p) => {
            bail!(
                "agent {pubkey} is not a member of project {p} (member of: {})",
                all.join(", ")
            );
        }
        (Some(p), _) => Ok(p.to_string()),
        (None, [single]) => Ok(single.clone()),
        (None, []) => bail!(
            "agent {pubkey} is not a member of any project; use `tenex agent create` or pass --project"
        ),
        (None, many) => bail!(
            "agent {pubkey} belongs to multiple projects ({}); pass --project <dTag>",
            many.join(", ")
        ),
    }
}

fn normalize_project_arg(raw: &str) -> String {
    // NIP-33 coordinate: `31933:<pubkey-hex>:<dTag>`. Strip the kind+pubkey
    // prefix and return the dTag.
    let parts: Vec<&str> = raw.splitn(3, ':').collect();
    if parts.len() == 3 && parts[0] == "31933" && !parts[2].is_empty() {
        return parts[2].to_string();
    }
    raw.to_string()
}

fn project_root_for(base_dir: &std::path::Path, d_tag: &str) -> PathBuf {
    // Match the daemon's project workspace layout — projects live at
    // `<projects_base>/<dTag>`. When `projectsBase` is unset, fall back to
    // `<base_dir>/projects/<dTag>`, matching `tenex_project::paths`.
    if let Ok(doc) = crate::store::tenex_config::TenexConfigDoc::load(base_dir) {
        if let Some(pb) = doc.projects_base() {
            return PathBuf::from(pb).join(d_tag);
        }
    }
    base_dir.join("projects").join(d_tag)
}

/// Load todos and self-applied skills for `(conversation_id, agent_pubkey)`.
/// Propagates real storage/decode failures so bootstrap aborts with a clear
/// error; a missing `agent_context_state` row is the normal first-run
/// condition and yields empty state.
fn load_conversation_state(
    conv_db_path: &std::path::Path,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Result<(Vec<TodoItem>, Vec<String>)> {
    let store = ConversationStore::open(conv_db_path)
        .with_context(|| format!("opening conversation store at {}", conv_db_path.display()))?;
    store
        .ensure_conversation(conversation_id)
        .with_context(|| format!("ensuring conversation {conversation_id} exists"))?;
    let Some(state) = store
        .get_agent_context_state(conversation_id, agent_pubkey)
        .with_context(|| {
            format!(
                "reading agent_context_state for conversation {conversation_id}, agent {agent_pubkey}"
            )
        })?
    else {
        return Ok((Vec::new(), Vec::new()));
    };
    let todos = state
        .todos
        .map(serde_json::from_value::<Vec<TodoItem>>)
        .transpose()
        .context("decoding persisted todos")?
        .unwrap_or_default();
    let skills = state
        .self_applied_skills
        .map(serde_json::from_value::<Vec<String>>)
        .transpose()
        .context("decoding persisted self_applied_skills")?
        .unwrap_or_default();
    Ok((todos, skills))
}

fn resolve_relays(base_dir: &std::path::Path) -> Vec<String> {
    match crate::store::tenex_config::TenexConfigDoc::load(base_dir) {
        Ok(doc) => {
            let configured = doc.relays();
            if configured.is_empty() {
                vec!["wss://relay.tenex.chat".to_string()]
            } else {
                configured
            }
        }
        Err(_) => vec!["wss://relay.tenex.chat".to_string()],
    }
}

async fn build_relay_client(keys: &Keys, relays: &[String]) -> Result<Client> {
    let client = Client::builder()
        .signer(keys.clone())
        .opts(ClientOptions::new().automatic_authentication(true))
        .build();
    for relay in relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add_relay {relay}"))?;
    }
    client.connect().await;
    Ok(client)
}

fn placeholder_model() -> ResolvedModel {
    ResolvedModel {
        provider: "standalone".to_string(),
        model: "mcp".to_string(),
        api_key: None,
        base_url: None,
    }
}

fn open_rag_store(base_dir: &std::path::Path) -> Option<Arc<tenex_rag::RagStore>> {
    let cfg = tenex_rag::EmbedConfig::load_from_base_dir(base_dir)?;
    let db_path = base_dir.join("embeddings.db");
    tenex_rag::RagStore::open(&db_path, &cfg).ok().map(Arc::new)
}

fn read_blossom_server_url(base_dir: &std::path::Path) -> Option<String> {
    let path = base_dir.join("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    raw.get("blossomServerUrl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Aggregate the agent's tool grants from its preloaded skills. Mirrors the
/// turn-loop bootstrap stage: the agent's static `default.skills`, the
/// persisted self-applied skills, plus the category-auto-enable rule
/// (`workflows` for orchestrators and principals). Each loaded skill's
/// frontmatter `tools` list contributes to the returned set.
fn resolve_granted_tools(
    agent: &LoadedAgent,
    category: Option<tenex_supervision::types::AgentCategory>,
    self_applied: &[String],
    ctx: &SkillLookupCtx,
) -> HashSet<String> {
    let mut ids: Vec<String> = agent.default_skills.clone();
    for s in self_applied {
        if !ids.iter().any(|existing| existing == s) {
            ids.push(s.clone());
        }
    }
    if matches!(
        category,
        Some(tenex_supervision::types::AgentCategory::Orchestrator)
            | Some(tenex_supervision::types::AgentCategory::Principal)
    ) && !ids.iter().any(|id| id == "workflows")
    {
        ids.push("workflows".to_string());
    }
    tenex_agent::skills::fetch_skills(&ids, ctx)
        .iter()
        .filter_map(|s| s.frontmatter.as_ref())
        .flat_map(|fm| fm.tools.iter().cloned())
        .collect()
}
