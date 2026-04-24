use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

use tokio::sync::{mpsc::UnboundedSender, watch};
use tokio::time::MissedTickBehavior;
use tracing::debug;

use crate::agent_inventory::read_project_index_agent_pubkeys;
use crate::backend_status_runtime::agents_dir;

/// Polls the local agent inventory on a fixed interval and emits a trigger
/// message (the owner pubkey) for each whitelisted owner whenever the sorted
/// set of installed agent pubkeys changes.
///
/// The downstream consumer uses the trigger to reconcile the observed local
/// agent set against the most recently cached kind 14199 whitelist snapshot
/// for each owner.
///
/// `owners` is shared with the daemon boot wiring so SIGHUP reloads can swap
/// the whitelisted owner set atomically while the polling thread keeps
/// running.
pub struct AgentInventoryPoller {
    pub tenex_base_dir: PathBuf,
    pub owners: Arc<RwLock<Vec<String>>>,
    pub interval: Duration,
    pub trigger_tx: UnboundedSender<String>,
}

impl AgentInventoryPoller {
    /// Reads the inventory once and compares the sorted pubkey set against
    /// `last_seen`.
    ///
    /// Returns `true` when the set changed (including on the first observation)
    /// and fires one trigger per owner currently held in `self.owners`.
    /// Returns `false` when the set is unchanged and nothing is fired.
    ///
    /// Errors reading the inventory (e.g. the `agents/` directory is missing
    /// or transiently unreadable) are logged at `debug!` level and treated as
    /// an empty set. This keeps the poller resilient during daemon startup or
    /// brief filesystem churn.
    pub fn run_once(&self, last_seen: &mut Option<BTreeSet<String>>) -> bool {
        let current = self.collect_current_pubkeys();

        let changed = match last_seen {
            Some(previous) => *previous != current,
            None => true,
        };

        if !changed {
            return false;
        }

        *last_seen = Some(current);

        let owners_snapshot: Vec<String> = self
            .owners
            .read()
            .expect("agent inventory owners lock must not be poisoned")
            .clone();
        for owner in &owners_snapshot {
            if let Err(err) = self.trigger_tx.send(owner.clone()) {
                debug!(
                    owner = %owner,
                    error = %err,
                    "agent inventory trigger channel closed; dropping trigger"
                );
            }
        }

        true
    }

    /// Blocking loop: read the inventory, fire triggers on change, sleep for
    /// `self.interval`, repeat.
    pub fn run_forever(self) {
        let mut last_seen: Option<BTreeSet<String>> = None;
        loop {
            self.run_once(&mut last_seen);
            thread::sleep(self.interval);
        }
    }

    pub async fn run_forever_async(self, mut stop: watch::Receiver<bool>) {
        let mut last_seen: Option<BTreeSet<String>> = None;
        if *stop.borrow() {
            return;
        }
        self.run_once(&mut last_seen);

        let mut interval = tokio::time::interval(self.interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                changed = stop.changed() => {
                    let _ = changed;
                    if *stop.borrow() {
                        return;
                    }
                }
                _ = interval.tick() => {
                    self.run_once(&mut last_seen);
                }
            }
        }
    }

    fn collect_current_pubkeys(&self) -> BTreeSet<String> {
        match read_project_index_agent_pubkeys(agents_dir(&self.tenex_base_dir)) {
            Ok(pubkeys) => pubkeys,
            Err(err) => {
                debug!(
                    base_dir = %self.tenex_base_dir.display(),
                    error = %err,
                    "agent inventory read failed; treating as empty set"
                );
                BTreeSet::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;
    use tokio::sync::mpsc;

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": "active",
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            out.push(msg);
        }
        out
    }

    fn poller(
        base_dir: PathBuf,
        owners: Vec<String>,
        tx: UnboundedSender<String>,
    ) -> AgentInventoryPoller {
        AgentInventoryPoller {
            tenex_base_dir: base_dir,
            owners: Arc::new(RwLock::new(owners)),
            interval: Duration::from_secs(2),
            trigger_tx: tx,
        }
    }

    #[test]
    fn run_once_returns_true_on_first_observation_and_fires_one_trigger_per_owner() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&base_dir, &agent_a, "alpha");
        write_agent(&base_dir, &agent_b, "beta");

        let owner = pubkey_hex(0x11);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir, vec![owner.clone()], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        assert_eq!(drain(&mut rx), vec![owner]);

        let expected: BTreeSet<String> = [agent_a, agent_b].into_iter().collect();
        assert_eq!(last_seen, Some(expected));
    }

    #[test]
    fn run_once_returns_false_when_agent_set_unchanged() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&base_dir, &agent_a, "alpha");
        write_agent(&base_dir, &agent_b, "beta");

        let owner = pubkey_hex(0x11);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir, vec![owner], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        let _ = drain(&mut rx);

        assert!(!poller.run_once(&mut last_seen));
        assert!(drain(&mut rx).is_empty());
    }

    #[test]
    fn run_once_fires_again_when_agent_added() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let agent_a = pubkey_hex(0x21);
        write_agent(&base_dir, &agent_a, "alpha");

        let owner = pubkey_hex(0x11);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir.clone(), vec![owner.clone()], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        let _ = drain(&mut rx);

        let agent_b = pubkey_hex(0x22);
        write_agent(&base_dir, &agent_b, "beta");

        assert!(poller.run_once(&mut last_seen));
        assert_eq!(drain(&mut rx), vec![owner]);
    }

    #[test]
    fn run_once_fires_when_agent_removed() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&base_dir, &agent_a, "alpha");
        write_agent(&base_dir, &agent_b, "beta");

        let owner = pubkey_hex(0x11);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir.clone(), vec![owner.clone()], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        let _ = drain(&mut rx);

        fs::remove_file(base_dir.join("agents").join(format!("{agent_b}.json")))
            .expect("agent file must delete");

        assert!(poller.run_once(&mut last_seen));
        assert_eq!(drain(&mut rx), vec![owner]);
    }

    #[test]
    fn run_once_fires_per_owner() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let agent_a = pubkey_hex(0x21);
        write_agent(&base_dir, &agent_a, "alpha");

        let owner_one = pubkey_hex(0x11);
        let owner_two = pubkey_hex(0x12);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir, vec![owner_one.clone(), owner_two.clone()], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        assert_eq!(drain(&mut rx), vec![owner_one, owner_two]);
    }

    /// When the `agents/` directory is missing, the poller reports an empty
    /// set as the first observation: `run_once` returns `true`, fires one
    /// trigger per owner, and caches the empty set. This lets the downstream
    /// reconciler compare the empty-local inventory against the cached 14199
    /// snapshot and decide what (if anything) to publish.
    #[test]
    fn run_once_ignores_missing_agents_dir_and_reports_empty_set() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();

        let owner = pubkey_hex(0x11);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let poller = poller(base_dir, vec![owner.clone()], tx);

        let mut last_seen = None;
        assert!(poller.run_once(&mut last_seen));
        assert_eq!(drain(&mut rx), vec![owner]);
        assert_eq!(last_seen, Some(BTreeSet::new()));

        assert!(!poller.run_once(&mut last_seen));
        assert!(drain(&mut rx).is_empty());
    }
}
