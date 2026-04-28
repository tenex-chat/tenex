//! Nostr `Kind` constants used by the agent protocol. The numbers are the
//! single source of truth — every other crate that needs them imports from here.

use nostr::Kind;

/// kind:1 — unified conversation format (completion, conversation, delegation,
/// ask, error, tool-use, intervention-review).
pub const TEXT_NOTE: Kind = Kind::TextNote;

/// kind:1111 — NIP-22 generic comment. Lesson refinements use this with
/// `["K", "4129"]` indicating the parent kind.
pub const COMMENT: u16 = 1111;

/// kind:4129 — NDKAgentLesson. Persisted lessons learned.
pub const AGENT_LESSON: u16 = 4129;

/// kind:24010 — TenexProjectStatus.
pub const PROJECT_STATUS: u16 = 24010;

/// kind:24011 — TenexInstalledAgentList.
pub const INSTALLED_AGENT_LIST: u16 = 24011;

/// kind:24020 — TenexAgentConfigUpdate.
pub const AGENT_CONFIG_UPDATE: u16 = 24020;

/// kind:24133 — TenexOperationsStatus.
pub const OPERATIONS_STATUS: u16 = 24133;

/// kind:24134 — TenexStopCommand. Kill signal for a running agent.
pub const STOP_COMMAND: u16 = 24134;

/// kind:24135 — TenexStreamTextDelta. Ephemeral live update.
pub const STREAM_TEXT_DELTA: u16 = 24135;

/// kind:31933 — NIP-33 project event.
pub const PROJECT: u16 = 31933;

/// Build a `Kind` from a u16 constant in this module.
pub fn custom(k: u16) -> Kind {
    Kind::Custom(k)
}
