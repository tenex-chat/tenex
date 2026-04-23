use std::collections::BTreeSet;

use crate::backend_config::InterventionConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EligibilityInputs<'a> {
    pub config: &'a InterventionConfig,
    pub project_d_tag: &'a str,
    pub conversation_id: &'a str,
    pub completing_agent_pubkey: &'a str,
    pub target_user_pubkey: &'a str,
    pub intervention_agent_pubkey: Option<&'a str>,
    pub root_event_author_pubkey: Option<&'a str>,
    pub project_agent_pubkeys: &'a BTreeSet<String>,
    pub backend_pubkey: &'a str,
    pub whitelisted_pubkeys: &'a [String],
    pub ral_has_active_delegations: bool,
    pub notified_recently: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Arm,
    SkipDisabled,
    SkipAgentNotConfigured,
    SkipAgentNotResolved,
    SkipInterventionIsCompletingAgent,
    SkipTargetNotWhitelisted,
    SkipNotTopLevel,
    SkipActiveDelegations,
    SkipAlreadyNotifiedRecently,
}

pub fn evaluate(inputs: EligibilityInputs<'_>) -> Eligibility {
    if !inputs.config.enabled {
        return Eligibility::SkipDisabled;
    }
    let Some(_slug) = inputs.config.agent_slug.as_deref() else {
        return Eligibility::SkipAgentNotConfigured;
    };

    let Some(intervention_agent_pubkey) = inputs.intervention_agent_pubkey else {
        return Eligibility::SkipAgentNotResolved;
    };

    if intervention_agent_pubkey == inputs.completing_agent_pubkey {
        return Eligibility::SkipInterventionIsCompletingAgent;
    }

    if !is_human_whitelisted(
        inputs.target_user_pubkey,
        inputs.backend_pubkey,
        inputs.project_agent_pubkeys,
        inputs.whitelisted_pubkeys,
    ) {
        return Eligibility::SkipTargetNotWhitelisted;
    }

    let Some(root_author) = inputs.root_event_author_pubkey else {
        return Eligibility::SkipNotTopLevel;
    };
    if !is_human_whitelisted(
        root_author,
        inputs.backend_pubkey,
        inputs.project_agent_pubkeys,
        inputs.whitelisted_pubkeys,
    ) {
        return Eligibility::SkipNotTopLevel;
    }

    if inputs.ral_has_active_delegations {
        return Eligibility::SkipActiveDelegations;
    }

    if inputs.notified_recently {
        return Eligibility::SkipAlreadyNotifiedRecently;
    }

    Eligibility::Arm
}

fn is_human_whitelisted(
    pubkey: &str,
    backend_pubkey: &str,
    project_agent_pubkeys: &BTreeSet<String>,
    whitelisted_pubkeys: &[String],
) -> bool {
    if pubkey == backend_pubkey {
        return false;
    }
    if project_agent_pubkeys.contains(pubkey) {
        return false;
    }
    whitelisted_pubkeys.iter().any(|entry| entry == pubkey)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUMAN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const AGENT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const COMPLETING_AGENT: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const INTERVENTION_AGENT: &str =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const BACKEND: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const UNKNOWN: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn project_agents() -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        set.insert(AGENT.to_string());
        set.insert(COMPLETING_AGENT.to_string());
        set.insert(INTERVENTION_AGENT.to_string());
        set
    }

    fn config_enabled() -> InterventionConfig {
        InterventionConfig {
            enabled: true,
            agent_slug: Some("reviewer".to_string()),
            timeout_seconds: 300,
        }
    }

    fn arm_inputs<'a>(
        config: &'a InterventionConfig,
        whitelisted: &'a [String],
        project_agent_pubkeys: &'a BTreeSet<String>,
    ) -> EligibilityInputs<'a> {
        EligibilityInputs {
            config,
            project_d_tag: "proj",
            conversation_id: "conv",
            completing_agent_pubkey: COMPLETING_AGENT,
            target_user_pubkey: HUMAN,
            intervention_agent_pubkey: Some(INTERVENTION_AGENT),
            root_event_author_pubkey: Some(HUMAN),
            project_agent_pubkeys,
            backend_pubkey: BACKEND,
            whitelisted_pubkeys: whitelisted,
            ral_has_active_delegations: false,
            notified_recently: false,
        }
    }

    #[test]
    fn arms_when_all_conditions_pass() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        assert_eq!(
            evaluate(arm_inputs(&config, &whitelisted, &project_agent_pubkeys)),
            Eligibility::Arm
        );
    }

    #[test]
    fn skips_when_disabled() {
        let mut config = config_enabled();
        config.enabled = false;
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        assert_eq!(
            evaluate(arm_inputs(&config, &whitelisted, &project_agent_pubkeys)),
            Eligibility::SkipDisabled
        );
    }

    #[test]
    fn skips_when_no_agent_slug_configured() {
        let mut config = config_enabled();
        config.agent_slug = None;
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        assert_eq!(
            evaluate(arm_inputs(&config, &whitelisted, &project_agent_pubkeys)),
            Eligibility::SkipAgentNotConfigured
        );
    }

    #[test]
    fn skips_when_intervention_agent_cannot_be_resolved() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.intervention_agent_pubkey = None;
        assert_eq!(evaluate(inputs), Eligibility::SkipAgentNotResolved);
    }

    #[test]
    fn skips_when_completing_agent_is_intervention_agent() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.completing_agent_pubkey = INTERVENTION_AGENT;
        assert_eq!(
            evaluate(inputs),
            Eligibility::SkipInterventionIsCompletingAgent
        );
    }

    #[test]
    fn skips_when_target_user_not_whitelisted() {
        let config = config_enabled();
        let whitelisted: Vec<String> = Vec::new();
        let project_agent_pubkeys = project_agents();
        assert_eq!(
            evaluate(arm_inputs(&config, &whitelisted, &project_agent_pubkeys)),
            Eligibility::SkipTargetNotWhitelisted
        );
    }

    #[test]
    fn skips_when_target_is_backend() {
        let config = config_enabled();
        let whitelisted = vec![BACKEND.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.target_user_pubkey = BACKEND;
        assert_eq!(evaluate(inputs), Eligibility::SkipTargetNotWhitelisted);
    }

    #[test]
    fn skips_when_target_is_agent() {
        let config = config_enabled();
        let whitelisted = vec![AGENT.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.target_user_pubkey = AGENT;
        assert_eq!(evaluate(inputs), Eligibility::SkipTargetNotWhitelisted);
    }

    #[test]
    fn skips_when_root_author_unknown() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.root_event_author_pubkey = None;
        assert_eq!(evaluate(inputs), Eligibility::SkipNotTopLevel);
    }

    #[test]
    fn skips_when_root_author_is_agent() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.root_event_author_pubkey = Some(AGENT);
        assert_eq!(evaluate(inputs), Eligibility::SkipNotTopLevel);
    }

    #[test]
    fn skips_when_root_author_is_backend() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.root_event_author_pubkey = Some(BACKEND);
        assert_eq!(evaluate(inputs), Eligibility::SkipNotTopLevel);
    }

    #[test]
    fn skips_when_root_author_not_whitelisted() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.root_event_author_pubkey = Some(UNKNOWN);
        assert_eq!(evaluate(inputs), Eligibility::SkipNotTopLevel);
    }

    #[test]
    fn skips_when_delegations_active() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.ral_has_active_delegations = true;
        assert_eq!(evaluate(inputs), Eligibility::SkipActiveDelegations);
    }

    #[test]
    fn skips_when_recently_notified() {
        let config = config_enabled();
        let whitelisted = vec![HUMAN.to_string()];
        let project_agent_pubkeys = project_agents();
        let mut inputs = arm_inputs(&config, &whitelisted, &project_agent_pubkeys);
        inputs.notified_recently = true;
        assert_eq!(evaluate(inputs), Eligibility::SkipAlreadyNotifiedRecently);
    }
}
