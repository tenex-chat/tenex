use super::*;

use async_trait::async_trait;
use tenex_protocol::{
    Channel, ChannelError, EncodingContext, Intent, MessageRef, PrincipalRef, ProjectRef,
};

use crate::emit::EmitStateArgs;
use crate::skills::SkillLookupCtx;
use serde_json::json;

struct FakeChannel {
    identity: PrincipalRef,
}

#[async_trait]
impl Channel for FakeChannel {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn identity(&self) -> &PrincipalRef {
        &self.identity
    }

    async fn send(
        &self,
        _intent: Intent,
        _ctx: &EncodingContext,
    ) -> Result<Vec<MessageRef>, ChannelError> {
        Err(ChannelError::Unsupported("test"))
    }
}

fn make_test_tool_set(category: Option<AgentCategory>, granted: HashSet<String>) -> ToolSet {
    let keys = Keys::generate();
    let pubkey = keys.public_key();
    let pubkey_hex = pubkey.to_hex();
    let identity = PrincipalRef::nostr_agent(pubkey);
    let channel: Arc<dyn Channel> = Arc::new(FakeChannel {
        identity: identity.clone(),
    });
    let project_ref = ProjectRef {
        author: pubkey,
        d_tag: "test".to_string(),
    };
    let emit_state = Arc::new(EmitState::new(EmitStateArgs {
        channel,
        project: project_ref,
        triggering_principal: identity,
        triggering_message: None,
        conversation_root: None,
        completion_recipient: None,
        model: "test:test".to_string(),
        team: None,
        current_branch: None,
        completion_project_a_tags: vec![],
    }));

    let resolved_model = Arc::new(ResolvedModel {
        provider: "test".into(),
        model: "test".into(),
        api_keys: Vec::new(),
        base_url: None,
        key_health: std::sync::Arc::new(tenex_llm_config::key_health::KeyHealthTracker::new()),
    });

    let tmp = std::env::temp_dir();
    let agent_home = tmp.join(format!("tenex-test-home-{}", uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&agent_home);
    let agents_md = Arc::new(AgentsMdReminderState::new(tmp.clone()));

    let skill_ctx = Arc::new(SkillLookupCtx {
        agent_pubkey: pubkey_hex.clone(),
        project_path: tmp.display().to_string(),
        base_dir: tmp.clone(),
        agent_config_path: tmp.join("agent.json").display().to_string(),
    });
    let self_applied = Arc::new(Mutex::new(Vec::new()));

    let injection_tracker = Arc::new(Mutex::new(MessageInjectionTracker::new(
        tmp.join("nonexistent-test-conv.db"),
        "test-conv".into(),
        pubkey_hex.clone(),
        "test-event".into(),
        false,
        None,
    )));

    ToolSet {
        emit_state,
        project_agents: Arc::new(vec![]),
        teams: Arc::new(vec![]),
        owner_pubkey: pubkey_hex.clone(),
        escalation_pubkey: None,
        base_dir: tmp.clone(),
        allows_delegation: true,
        agent_category: category,
        conv_db_path: tmp.join("conv.db"),
        conversation_id: "test".into(),
        agent_pubkey: pubkey_hex.clone(),
        agent_nsec: keys.secret_key().to_secret_hex(),
        agent_home,
        resolved_model: resolved_model.clone(),
        summarization_model: resolved_model.clone(),
        project_d_tag: "test".into(),
        agent_slug: "test".into(),
        project_id: "test".into(),
        execution_id: "test".into(),
        suppress_response: Arc::new(AtomicBool::new(false)),
        rag_store: None,
        working_dir: tmp.display().to_string(),
        agents_md,
        shell_env: vec![],
        granted_tools: granted,
        todos: Arc::new(Mutex::new(Vec::new())),
        skill_list: SkillListTool::new(skill_ctx.clone()),
        skills_set: SkillsSetTool::new(skill_ctx, self_applied),
        mcp_proxy_tools: vec![],
        delegate: None,
        rag_add_documents: RagAddDocumentsTool::new(None, "test".into(), pubkey_hex.clone()),
        rag_search: RagSearchTool::new(None, "test".into(), pubkey_hex, resolved_model),
        runtime_state: None,
        message_injections: injection_tracker,
        telegram_config: None,
        blossom_url: "http://test".into(),
        agent_keys: keys,
    }
}

fn tool_names(set: &ToolSet) -> HashSet<String> {
    let recorder = ToolRecorder::new();
    set.build_for_turn(recorder).tool_names().collect()
}

#[tokio::test]
async fn registry_provider_and_projection_defs_have_matching_names() {
    let set = make_test_tool_set(None, HashSet::new());
    let recorder = ToolRecorder::new();
    let registry = set.build_for_turn(recorder);

    let provider_names: HashSet<String> = registry
        .provider_definitions("test prompt".into())
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    let projection_defs = registry.projection_tool_defs();
    let projection_names: HashSet<String> = projection_defs
        .iter()
        .map(|definition| definition.name.clone())
        .collect();

    assert_eq!(provider_names, projection_names);
    assert!(
        projection_defs
            .iter()
            .any(|definition| definition.name == "skills_set" && definition.preserve_results),
        "skills_set results should be preserved because they carry skill bodies"
    );
}

#[tokio::test]
async fn registry_execute_records_provider_tool_ids() {
    let set = make_test_tool_set(None, HashSet::new());
    let recorder = ToolRecorder::new();
    let registry = set.build_for_turn(recorder.clone());

    let output = registry
        .execute(
            "no_response",
            json!({}),
            Some("provider-tool-1".into()),
            Some("provider-call-1".into()),
        )
        .await
        .expect("tool executes");
    assert!(output.contains("silent-complete"));

    let records = recorder.take_records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].call_id, "provider-tool-1");
    assert_eq!(
        records[0].provider_call_id.as_deref(),
        Some("provider-call-1")
    );
}

fn assert_workspace_restricted(names: &HashSet<String>) {
    for absent in [
        "shell", "fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep",
    ] {
        assert!(
            !names.contains(absent),
            "{absent} must be absent for workspace-restricted category, names: {names:?}"
        );
    }
    for present in [
        "home_fs_read",
        "home_fs_write",
        "home_fs_edit",
        "home_fs_glob",
        "home_fs_grep",
    ] {
        assert!(
            names.contains(present),
            "{present} must be present for workspace-restricted category, names: {names:?}"
        );
    }
}

#[test]
fn orchestrator_has_no_workspace_or_publish_tools() {
    let set = make_test_tool_set(Some(AgentCategory::Orchestrator), HashSet::new());
    let names = tool_names(&set);
    assert_workspace_restricted(&names);
    for absent in ["report_publish", "html_publish"] {
        assert!(
            !names.contains(absent),
            "{absent} must be absent for orchestrator, names: {names:?}"
        );
    }
}

#[test]
fn principal_has_no_workspace_tools_but_keeps_publish_tools() {
    let set = make_test_tool_set(Some(AgentCategory::Principal), HashSet::new());
    let names = tool_names(&set);
    assert_workspace_restricted(&names);
    for present in ["report_publish", "html_publish"] {
        assert!(
            names.contains(present),
            "{present} must be present for principal, names: {names:?}"
        );
    }
}

#[test]
fn orchestrator_with_skill_grant_still_restricted() {
    let mut granted = HashSet::new();
    granted.insert("fs_read".to_string());
    granted.insert("fs_write".to_string());
    granted.insert("fs_glob".to_string());
    granted.insert("fs_grep".to_string());
    let set = make_test_tool_set(Some(AgentCategory::Orchestrator), granted);
    let names = tool_names(&set);
    assert_workspace_restricted(&names);
    for absent in ["report_publish", "html_publish"] {
        assert!(
            !names.contains(absent),
            "{absent} must be absent for orchestrator, names: {names:?}"
        );
    }
}

#[test]
fn worker_with_grants_keeps_project_tools() {
    let mut granted = HashSet::new();
    granted.insert("fs_read".to_string());
    granted.insert("fs_write".to_string());
    granted.insert("fs_glob".to_string());
    granted.insert("fs_grep".to_string());
    let set = make_test_tool_set(Some(AgentCategory::Worker), granted);
    let names = tool_names(&set);
    for present in [
        "shell",
        "fs_read",
        "fs_write",
        "fs_edit",
        "fs_glob",
        "fs_grep",
        "report_publish",
        "html_publish",
    ] {
        assert!(names.contains(present), "{present} must be present");
    }
}

#[test]
fn uncategorized_falls_back_to_existing_behavior() {
    let set = make_test_tool_set(None, HashSet::new());
    let names = tool_names(&set);
    assert!(names.contains("shell"));
    assert!(names.contains("home_fs_read"));
    assert!(names.contains("home_fs_write"));
    assert!(names.contains("report_publish"));
    assert!(names.contains("html_publish"));
    assert!(!names.contains("fs_read"));
    assert!(!names.contains("fs_write"));
}

fn fake_mcp_tool() -> super::McpProxyTool {
    super::McpProxyTool::new(
        tenex_mcp::ToolManifestEntry {
            name: "fake_mcp_fs_read".to_string(),
            server: "test".to_string(),
            tool: "fs_read".to_string(),
            description: "test".to_string(),
            input_schema: serde_json::json!({}),
        },
        std::path::PathBuf::from("/tmp/test-mcp.sock"),
        false,
    )
}

#[test]
fn restricted_categories_drop_mcp_proxy_tools() {
    let mut set = make_test_tool_set(Some(AgentCategory::Orchestrator), HashSet::new());
    set.mcp_proxy_tools = vec![fake_mcp_tool()];
    let names = tool_names(&set);
    assert!(
        !names.contains("fake_mcp_fs_read"),
        "MCP proxy tools must be absent for restricted category, names: {names:?}"
    );
}

#[test]
fn unrestricted_categories_keep_mcp_proxy_tools() {
    let mut set = make_test_tool_set(Some(AgentCategory::Worker), HashSet::new());
    set.mcp_proxy_tools = vec![fake_mcp_tool()];
    let names = tool_names(&set);
    assert!(
        names.contains("fake_mcp_fs_read"),
        "MCP proxy tools must be present for unrestricted category, names: {names:?}"
    );
}
