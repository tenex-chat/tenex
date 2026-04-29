use anyhow::Result;
use serde_json::Value;

use crate::doc::AgentDoc;
use crate::storage::{AgentDefaultConfigUpdate, AgentStorage};

impl AgentStorage {
    /// Mirror `updateDefaultConfig` (`AgentStorage.ts:947-1005`).
    ///
    /// Applies only fields represented as `Some(...)`. Empty vector snapshots
    /// clear their corresponding default field.
    pub fn update_default_config(
        &mut self,
        pubkey: &str,
        updates: &AgentDefaultConfigUpdate,
    ) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };

        let mut default = agent
            .raw()
            .get("default")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        if let Some(model) = &updates.model {
            default.insert("model".into(), Value::String(model.clone()));
        }
        apply_array_update(&mut default, "tools", updates.tools.as_ref());
        apply_array_update(
            &mut default,
            "blockedSkills",
            updates.blocked_skills.as_ref(),
        );
        apply_array_update(&mut default, "skills", updates.skills.as_ref());
        apply_array_update(&mut default, "mcp", updates.mcp.as_ref());

        if default.is_empty() {
            agent.raw_mut().shift_remove("default");
        } else {
            agent
                .raw_mut()
                .insert("default".into(), Value::Object(default));
        }
        self.save_agent(&agent)?;
        Ok(true)
    }

    /// Mirror `resetDefaultConfig` (`AgentStorage.ts:1007-1021`).
    pub fn reset_default_config(&mut self, pubkey: &str) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        agent.raw_mut().shift_remove("default");
        agent.raw_mut().shift_remove("isPM");
        self.save_agent(&agent)?;
        Ok(true)
    }

    /// Mirror `updateAgentIsPM` (`AgentStorage.ts:1023-1037`).
    pub fn update_agent_is_pm(&mut self, pubkey: &str, is_pm: bool) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        agent.raw_mut().insert("isPM".into(), Value::Bool(is_pm));
        self.save_agent(&agent)?;
        Ok(true)
    }
}

fn apply_array_update(
    target: &mut serde_json::Map<String, Value>,
    key: &str,
    update: Option<&Vec<String>>,
) {
    let Some(values) = update else {
        return;
    };
    if values.is_empty() {
        target.shift_remove(key);
    } else {
        target.insert(
            key.into(),
            Value::Array(values.iter().cloned().map(Value::String).collect()),
        );
    }
}
