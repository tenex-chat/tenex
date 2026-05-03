use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_protocol::{
    ErrorResponse, McpControlRequest, McpControlResponse, McpSubscribeRequest,
    McpSubscribeResponse, McpSubscriptionStopRequest, McpSubscriptionStopResponse,
    RuntimeControlResponse,
};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use super::mcp_resource_control::{
    ensure_agent_can_access_server, extract_item_id, list_resources, read_resource,
    resource_read_text, validate_resource_uri,
};
use super::mcp_subscription_delivery::dispatch_notification;
use super::RuntimeShared;

pub(super) struct McpControlCommand {
    pub request: McpControlRequest,
    pub respond_to: oneshot::Sender<RuntimeControlResponse>,
}

pub(super) struct McpSubscriptionRegistry {
    persistence_path: PathBuf,
    subscriptions: Mutex<HashMap<String, McpSubscription>>,
    active: Mutex<HashMap<String, ActiveSubscription>>,
    resource_ref_counts: Mutex<HashMap<ResourceKey, usize>>,
    content_snapshots: Mutex<HashMap<String, HashSet<String>>>,
}

struct ActiveSubscription {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ResourceKey {
    server_name: String,
    resource_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpSubscription {
    pub(super) id: String,
    pub(super) agent_pubkey: String,
    pub(super) agent_slug: String,
    pub(super) server_name: String,
    pub(super) resource_uri: String,
    pub(super) conversation_id: String,
    pub(super) root_event_id: String,
    pub(super) project_id: String,
    pub(super) description: String,
    pub(super) status: McpSubscriptionStatus,
    pub(super) notifications_received: u64,
    pub(super) last_notification_at: Option<i64>,
    pub(super) last_error: Option<String>,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum McpSubscriptionStatus {
    Active,
    Error,
}

impl McpSubscriptionRegistry {
    pub(super) fn load(base_dir: PathBuf) -> Result<Arc<Self>> {
        let persistence_path = base_dir.join("mcp_subscriptions.json");
        let subscriptions = match std::fs::read(&persistence_path) {
            Ok(bytes) => serde_json::from_slice::<Vec<McpSubscription>>(&bytes)
                .with_context(|| format!("parsing {}", persistence_path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reading {}", persistence_path.display()))
            }
        };
        Ok(Arc::new(Self {
            persistence_path,
            subscriptions: Mutex::new(
                subscriptions
                    .into_iter()
                    .map(|subscription| (subscription.id.clone(), subscription))
                    .collect(),
            ),
            active: Mutex::new(HashMap::new()),
            resource_ref_counts: Mutex::new(HashMap::new()),
            content_snapshots: Mutex::new(HashMap::new()),
        }))
    }

    pub(super) async fn restore_active(self: &Arc<Self>, shared: Arc<RuntimeShared>) -> Result<()> {
        let records: Vec<McpSubscription> = self
            .subscriptions
            .lock()
            .unwrap()
            .values()
            .filter(|subscription| {
                subscription.project_id == shared.project_id
                    && subscription.status == McpSubscriptionStatus::Active
            })
            .cloned()
            .collect();

        for record in records {
            if let Err(error) = self
                .start_subscription(shared.clone(), record.clone())
                .await
            {
                warn!(
                    subscription = %record.id,
                    error = %error,
                    "failed to restore MCP subscription"
                );
                self.mark_error(&record.id, error.to_string())?;
            }
        }
        Ok(())
    }

    pub(super) async fn shutdown(&self) {
        let active: Vec<ActiveSubscription> = self
            .active
            .lock()
            .unwrap()
            .drain()
            .map(|(_, v)| v)
            .collect();
        for active in active {
            let _ = active.stop.send(());
            active.task.abort();
        }
    }

    async fn create(
        self: &Arc<Self>,
        shared: Arc<RuntimeShared>,
        req: McpSubscribeRequest,
    ) -> Result<McpSubscribeResponse> {
        validate_resource_uri(&req.resource_uri)?;
        ensure_agent_can_access_server(&shared, &req.agent_pubkey, &req.server_name)?;

        let now = super::runtime_setup::now_ms();
        let record = McpSubscription {
            id: format!("mcp-sub-{}-{}", now, uuid::Uuid::new_v4().simple()),
            agent_pubkey: req.agent_pubkey,
            agent_slug: req.agent_slug,
            server_name: req.server_name,
            resource_uri: req.resource_uri,
            conversation_id: req.conversation_id,
            root_event_id: req.root_event_id,
            project_id: shared.project_id.clone(),
            description: req.description,
            status: McpSubscriptionStatus::Active,
            notifications_received: 0,
            last_notification_at: None,
            last_error: None,
            created_at: now,
            updated_at: now,
        };

        self.start_subscription(shared, record.clone()).await?;
        self.subscriptions
            .lock()
            .unwrap()
            .insert(record.id.clone(), record.clone());
        self.save()?;

        Ok(McpSubscribeResponse {
            content: serde_json::to_string_pretty(&json!({
                "success": true,
                "message": format!("Successfully created MCP subscription '{}'", record.id),
                "subscription": subscription_summary(&record),
                "hint": format!("Use mcp_subscription_stop with subscriptionId '{}' to cancel this subscription.", record.id),
            }))?,
        })
    }

    async fn stop(
        self: &Arc<Self>,
        shared: Arc<RuntimeShared>,
        req: McpSubscriptionStopRequest,
    ) -> Result<McpSubscriptionStopResponse> {
        let record = self
            .subscriptions
            .lock()
            .unwrap()
            .get(&req.subscription_id)
            .cloned()
            .with_context(|| format!("Subscription '{}' not found", req.subscription_id))?;
        if record.agent_pubkey != req.agent_pubkey {
            bail!(
                "You are not authorized to stop subscription '{}'. Only the agent that created the subscription can stop it.",
                req.subscription_id
            );
        }

        self.teardown_subscription(&shared, &record).await;
        self.subscriptions.lock().unwrap().remove(&record.id);
        self.content_snapshots.lock().unwrap().remove(&record.id);
        self.save()?;

        Ok(McpSubscriptionStopResponse {
            content: serde_json::to_string_pretty(&json!({
                "success": true,
                "message": format!("Successfully stopped MCP subscription '{}'", record.id),
                "subscription": {
                    "id": record.id,
                    "serverName": record.server_name,
                    "resourceUri": record.resource_uri,
                    "notificationsReceived": record.notifications_received,
                }
            }))?,
        })
    }

    async fn start_subscription(
        self: &Arc<Self>,
        shared: Arc<RuntimeShared>,
        record: McpSubscription,
    ) -> Result<()> {
        let mut updates = shared
            .mcp_runtime
            .resource_updates(&record.server_name)
            .await?;
        let key = ResourceKey {
            server_name: record.server_name.clone(),
            resource_uri: record.resource_uri.clone(),
        };
        let first_subscription = {
            let refs = self.resource_ref_counts.lock().unwrap();
            !refs.contains_key(&key)
        };
        if first_subscription {
            shared
                .mcp_runtime
                .subscribe_resource(&record.server_name, &record.resource_uri)
                .await?;
        }
        {
            let mut refs = self.resource_ref_counts.lock().unwrap();
            *refs.entry(key).or_insert(0) += 1;
        }

        let (stop, mut stop_rx) = oneshot::channel();
        let registry = self.clone();
        let task_shared = shared.clone();
        let task_record = record.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    update = updates.recv() => {
                        match update {
                            Ok(uri) if uri == task_record.resource_uri => {
                                if let Err(error) = registry
                                    .deliver_notification(task_shared.clone(), task_record.clone())
                                    .await
                                {
                                    warn!(
                                        subscription = %task_record.id,
                                        error = %error,
                                        "failed to deliver MCP resource notification"
                                    );
                                    let _ = registry.mark_error(&task_record.id, error.to_string());
                                }
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                                warn!(subscription = %task_record.id, count, "MCP resource notification receiver lagged");
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        });

        self.active
            .lock()
            .unwrap()
            .insert(record.id.clone(), ActiveSubscription { stop, task });
        info!(
            subscription = %record.id,
            server = %record.server_name,
            resource = %record.resource_uri,
            "MCP subscription active"
        );
        Ok(())
    }

    async fn teardown_subscription(&self, shared: &RuntimeShared, record: &McpSubscription) {
        if let Some(active) = self.active.lock().unwrap().remove(&record.id) {
            let _ = active.stop.send(());
            active.task.abort();
        }

        let key = ResourceKey {
            server_name: record.server_name.clone(),
            resource_uri: record.resource_uri.clone(),
        };
        let should_unsubscribe = {
            let mut refs = self.resource_ref_counts.lock().unwrap();
            match refs.get_mut(&key) {
                Some(count) if *count > 1 => {
                    *count -= 1;
                    false
                }
                Some(_) => {
                    refs.remove(&key);
                    true
                }
                None => false,
            }
        };
        if should_unsubscribe {
            if let Err(error) = shared
                .mcp_runtime
                .unsubscribe_resource(&record.server_name, &record.resource_uri)
                .await
            {
                warn!(
                    subscription = %record.id,
                    error = %error,
                    "failed to unsubscribe MCP resource"
                );
            }
        }
    }

    async fn deliver_notification(
        self: &Arc<Self>,
        shared: Arc<RuntimeShared>,
        record: McpSubscription,
    ) -> Result<()> {
        let read = shared
            .mcp_runtime
            .read_resource(&record.server_name, &record.resource_uri)
            .await?;
        let content = resource_read_text(&read);
        if content.trim().is_empty() {
            return Ok(());
        }
        let Some(new_content) = self.extract_new_items(&record.id, &content) else {
            return Ok(());
        };

        self.mark_delivered(&record.id)?;
        dispatch_notification(shared, &record, &new_content).await
    }

    fn extract_new_items(&self, subscription_id: &str, content: &str) -> Option<String> {
        let lines: Vec<&str> = content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let current: HashMap<String, String> = lines
            .iter()
            .map(|line| (extract_item_id(line), (*line).to_string()))
            .collect();
        let mut snapshots = self.content_snapshots.lock().unwrap();
        let previous = snapshots.insert(
            subscription_id.to_string(),
            current.keys().cloned().collect::<HashSet<_>>(),
        );
        let Some(previous) = previous else {
            return Some(content.to_string());
        };
        let new_lines: Vec<String> = current
            .into_iter()
            .filter_map(|(id, line)| (!previous.contains(&id)).then_some(line))
            .collect();
        (!new_lines.is_empty()).then(|| new_lines.join("\n"))
    }

    fn mark_delivered(&self, subscription_id: &str) -> Result<()> {
        let now = super::runtime_setup::now_ms();
        if let Some(subscription) = self.subscriptions.lock().unwrap().get_mut(subscription_id) {
            subscription.notifications_received += 1;
            subscription.last_notification_at = Some(now);
            subscription.updated_at = now;
            subscription.status = McpSubscriptionStatus::Active;
            subscription.last_error = None;
        }
        self.save()
    }

    fn mark_error(&self, subscription_id: &str, error: String) -> Result<()> {
        let now = super::runtime_setup::now_ms();
        if let Some(subscription) = self.subscriptions.lock().unwrap().get_mut(subscription_id) {
            subscription.status = McpSubscriptionStatus::Error;
            subscription.last_error = Some(error);
            subscription.updated_at = now;
        }
        self.save()
    }

    fn save(&self) -> Result<()> {
        let mut subscriptions: Vec<McpSubscription> = self
            .subscriptions
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        subscriptions.sort_by(|a, b| a.id.cmp(&b.id));
        let bytes = serde_json::to_vec_pretty(&subscriptions)?;
        crate::store::atomic::write(&self.persistence_path, &bytes)
            .with_context(|| format!("writing {}", self.persistence_path.display()))
    }
}

fn subscription_summary(subscription: &McpSubscription) -> serde_json::Value {
    json!({
        "id": subscription.id,
        "serverName": subscription.server_name,
        "resourceUri": subscription.resource_uri,
        "conversationId": subscription.conversation_id,
        "status": subscription.status,
        "description": subscription.description,
    })
}

pub(super) async fn handle_control(shared: Arc<RuntimeShared>, command: McpControlCommand) {
    let response = match handle_request(shared, command.request).await {
        Ok(response) => response,
        Err(error) => RuntimeControlResponse::Error(ErrorResponse {
            message: error.to_string(),
        }),
    };
    let _ = command.respond_to.send(response);
}

async fn handle_request(
    shared: Arc<RuntimeShared>,
    request: McpControlRequest,
) -> Result<RuntimeControlResponse> {
    match request {
        McpControlRequest::ListResources(req) => Ok(RuntimeControlResponse::Mcp(
            McpControlResponse::ListResources(list_resources(shared, req).await?),
        )),
        McpControlRequest::ReadResource(req) => Ok(RuntimeControlResponse::Mcp(
            McpControlResponse::ReadResource(read_resource(shared, req).await?),
        )),
        McpControlRequest::Subscribe(req) => {
            Ok(RuntimeControlResponse::Mcp(McpControlResponse::Subscribe(
                shared.mcp_subscriptions.clone().create(shared, req).await?,
            )))
        }
        McpControlRequest::SubscriptionStop(req) => Ok(RuntimeControlResponse::Mcp(
            McpControlResponse::SubscriptionStop(
                shared.mcp_subscriptions.clone().stop(shared, req).await?,
            ),
        )),
    }
}
