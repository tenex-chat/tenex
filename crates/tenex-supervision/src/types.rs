use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentCategory {
    Principal,
    Orchestrator,
    Worker,
    Reviewer,
    DomainExpert,
    Generalist,
}

impl AgentCategory {
    /// All categories can delegate except domain-experts, who are intended to
    /// answer focused questions rather than coordinate other agents.
    pub fn allows_delegation(self) -> bool {
        !matches!(self, Self::DomainExpert)
    }

    /// Orchestrators and principals coordinate work rather than touching the
    /// project workspace directly. The shell and project-scoped filesystem
    /// tools (and MCP proxies that may wrap them) are withheld from these
    /// categories; they fall back to their personal `home_fs_*` workspace.
    pub fn is_workspace_access_restricted(self) -> bool {
        matches!(self, Self::Orchestrator | Self::Principal)
    }

    /// All categories may publish reports and HTML artifacts except
    /// orchestrators, whose role is purely coordinative.
    pub fn is_publishing_output_allowed(self) -> bool {
        !matches!(self, Self::Orchestrator)
    }
}

impl FromStr for AgentCategory {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "principal" => Ok(Self::Principal),
            "orchestrator" => Ok(Self::Orchestrator),
            "worker" => Ok(Self::Worker),
            "reviewer" => Ok(Self::Reviewer),
            "domain-expert" => Ok(Self::DomainExpert),
            "generalist" => Ok(Self::Generalist),
            _ => Err(()),
        }
    }
}

impl fmt::Display for AgentCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Principal => "principal",
            Self::Orchestrator => "orchestrator",
            Self::Worker => "worker",
            Self::Reviewer => "reviewer",
            Self::DomainExpert => "domain-expert",
            Self::Generalist => "generalist",
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
}

#[derive(Debug, Clone)]
pub struct TodoEntry {
    pub id: String,
    pub status: TodoStatus,
}

pub struct PostCompletionContext<'a> {
    pub todos: &'a [TodoEntry],
    pub tool_calls_made: &'a [String],
    pub nudged_about_todos: bool,
    pub pending_delegation_count: usize,
    pub triggering_message: &'a str,
}

pub struct PreToolContext<'a> {
    pub tool_name: &'a str,
    pub todos: &'a [TodoEntry],
    pub agent_category: &'a AgentCategory,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EnforcementMode {
    OncePerExecution,
    RepeatUntilResolved,
}

pub struct Detection {
    pub heuristic_name: &'static str,
    pub message: String,
    pub enforcement: EnforcementMode,
    pub re_engage: bool,
}
