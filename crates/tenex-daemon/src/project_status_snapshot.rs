use crate::backend_events::project_status::{
    ProjectStatusAgent, ProjectStatusInputs, ProjectStatusScheduledTask,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusSnapshot {
    pub created_at: u64,
    pub project_tag: Vec<String>,
    pub project_owner_pubkey: String,
    pub whitelisted_pubkeys: Vec<String>,
    pub project_manager_pubkey: Option<String>,
    pub agents: Vec<ProjectStatusAgent>,
    pub worktrees: Vec<String>,
    pub scheduled_tasks: Vec<ProjectStatusScheduledTask>,
}

impl ProjectStatusSnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        created_at: u64,
        project_tag: Vec<String>,
        project_owner_pubkey: String,
        whitelisted_pubkeys: Vec<String>,
        project_manager_pubkey: Option<String>,
        agents: Vec<ProjectStatusAgent>,
        worktrees: Vec<String>,
        scheduled_tasks: Vec<ProjectStatusScheduledTask>,
    ) -> Self {
        Self {
            created_at,
            project_tag,
            project_owner_pubkey,
            whitelisted_pubkeys,
            project_manager_pubkey,
            agents,
            worktrees,
            scheduled_tasks,
        }
    }

    pub fn as_inputs(&self) -> ProjectStatusInputs<'_> {
        ProjectStatusInputs {
            created_at: self.created_at,
            project_tag: &self.project_tag,
            project_owner_pubkey: &self.project_owner_pubkey,
            whitelisted_pubkeys: &self.whitelisted_pubkeys,
            project_manager_pubkey: self.project_manager_pubkey.as_deref(),
            agents: &self.agents,
            worktrees: &self.worktrees,
            scheduled_tasks: &self.scheduled_tasks,
        }
    }

    pub fn project_a_tag(owner_pubkey: &str, project_d_tag: &str) -> Vec<String> {
        vec![
            "a".to_string(),
            format!("31933:{owner_pubkey}:{project_d_tag}"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::heartbeat::BackendSigner;
    use crate::backend_events::project_status::{
        PROJECT_STATUS_KIND, ProjectStatusScheduledTaskKind, encode_project_status,
    };
    use crate::nostr_event::{
        NormalizedNostrEvent, canonical_payload, event_hash_hex, verify_signed_event,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use std::str::FromStr;

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct Secp256k1Signer<C: Signing> {
        secp: Secp256k1<C>,
        keypair: Keypair,
        xonly_hex: String,
    }

    impl<C: Signing> Secp256k1Signer<C> {
        fn new(secp: Secp256k1<C>, secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key hex");
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            let xonly_hex = hex::encode(xonly.serialize());
            Self {
                secp,
                keypair,
                xonly_hex,
            }
        }
    }

    impl<C: Signing> BackendSigner for Secp256k1Signer<C> {
        fn xonly_pubkey_hex(&self) -> String {
            self.xonly_hex.clone()
        }

        fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            Ok(hex::encode(sig.to_byte_array()))
        }
    }

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    #[test]
    fn builds_project_a_tag_from_owner_and_d_tag() {
        let owner = pubkey_hex(0x02);

        assert_eq!(
            ProjectStatusSnapshot::project_a_tag(&owner, "demo-project"),
            vec!["a".to_string(), format!("31933:{owner}:demo-project")]
        );
    }

    #[test]
    fn snapshot_as_inputs_encodes_expected_project_status_tag_order() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let manager = pubkey_hex(0x03);
        let worker = pubkey_hex(0x04);
        let whitelisted = vec![owner.clone(), pubkey_hex(0x05)];
        let extra_whitelisted = whitelisted[1].clone();
        let project_tag = ProjectStatusSnapshot::project_a_tag(&owner, "demo-project");

        let snapshot = ProjectStatusSnapshot::new(
            1_700_000_000,
            project_tag.clone(),
            owner.clone(),
            whitelisted,
            Some(manager.clone()),
            vec![ProjectStatusAgent {
                pubkey: worker.clone(),
                slug: "worker".to_string(),
            }],
            vec!["main".to_string()],
            vec![ProjectStatusScheduledTask {
                id: "task-1".to_string(),
                title: "Nightly build".to_string(),
                schedule: "0 1 * * *".to_string(),
                target_agent: "worker".to_string(),
                kind: ProjectStatusScheduledTaskKind::Cron,
                last_run: Some(1_699_999_999),
            }],
        );

        let inputs = snapshot.as_inputs();
        let event = encode_project_status(&inputs, &signer).expect("encode project status");

        assert_eq!(inputs.project_tag, &project_tag);
        assert_eq!(
            event.tags,
            vec![
                project_tag,
                vec!["p".to_string(), owner.clone()],
                vec!["p".to_string(), extra_whitelisted],
                vec!["agent".to_string(), worker.clone(), "worker".to_string(),],
                vec!["branch".to_string(), "main".to_string()],
                vec![
                    "scheduled-task".to_string(),
                    "task-1".to_string(),
                    "Nightly build".to_string(),
                    "0 1 * * *".to_string(),
                    "worker".to_string(),
                    "cron".to_string(),
                    "1699999999".to_string(),
                ],
            ]
        );
        assert_eq!(event.kind, PROJECT_STATUS_KIND);
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        verify_signed_event(&event).expect("signature must verify");

        let expected_canonical = canonical_payload(&NormalizedNostrEvent {
            kind: event.kind,
            content: event.content.clone(),
            tags: event.tags.clone(),
            pubkey: Some(event.pubkey.clone()),
            created_at: Some(event.created_at),
        })
        .expect("canonical payload");
        assert_eq!(event.id, event_hash_hex(&expected_canonical));
    }
}
