//! Public API for `tenex-agent`. The bin targets (`tenex-agent`,
//! `tenex-agent-acp`) continue to compile as independent crate roots with
//! their own `mod` declarations; this `lib.rs` exposes the subset of types
//! needed by external standalone consumers (the `tenex mcp agent` command).
//!
//! Both compile units share source files. Items only used by the bin's
//! turn-loop machinery surface as `dead_code` warnings in the lib build; the
//! suppression below applies to lib-only compilation while leaving the bins
//! to surface their own genuine dead code.
#![allow(dead_code)]

pub mod config;
pub mod emit;
pub mod home;
pub mod mcp_stdio;
pub mod skills;

pub(crate) mod injections;
pub(crate) mod llm_accounting;
pub(crate) mod project_hooks;
pub(crate) mod llm_retry;
pub(crate) mod runtime_control;
pub(crate) mod runtime_state;
pub(crate) mod runtime_state_json;
pub(crate) mod runtime_tracker;
pub(crate) mod tools;
pub(crate) mod workflows;

pub use emit::{EmitState, EmitStateArgs};
pub use tools::agent_context_state::save_context_state;
pub use tools::mcp_agent_tools::{build_mcp_agent_tools, McpAgentContext};
pub use tools::TodoItem;

pub use rig_core;
